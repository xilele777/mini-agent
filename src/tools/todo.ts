import type { Tool } from './types.js'
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ROOT } from '../guard.js'

export interface Task {
  id: number
  title: string
}

/** 磁盘与内存共用同一份状态形状:tasks + nextId */
interface Persisted {
  tasks: Task[]
  nextId: number
}

/** 持久化文件:项目根目录下一个点开头的数据文件,不进 git */
const TODO_FILE = resolve(ROOT, '.mini-agent-todo.json')

/** 读回的内容不可盲信,用 zod 校验 —— 和校验工具参数同一套思路 */
const persistedSchema = z.object({
  tasks: z.array(z.object({ id: z.number(), title: z.string() })),
  nextId: z.number(),
})

/** 读盘。文件不存在(首次)、JSON 坏了、结构不对,一律回空清单,不抛异常 */
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

/** 整份覆盖写回。失败让异常往上抛 —— executeCall 会转成错误文本,模型能看到"写入失败" */
async function savePersisted(p: Persisted): Promise<void> {
  await writeFile(TODO_FILE, JSON.stringify(p, null, 2), 'utf8')
}

// ──────────────────────────────────────────────
// 内存态:模块私有,唯一的读写入口只有下面三个函数 + 启动钩子。
// 注册表、agent.ts 都不能绕过工具函数直接改清单 —— 状态工具的第一纪律是"入口收窄"。
// ──────────────────────────────────────────────
let state: Persisted = { tasks: [], nextId: 1 }

/** 启动时调用一次:把磁盘状态读进内存。此后本进程所有操作都基于这份内存态 */
export async function loadTodoFromDisk(): Promise<void> {
  state = await loadPersisted()
}

/** list 是纯内存读,不再碰盘 —— 秒回 */
export function listTasks(): string {
  if (state.tasks.length === 0) {
    return '[当前没有待办任务]'
  }
  return ['当前待办任务:', ...state.tasks.map((t) => `#${t.id}  ${t.title}`)].join('\n')
}

export async function addTask(title: string): Promise<string> {
  const task: Task = { id: state.nextId, title }
  const next: Persisted = { tasks: [...state.tasks, task], nextId: state.nextId + 1 }
  // 先写盘成功,再替换内存 —— 两个崩溃点(写盘前/写盘后)内存都与磁盘一致
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
  // 同样:先写盘,再替换内存
  await savePersisted(next)
  state = next
  return `已完成并移除任务 #${target.id}:"${target.title}"。剩余 ${next.tasks.length} 项。`
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