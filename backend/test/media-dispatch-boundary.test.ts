import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withMediaExecution } from '../src/infrastructure/providers/media-execution.js'
const directory = await mkdtemp(join(tmpdir(), 'media-dispatch-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { generate } = await import('../src/infrastructure/providers/providers.js')
const { synthesizeSpeech } = await import('../src/infrastructure/providers/speech-provider.js')
after(() => rm(directory, { recursive: true, force: true }))
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const model = { id: 'image', remote_id: 'image', modality: 'image' as const, settings: { request_path: 'images', image_url_path: 'data.0.url', request_template: { prompt: '{{prompt}}' } } }
test('local preparation failures precede dispatch intent; persistence failure prevents the paid POST', async t => {
 let dispatch = 0, fetches = 0
 t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('must not reach') })
 await assert.rejects(withMediaExecution({ beforeDispatch: () => { dispatch++ } }, () => generate(model, provider, { prompt: 'image' }, [{ kind: 'image', path: '/missing/reference.png' }], 'project', () => {})))
 assert.equal(dispatch, 0); assert.equal(fetches, 0)
 await assert.rejects(withMediaExecution({ beforeDispatch: () => { throw new Error('durable intent unavailable') } }, () => generate(model, provider, { prompt: 'image' }, [], 'project', () => {})), /durable intent unavailable/)
 assert.equal(fetches, 0)
})
test('an uncertain paid POST occurs once and cancellation before dispatch sends nothing', async t => {
 let fetches = 0, dispatch = 0
 t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('response lost') })
 await assert.rejects(withMediaExecution({ beforeDispatch: () => { dispatch++ } }, () => generate(model, provider, { prompt: 'image' }, [], 'project', () => {})))
 assert.equal(fetches, 1); assert.equal(dispatch, 1)
 const controller = new AbortController(), reason = new Error('cancel before paid request'); controller.abort(reason)
 await assert.rejects(withMediaExecution({ signal: controller.signal }, () => generate(model, provider, { prompt: 'image' }, [], 'project', () => {})), issue => issue === reason)
 assert.equal(fetches, 1)
})
test('TTS sends the persisted request id and a cancelled paid stream preserves the user reason', async t => {
 const controller = new AbortController(), reason = new Error('stop speech')
 let calls = 0
 const fake: typeof fetch = async (_url, init) => {
  calls++; assert.equal(new Headers(init?.headers).get('X-Api-Request-Id'), 'persisted-request-id')
  queueMicrotask(() => controller.abort(reason))
  return new Response(new ReadableStream({ start() {} }))
 }
 await assert.rejects(synthesizeSpeech({ api_key: 'fixture-key', text: '台词', speaker: 'speaker', request_id: 'persisted-request-id', signal: controller.signal }, fake), issue => issue === reason)
 assert.equal(calls, 1)
})

test('TTS failure retains safe correlation and dispatch evidence without provider response details', async () => {
 const fake: typeof fetch = async () => new Response('private-key-or-script', { status: 503 })
 await assert.rejects(synthesizeSpeech({ api_key: 'fixture-key', text: '台词', speaker: 'speaker', request_id: 'failed-request-id' }, fake), issue => {
  const error = issue as Error & { provider_request_id?: string; delivery?: string }
  assert.equal(error.provider_request_id, 'failed-request-id'); assert.equal(error.delivery, 'unknown')
  assert.match(error.message, /failed-request-id/); assert.equal(error.message.includes('private-key-or-script'), false)
  return true
 })
 let calls = 0
 await assert.rejects(withMediaExecution({ beforeDispatch: () => { throw new Error('intent not persisted') } }, () => synthesizeSpeech({ api_key: 'fixture-key', text: '台词', speaker: 'speaker' }, async () => { calls++; throw new Error('must not fetch') })), /intent not persisted/)
 assert.equal(calls, 0)
})
