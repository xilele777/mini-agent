import { loadConfig } from './config.js'
import { createRuntime } from './runtime.js'

export const testConfig = loadConfig({
  OPENAI_API_KEY: 'test-only-key',
  OPENAI_BASE_URL: 'https://example.test/v1',
  OPENAI_MODEL: 'test-model',
  MINI_AGENT_SHELL: process.execPath,
}, process.platform)

// 漏掉模拟流时明确失败，避免测试意外访问网络。
export const testRuntime = createRuntime(
  testConfig,
  async () => {
    throw new Error('测试必须注入模拟流')
  }
)