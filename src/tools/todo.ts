import type { Tool } from './types.js'
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ROOT } from '../guard.js'

export interface Task {
  id: number
  title: string
}

/** 磁盘上持久化的是整份状态:tasks + nextId */
interface Persisted {
  tasks: Task[]
  nextId: number
}

/** 持久化文件:项目根目录下一个点开头的数据文件,不进 git */
const TODO_FILE = resolve(ROOT, '.mini-agent-todo.json')

/**
 * 从磁盘读回时不能盲信内容:文件可能被人手改坏、可能不是我们写的结构。
 * 用 zod 校验 —— 和项目里校验工具参数是同一套思路。
 */
const persistedSchema = z.object({
  tasks: z.array(z.object({ id: z.number(), title: z.string() })),
  nextId: z.number(),
})

/**
 * 读盘。三种失败一律返回空清单、不抛异常:
 *   · 文件不存在 —— 首次运行,很正常;
 *   · JSON 解析失败 —— 警告一声,从空开始(原文件没删,还能抢救);
 *   · 结构不对(zod 拒绝) —— 同上。
 * 为什么不让它把异常抛出去:这文件只是 agent 的草稿,读坏了不该让整个 agent 崩。
 */
async function loadPersisted(): Promise<Persisted> {
  try {
    const raw = await readFile(TODO_FILE, 'utf8')
    const parsed = persistedSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    console.warn(`[todo] ${TODO_FILE} 内容无法解析,已从空清单开始(原文件未删除)`)
  } catch {
    // 首次运行没有这个文件
  }
  return { tasks: [], nextId: 1 }
}

/**
 * 整份覆盖写回。失败就让异常往上抛 —— executeCall 会接住并转成错误文本,
 * 模型能看到"写入失败",而不是"内存加了、磁盘没存"的静默丢数据。
 */
async function savePersisted(p: Persisted): Promise<void> {
  await writeFile(TODO_FILE, JSON.stringify(p, null, 2), 'utf8')
}

export async function listTasks(): Promise<string> {
  const { tasks } = await loadPersisted()
  if (tasks.length === 0) {
    return '[当前没有待办任务]'
  }
  return ['当前待办任务:', ...tasks.map((t) => `#${t.id}  ${t.title}`)].join('\n')
}

export async function addTask(title: string): Promise<string> {
  const s = await loadPersisted()
  const task: Task = { id: s.nextId, title }
  await savePersisted({ tasks: [...s.tasks, task], nextId: s.nextId + 1 })
  return `已添加任务 #${task.id}:"${task.title}"。当前共 ${s.tasks.length + 1} 项。`
}

export async function removeTask(id: number): Promise<string> {
  const s = await loadPersisted()
  const target = s.tasks.find((t) => t.id === id)
  if (!target) {
    return `错误:清单里没有编号 #${id} 的任务。先用 list_todos 查看当前有哪些任务再操作。`
  }
  await savePersisted({ tasks: s.tasks.filter((t) => t.id !== id), nextId: s.nextId })
  return `已完成并移除任务 #${target.id}:"${target.title}"。剩余 ${s.tasks.length - 1} 项。`
}

// ──────────────────────────────────────────────
// 工具定义与上一版完全相同 —— execute 本来就支持返回 Promise,
// async 函数直接 return,不用任何包装。
// ──────────────────────────────────────────────

const addTodoParams = z.object({
  title: z.string().min(1, '任务描述不能为空').describe('任务的简短描述,例如 "读 README 找出 TODO"'),
})

export const addTodoTool: Tool<z.infer<typeof addTodoParams>> = {
  name: 'add_todo',
  description:
    '往任务清单里加一条待办。接到多步任务时,先把它拆成若干条 add_todo 记录在案,再做其中任意一步。',
  schema: addTodoParams,
  execute: async ({ title }) => addTask(title),
}

const listTodosParams = z.object({})

export const listTodoTool: Tool<z.infer<typeof listTodosParams>> = {
  name: 'list_todos',
  description: '查看任务清单里当前还有哪些任务。做多步任务前先调它确认进度,不要凭记忆猜。',
  schema: listTodosParams,
  execute: async () => listTasks(),
}

const removeTodoParams = z.object({
  id: z.number().int().min(1).describe('要移除的任务编号,来自 list_todos 返回的 # 号'),
})

export const removeTodoTool: Tool<z.infer<typeof removeTodoParams>> = {
  name: 'remove_todo',
  description: '把清单里的一条任务标记为已完成并移除。只在真正完成这件事之后调用。',
  schema: removeTodoParams,
  execute: async ({ id }) => removeTask(id),
}