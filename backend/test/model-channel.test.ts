import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acquireModelChannel, modelChannelIdentity, modelChannelConcurrency } from '../src/infrastructure/providers/model-channel.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { streamText, type GenerationModel, type TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
import { analyzeGeminiImage } from '../src/infrastructure/providers/gemini-image-analysis.js'
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const identity = (tag: string, protocol = 'responses', credential = 'secret') => modelChannelIdentity(`https://${tag}.invalid/v1`, protocol, 'Authorization', `Bearer ${credential}`)

function configured(protocol: 'responses' | 'chat_completions' | 'anthropic_messages' | 'gemini_generate_content', index = 0): GenerationModel {
  if (protocol === 'gemini_generate_content') return { id: 'native-image-' + index, remote_id: 'image-' + index, modality: 'image', protocol: 'image_generations',
    settings: { image_analysis: { enabled: true, protocol, remote_id: 'text-analysis-' + index } } }
  return { id: protocol + index, remote_id: 'remote-' + index, modality: 'text', protocol, settings: {
    text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192 },
  } }
}
function response(protocol: string) {
  if (protocol === 'gemini_generate_content') return Response.json({ candidates: [{ content: { parts: [{ text: '完整答案' }] }, finishReason: 'STOP' }] })
  if (protocol === 'anthropic_messages') return Response.json({ type: 'message', content: [{ type: 'text', text: '完整答案' }], stop_reason: 'end_turn' })
  if (protocol === 'chat_completions') return Response.json({ choices: [{ message: { content: '完整答案' }, finish_reason: 'stop' }] })
  return Response.json({ status: 'completed', output_text: '完整答案' })
}

test('one channel limits open requests while protocol and credential identities stay independent', async () => {
  const same = identity('channel-concurrency')
  const running = await Promise.all(Array.from({ length: modelChannelConcurrency }, () => acquireModelChannel(same)))
  let admitted = false
  const pending = acquireModelChannel(same).then(value => { admitted = true; return value })
  await flush(); assert.equal(admitted, false)
  const protocol = await acquireModelChannel(identity('channel-concurrency', 'chat_completions'))
  const account = await acquireModelChannel(identity('channel-concurrency', 'responses', 'different-account'))
  protocol.release(); account.release(); running[0]!.release()
  const next = await pending; assert.equal(admitted, true)
  next.release(); running.slice(1).forEach(value => value.release())
})

test('cancelling one queued request cannot release another request slot or cancel its siblings', async () => {
  const key = identity('channel-cancel'), controller = new AbortController(), reason = new Error('cancel queued task')
  const running = await Promise.all(Array.from({ length: modelChannelConcurrency }, () => acquireModelChannel(key)))
  const cancelled = assert.rejects(acquireModelChannel(key, controller.signal), issue => issue === reason)
  let nextAdmitted = false
  const pending = acquireModelChannel(key).then(value => { nextAdmitted = true; return value })
  controller.abort(reason); await cancelled; await flush()
  assert.equal(nextAdmitted, false)
  running[0]!.release(); const next = await pending; next.release(); running.slice(1).forEach(value => value.release())
})

test('429 cooldown is shared, does not replay requests, and independently cancels queued waits', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const key = identity('channel-cooldown'), controller = new AbortController(), reason = new Error('stop waiting')
  const first = await acquireModelChannel(key)
  first.response(new Response(null, { status: 429, headers: { 'Retry-After': '2' } })); first.release()
  let admitted = false
  const waiting = acquireModelChannel(key).then(value => { admitted = true; return value })
  const stopped = assert.rejects(acquireModelChannel(key, controller.signal), issue => issue === reason)
  controller.abort(reason); await stopped
  t.mock.timers.tick(1999); await flush(); assert.equal(admitted, false)
  t.mock.timers.tick(1); (await waiting).release(); assert.equal(admitted, true)
})

test('long shared cooldown hands back explicit continuation before dispatch and retains retry time', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const key = identity('channel-long-wait'), first = await acquireModelChannel(key)
  first.response(new Response(null, { status: 429, headers: { 'Retry-After': '120' } })); first.release()
  await assert.rejects(acquireModelChannel(key), issue => issue instanceof TextProviderError && !issue.retryable && issue.delivery === 'not_sent' &&
    issue.retryAfterMs === 120000 && (issue as TextProviderError & { retryAt: number; code: string }).retryAt === 121000 && (issue as any).code === 'model_retry_wait')
  t.mock.timers.tick(120000); (await acquireModelChannel(key)).release()
})

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages', 'gemini_generate_content'] as const) {
  test(`${protocol}: actual model requests share channel capacity across model IDs`, async t => {
    const provider = { adapter: 'http' as const, base_url: `https://wire-${protocol.replaceAll('_', '-')}.invalid/v1` }
    let calls = 0
    const releases: Array<(result: Response) => void> = [], dispatch: TextRequestMetrics[] = []
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Promise<Response>(resolve => releases.push(resolve)) })
    const requests = Array.from({ length: modelChannelConcurrency + 2 }, (_, index) => protocol === 'gemini_generate_content'
      ? analyzeGeminiImage(configured(protocol, index), provider, { prompt: 'source', images: [{ data_url: 'data:image/png;base64,AQID' }] }, undefined, undefined, { onDispatch: value => dispatch.push(value) })
      : streamText(configured(protocol, index), provider, { prompt: 'full source' }, undefined, undefined, undefined, undefined, value => dispatch.push(value)))
    await flush(); assert.equal(calls, modelChannelConcurrency); assert.equal(dispatch.length, modelChannelConcurrency)
    releases.splice(0).forEach(release => release(response(protocol)))
    await flush(); assert.equal(calls, modelChannelConcurrency + 2)
    releases.splice(0).forEach(release => release(response(protocol)))
    assert.deepEqual(await Promise.all(requests), Array(modelChannelConcurrency + 2).fill('完整答案'))
  })

  test(`${protocol}: long 429 cooldown blocks the next dispatch without replaying the failed request`, async t => {
    const provider = { adapter: 'http' as const, base_url: `https://rate-${protocol.replaceAll('_', '-')}.invalid/v1` }
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'Retry-After': '120' } }) })
    const run = () => protocol === 'gemini_generate_content'
      ? analyzeGeminiImage(configured(protocol), provider, { prompt: 'source', images: [{ data_url: 'data:image/png;base64,AQID' }] })
      : streamText(configured(protocol), provider, { prompt: 'source' })
    await assert.rejects(run(), issue => issue instanceof TextProviderError && issue.upstreamStatus === 429 && (issue as any).code === 'model_retry_wait')
    await assert.rejects(run(), issue => issue instanceof TextProviderError && issue.delivery === 'not_sent' && (issue as any).code === 'model_retry_wait')
    assert.equal(calls, 1, 'the coordinator neither replays a failed call nor dispatches during a long cooldown')
  })
}
