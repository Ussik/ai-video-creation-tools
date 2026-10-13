import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import { documentedImageEndpoints, documentedImageSettings } from '@video-studio/shared/models/documented-images-api'

const testData = await mkdtemp(join(tmpdir(), 'documented-images-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { generate } = await import('../src/infrastructure/providers/providers.js')
after(async () => { await rm(testData, { recursive: true, force: true }) })
const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#dd6655' } }).png().toBuffer()
const provider = { adapter: 'http' as const, base_url: 'https://service.invalid/draw/v1' }
const outputUrl = 'https://cdn.invalid/result.png'
const makeModel = (settings = documentedImageSettings()) => ({ id: 'image', remote_id: 'user-image-model', modality: 'image' as const, settings })
async function references() {
  return Promise.all(['first', 'second'].map(async (name, index) => {
    const path = join(testData, name + '.png')
    const imageBytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: index ? '#0055ee' : '#ee5500' } }).png().toBuffer()
    await writeFile(path, imageBytes)
    return { kind: 'image' as const, path, bytes: imageBytes }
  }))
}

test('documented endpoint defaults separate draw submission and site-level task queries without choosing a host', () => {
  for (const base of ['https://service.invalid', 'https://service.invalid/v1/', 'https://service.invalid/draw/v1',
    'https://service.invalid/draw/v1/images/generations', 'https://service.invalid/draw/v1/images/edits']) {
    assert.deepEqual(documentedImageEndpoints(base), { submit: provider.base_url, tasks: 'https://service.invalid/v1' })
  }
  assert.deepEqual(documentedImageEndpoints('http://localhost:8888/proxy/draw/v1'), {
    submit: 'http://localhost:8888/proxy/draw/v1', tasks: 'http://localhost:8888/proxy/v1',
  })
})

test('text generation sends mandatory async and a ratio, saves the ID and URL before polling and downloading', async t => {
  const events: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const address = String(url)
    if (init?.method === 'POST') {
      events.push('submit')
      assert.equal(address, 'https://service.invalid/draw/v1/images/generations')
      assert.deepEqual(JSON.parse(String(init.body)), { model: 'user-image-model', prompt: '海边', n: 1, size: '1:1', async: true })
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer image-secret')
      return Response.json({ task_id: 'task /one', status: 'processing', progress: 0 })
    }
    if (address === outputUrl) {
      events.push('download')
      assert.deepEqual(events, ['submit', 'save ID', 'query', 'save URL', 'download'])
      return new Response(bytes, { headers: { 'content-type': 'image/png' } })
    }
    events.push('query')
    assert.equal(address, 'https://service.invalid/v1/tasks/task%20%2Fone')
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer image-secret')
    // The documented completed response has no status.
    return Response.json({ created: 1782800000, data: [{ url: outputUrl }] })
  })
  const result = await generate(makeModel(), provider, { prompt: '海边' }, [], 'text', id => {
    assert.equal(id, 'task /one'); events.push('save ID')
  }, () => 'image-secret', url => { assert.equal(url, outputUrl); events.push('save URL') })
  assert.equal(result.remoteUrl, outputUrl)
  assert.deepEqual(await readFile(result.path), bytes)
})

test('both documented JSON endpoints send ordered multi-image arrays, pixel sizes and explicitly enabled imageSize', async t => {
  const refs = await references()
  for (const path of ['images/generations', 'images/edits']) for (const field of ['image', 'images']) {
    const settings = documentedImageSettings({ image_reference_path: path, image_reference_field: field,
      image_size_mode: 'pixels', resolutions: ['1280x720'], image_clarity_parameter: true,
      image_task_base_url: 'https://tasks.invalid/v1' }, provider.base_url)
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        assert.equal(String(url), `https://service.invalid/draw/v1/${path}`)
        assert.deepEqual(JSON.parse(String(init.body)), { model: 'user-image-model', prompt: '保留身份与构图', n: 1,
          size: '1280x720', imageSize: '4K', [field]: refs.map(ref => `data:image/png;base64,${ref.bytes.toString('base64')}`), async: true })
        return Response.json({ task_id: 'reference-task' })
      }
      if (String(url) === outputUrl) return new Response(bytes)
      assert.equal(String(url), 'https://tasks.invalid/v1/tasks/reference-task')
      return Response.json({ status: 'completed', data: [{ url: outputUrl }] })
    })
    await generate(makeModel(settings), provider, { prompt: '保留身份与构图', mode: 'reference', resolution: '1280x720', clarity: '4K' }, refs, 'refs', () => {})
  }
})

test('documented multipart edits repeat image files and resume by GET without reading deleted references or uploading again', async t => {
  const refs = await references()
  const settings = documentedImageSettings({ image_reference_transport: 'multipart' })
  let saved = '', posts = 0, queries = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++
      assert.equal(String(url), 'https://service.invalid/draw/v1/images/edits')
      assert.ok(init.body instanceof FormData)
      assert.equal((init.headers as Record<string, string>)['Content-Type'], undefined)
      const form = await new Request(String(url), init).formData()
      assert.equal(form.get('async'), 'true'); assert.equal(form.get('size'), '16:9')
      assert.equal(form.get('n'), '1'); assert.equal(form.get('model'), 'user-image-model')
      assert.equal(form.getAll('image[]').length, 0)
      const files = form.getAll('image') as File[]
      assert.equal(files.length, 2)
      for (const [index, file] of files.entries()) {
        assert.equal(file.name, `reference-${index + 1}.png`)
        assert.equal(file.type, 'image/png')
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), refs[index]!.bytes)
      }
      return Response.json({ task_id: 'files-task', status: 'processing' })
    }
    if (String(url) === outputUrl) return new Response(bytes)
    queries++; assert.equal(saved, 'files-task')
    assert.equal(String(url), 'https://service.invalid/v1/tasks/files-task')
    return Response.json({ data: [{ url: outputUrl }] })
  })
  await generate(makeModel(settings), provider, { prompt: '编辑', mode: 'reference', ratio: '16:9' }, refs, 'files', id => { saved = id })
  await Promise.all(refs.map(ref => rm(ref.path)))
  await generate(makeModel(settings), provider, { prompt: '编辑', mode: 'reference', _external_id: saved }, refs, 'files', () => assert.fail('must not resubmit'))
  assert.equal(posts, 1); assert.equal(queries, 2)
})

test('queued and in_progress responses are polled until URL completion', async t => {
  const settings = documentedImageSettings({ poll_seconds: 1 })
  const statuses = ['queued', 'in_progress']
  let queries = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ task_id: 'pending' })
    if (String(url) === outputUrl) return new Response(bytes)
    const status = statuses[queries++]
    return Response.json(status ? { task_id: 'pending', status, progress: 45 } : { data: [{ url: outputUrl }] })
  })
  await generate(makeModel(settings), provider, { prompt: '待完成' }, [], 'pending', () => {})
  assert.equal(queries, 3)
})

test('failed upstream tasks, HTTP failures and task persistence errors never repeat a generation submission', async t => {
  for (const stage of ['task failed', 'HTTP failed', 'ID save failed']) await t.test(stage, async t => {
    let posts = 0, queries = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++
        return stage === 'HTTP failed' ? Response.json({ error: { message: '上游不可用' } }, { status: 502 }) : Response.json({ task_id: 'failed-task' })
      }
      queries++
      return Response.json({ task_id: 'failed-task', status: 'failed', error: { message: '上游生成失败', code: '' } })
    })
    await assert.rejects(generate(makeModel(), provider, { prompt: '测试' }, [], 'failure', () => {
      if (stage === 'ID save failed') throw new Error('storage failed')
    }), stage === 'task failed' ? /上游生成失败/ : stage === 'HTTP failed' ? /502.*上游不可用/ : /failed-task.*保存任务编号失败/)
    assert.equal(posts, 1); assert.equal(queries, stage === 'task failed' ? 1 : 0)
  })
})

test('invalid documented request options fail before an upstream submission', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid request must not reach a provider'))
  for (const [settings, request, message] of [
    [documentedImageSettings(), { prompt: '测试', mode: 'reference' as const }, /至少一张/],
    [documentedImageSettings({ image_clarity_parameter: true }), { prompt: '测试', clarity: '8K' }, /1K、2K 或 4K/],
    [documentedImageSettings(), { prompt: '测试', ratio: 'auto' }, /size/],
    [{ ...documentedImageSettings(), async_image: false }, { prompt: '测试' }, /必须启用任务查询/],
    [{ ...documentedImageSettings(), request_template: { model: '{{model}}', prompt: '{{prompt}}' } }, { prompt: '测试' }, /async: true/],
  ] as const) await assert.rejects(generate(makeModel(settings), provider, request, [], 'invalid', () => {}), message)
})
