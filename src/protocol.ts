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

# 严格规则
1. 每次只计算一个步骤。
2. 所有数学运算都必须使用 calculate 工具,禁止心算,即使你认为很简单。

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
