import type { Tool } from './types.js'
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ROOT } from '../guard.js'

/** 待办只保存编号与标题；完成时移除条目，没有独立的执行或暂停状态。 */
export interface Task {
  id: number
  title: string
}

/** 内存与磁盘共用的状态结构：待办列表及下一个可分配的编号。 */
interface Persisted {
  tasks: Task[]
  nextId: number
}

/** 固定的项目内状态文件，由工具维护并通过 gitignore 排除。 */
const TODO_FILE = resolve(ROOT, '.mini-agent-todo.json')

/** 磁盘 JSON 也可能被手动修改，载入内存前需检查结构。 */
const persistedSchema = z.object({
  tasks: z.array(z.object({ id: z.number(), title: z.string() })),
  nextId: z.number(),
})

/** 启动时读取状态；文件不可读、JSON 解析失败或结构不符时回退为空清单。 */
async function loadPersisted(): Promise<Persisted> {
  try {
    const raw = await readFile(TODO_FILE, 'utf8')
    const parsed = persistedSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    console.warn(`[todo] ${TODO_FILE} 内容无法解析,已从空清单开始(原文件未删除)`)
  } catch {
    // 当前策略统一回退，首次无文件、读取错误和 JSON 解析错误在此不作区分。
  }
  return { tasks: [], nextId: 1 }
}

/**
 * 整份覆盖磁盘文件，失败由 executeCall 转成工具错误。
 * 此写入没有原子替换保障，失败时磁盘文件也可能已部分改变。
 */
async function savePersisted(p: Persisted): Promise<void> {
  await writeFile(TODO_FILE, JSON.stringify(p, null, 2), 'utf8')
}

// 每个进程持有自己的状态副本，通过启动恢复及增删函数更新，未做多进程协调。
let state: Persisted = { tasks: [], nextId: 1 }

/** 启动时载入一次，此后工具读取内存；运行中手改磁盘文件不会自动刷新。 */
export async function loadTodoFromDisk(): Promise<void> {
  state = await loadPersisted()
}

/** 返回内存中的待办列表，不重新读取磁盘。 */
export function listTasks(): string {
  if (state.tasks.length === 0) {
    return '[当前没有待办任务]'
  }
  return ['当前待办任务:', ...state.tasks.map((t) => `#${t.id}  ${t.title}`)].join('\n')
}

export async function addTask(title: string): Promise<string> {
  const task: Task = { id: state.nextId, title }
  const next: Persisted = { tasks: [...state.tasks, task], nextId: state.nextId + 1 }
  // 写盘成功后才发布新的内存状态；写入失败时保留旧内存。
  await savePersisted(next)
  state = next
  return `已添加任务 #${task.id}:"${task.title}"。当前共 ${next.tasks.length} 项。`
}

export async function removeTask(id: number): Promise<string> {
  const target = state.tasks.find((t) => t.id === id)
  if (!target) {
    return `错误:清单里没有编号 #${id} 的任务。先用 list_todos 查看当前有哪些任务再操作。`
  }
  const next: Persisted = {
    tasks: state.tasks.filter((t) => t.id !== id),
    nextId: state.nextId,
  }
  // 与添加保持相同顺序：写盘成功后更新内存。
  await savePersisted(next)
  state = next
  return `已完成并移除任务 #${target.id}:"${target.title}"。剩余 ${next.tasks.length} 项。`
}

// 工具层负责参数说明，状态函数负责读写；Promise 由注册表统一等待。

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
