import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadDevEnvironment, devEnvironmentMessage } from '../dev-environment.mjs'

const valid = { LANGFUSE_TRACING: 'true', LANGFUSE_PUBLIC_KEY: 'fixture-public', LANGFUSE_SECRET_KEY: 'fixture-secret', LANGFUSE_BASE_URL: 'http://127.0.0.1:3035' }
const serialize = values => Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
async function fixture(t, content) {
  const root = await mkdtemp(join(tmpdir(), 'studio-dev-environment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  if (content !== undefined) await writeFile(join(root, '.env.langfuse.local'), content)
  return root
}

test('missing local file permits startup and respects complete process configuration', async t => {
  const root = await fixture(t)
  const environment = {}
  assert.equal(loadDevEnvironment(root, environment).state, 'disabled')
  assert.deepEqual(environment, {})
  const configured = loadDevEnvironment(root, { ...valid })
  assert.equal(configured.state, 'enabled')
  assert.equal(configured.loaded, false)
})

test('only dedicated Langfuse fields load, with existing process values taking precedence', async t => {
  const root = await fixture(t, serialize({ ...valid, NODE_OPTIONS: '--fixture-unexpected-option', LANGFUSE_TRACING_SAMPLING_RATE: '0.5' }))
  const environment = { LANGFUSE_PUBLIC_KEY: 'process-public', LANGFUSE_TRACING: 'false' }
  const result = loadDevEnvironment(root, environment)
  assert.equal(result.state, 'disabled')
  assert.equal(result.loaded, true)
  assert.equal(environment.LANGFUSE_PUBLIC_KEY, 'process-public')
  assert.equal(environment.LANGFUSE_SECRET_KEY, valid.LANGFUSE_SECRET_KEY)
  assert.equal(environment.LANGFUSE_TRACING, 'false')
  assert.equal(environment.NODE_OPTIONS, undefined)
  const emptyOverride = loadDevEnvironment(root, { LANGFUSE_PUBLIC_KEY: '' })
  assert.equal(emptyOverride.state, 'incomplete')
})

test('quoted values and comments use dotenv semantics', async t => {
  const root = await fixture(t, '# local fixture\nexport LANGFUSE_TRACING="true" # switch\nLANGFUSE_PUBLIC_KEY=fixture-public\nLANGFUSE_SECRET_KEY=\'fixture-#secret\'\nLANGFUSE_BASE_URL="http://127.0.0.1:3035"\n')
  const environment = {}
  assert.equal(loadDevEnvironment(root, environment).state, 'enabled')
  assert.equal(environment.LANGFUSE_SECRET_KEY, 'fixture-#secret')
})

test('unreadable or malformed local configuration fails with a fixed message and no secret', async t => {
  for (const content of ['LANGFUSE_SECRET_KEY="private-value-not-for-output\n', 'LANGFUSE_SECRET_KEY=fixture-secret\nprivate-value-not-for-output', 'LANGFUSE_SECRET_KEY="private-value-not-for-output" trailing']) {
    const root = await fixture(t, content)
    assert.throws(() => loadDevEnvironment(root, {}), error => {
      assert.match(error.message, /配置无法读取或格式无效/)
      assert.doesNotMatch(error.message, /private-value-not-for-output|fixture-secret/)
      return true
    })
  }
})

test('local configuration symlinks are rejected without reading the target', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t)
  const target = join(root, 'private-target')
  await writeFile(target, serialize(valid))
  await symlink(target, join(root, '.env.langfuse.local'))
  assert.throws(() => loadDevEnvironment(root, {}), /配置无法读取或格式无效/)
})

test('enabled configurations are distinguished from incomplete and unsafe configuration', async t => {
  const root = await fixture(t)
  assert.equal(loadDevEnvironment(root, { ...valid }).state, 'enabled')
  for (const values of [
    { LANGFUSE_SECRET_KEY: '' }, { LANGFUSE_BASE_URL: 'http://remote.example' }, { LANGFUSE_BASE_URL: 'https://user:secret@remote.example' },
    { LANGFUSE_BASE_URL: 'https://remote.example?secret=value' }, { LANGFUSE_TRACING_SAMPLING_RATE: 'NaN' },
    { VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS: '0' }, { VIDEO_STUDIO_LANGFUSE_MAX_PENDING: '257' }, { LANGFUSE_TRACING: 'yes' },
  ]) assert.equal(loadDevEnvironment(root, { ...valid, ...values }).state, 'incomplete')
})

test('startup messages reveal only configuration state, including a zero sampling rate', async t => {
  const root = await fixture(t)
  const enabled = loadDevEnvironment(root, { ...valid })
  const incomplete = loadDevEnvironment(root, { ...valid, LANGFUSE_SECRET_KEY: '' })
  const disabled = loadDevEnvironment(root, { ...valid, LANGFUSE_TRACING: 'false' })
  const noSamples = loadDevEnvironment(root, { ...valid, LANGFUSE_TRACING_SAMPLING_RATE: '0' })
  assert.match(devEnvironmentMessage(enabled), /追踪配置已启用/)
  assert.match(devEnvironmentMessage(incomplete), /配置不完整或无效，追踪未启用/)
  assert.match(devEnvironmentMessage(disabled), /追踪已关闭/)
  assert.match(devEnvironmentMessage(noSamples), /采样率为 0/)
  for (const result of [enabled, incomplete, disabled, noSamples]) assert.doesNotMatch(devEnvironmentMessage(result), /fixture-public|fixture-secret|127\.0\.0\.1/)
})
