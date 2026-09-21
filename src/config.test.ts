import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, loadConfig } from './config.js'

const valid = {
  OPENAI_API_KEY: 'test-only-key',
  OPENAI_BASE_URL: 'https://example.test/gateway/v1/',
  OPENAI_MODEL: 'test-model',
}

test('纯输入解析、默认值和 URL 路径保留', () => {
  const config = loadConfig(valid, 'linux')

  assert.equal(config.baseURL, 'https://example.test/gateway/v1')
  assert.equal(config.shell, '/bin/sh')
  assert.equal(config.requestTimeoutMs, 120_000)
  assert.equal(config.commandTimeoutMs, 30_000)
  assert.equal(config.maxIterations, 10)
  assert.equal(config.subagentMaxIterations, 6)
  assert.equal(config.maxReadBytes, 5 * 1024 * 1024)
  assert.ok(Object.isFrozen(config))
  assert.equal(valid.OPENAI_BASE_URL, 'https://example.test/gateway/v1/')
})

test('显式覆盖与单位转换', () => {
  const config = loadConfig({
    ...valid,
    MINI_AGENT_REQUEST_TIMEOUT_MS: ' 9000 ',
    MINI_AGENT_COMMAND_TIMEOUT_MS: '2000',
    MINI_AGENT_MAX_ITERATIONS: '3',
    MINI_AGENT_SUBAGENT_MAX_ITERATIONS: '2',
    MINI_AGENT_MAX_READ_MB: '0.5',
  }, 'linux')

  assert.equal(config.requestTimeoutMs, 9000)
  assert.equal(config.commandTimeoutMs, 2000)
  assert.equal(config.maxIterations, 3)
  assert.equal(config.subagentMaxIterations, 2)
  assert.equal(config.maxReadBytes, 512 * 1024)
})

test('缺少必填字段时一次报告，不采用开发者的模型默认值', () => {
  assert.throws(() => loadConfig({}, 'linux'), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.deepEqual(error.fields, [
      'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
    ])
    return true
  })
})

test('Windows 明确配置绝对 shell 路径，不读取机器上的文件', () => {
  for (const shell of [undefined, '', 'bash.exe', 'C:bash.exe', '\\bash.exe']) {
    assert.throws(() => loadConfig({
      ...valid,
      MINI_AGENT_SHELL: shell,
    }, 'win32'), ConfigError)
  }

  const shell = 'C:\\Program Files\\Git\\bin\\bash.exe'

  assert.equal(
    loadConfig({ ...valid, MINI_AGENT_SHELL: shell }, 'win32').shell,
    shell
  )
})

test('非法数值不会静默使用默认值', () => {
  for (const value of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity']) {
    assert.throws(() => loadConfig({
      ...valid,
      MINI_AGENT_MAX_ITERATIONS: value,
    }, 'linux'), ConfigError)
  }

  assert.throws(() => loadConfig({
    ...valid,
    MINI_AGENT_REQUEST_TIMEOUT_MS: '2147483648',
  }, 'linux'), ConfigError)
})

test('URL 只允许无认证、查询参数和片段的 HTTP(S) 地址', () => {
  for (const url of [
    'bad-url',
    'file:///tmp/model',
    'https://user:secret@example.test/v1',
    'https://example.test/v1?api_key=secret',
    'https://example.test/v1#secret',
    'https://example.test/v1?',
  ]) {
    assert.throws(() => loadConfig({
      ...valid,
      OPENAI_BASE_URL: url,
    }, 'linux'), ConfigError)
  }

  assert.equal(loadConfig({
    ...valid,
    OPENAI_BASE_URL: 'http://localhost:8000',
  }, 'linux').baseURL, 'http://localhost:8000')
})

test('错误只暴露字段名，不回显密钥或其他原始输入', () => {
  assert.throws(() => loadConfig({
    ...valid,
    OPENAI_API_KEY: 'secret key',
    OPENAI_BASE_URL: 'https://example.test/?token=private-token',
    MINI_AGENT_MAX_ITERATIONS: 'private-number',
  }, 'linux'), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /OPENAI_API_KEY/)

    const output = String(error) + JSON.stringify(error)

    for (const secret of ['secret key', 'private-token', 'private-number']) {
      assert.ok(!output.includes(secret))
    }

    return true
  })
})