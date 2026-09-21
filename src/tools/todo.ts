import { z } from 'zod'
import type { Tool } from './types.js'
import type { SessionHandle } from '../session.js'
import { CheckpointError } from '../turn.js'

export function createTodoTools(session: SessionHandle): Tool[] {
  async function update(
    change: Parameters<SessionHandle['update']>[0]
  ) {
    try {
      await session.update(change)
    } catch (error) {
      throw new CheckpointError(error)
    }
  }

  const add: Tool<{ title: string }> = {
    name: 'add_todo',
    description: '为当前会话添加待办；多步任务先记录计划。',
    schema: z.object({
      title: z.string().trim().min(1),
    }),
    execute: async ({ title }) => {
      let id = 0

      await update((draft) => {
        id = draft.todo.nextId++
        draft.todo.tasks.push({ id, title })
      })

      return `已添加任务 #${id}：${title}`
    },
  }

  const list: Tool = {
    name: 'list_todos',
    description: '查看当前会话的待办。',
    schema: z.object({}),
    execute: () => {
      const tasks = session.snapshot.todo.tasks

      return tasks.length
        ? tasks.map((t) => `#${t.id}  ${t.title}`).join('\n')
        : '[当前没有待办任务]'
    },
  }

  const remove: Tool<{ id: number }> = {
    name: 'remove_todo',
    description: '完成任务后移除当前会话中的对应待办。',
    schema: z.object({
      id: z.number().int().positive(),
    }),
    execute: async ({ id }) => {
      const target = session.snapshot.todo.tasks.find((t) => t.id === id)

      if (!target) return `错误：没有编号 #${id} 的待办。`

      await update((draft) => {
        draft.todo.tasks = draft.todo.tasks.filter((t) => t.id !== id)
      })

      return `已完成并移除任务 #${id}：${target.title}`
    },
  }

  return [add, list, remove]
}