import 'dotenv/config'
import { ConfigError } from './config.js'
import { runDoctor } from './doctor.js'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('用法：npm run doctor -- [--online]\n默认检查配置与 shell；--online 请求模型，可能计费。')
    return
  }

  if (
    args.length > 1 ||
    args.some((arg) => arg !== '--online')
  ) {
    console.error('用法：npm run doctor [-- --online]')
    process.exitCode = 2
    return
  }

  await runDoctor(args.includes('--online'))
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigError
      ? error.message
      : '诊断无法完成。'
  )
  process.exitCode = 1
})
