import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Model, Provider } from '../src/infrastructure/database/db.js'
import { generateSourceStructuredText } from '../src/modules/script/script-source-output.js'
import { streamText } from '../src/infrastructure/providers/providers.js'

const model = (id: string, settings = '{}'): Model => ({ id, provider_id: 'provider', name: id, remote_id: id, modality: 'text', protocol: 'responses', settings, enabled: 1, archived: 0 })
const provider: Provider = { id: 'provider', name: 'provider', adapter: 'http', base_url: 'https://example.invalid', auth_header: 'Authorization', auth_prefix: 'Bearer ', key_ciphertext: null, model_catalog: '', enabled: 1, archived: 0, created_at: '' }
const contract = { name: 'script_source_map', schema: { type: 'object' } }

test('first useful source request uses native schema without mutating model settings', async () => {
  const original = model('native'), calls: string[] = []
  const generate = async (configured: Model) => { calls.push(JSON.parse(configured.settings).structured_output_mode); return '{}' }
  await generateSourceStructuredText(original, provider, 'read source', contract, undefined, generate)
  await generateSourceStructuredText(original, provider, 'read next', contract, undefined, generate)
  assert.deepEqual(calls, ['json_schema', 'json_schema']); assert.equal(original.settings, '{}')
})

test('only explicit unsupported-format errors fall back once and cache against the specific configuration', async () => {
  const original = model('unsupported'), calls: Array<string | undefined> = []
  const generate = async (configured: Model) => {
    const mode = JSON.parse(configured.settings).structured_output_mode; calls.push(mode)
    if (mode === 'json_schema') throw new Error('文本模型返回 400: unsupported parameter text.format json_schema')
    return '{}'
  }
  await generateSourceStructuredText(original, provider, 'read', contract, undefined, generate)
  await generateSourceStructuredText(original, provider, 'read next', contract, undefined, generate)
  await generateSourceStructuredText(original, { ...provider, base_url: 'https://other.invalid' }, 'read', contract, undefined, generate)
  assert.deepEqual(calls, ['json_schema', 'prompt', 'prompt', 'json_schema', 'prompt'])
})

test('explicit user modes are honored and network, auth or invalid-schema failures never cause format fallback', async () => {
  const calls: string[] = []
  for (const mode of ['prompt', 'json_object', 'json_schema']) await generateSourceStructuredText(model(mode, JSON.stringify({ structured_output_mode: mode })), provider, 'read', contract, undefined,
    async configured => { calls.push(JSON.parse(configured.settings).structured_output_mode); return '{}' })
  assert.deepEqual(calls, ['prompt', 'json_object', 'json_schema'])
  for (const message of ['HTTP 401 unauthorized', 'fetch failed', 'HTTP 400 invalid schema for text.format json_schema',
    'HTTP 400 Invalid schema for response_format: unsupported keyword', 'HTTP 500 unsupported json_schema']) {
    let count = 0
    await assert.rejects(generateSourceStructuredText(model(message), provider, 'read', contract, undefined, async () => { count++; throw new Error(message) }))
    assert.equal(count, 1, message)
  }
})

test('stage generation and review share capability detection through the actual text transport', async t => {
  const original = model('shared-stage-capability', JSON.stringify({ request_path: 'responses' })), formats: Array<string | undefined> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), format = body.text?.format?.type
    formats.push(format)
    return format === 'json_schema'
      ? new Response('unsupported text.format json_schema', { status: 400 })
      : new Response(JSON.stringify({ output_text: '{}' }), { headers: { 'content-type': 'application/json' } })
  })
  for (const name of ['workflow_draft', 'script_draft_completeness', 'script_source_map']) {
    assert.equal(await streamText(original, provider, { prompt: 'read-only screenplay task', structured_output: { ...contract, name } }), '{}')
  }
  assert.deepEqual(formats, ['json_schema', undefined, undefined, undefined])
  assert.equal(original.settings, JSON.stringify({ request_path: 'responses' }))
})
