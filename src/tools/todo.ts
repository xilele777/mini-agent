import type { Tool } from './types.js'
import { z } from 'zod'

// ──────────────────────────────────────────────
// 1) 任务 = 编号 + 一句话描述。
//    编号由我们自己递增生成,模型用 #号 引用具体某条任务。
// ──────────────────────────────────────────────
export interface Task {
  id: number
  title: string
}

// ──────────────────────────────────────────────
// 2) 状态 = 进程内单例(模块顶层,程序运行期间一直活着)。
//    tasks:  当前清单
//    nextId: 下一个新任务的编号。只增不减,保证编号永不重复
//            (就算删了 #2,下一个新任务也是 #5,不会出现两个 #5)。
// ──────────────────────────────────────────────
export const todoState: {
  tasks: Task[]
  nextId: number
} = {
  tasks: [],
  nextId: 1,
}

// ──────────────────────────────────────────────
// 3) 三个纯函数。每个都返回一段"面向模型的中文文本"——
//    这是模型看见状态唯一的信息通道,必须让它在不猜的情况下知道现状。
// ──────────────────────────────────────────────

export function listTasks(): string {
  if (todoState.tasks.length === 0) {
    return '[当前没有待办任务]'
  }
  const lines = todoState.tasks.map((t) => `#${t.id}  ${t.title}`)
  return ['当前待办任务:', ...lines].join('\n')
}

export function addTask(title: string): string {
  const task: Task = { id: todoState.nextId, title }
  todoState.nextId += 1
  todoState.tasks.push(task)
  return `已添加任务 #${task.id}:"${task.title}"。当前共 ${todoState.tasks.length} 项。`
}

export function removeTask(id: number): string {
  const target = todoState.tasks.find((t) => t.id === id)
  if (!target) {
    return `错误:清单里没有编号 #${id} 的任务。先用 list_todos 查看当前有哪些任务再操作。`
  }
  todoState.tasks = todoState.tasks.filter((t) => t.id !== id)
  return `已完成并移除任务 #${target.id}:"${target.title}"。剩余 ${todoState.tasks.length} 项。`
}

// ──────────────────────────────────────────────
// 4) 包成 Tool。
//    注意:add / remove 会改内存状态,但不碰磁盘、不执行命令,
//    —— 不是"副作用",所以不需要 needsApproval: true。
//    一旦将来改成写盘持久化,就需要重新考虑是否要审批。
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