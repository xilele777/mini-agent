import { setTimeout as delay } from 'node:timers/promises'
import OpenAI from 'openai'
import type { CompletionUsage } from 'openai/resources/completions'
import { ContextBudgetError, estimateInputTokens } from './context-budget.js'
import type { CreateTurnStream, TurnRequest, TurnStatus } from './turn.js'
import type { EventSink, RuntimeEvent } from './telemetry.js'

// Note: 逐传输预留预算，流开始后不重试 — 见 .agents/notes/implemented/architecture/2026-09-22-runtime-resilience.md
export interface RunLimits {
  maxRequests: number
  maxTokens: number
  timeoutMs: number
  maxRetries: number
  retryBaseMs: number
}
export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxRequests: 24,
  maxTokens: 200_000,
  timeoutMs: 600_000,
  maxRetries: 2,
  retryBaseMs: 500,
}
export class RunBudgetError extends ContextBudgetError {
  constructor(message: string) {
    super(message)
    this.name = 'RunBudgetError'
  }
}

function retryable(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIConnectionError ||
    (error instanceof Error && error.name === 'ModelTimeoutError') ||
    (error instanceof OpenAI.APIError &&
      error.status !== undefined &&
      [408, 429, 500, 502, 503, 504].includes(error.status))
  )
}

function validUsage(usage: CompletionUsage | null | undefined): usage is CompletionUsage {
  return (
    !!usage &&
    [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0
    ) &&
    usage.total_tokens >= usage.prompt_tokens + usage.completion_tokens
  )
}

export class RunControl {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly started = performance.now()
  private readonly timer: ReturnType<typeof setTimeout>
  private requests = 0
  private chargedTokens = 0
  private actualTokens = 0
  private estimatedRequests = 0
  private action = 0
  private toolCalls = 0
  private readonly abort: () => void

  constructor(
    readonly limits: RunLimits = DEFAULT_RUN_LIMITS,
    private readonly parent?: AbortSignal,
    private readonly sink: EventSink = () => {}
  ) {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxRetries' ? 0 : 1))
        throw new Error('运行预算必须是有效整数')
    }
    if (limits.timeoutMs > 2_147_483_647) throw new Error('运行时限过大')
    this.abort = () => this.controller.abort(parent?.reason)
    this.signal = this.controller.signal
    if (parent?.aborted) this.abort()
    else parent?.addEventListener('abort', this.abort, { once: true })
    this.timer = setTimeout(() => this.expire(), limits.timeoutMs)
  }

  private expire() {
    this.controller.abort(new RunBudgetError('本轮总时间预算已耗尽（包含批准等待）'))
  }
  check() {
    if (performance.now() - this.started >= this.limits.timeoutMs && !this.signal.aborted)
      this.expire()
    this.signal.throwIfAborted()
  }
  emit(event: RuntimeEvent) {
    if (event.type === 'tool' && event.state === 'started') this.toolCalls++
    this.sink(event)
  }
  nextAction() {
    return ++this.action
  }
  get remainingRequests() {
    return Math.max(0, this.limits.maxRequests - this.requests)
  }
  get stats() {
    return {
      requests: this.requests,
      chargedTokens: this.chargedTokens,
      actualTokens: this.actualTokens,
      estimatedRequests: this.estimatedRequests,
      elapsedMs: Math.round(performance.now() - this.started),
      toolCalls: this.toolCalls,
    }
  }
  end(status: TurnStatus) {
    this.emit({ type: 'turn_end', status, ...this.stats })
  }
  dispose() {
    clearTimeout(this.timer)
    this.parent?.removeEventListener('abort', this.abort)
  }

  stream(create: CreateTurnStream, request: TurnRequest): ReturnType<CreateTurnStream> {
    const self = this
    const scope = request.scope ?? 'main'
    const taskId = request.taskId ?? null
    async function* consume() {
      for (let attempt = 0; ; attempt++) {
        self.check()
        const reserve =
          estimateInputTokens(request.messages, request.tools) + request.maxOutputTokens
        if (!self.remainingRequests) throw new RunBudgetError('本轮总请求次数预算已耗尽')
        if (self.chargedTokens + reserve > self.limits.maxTokens)
          throw new RunBudgetError('本轮累计 token 预算不足以预留本次请求')
        const requestNumber = ++self.requests
        const requestStarted = performance.now()
        self.chargedTokens += reserve
        self.estimatedRequests++
        self.emit({
          type: 'request_start',
          scope,
          taskId,
          request: requestNumber,
          reservedTokens: reserve,
        })
        let seen = false
        let usage: CompletionUsage | undefined
        let failed: unknown
        let succeeded = false
        try {
          const stream = await create({ ...request, signal: self.signal })
          for await (const chunk of stream) {
            self.check()
            // 任意已交付 chunk 都关闭重试窗口，包含 role-only 和部分参数。
            seen = true
            if (validUsage(chunk.usage)) usage = chunk.usage
            yield chunk
          }
          self.check()
          succeeded = true
        } catch (error) {
          failed = error
        } finally {
          if (usage) {
            self.chargedTokens += usage.total_tokens - reserve
            self.actualTokens += usage.total_tokens
            self.estimatedRequests--
          }
          self.emit({
            type: 'request_end',
            scope,
            taskId,
            request: requestNumber,
            outcome: succeeded ? 'returned' : 'failed',
            tokens: usage?.total_tokens ?? reserve,
            accounting: usage ? 'actual' : 'estimated',
            elapsedMs: Math.round(performance.now() - requestStarted),
          })
        }
        self.check()
        if (succeeded) {
          if (self.chargedTokens > self.limits.maxTokens)
            throw new RunBudgetError('服务端 usage 超过本轮 token 预算，已停止后续动作')
          return
        }
        if (seen || attempt >= self.limits.maxRetries || !retryable(failed)) throw failed
        // 下次发送前仍会重新预留；不让毫无额度的重试先等待。
        if (!self.remainingRequests) throw new RunBudgetError('本轮总请求次数预算已耗尽')
        const delayMs = Math.min(10_000, self.limits.retryBaseMs * 2 ** attempt)
        self.emit({ type: 'retry', scope, taskId, attempt: attempt + 1, delayMs })
        await delay(delayMs, undefined, { signal: self.signal }).catch(() => self.check())
      }
    }
    return Promise.resolve(consume())
  }
}
