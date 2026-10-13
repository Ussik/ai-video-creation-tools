import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import { imagesApiSettings, imagesReferenceSettings } from '@video-studio/shared/models/images-api-settings'
import { prepareImageReferences } from '../src/infrastructure/providers/image-references.js'

const testData = await mkdtemp(join(tmpdir(), 'image-api-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { generate } = await import('../src/infrastructure/providers/providers.js')
after(async () => { await rm(testData, { recursive: true, force: true }) })
const resultBytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#dd6655' } }).png().toBuffer()
const provider = { adapter: 'http' as const, base_url: 'https://images.invalid/v1' }

async function reference(name: string, color: string) {
  const path = join(testData, name)
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()
  await writeFile(path, bytes)
  return { kind: 'image' as const, path, bytes }
}

test('Images keeps model names free and uses JSON generations without reference files', async t => {
  for (const remote_id of ['arbitrary-image-model', 'another-model']) {
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), 'https://images.invalid/v1/images/generations')
      assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(String(init.body)), { model: remote_id, prompt: '海边', n: 1, size: 'auto' })
      return Response.json({ data: [{ b64_json: resultBytes.toString('base64') }] })
    })
    await generate({ id: remote_id, remote_id, modality: 'image', settings: imagesApiSettings() }, provider,
      { prompt: '海边', mode: 'text', ratio: '16:9' }, [], remote_id, () => {})
  }
})

test('multipart references use the chosen endpoint, ordered binary files, custom auth and pixel dimensions', async t => {
  const refs = await Promise.all([reference('first.wrong-extension', '#ff0000'), reference('second.png', '#0000ff')])
  // Both endpoints may support references; transport never infers a provider or model name.
  for (const path of ['images/edits', 'images/generations']) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      calls++
      assert.equal(String(url), `https://images.invalid/v1/${path}`)
      assert.equal((init.headers as Record<string, string>)['X-Api-Key'], 'image-secret')
      assert.equal((init.headers as Record<string, string>)['Content-Type'], undefined, 'fetch must set the multipart boundary')
      assert.ok(init.body instanceof FormData)
      const wire = new Request(String(url), init)
      assert.match(wire.headers.get('content-type')!, /^multipart\/form-data; boundary=/)
      const data = await wire.formData()
      assert.equal(data.get('model'), 'user-configured-model')
      assert.equal(data.get('prompt'), '保持参考图的身份与顺序')
      assert.equal(data.get('size'), '1280x720')
      const files = data.getAll('image[]') as File[]
      assert.equal(files.length, 2)
      for (let i = 0; i < files.length; i++) {
        assert.equal(files[i]!.type, 'image/png', 'decode MIME instead of trusting the extension')
        assert.deepEqual(Buffer.from(await files[i]!.arrayBuffer()), refs[i]!.bytes)
      }
      return Response.json({ data: [{ b64_json: resultBytes.toString('base64') }] })
    })
    await generate({ id: 'multipart', remote_id: 'user-configured-model', modality: 'image',
      settings: imagesApiSettings({ image_reference_path: path }) },
    { ...provider, auth_header: 'X-Api-Key', auth_prefix: '' },
    { prompt: '保持参考图的身份与顺序', mode: 'reference', resolution: '1280x720' }, refs, 'multipart', () => {}, () => 'image-secret')
    assert.equal(calls, 1)
  }
})

test('JSON multi-reference gateways retain the chosen fields, ratio and endpoint', async t => {
  const refs = await Promise.all([reference('json-first.png', '#ff0000'), reference('json-second.png', '#0000ff')])
  for (const path of ['images/generations', 'images/edits']) {
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), `https://images.invalid/v1/${path}`)
      const body = JSON.parse(String(init.body))
      assert.equal(body.size, '16:9')
      assert.deepEqual(body.image, refs.map(ref => `data:image/png;base64,${ref.bytes.toString('base64')}`))
      return Response.json({ data: [{ b64_json: resultBytes.toString('base64') }] })
    })
    await generate({ id: 'json', remote_id: 'any-model', modality: 'image', settings: imagesReferenceSettings({ image_reference_path: path }) },
      provider, { prompt: '分镜', mode: 'reference', ratio: '16:9' }, refs, 'json', () => {})
  }
})

test('async file references save the task ID before querying and resume without another upload', async t => {
  const refs = [await reference('async-reference.png', '#ff0000')]
  const settings = { ...imagesApiSettings(), async_image: true, id_path: 'task_id', get_path: 'images/tasks/{id}', status_path: 'status' }
  const model = { id: 'async-native', remote_id: 'any-model', modality: 'image' as const, settings }
  let saved = '', uploads = 0, queries = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (init.method === 'POST') {
      uploads++; assert.ok(init.body instanceof FormData)
      return Response.json({ task_id: 'native-task' })
    }
    queries++
    assert.equal(saved, 'native-task')
    assert.equal(String(url), 'https://images.invalid/v1/images/tasks/native-task')
    return Response.json({ status: 'completed', data: [{ b64_json: resultBytes.toString('base64') }] })
  })
  await generate(model, provider, { prompt: '分镜', mode: 'reference' }, refs, 'async-native', id => { saved = id })
  await rm(refs[0]!.path)
  await generate(model, provider, { prompt: '分镜', _external_id: saved }, refs, 'async-native', () => assert.fail('must not resubmit'))
  assert.equal(uploads, 1); assert.equal(queries, 2)
})

test('large image upload copies shrink while preserving originals, resolution and transparency', async () => {
  const opaquePath = join(testData, 'large.png')
  const original = await sharp(randomBytes(2048 * 2048 * 3), { raw: { width: 2048, height: 2048, channels: 3 } }).png().toBuffer()
  await writeFile(opaquePath, original)
  const opaque = (await prepareImageReferences([{ kind: 'image', path: opaquePath }]))[0]!
  assert.equal(opaque.mime, 'image/jpeg')
  assert.ok(opaque.bytes.length < original.length / 2)
  const info = await sharp(opaque.bytes).metadata()
  assert.equal(info.width, 2048); assert.equal(info.height, 2048)
  assert.deepEqual(await readFile(opaquePath), original)
  const uncompressed = (await prepareImageReferences([{ kind: 'image', path: opaquePath }], false))[0]!
  assert.deepEqual(uncompressed.bytes, original)

  const alphaPath = join(testData, 'transparent.png')
  const alpha = await sharp({ create: { width: 2304, height: 1024, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 0.5 } } }).png().toBuffer()
  await writeFile(alphaPath, alpha)
  const transparent = (await prepareImageReferences([{ kind: 'image', path: alphaPath }]))[0]!
  const metadata = await sharp(transparent.bytes).metadata()
  assert.equal(metadata.hasAlpha, true)
  assert.ok(Math.max(metadata.width!, metadata.height!) <= 2048)
  const stats = await sharp(transparent.bytes).stats()
  assert.ok(stats.channels[3]!.mean > 120 && stats.channels[3]!.mean < 135)
  assert.deepEqual(await readFile(alphaPath), alpha)
})

test('image HTTP failures retain upstream reasons and request IDs, hide credentials and never resubmit', async t => {
  for (const status of [400, 502, 520]) await t.test(String(status), async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return Response.json({ error: { message: 'Invalid image field. Bearer image-secret https://images.invalid?token=private-token', code: 'invalid_image' } },
        { status, headers: { 'x-request-id': 'image-trace' } })
    })
    await assert.rejects(generate({ id: 'errors', remote_id: 'image-model', modality: 'image', settings: imagesApiSettings() }, provider,
      { prompt: 'private prompt' }, [], 'errors', () => {}, () => 'image-secret'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.match(error.message, /Invalid image field/)
      assert.match(error.message, /invalid_image/)
      assert.match(error.message, /image-trace/)
      assert.match(error.message, /模型：image-model/)
      assert.match(error.message, /接口：https:\/\/images.invalid\/v1\/images\/generations/)
      assert.ok(!/image-secret|private-token|private prompt/.test(error.message))
      return true
    })
    assert.equal(calls, 1)
  })
})

test('HTML and empty image gateway errors remain readable', async t => {
  for (const raw of ['', '<html><script>hidden-script</script><body>Gateway timed out</body></html>']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(raw, { status: 502, headers: { 'cf-ray': 'gateway-ray' } }))
    await assert.rejects(generate({ id: 'gateway', remote_id: 'any-model', modality: 'image', settings: imagesApiSettings() }, provider,
      { prompt: '分镜' }, [], 'gateway', () => {}), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, raw ? /Gateway timed out/ : /空响应体/)
      assert.match(error.message, /gateway-ray/)
      assert.ok(!/hidden-script|<html>/.test(error.message))
      return true
    })
  }
})

test('synchronous images can finish after 90 seconds and time out at their configured deadline including body reads', async t => {
  for (const stage of ['slow success', 'response timeout', 'body timeout']) await t.test(stage, async t => {
    const complete = stage === 'slow success'
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, complete ? 600_000 : 120_000)
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    let started!: () => void, body!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal, calls = 0
    const waiting = new Promise<void>(resolve => { started = resolve })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++; signal = init.signal!
      if (stage === 'response timeout') return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        started()
      })
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        body = controller
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        started()
      } }))
    })
    const result = generate({ id: 'slow', remote_id: 'slow-model', modality: 'image', settings: imagesApiSettings(complete ? {} : { request_timeout_seconds: 120 }) },
      provider, { prompt: '分镜' }, [], 'slow', () => {})
    const failure = complete ? undefined : assert.rejects(result, /TIMEOUT.*最长等待：120 秒/)
    await waiting
    t.mock.timers.tick(90_001)
    assert.equal(signal.aborted, false)
    if (complete) {
      body.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: resultBytes.toString('base64') }] })))
      body.close(); assert.ok((await result).path)
    } else {
      t.mock.timers.tick(30_000); await failure
    }
    assert.equal(calls, 1)
  })
})
