import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderExecutionError, providerHttpFailure } from '../src/infrastructure/providers/provider-failure.js'
import { pollExistingProviderTask } from '../src/infrastructure/providers/provider-poll.js'
import { synthesizeSpeech } from '../src/infrastructure/providers/speech-provider.js'
import { resolveMediaTaskCapabilities } from '@video-studio/shared/models/media-task-capabilities'

const directory = await mkdtemp(join(tmpdir(), 'typed-provider-failure-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { generate } = await import('../src/infrastructure/providers/providers.js')
after(() => rm(directory, { recursive: true, force: true }))
const provider = { adapter: 'http' as const, base_url: 'https://typed.invalid/v1' }
const image = (extra = {}) => ({ id: 'image', remote_id: 'actual', modality: 'image' as const,
  settings: { request_path: 'images', request_template: { prompt: '{{prompt}}' }, image_url_path: 'data.0.url', ...extra } })
const runImage = (extra = {}) => generate(image(extra), provider, { prompt: 'private prompt' }, [], 'project', () => {}, () => 'private-key')

test('image paid creates preserve rejected status and rate information without automatic retries', async t => {
  for (const status of [401, 429, 503]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { code: 'safe_vendor_code', message: 'private-key' } },
      { status, headers: { 'Retry-After': '4', 'x-request-id': 'upstream:1' } }) })
    await assert.rejects(runImage(), issue => {
      assert.ok(issue instanceof ProviderExecutionError)
      assert.equal(issue.upstreamStatus, status); assert.equal(issue.upstreamCode, 'safe_vendor_code')
      assert.equal(issue.delivery, 'rejected'); assert.equal(issue.failure_stage, 'create')
      assert.equal(issue.reason, status === 401 ? 'authentication' : status === 429 ? 'rate_limit' : 'protocol')
      assert.equal(issue.retryable, false); assert.equal(issue.retryAfterMs, 4000)
      assert.equal(issue.message.includes('private-key'), false)
      return true
    })
    assert.equal(calls, 1); t.mock.restoreAll()
  }
})

test('invalid JSON, field shape and absent media result have distinct stable facts', async t => {
  for (const [body, reason] of [['{broken', 'json_syntax'], ['[]', 'field_contract'], ['{}', 'field_contract']] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body))
    await assert.rejects(runImage(), issue => issue instanceof ProviderExecutionError && issue.reason === reason && issue.delivery === 'accepted')
    t.mock.restoreAll()
  }
})

test('uncertain network create sends exactly once and never grants automatic retry', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed') })
  await assert.rejects(runImage(), issue => issue instanceof ProviderExecutionError && issue.reason === 'network' &&
    issue.failure_stage === 'create' && issue.delivery === 'unknown' && issue.retryable === false)
  assert.equal(calls, 1)
})

test('restored image task authentication and JSON failures stop after one query without paid POST', async t => {
  for (const response of [new Response('', { status: 401 }), new Response('{broken')]) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { calls++; assert.equal(init.method, 'GET'); return response })
    await assert.rejects(generate(image({ async_image: true, get_path: 'tasks/{id}' }), provider, { prompt: '', _external_id: 'known' }, [], 'project',
      () => assert.fail('existing task cannot create a task')), issue => issue instanceof ProviderExecutionError)
    assert.equal(calls, 1); t.mock.restoreAll()
  }
})

test('read-only polling retries transient facts and preserves final cause; terminal failure never queries again', async () => {
  let calls = 0, waits = 0
  const failure = providerHttpFailure(new Response('', { status: 503 }), 'query', 'temporary gateway')
  const result = await pollExistingProviderTask({ taskId: 'known', label: '图片', immediate: true, intervalMs: 1,
    query: async () => { if (++calls < 3) throw failure; return { done: true } },
    decode: () => ({ state: 'succeeded', value: 'result' }), wait: async () => { waits++ }, timeoutMessage: 'timeout' })
  assert.equal(result, 'result'); assert.equal(calls, 3); assert.equal(waits, 2)
  calls = 0
  await assert.rejects(pollExistingProviderTask({ taskId: 'known', label: '视频', immediate: true, intervalMs: 1,
    query: async () => { calls++; throw failure }, decode: () => ({ state: 'pending' }), wait: async () => {}, timeoutMessage: 'timeout' }),
  issue => issue instanceof ProviderExecutionError && issue.upstreamStatus === 503 && issue.delivery === 'rejected' && issue.reason === 'protocol')
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(pollExistingProviderTask({ taskId: 'known', label: '视频', immediate: true, intervalMs: 1,
    query: async () => { calls++; return {} }, decode: () => ({ state: 'cancelled', message: 'confirmed cancellation' }), wait: async () => {}, timeoutMessage: 'timeout' }),
  issue => issue instanceof ProviderExecutionError && issue.reason === 'cancelled' && issue.delivery === 'completed')
  assert.equal(calls, 1)
})

test('speech retains exact rejection versus accepted malformed stream versus business terminal', async () => {
  const input = { api_key: 'private-key', text: '台词', speaker: 'voice', request_id: 'correlation' }
  for (const [response, reason, delivery] of [
    [new Response('private-key', { status: 401 }), 'authentication', 'rejected'],
    [new Response('{broken\n'), 'json_syntax', 'accepted'],
    [Response.json({ invalid: 'message' }), 'field_contract', 'accepted'],
    [new Response(JSON.stringify({ code: 45000030, message: 'private-key' }) + '\n'), 'business', 'completed'],
  ] as const) {
    let calls = 0
    await assert.rejects(synthesizeSpeech(input, async () => { calls++; return response }), issue => {
      assert.ok(issue instanceof ProviderExecutionError)
      assert.equal(issue.reason, reason); assert.equal(issue.delivery, delivery); assert.equal(issue.provider_request_id, 'correlation')
      assert.equal(issue.retryable, false); assert.equal(issue.message.includes('private-key'), false)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('media capability facts follow selected settings and distinguish local stop from remote cancel', () => {
  assert.equal(resolveMediaTaskCapabilities('image', { async_image: true, get_path: 'tasks/{id}', image_url_path: 'data.0.url' }).query_existing, true)
  assert.equal(resolveMediaTaskCapabilities('image', { async_image: false, get_path: 'tasks/{id}' }).query_existing, false)
  assert.equal(resolveMediaTaskCapabilities('video', {}).query_existing, false)
  assert.deepEqual(resolveMediaTaskCapabilities('audio', { get_path: 'pretend', cancel_path: 'pretend' }),
    { asynchronous: false, query_existing: false, download_result: false, local_stop: true, remote_cancel: false, terminal_status: false })
})


test('body disconnections preserve already accepted HTTP delivery for image and speech', async t => {
  const broken = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } }))
  t.mock.method(globalThis, 'fetch', async () => broken())
  await assert.rejects(runImage(), issue => issue instanceof ProviderExecutionError && issue.reason === 'network' &&
    issue.upstreamStatus === 200 && issue.delivery === 'accepted' && issue.retryable === false)
  await assert.rejects(synthesizeSpeech({ api_key: 'private', text: '台词', speaker: 'voice' }, async () => broken()),
    issue => issue instanceof ProviderExecutionError && issue.reason === 'network' && issue.upstreamStatus === 200 && issue.delivery === 'accepted')
})


test('selected media settings are checked before paying for a result that cannot be queried or decoded', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ id: 'should-never-create' }) })
  for (const model of [image({ image_url_path: undefined }), image({ async_image: true }),
    { id: 'video', remote_id: 'actual', modality: 'video' as const, settings: { create_path: 'tasks' } }]) {
    await assert.rejects(generate(model, provider, { prompt: 'prompt' }, [], 'project', () => {}),
      issue => issue instanceof ProviderExecutionError && issue.reason === 'configuration' && issue.delivery === 'not_sent')
  }
  assert.equal(calls, 0)
})
