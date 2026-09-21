import 'dotenv/config'
import { ConfigError, loadConfig } from './config.js'
import {
  checkModel,
  checkShell,
  type CheckResult,
} from './doctor.js'

async function main() {
  const args = process.argv.slice(2)

  if (
    args.length > 1 ||
    args.some((arg) => arg !== '--online')
  ) {
    console.error('用法：npm run doctor [-- --online]')
    process.exitCode = 2
    return
  }

  const config = loadConfig(process.env, process.platform)

  console.log('[OK] 配置格式通过；密钥和原始配置值不显示。')

  const report = (result: CheckResult) => {
    console.log(`[${result.ok ? 'OK' : 'FAIL'}] ${result.message}`)

    if (!result.ok) {
      process.exitCode = 1
    }
  }

  report(await checkShell(config))

  if (args.includes('--online')) {
    console.log('[检查] 将发起一次模型流式请求，可能产生费用。')
    report(await checkModel(config))
  } else {
    console.log('[SKIP] 尚未检查模型连接；使用 --online 运行在线探针。')
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigError
      ? error.message
      : '诊断无法完成。'
  )
  process.exitCode = 1
})