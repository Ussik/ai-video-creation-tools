import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backgroundTextResponse, withTextResponseRecovery, type BackgroundResponse } from '../src/infrastructure/providers/text-background.js'
const url = 'https://fixture.invalid/v1/responses'
const passthrough = <T>(value: Promise<T>) => value
function store() {
  const rows = new Map<string, BackgroundResponse>()
  return { rows, read: (key: string) => rows.get(key), save: (key: string, value?: BackgroundResponse) => { if (value) rows.set(key, value); else rows.delete(key) } }
}

test('a dropped background response resumes by response ID without another inference POST', async t => {
  const saved = store(), calls: string[] = []
  let failed = false
  t.mock.method(globalThis, 'fetch', async (target: unknown, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${target}`)
    if (init?.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { input: '剧本', background: true, stream: false })
      return Response.json({ id: 'resp_story', status: 'queued' })
    }
    if (!failed) { failed = true; throw new TypeError('fetch failed') }
    return Response.json({ id: 'resp_story', status: 'completed', output_text: '完整创作结果' })
  })
  const invoke = () => withTextResponseRecovery(saved, () => backgroundTextResponse(url, { input: '剧本' }, {}, new AbortController().signal, passthrough, () => {}))
  await assert.rejects(invoke(), /fetch failed/)
  const result = await invoke()
  assert.equal((await result.json()).output_text, '完整创作结果')
  assert.equal(calls.filter(call => call.startsWith('POST')).length, 1)
  assert.equal(calls.at(-1), `GET ${url}/resp_story`)
})

test('an unknown POST outcome is retained and cannot be blindly resubmitted', async t => {
  const saved = store()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed') })
  const invoke = () => withTextResponseRecovery(saved, () => backgroundTextResponse(url, { input: '剧本' }, {}, new AbortController().signal, passthrough, () => {}))
  await assert.rejects(invoke(), /fetch failed/)
  await assert.rejects(invoke(), /停止自动重发/)
  assert.equal(calls, 1)
})

test('explicit stop cancels the accepted provider response; server interruption keeps it recoverable', async t => {
  for (const explicit of [true, false]) {
    const saved = store(), controller = new AbortController(), calls: string[] = []
    t.mock.method(globalThis, 'fetch', async (target: unknown, init?: RequestInit) => {
      calls.push(String(target))
      if (init?.method === 'POST' && target === url) return Response.json({ id: 'resp_story', status: 'queued' })
      if (String(target).endsWith('/cancel')) return Response.json({ status: 'cancelled' })
      queueMicrotask(() => controller.abort(explicit ? undefined : new Error('server restart')))
      return Response.json({ id: 'resp_story', status: 'in_progress' })
    })
    await assert.rejects(withTextResponseRecovery(saved, () => backgroundTextResponse(url, { input: '剧本' }, {}, controller.signal, passthrough, () => {})))
    assert.equal(calls.includes(`${url}/resp_story/cancel`), explicit)
    assert.equal([...saved.rows.values()][0].id, 'resp_story')
    t.mock.restoreAll()
  }
})
