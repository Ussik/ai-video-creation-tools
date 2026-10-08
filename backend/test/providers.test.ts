import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import sharp from 'sharp'
import { imagePreferencePrompt } from '../../web/src/canvas-model-parameters.js'
import { rightApiImageSettings } from '../src/rightapi-image-settings.js'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-providers-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { generate } = await import('../src/providers.js')
const { render } = await import('../src/render.js')

after(async () => { await rm(testData, { recursive: true, force: true }) })

const imageBytes = await sharp({
  create: { width: 16, height: 16, channels: 3, background: '#dc6250' },
}).png().toBuffer()

test('RightAPI sends ordered data URL references and the chosen ratio, persists task ID, then consumes a status-less completed image', async t => {
  const images = await Promise.all(['png', 'jpeg', 'webp'].map(async extension => {
    const path = join(testData, `rightapi-reference.${extension}`)
    const bytes = extension === 'png' ? imageBytes : await sharp(imageBytes).toFormat(extension as 'jpeg' | 'webp').toBuffer()
    await writeFile(path, bytes)
    return { path, data: `data:image/${extension};base64,${bytes.toString('base64')}` }
  }))
  const pricing = { per_image: 0.06 }
  const settings = rightApiImageSettings({ ratios: ['1:1', '9:16', '21:9'], default_ratio: '9:16', pricing })
  assert.deepEqual(settings.ratios, ['1:1', '9:16', '21:9'])
  assert.equal(settings.pricing, pricing)
  const model = { id: 'rightapi-image', name: '图片模型', provider_id: 'rightapi', enabled: true,
    protocol: 'image_generations' as const, remote_id: 'gpt-image-2.5', modality: 'image' as const, settings: { ...settings, poll_seconds: 1 } }
  let submitted: Record<string, unknown> | undefined
  let taskId = ''
  let queries = 0
  const methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    methods.push(init.method || 'GET')
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key')
    if (init.method === 'POST') {
      assert.equal(String(url), 'https://www.rightapi.ai/draw/v1/images/generations')
      submitted = JSON.parse(String(init.body))
      return Response.json({ task_id: 'task_image_1', status: 'processing', progress: 0 })
    }
    assert.equal(taskId, 'task_image_1', 'persist task ID before the first query')
    assert.equal(String(url), 'https://www.rightapi.ai/v1/tasks/task_image_1')
    return Response.json(++queries === 1 ? { status: 'in_progress', progress: 45 } : { created: 1782800000, data: [{ b64_json: imageBytes.toString('base64') }] })
  })
  const prompt = imagePreferencePrompt(model, '使用人物、场景和道具设定制作分镜', { ratio: '9:16', resolution: null, clarity: '1K', quality: null, background: null }, 'reference')
  const result = await generate(model, { adapter: 'http', base_url: 'https://www.right.codes/v1' },
    { prompt, mode: 'reference', ratio: '9:16' }, images.map(image => ({ kind: 'image', path: image.path })), 'rightapi-test', id => { taskId = id }, () => 'test-key')
  assert.deepEqual(submitted?.image, images.map(image => image.data))
  assert.equal(submitted?.size, '9:16')
  assert.equal(submitted?.async, true)
  assert.equal(submitted?.n, 1)
  assert.equal(submitted?.model, 'gpt-image-2.5')
  assert.match(String(submitted?.prompt), /整张输出图片使用此比例/)
  assert.equal(Object.hasOwn(submitted || {}, 'ratio'), false)
  assert.deepEqual(methods, ['POST', 'GET', 'GET'])
  assert.ok((await stat(result.path)).size > 0)
})

test('RightAPI resumes the persisted image task without resubmitting or loading reference files and saves the download URL first', async t => {
  let savedUrl = ''
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    urls.push(String(url))
    assert.notEqual(init?.method, 'POST')
    if (String(url) === 'https://www.rightapi.ai/v1/tasks/task_resume') return Response.json({ data: [{ url: 'https://cdn.invalid/rightapi-result.png' }] })
    assert.equal(savedUrl, 'https://cdn.invalid/rightapi-result.png')
    assert.equal(String(url), savedUrl)
    return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } })
  })
  const result = await generate({ id: 'rightapi-image', remote_id: 'gpt-image-2.5', modality: 'image', settings: rightApiImageSettings() },
    { adapter: 'http', base_url: 'https://www.right.codes/v1' }, { prompt: '已提交的任务', _external_id: 'task_resume' },
    [{ kind: 'image', path: join(testData, 'removed-reference.png') }], 'rightapi-resume', () => { assert.fail('must not create another task') }, undefined, url => { savedUrl = url })
  assert.equal(result.remoteUrl, savedUrl)
  assert.deepEqual(urls, ['https://www.rightapi.ai/v1/tasks/task_resume', savedUrl])
  assert.ok((await stat(result.path)).size > 0)
})

test('RightAPI task failure exposes error.message and querying never starts a new generation', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.method, 'GET'); calls++
    return Response.json({ task_id: 'task_failed', status: 'failed', error: { message: '模型暂不可用' } })
  })
  await assert.rejects(generate({ id: 'async', remote_id: 'gpt-image-2.5-flare', modality: 'image', settings: rightApiImageSettings() },
    { adapter: 'http', base_url: 'https://www.right.codes/v1' }, { prompt: '分镜', _external_id: 'task_failed' }, [], 'rightapi-failure', () => {}), /图片任务 task_failed 失败：模型暂不可用/)
  assert.equal(calls, 1)
})

test('RightAPI query connection failures retry only GET and keep the original task recoverable', async t => {
  let queries = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.method, 'GET'); queries++
    throw new TypeError('connection closed')
  })
  await assert.rejects(generate({ id: 'async', remote_id: 'gpt-image-2.5', modality: 'image', settings: { ...rightApiImageSettings(), poll_seconds: 1 } },
    { adapter: 'http', base_url: 'https://www.right.codes/v1' }, { prompt: '分镜', _external_id: 'task_network' }, [], 'rightapi-network', () => {}), /查询图片任务 task_network 失败，可继续查询原任务/)
  assert.equal(queries, 3)
})

test('RightAPI cannot query before its task ID is persisted', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.method, 'POST'); calls++
    return Response.json({ task_id: 'task_unpersisted', status: 'processing' })
  })
  await assert.rejects(generate({ id: 'async', remote_id: 'gpt-image-2.5', modality: 'image', settings: rightApiImageSettings() },
    { adapter: 'http', base_url: 'https://www.right.codes/v1' }, { prompt: '分镜', mode: 'text', ratio: '16:9' }, [], 'rightapi-persist', () => { throw new Error('database unavailable') }), /task_unpersisted 已提交，但保存任务编号失败/)
  assert.equal(calls, 1)
})

test('ratio-only image requests send both the selected ratio and the whole-image prompt instruction', async t => {
  const model = { id: 'ratio-image', name: '图片模型', provider_id: 'ratio-provider', remote_id: 'ratio-image', modality: 'image' as const,
    protocol: 'image_generations' as const, enabled: true, settings: {
      request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' },
      image_base64_path: 'data.0.b64_json',
    } }
  let submitted: Record<string, unknown> | undefined
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), 'https://image-provider.invalid/v1/images/generations')
    submitted = JSON.parse(String(init.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } })
  })
  const prompt = imagePreferencePrompt(model, '制作人物视觉设定信息图', { ratio: '9:16', resolution: null, clarity: '2K', quality: 'standard', background: 'auto' })
  await generate(model, { adapter: 'http', base_url: 'https://image-provider.invalid/v1' },
    { prompt, mode: 'text', ratio: '9:16', resolution: null, clarity: '2K' }, [], 'ratio-testproject', () => {})
  assert.equal(submitted?.ratio, '9:16')
  assert.equal(submitted?.prompt, prompt)
  assert.ok(String(submitted?.prompt).includes('画面比例：9:16（宽:高，竖版）'))
  assert.ok(String(submitted?.prompt).includes('整张输出图片使用此比例'))
  assert.ok(!Object.hasOwn(submitted || {}, 'size'), 'do not invent a size field for a ratio-only template')
})

test('configured text and image APIs use templates, response paths and provider auth', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    calls.push({ path: request.url || '', body, auth: request.headers['x-api-key'] as string | undefined })
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({ choices: [{ message: { content: '镜头脚本已完成' } }] }))
    } else if (request.url === '/v1/images/generations') {
      response.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }))
    } else {
      response.writeHead(404).end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    const provider = { adapter: 'http' as const, base_url: `http://127.0.0.1:${address.port}/v1`, auth_header: 'X-API-Key', auth_prefix: '' }
    const text = await generate({ id: 'deepseek', remote_id: 'deepseek-chat', modality: 'text', settings: {
      request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      text_path: 'choices.0.message.content',
    } }, provider, { prompt: '一个城市夜景' }, [], 'testproject', () => {}, () => 'secret')
    assert.equal(await readFile(text.path, 'utf8'), '镜头脚本已完成')
    assert.deepEqual(calls[0]?.body, { model: 'deepseek-chat', messages: [{ role: 'user', content: '一个城市夜景' }] })
    assert.equal(calls[0]?.auth, 'secret')

    const reference = join(testData, 'reference.png')
    await writeFile(reference, imageBytes)
    const image = await generate({ id: 'gpt-image', remote_id: 'gpt-image-1', modality: 'image', settings: {
      request_path: 'images/generations',
      request_template: { model: '{{model}}', prompt: '{{prompt}}', reference: '{{image}}', size: '{{size}}' },
      image_base64_path: 'data.0.b64_json',
    } }, provider, { prompt: '红色图形', resolution: '1536x1024' }, [{ kind: 'image', path: reference }], 'testproject', () => {}, () => 'secret')
    assert.ok((calls[1]?.body.reference as string).startsWith('data:image/png;base64,'))
    assert.equal(calls[1]?.body.size, '1536x1024')
    assert.equal((await sharp(image.path).metadata()).format, 'png')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('non-streaming text can finish after the former 90-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  let requestSignal: AbortSignal | undefined
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    calls++
    requestSignal = init.signal!
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller
      requestSignal!.addEventListener('abort', () => controller.error(requestSignal!.reason), { once: true })
      started()
    } }))
  })
  const result = generate({ id: 'slow-text', remote_id: 'slow-text', modality: 'text', settings: {
    request_path: '/text', text_path: 'output_text',
  } }, { adapter: 'http', base_url: 'https://example.invalid' }, { prompt: '整理视觉设定' }, [], 'slow-text', () => {})
  await waiting
  t.mock.timers.tick(90_001)
  assert.equal(requestSignal!.aborted, false)
  body!.enqueue(new TextEncoder().encode(JSON.stringify({ output_text: '设定草稿已完成' })))
  body!.close()
  assert.equal(await readFile((await result).path, 'utf8'), '设定草稿已完成')
  assert.equal(calls, 1)
})

test('text timeouts cover both waiting for a response and reading its body without retrying', async t => {
  for (const stage of ['response', 'body']) await t.test(stage, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      calls++
      const signal = init.signal!
      if (stage === 'response') return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        started()
      })
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        started()
      } }))
    })
    const failure = assert.rejects(generate({ id: 'timeout-text', remote_id: 'timeout-text', modality: 'text', settings: {
      request_path: '/text', text_path: 'output_text',
    } }, { adapter: 'http', base_url: 'https://example.invalid' }, { prompt: '整理视觉设定' }, [], 'timeout-text', () => {}),
    /文本模型请求超时（最长等待 10 分钟）/)
    await waiting
    t.mock.timers.tick(10 * 60_000)
    await failure
    assert.equal(calls, 1)
  })
})

test('configured text paths read content blocks without exposing reasoning text', async () => {
  const responses: Record<string, unknown>[] = [
    { choices: [{ message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '正文一' }] } }] },
    { output: [{ type: 'message', content: [
      { type: 'reasoning', text: '内部推理' },
      { type: 'output_text', text: '正文二' },
      { type: 'output_text', text: '正文三' },
    ] }] },
    { choices: [{ message: { content: null, reasoning_content: '内部推理' } }], output_text: '正文四' },
    { choices: [{ message: { content: null, reasoning_content: '内部推理' } }] },
  ]
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(responses.shift()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    const provider = { adapter: 'http' as const, base_url: `http://127.0.0.1:${address.port}/v1` }
    const model = { id: 'text', remote_id: 'text-model', modality: 'text' as const, settings: {
      request_path: 'chat/completions', text_paths: ['choices.0.message', 'output.0.content', 'output_text'],
    } }
    for (const [index, expected] of ['正文一', '正文二\n正文三', '正文四'].entries()) {
      const result = await generate(model, provider, { prompt: `输入 ${index}` }, [], 'textblocks', () => {})
      assert.equal(await readFile(result.path, 'utf8'), expected)
    }
    await assert.rejects(generate(model, provider, { prompt: '仅推理' }, [], 'textblocks', () => {}),
      /模型响应没有符合配置路径的文本/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Responses text paths skip reasoning ancestors and find later output messages', async () => {
  const responses: Record<string, unknown>[] = [
    { output: [
      { type: 'reasoning', content: [{ type: 'summary_text', text: '我们需要回答用户中文...' }] },
      { type: 'message', content: [
        { type: 'reasoning', text: '另一段推理' },
        { type: 'output_text', text: '{"outline":"完整剧本"}' },
      ] },
    ] },
    { output: [{ type: 'reasoning', content: [{ type: 'summary_text', text: '只有推理' }] }] },
  ]
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(responses.shift()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    const provider = { adapter: 'http' as const, base_url: `http://127.0.0.1:${address.port}/v1` }
    const model = { id: 'responses', remote_id: 'text-model', modality: 'text' as const, protocol: 'responses' as const,
      settings: { request_path: 'responses', text_paths: ['output_text', 'output.0.content.0.text'] } }
    const result = await generate(model, provider, { prompt: '剧本' }, [], 'responses', () => {})
    assert.equal(await readFile(result.path, 'utf8'), '{"outline":"完整剧本"}')
    await assert.rejects(generate(model, provider, { prompt: '剧本' }, [], 'responses', () => {}),
      /模型响应没有符合配置路径的文本/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('async video config saves external task ID and resumes without creating a duplicate', async () => {
  let created = 0
  const requests: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      created++
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ id: 'job-123' }))
    } else if (request.url === '/v1/tasks/job-123') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `http://127.0.0.1:${address.port}/result.mp4` } }))
    } else if (request.url === '/result.mp4') {
      response.setHeader('Content-Type', 'video/mp4')
      response.end(Buffer.from('mock video result'))
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    const provider = { adapter: 'http' as const, base_url: `http://127.0.0.1:${address.port}/v1` }
    const model = { id: 'video', remote_id: 'video-v1', modality: 'video' as const, settings: {
      create_path: 'tasks', get_path: 'tasks/{id}', id_path: 'id', status_path: 'status',
      result_path: 'content.video_url', poll_seconds: 0.001,
      request_template: { model: '{{model}}', content: '{{content}}', ratio: '{{ratio}}', duration: '{{duration}}', unused: '{{reference_video_url}}' },
      image_reference_template: { type: 'image_url', image_url: { url: '{{image}}' }, role: '{{role}}' },
      reference_roles: { first_frame: ['first_frame'] },
      content_template: [{ type: 'text', text: '{{prompt}}' }, '{{image_references}}', '{{video_references}}'],
      mode_variables: { first_frame: { ratio: 'adaptive' } },
    } }
    const reference = join(testData, 'video-reference.png')
    await writeFile(reference, imageBytes)
    let savedId = ''
    const result = await generate(model, provider, { prompt: '海边日落', mode: 'first_frame', ratio: '16:9', duration: 4 },
      [{ kind: 'image', path: reference }], 'testproject', (id) => { savedId = id })
    assert.equal(savedId, 'job-123')
    assert.equal(created, 1)
    assert.equal(requests[0]?.ratio, 'adaptive')
    assert.equal('unused' in (requests[0] ?? {}), false)
    assert.equal((requests[0]?.content as unknown[]).length, 2)
    assert.equal(await readFile(result.path, 'utf8'), 'mock video result')

    await rm(reference)
    await generate(model, provider, { prompt: '海边日落', _external_id: savedId }, [{ kind: 'image', path: reference }], 'testproject', () => {
      throw new Error('恢复任务不得重新创建')
    })
    assert.equal(created, 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('local image assets export to a playable MP4', async () => {
  const image = join(testData, 'export-image.png')
  await writeFile(image, imageBytes)
  const output = await render({ id: 'exportproject', ratio: '16:9' },
    [{ title: '画面 1', asset_id: 'export-image', in_ms: 0, out_ms: 1000, source_duration_ms: null }],
    { 'export-image': { kind: 'image', path: image } })
  const bytes = await readFile(output)
  assert.ok((await stat(output)).size > 1000)
  assert.equal(bytes.subarray(4, 8).toString(), 'ftyp')
})

test('Base64 image save failure states that no recovery URL exists', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    const model = { id: 'base64', remote_id: 'base64-image', modality: 'image' as const, settings: {
      request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' },
      image_base64_path: 'data.0.b64_json',
    } }
    const provider = { adapter: 'http' as const, base_url: `http://127.0.0.1:${address.port}/v1` }
    await assert.rejects(generate(model, provider, { prompt: '图片' }, [], '../invalid-project', () => {}),
      /Base64，但保存本地文件失败.*没有可恢复链接/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('legacy demo adapter rejects generation', async () => {
  await assert.rejects(generate({ id: 'legacy', remote_id: 'legacy', modality: 'image', settings: {} },
    { adapter: 'demo', base_url: 'local://demo' }, { prompt: '旧请求' }, [], 'exportproject', () => {}),
  /演示模型已停用/)
})
