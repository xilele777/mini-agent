const SAFE = /^[0-9+\-*/(). ]+$/

export function calculate(expression: string): string{

  if(expression.length>100){
    return '错误，表达式过长，不能超过 100 个字符'
  }

  if(!SAFE.test(expression)){
    return '错误，表达式包含非法字符,只允许数字和 + - * / ( ) . 以及空格'
  }

  try{
    const result = eval(expression)
    if(!Number.isFinite(result)){
      return '错误，计算结果不是有效数字，请检查是否除以了0'
    }
    return String(result)
  }catch(e){
    return `错误，表达式无法计算(${String(e)})`
  }
}


//测试
// const cases = ['1+1', '12 * 34', '(2+3)*4', '1/0', 'abc', '1+']

// for (const c of cases) {
//   console.log(`${c}  =>  ${calculate(c)}`)
// }