import { validVideo } from './fixtures/valid-video.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { seedance2VideoSettings, seedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'

const directory = await mkdtemp(join(tmpdir(), 'video-result-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { generate, recoverVideo } = await import('../src/infrastructure/providers/providers.js')
after(async () => { await rm(directory, { recursive: true, force: true }) })
const provider = { adapter: 'http' as const, base_url: 'https://provider.invalid/v1' }
const resultUrl = 'https://cdn.invalid/video.mp4?signature=private-result-token'
const genericSettings = { create_path: 'tasks', get_path: 'tasks/{id}', request_template: { prompt: '{{prompt}}' },
  id_path: 'id', status_path: 'status', result_path: 'output.url', poll_seconds: 0.001 }
const model = (settings: Record<string, unknown> = genericSettings) => ({ id: 'video', remote_id: 'configured-video', modality: 'video' as const,
  settings: { ...settings, poll_seconds: 0.001 } })
const complete = () => Response.json({ status: 'succeeded', output: { url: resultUrl }, content: { video_url: resultUrl } })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function fastPoll(t: TestContext) {
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => schedule(callback, 0))
}

test('generic and Seedance save the task ID and result URL in order before downloading', async t => {
  for (const [name, settings] of [['generic', genericSettings], ['seedance2', seedance2VideoSettings()], ['seedance25', seedance25VideoSettings()]] as const) {
    await t.test(name, async t => {
      fastPoll(t)
      const events: string[] = []
      t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
        if (options?.method === 'POST') { events.push('create'); return Response.json({ id: 'accepted-task' }) }
        if (String(url) === resultUrl) {
          events.push('download')
          assert.deepEqual(events, ['create', 'save ID', 'poll', 'save URL', 'download'])
          return new Response(validVideo)
        }
        events.push('poll')
        return complete()
      })
      const result = await generate(model(settings), provider, { prompt: '夜晚街道', mode: 'text', duration: 5 }, [], name,
        async id => { assert.equal(id, 'accepted-task'); events.push('save ID') }, undefined,
        () => assert.fail('video must not invoke the image URL callback'),
        async url => { assert.equal(url, resultUrl); events.push('save URL') })
      assert.deepEqual(await readFile(result.path), validVideo)
      assert.equal(result.remoteUrl, resultUrl)
    })
  }
})

test('a persisted task ID only polls and downloads, skipping missing references and invalid generation mode settings', async t => {
  fastPoll(t)
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    assert.notEqual(options?.method, 'POST', 'restoring a known ID never creates a task')
    requests.push(String(url))
    return String(url) === resultUrl ? new Response(validVideo) : complete()
  })
  const result = await generate(model({ ...seedance25VideoSettings(), create_path: undefined, request_template: undefined }), provider,
    { prompt: '', _external_id: 'task /known', mode: 'first_frame', resolution: 'unsupported' },
    [{ kind: 'image', path: join(directory, 'missing-reference.png') }], 'existing-id',
    () => assert.fail('existing ID must not be persisted as a new submission'), undefined, undefined,
    url => { assert.equal(url, resultUrl) })
  assert.deepEqual(requests, ['https://provider.invalid/v1/contents/generations/tasks/task%20%2Fknown', resultUrl])
  assert.deepEqual(await readFile(result.path), validVideo)
})

test('invalid persisted task IDs stop before network access instead of falling through to creation', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('invalid persisted ID cannot query or create'))
  for (const id of ['', ' ', '\n\t', 'undefined', 'null']) {
    await assert.rejects(generate(model(), provider, { prompt: '动作', _external_id: id }, [], 'bad-existing-id', () => {}), /现有视频任务编号无效/)
  }
})

test('a persisted task ID cannot fall through to a paid POST after modality or async-image configuration changes', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('incompatible recovery settings cannot query or create'))
  for (const modality of ['text', 'image'] as const) {
    await assert.rejects(generate({ ...model(), modality, settings: { request_path: 'generate', request_template: { prompt: '{{prompt}}' } } },
      provider, { prompt: '动作', _external_id: 'already-submitted' }, [], 'incompatible-recovery', () => {}), /当前模型配置不兼容/)
  }
  for (const id of ['', ' ', '\n\t']) {
    await assert.rejects(generate({ ...model(), modality: 'image', settings: { async_image: true, get_path: 'tasks/{id}' } },
      provider, { prompt: '动作', _external_id: id }, [], 'invalid-image-recovery', () => {}), /现有图片任务编号无效/)
  }
})

test('missing or malformed task IDs in a creation response fail after one POST and never poll or auto-resubmit', async t => {
  let calls = 0, saved = 0
  const responses = [{}, { id: null }, { id: '' }, { id: '   ' }, { id: {} }, { id: [] }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 1.5 }, { id: false }, { id: 'undefined' }, { id: 'null' }]
  for (const payload of responses) {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
      assert.equal(options?.method, 'POST')
      calls++
      return Response.json(payload)
    })
    await assert.rejects(generate(model(), provider, { prompt: '动作' }, [], 'bad-create-id', () => { saved++ }), /没有返回有效任务 ID.*不要重复提交/)
    t.mock.restoreAll()
  }
  assert.equal(calls, responses.length)
  assert.equal(saved, 0)
})

test('generic providers can return exact numeric task IDs which are saved as strings before querying', async t => {
  fastPoll(t)
  const events: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') { events.push('create'); return Response.json({ id: 123 }) }
    if (String(url) === resultUrl) return new Response(validVideo)
    assert.equal(String(url), 'https://provider.invalid/v1/tasks/123')
    assert.deepEqual(events, ['create', 'save ID'])
    return complete()
  })
  const result = await generate(model(), provider, { prompt: '动作' }, [], 'numeric-task', id => {
    assert.equal(id, '123')
    events.push('save ID')
  })
  assert.deepEqual(await readFile(result.path), validVideo)
})

test('saving the task ID must finish successfully before any poll or download', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    calls++
    assert.equal(options?.method, 'POST')
    return Response.json({ id: 'accepted-but-unsaved' })
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作' }, [], 'id-checkpoint-failure', async () => {
    await flush()
    throw new Error('mock database failure including https://private.invalid/secret')
  }), error => {
    assert.match(String(error), /accepted-but-unsaved.*已提交，但保存任务编号失败/)
    assert.ok(!String(error).includes('https://private.invalid'))
    return true
  })
  assert.equal(calls, 1)
})

test('download waits for an asynchronous URL checkpoint and cannot start while it is pending', async t => {
  fastPoll(t)
  let release: (() => void) | undefined, downloads = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    assert.notEqual(options?.method, 'POST')
    if (String(url) === resultUrl) { downloads++; return new Response(validVideo) }
    return complete()
  })
  const pending = generate(model(), provider, { prompt: '动作', _external_id: 'known-id' }, [], 'url-checkpoint-gate', () => {}, undefined, undefined,
    () => new Promise<void>(resolve => { release = resolve }))
  for (let index = 0; index < 100 && !release; index++) await flush()
  assert.ok(release, 'poll reached the URL checkpoint')
  assert.equal(downloads, 0)
  release()
  await pending
  assert.equal(downloads, 1)
})

test('URL checkpoint failure stops immediately without download, recreated task, or signed URL in the error', async t => {
  fastPoll(t)
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    assert.notEqual(options?.method, 'POST')
    requests.push(String(url))
    return complete()
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作', _external_id: 'known-id' }, [], 'url-checkpoint-failure', () => {}, undefined, undefined,
    async () => { throw new Error(resultUrl) }), error => {
    assert.match(String(error), /保存可恢复链接失败/)
    assert.ok(!String(error).includes('private-result-token'))
    return true
  })
  assert.deepEqual(requests, ['https://provider.invalid/v1/tasks/known-id'])
})

test('invalid completed result URLs are rejected before checkpointing or downloading', async t => {
  fastPoll(t)
  let saved = 0, calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    calls++
    assert.equal(options?.method, 'GET')
    return Response.json({ status: 'succeeded', output: { url: 'file:///tmp/private.mp4' } })
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作', _external_id: 'known-id' }, [], 'bad-result-url', () => {}, undefined, undefined,
    () => { saved++ }), /有效的 HTTP 地址/)
  assert.equal(saved, 0)
  assert.equal(calls, 1)
})

test('a failed video download retains its URL checkpoint; recoverVideo then downloads only the saved URL', async t => {
  fastPoll(t)
  let savedUrl = '', downloads = 0
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    requests.push(String(url))
    assert.notEqual(options?.method, 'POST')
    if (String(url) === resultUrl) {
      downloads++
      if (downloads === 1) throw new Error(`mock connection failure: ${resultUrl}`)
      return new Response(validVideo)
    }
    return complete()
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作', _external_id: 'known-id' }, [], 'download-recovery', () => {}, undefined, undefined,
    url => { savedUrl = url }), error => {
    assert.match(String(error), /可重试下载现有结果，不会再次请求厂商生成/)
    assert.ok(!String(error).includes('private-result-token'))
    return true
  })
  assert.equal(savedUrl, resultUrl)
  assert.deepEqual(await readdir(join(directory, 'media', 'download-recovery')), [], 'failed download removes partial files')
  const recovered = await recoverVideo('download-recovery', savedUrl)
  assert.deepEqual(await readFile(recovered.path), validVideo)
  assert.deepEqual(requests, ['https://provider.invalid/v1/tasks/known-id', resultUrl, resultUrl])
})

test('URL-only recovery needs no model, API key or provider, and rejects non-HTTP URLs without network access', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    calls++
    assert.equal(String(url), resultUrl)
    assert.equal(options?.method, undefined)
    assert.equal(options?.headers, undefined)
    return new Response(validVideo)
  })
  const result = await recoverVideo('download-only', resultUrl)
  assert.deepEqual(await readFile(result.path), validVideo)
  for (const url of ['file:///tmp/private.mp4', 'data:video/mp4;base64,AAAA', 'not-a-url']) {
    await assert.rejects(recoverVideo('download-only', url))
  }
  assert.equal(calls, 1)
})

test('terminal vendor failure and repeated poll network errors never submit a replacement task', async t => {
  fastPoll(t)
  const statuses = ['failed', 'expired', 'cancelled', 'canceled']
  let gets = 0
  for (const status of statuses) {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
      gets++
      assert.equal(options?.method, 'GET')
      return Response.json({ status, error: { message: 'terminal vendor result' } })
    })
    await assert.rejects(generate(model(), provider, { prompt: '动作', _external_id: 'failed-id' }, [], 'terminal-failure', () => {}), /视频任务 failed-id 失败/)
  }
  let failures = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    assert.equal(options?.method, 'GET')
    failures++
    throw new Error('mock temporary network failure')
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作', _external_id: 'network-id' }, [], 'poll-network-failure', () => {}), /查询视频任务 network-id 失败/)
  assert.equal(gets, statuses.length)
  assert.equal(failures, 3)
})

test('uncertain create network and HTTP failures do not retry the paid POST', async t => {
  let creates = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    assert.equal(options?.method, 'POST')
    creates++
    throw new Error('mock response lost after acceptance')
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作' }, [], 'create-network-failure', () => {}), /response lost/)
  assert.equal(creates, 1)
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    assert.equal(options?.method, 'POST')
    creates++
    return Response.json({ error: 'uncertain upstream state' }, { status: 502 })
  })
  await assert.rejects(generate(model(), provider, { prompt: '动作' }, [], 'create-http-failure', () => {}), /502/)
  assert.equal(creates, 2)
})
