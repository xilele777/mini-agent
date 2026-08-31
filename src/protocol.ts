export type ParseResult = 
  { type: 'action'; tool: string; input: string } |
  { type: 'final'; content: string } |
  { type: 'error'; message: string }

const FINAL = /Final Answer:\s*([\s\S]*)/
const ACTION = /Action:\s*(.+)/
const INPUT  = /Action Input:\s*(.+)/

export function parse(text: string): ParseResult {
  const finalMatch = text.match(FINAL)
  if(finalMatch){
    return {
      type: 'final',
      content: (finalMatch[1] ?? '').trim()
    }
  }

  const actionMatch = text.match(ACTION)
  if(actionMatch){
    const inputMatch = text.match(INPUT)
    if(!inputMatch){
      return {
        type: 'error',
        message: '格式错误：你写了 Action 但缺少 Action Input，请补上工具的参数'
      }
    }
    return {
      type: 'action',
      tool: (actionMatch[1] ?? '').trim(),
      input: (inputMatch[1] ?? '').trim()
    }
  }

  return {
    type: 'error',
    message: '格式错误：请使用 "Action:" + "Action Input:" 调用工具，或用 "Final Answer:" 给出最终答案'
  }
}

export const SYSTEM_PROMPT = `你是一个可以使用工具的助手。

# 可用工具

- calculate: 计算数学表达式。参数是一个只含数字和 + - * / ( ) . 的表达式字符串。

# 输出格式

你每次回复只能是以下两种形态之一。

形态一，需要使用工具时：

Thought: 你的思考过程
Action: 工具名称
Action Input: 传给工具的参数

形态二，已经可以回答用户时：

Thought: 你的思考过程
Final Answer: 给用户的最终答案

# 严格规则

1. 写完 "Action Input:" 这一行后，你必须立即停止输出，不要再写任何内容。
2. 绝对不要自己编写 "Observation:"。工具的执行结果由系统提供给你，不是由你想象。
3. 每次回复只能包含一个 Action。
4. 不要在格式之外添加任何寒暄、解释或 Markdown 代码块。
5. 每次只计算一个步骤。
6. 所有数学运算都必须使用 calculate 工具,禁止心算,即使你认为很简单。

# 工作流程

你输出 Action 后，系统会执行工具，并把结果以 "Observation: ..." 的形式发给你。
你看到 Observation 后，再决定是继续使用工具，还是给出 Final Answer。
`

// const cases = [
//   'Thought: 需要计算\nAction: calculate\nAction Input: 12 * 34',
//   'Thought: 知道了\nFinal Answer: 答案是 408',
//   '好的！我来帮您计算。\nAction: calculate\nAction Input: 1+1',
//   'Action: calculate',
//   '我觉得答案是 42。',
// ]

// for (const c of cases) {
//   console.log('输入:', JSON.stringify(c))
//   console.log('结果:', JSON.stringify(parse(c)))
//   console.log('---')
// }
