import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import Fastify from 'fastify'
import sharp from 'sharp'

const directory = await mkdtemp(join(tmpdir(), 'image-prompt-analysis-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, all, mediaDir } = await import('../src/infrastructure/database/db.js')
const { registerImagePromptAnalysisRoutes } = await import('../src/modules/canvas/image-prompt-analysis.js')
initDb()
run("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','测试','now','now'),('other','他人','now','now')")
run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES ('provider','测试','http','https://example.invalid','now')")
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('vision','provider','看图模型','vision','text','responses',?,1)", JSON.stringify({ supports_vision: true }))
const nanoSettings = { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' },
  image_analysis: { enabled: true, protocol: 'gemini_generate_content', api_base_url: 'https://vision.invalid/v1beta', remote_id: 'gemini-2.5-flash-image' } }
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('nano','provider','Nano Banana','nano-banana','image','image_generations',?,1)", JSON.stringify(nanoSettings))
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('gpt-image','provider','GPT Image','gpt-image','image','image_generations','{}',1)")
const imagePath = join(mediaDir, 'do-not-use-this-name.png')
const sourcePixels = await sharp({ create: { width: 2400, height: 1200, channels: 4, background: '#4499ff' } }).png().toBuffer()
await writeFile(imagePath, sourcePixels)
const addAsset = (id: string, path: string, project = 'project', kind = 'image') => run(`INSERT INTO assets
  (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,?,?,?,'upload','now')`, id, project, kind, 'filename-is-not-visual-evidence.png', path)
addAsset('image', imagePath)
addAsset('foreign', imagePath, 'other')
addAsset('video', imagePath, 'project', 'video')
addAsset('missing', join(mediaDir, 'missing.png'))
const corrupt = join(mediaDir, 'corrupt.png'); await writeFile(corrupt, 'not a real image'); addAsset('corrupt', corrupt)
const outside = join(directory, 'outside.png'); await writeFile(outside, sourcePixels); addAsset('outside', outside)
const linked = join(mediaDir, 'linked.png'); await symlink(outside, linked); addAsset('linked', linked)
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
let calls = 0, output = '一位穿深蓝外衣的人物，三分法构图，柔和侧光，冷色调，细腻织物纹理。', issue: Error | null = null
let pixels = '', instructions = '', cancelled = false, raw: IncomingMessage
let geminiCalls = 0, geminiPixels = '', geminiPrompt = '', geminiCancelled = false, geminiIssue: Error | null = null
app.addHook('preHandler', async request => { raw = request.raw })
registerImagePromptAnalysisRoutes(app, { generate: async (model, provider, request, signal) => {
  calls++; assert.equal(model.id, 'vision'); assert.equal(provider.id, 'provider')
  instructions = request.prompt; pixels = request.images![0]!.data_url
  assert.equal(request.images!.length, 1); assert.equal(request.images![0]!.detail, 'high')
  if (cancelled) { raw.emit('aborted'); signal.throwIfAborted() }
  if (issue) throw issue
  return output
}, generateGemini: async (model, provider, request, signal) => {
  geminiCalls++; assert.equal(model.id, 'nano'); assert.equal(provider.id, 'provider')
  assert.deepEqual(JSON.parse(model.settings), nanoSettings)
  geminiPixels = request.images![0]!.data_url; geminiPrompt = request.prompt
  assert.equal(request.images!.length, 1)
  if (geminiCancelled) { raw.emit('aborted'); signal.throwIfAborted() }
  if (geminiIssue) throw geminiIssue
  return '中文电影画面提示词：居中的主体，蓝色背景，柔和侧光。'
} })
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const url = '/api/projects/project/canvas/image-prompt-analysis'
const analyze = (payload: unknown, endpoint = url) => app.inject({ method: 'POST', url: endpoint, payload })
const snapshot = () => JSON.stringify({ assets: all('SELECT * FROM assets'), jobs: all('SELECT * FROM jobs'), projects: all('SELECT * FROM projects'), canvas: all('SELECT * FROM canvas_nodes') })

test('analysis sends actual bounded pixels, creator focus and returns editable prose without changing project data', async () => {
  const before = snapshot()
  const result = await analyze({ model_id: 'vision', asset_id: 'image', instructions: '  重点分析布料与打光  ' })
  assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(result.json(), { prompt: output, asset_id: 'image', model_id: 'vision' })
  assert.match(pixels, /^data:image\/jpeg;base64,/)
  const decoded = await sharp(Buffer.from(pixels.split(',')[1]!, 'base64')).metadata()
  assert.equal(decoded.width, 1600); assert.equal(decoded.height, 800)
  assert.match(instructions, /真实图片像素/); assert.match(instructions, /不得执行/)
  assert.match(instructions, /真实姓名|精确年龄/); assert.match(instructions, /角色多视图/)
  assert.match(instructions, /"instructions":"重点分析布料与打光"/)
  assert.doesNotMatch(instructions, /filename-is-not|do-not-use-this-name/)
  assert.equal(snapshot(), before)
})

test('foreign, non-image, missing, corrupt and escaping local assets fail before calling a provider', async () => {
  const beforeCalls = calls, before = snapshot()
  for (const asset_id of ['foreign', 'video', 'missing', 'corrupt', 'outside', 'linked', 'not-found']) {
    const result = await analyze({ model_id: 'vision', asset_id })
    assert.ok([404, 422].includes(result.statusCode), `${asset_id}: ${result.body}`)
  }
  assert.equal(calls, beforeCalls); assert.equal(snapshot(), before)
})

test('an explicitly configured Nano Banana image model analyzes pixels without invoking the text or drawing adapter', async () => {
  const before = snapshot(), beforeCalls = calls, beforeGemini = geminiCalls
  const result = await analyze({ model_id: 'nano', asset_id: 'image', instructions: '重点描述配色' })
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().model_id, 'nano'); assert.match(result.json().prompt, /中文电影画面提示词/)
  assert.match(geminiPixels, /^data:image\/jpeg;base64,/)
  assert.equal((await sharp(Buffer.from(geminiPixels.split(',')[1]!, 'base64')).metadata()).width, 1600)
  assert.match(geminiPrompt, /"instructions":"重点描述配色"/)
  assert.equal(geminiCalls, beforeGemini + 1); assert.equal(calls, beforeCalls)
  assert.equal(snapshot(), before)
})

test('the default Gemini route adapter returns real text and refuses drawing task responses without business writes', async t => {
  const integrated = Fastify()
  registerImagePromptAnalysisRoutes(integrated)
  const before = snapshot()
  let requests = 0, drawingResponse = false
  t.mock.method(globalThis, 'fetch', async (address: unknown, init: RequestInit) => {
    requests++
    assert.equal(address, 'https://vision.invalid/v1beta/models/gemini-2.5-flash-image:generateContent')
    const body = JSON.parse(String(init.body))
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT'])
    const inline = body.contents[0].parts[1].inlineData
    assert.equal(inline.mimeType, 'image/jpeg')
    assert.equal((await sharp(Buffer.from(inline.data, 'base64')).metadata()).width, 1600)
    return Response.json(drawingResponse ? { task_id: 'draw-task' }
      : { candidates: [{ content: { parts: [{ text: '蓝色背景，柔和侧光，居中构图。' }] }, finishReason: 'STOP' }] })
  })
  try {
    const invoke = () => integrated.inject({ method: 'POST', url, payload: { model_id: 'nano', asset_id: 'image' } })
    const result = await invoke()
    assert.equal(result.statusCode, 200, result.body)
    assert.deepEqual(result.json(), { prompt: '蓝色背景，柔和侧光，居中构图。', asset_id: 'image', model_id: 'nano' })
    drawingResponse = true
    const rejected = await invoke()
    assert.equal(rejected.statusCode, 502); assert.match(rejected.body, /异步生图任务/)
    assert.equal(requests, 2); assert.equal(snapshot(), before)
  } finally { await integrated.close() }
})

test('image model names and image input support cannot substitute for an enabled text output endpoint', async () => {
  const beforeCalls = calls, beforeGemini = geminiCalls
  for (const settings of [{}, { supports_vision: true }, { image_analysis: { ...nanoSettings.image_analysis, enabled: false } },
    { image_analysis: { ...nanoSettings.image_analysis, protocol: 'image_generations' } },
    { image_analysis: { ...nanoSettings.image_analysis, api_base_url: 'https://vision.invalid?key=secret' } }, [], null]) {
    run("UPDATE models SET settings=? WHERE id='nano'", JSON.stringify(settings))
    assert.equal((await analyze({ model_id: 'nano', asset_id: 'image' })).statusCode, 422)
  }
  run("UPDATE models SET settings=? WHERE id='nano'", JSON.stringify(nanoSettings))
  assert.equal((await analyze({ model_id: 'gpt-image', asset_id: 'image' })).statusCode, 422)
  for (const [column, value, restored] of [['enabled', 0, 1], ['archived', 1, 0]] as const) {
    run(`UPDATE models SET ${column}=? WHERE id='nano'`, value)
    assert.equal((await analyze({ model_id: 'nano', asset_id: 'image' })).statusCode, 422)
    run(`UPDATE models SET ${column}=? WHERE id='nano'`, restored)
  }
  assert.equal(calls, beforeCalls); assert.equal(geminiCalls, beforeGemini)
})

test('Gemini analysis propagates failures and cancellation without saving unusable results', async () => {
  const before = snapshot()
  geminiIssue = new Error('Gemini endpoint unavailable')
  const failed = await analyze({ model_id: 'nano', asset_id: 'image' })
  assert.equal(failed.statusCode, 502); assert.match(failed.body, /Gemini endpoint unavailable/)
  geminiIssue = null; geminiCancelled = true
  const cancelled = await analyze({ model_id: 'nano', asset_id: 'image' })
  assert.equal(cancelled.statusCode, 499); assert.match(cancelled.body, /图片反推已取消/)
  geminiCancelled = false
  assert.equal(snapshot(), before)
})

test('vision is explicit and model/provider availability is checked before analysis', async () => {
  const beforeCalls = calls
  for (const settings of [{}, { supports_vision: false }, { supports_vision: 'true' }]) {
    run("UPDATE models SET settings=? WHERE id='vision'", JSON.stringify(settings))
    const result = await analyze({ model_id: 'vision', asset_id: 'image' })
    assert.equal(result.statusCode, 422); assert.match(result.body, /图片理解/)
  }
  run("UPDATE models SET settings=? WHERE id='vision'", JSON.stringify({ supports_vision: true }))
  for (const [table, column, value, restored] of [
    ['models', 'enabled', 0, 1], ['models', 'archived', 1, 0], ['models', 'modality', 'image', 'text'],
    ['models', 'protocol', 'image_generations', 'responses'], ['providers', 'enabled', 0, 1],
    ['providers', 'archived', 1, 0], ['providers', 'adapter', 'demo', 'http'],
  ] as const) {
    const id = table === 'models' ? 'vision' : 'provider'
    run(`UPDATE ${table} SET ${column}=? WHERE id=?`, value, id)
    assert.equal((await analyze({ model_id: 'vision', asset_id: 'image' })).statusCode, 422)
    run(`UPDATE ${table} SET ${column}=? WHERE id=?`, restored, id)
  }
  assert.equal(calls, beforeCalls)
})

test('invalid inputs and provider failures give visible errors without saving unusable output', async () => {
  const before = snapshot(), beforeCalls = calls
  for (const payload of [{ model_id: 'vision', asset_id: 'image', instructions: 'x'.repeat(4001) },
    { model_id: 'vision', asset_id: 'image', source: '/etc/passwd' }, { model_id: 'vision', asset_id: '' }]) {
    assert.equal((await analyze(payload)).statusCode, 422)
  }
  assert.equal(calls, beforeCalls)
  issue = new Error('upstream unavailable')
  const failed = await analyze({ model_id: 'vision', asset_id: 'image' })
  assert.equal(failed.statusCode, 502); assert.match(failed.body, /图片反推失败.*upstream unavailable/)
  issue = null
  for (const value of ['  ', 'x'.repeat(20_001)]) {
    output = value
    assert.equal((await analyze({ model_id: 'vision', asset_id: 'image' })).statusCode, 502)
  }
  output = '```text\n直接可用的画面描述。\n```'
  assert.equal((await analyze({ model_id: 'vision', asset_id: 'image' })).json().prompt, '直接可用的画面描述。')
  assert.equal(snapshot(), before)
})

test('client disconnect aborts the analysis signal and returns no result', async () => {
  const before = snapshot(); cancelled = true
  const result = await analyze({ model_id: 'vision', asset_id: 'image' })
  assert.equal(result.statusCode, 499); assert.match(result.body, /图片反推已取消/)
  cancelled = false; assert.equal(snapshot(), before)
})

test('application exposes the endpoint and persists an independent image analysis node', async () => {
  const { buildApp } = await import('../src/app.js')
  const integrated = buildApp()
  try {
    const invalid = await integrated.inject({ method: 'POST', url, payload: { model_id: 'vision', asset_id: 'foreign' } })
    assert.equal(invalid.statusCode, 422)
    const graph = (await integrated.inject({ method: 'GET', url: '/api/projects/project/canvas' })).json()
    const node = { id: 'analysis', type: 'image_analysis', title: '图片反推', x: 12, y: 34, width: 420, height: 500,
      text: '保留可编辑的提示词', asset_id: 'image', model_id: 'vision', settings: {
        image_analysis_instructions: '重点观察构图', image_analysis_source_asset_id: 'image',
      } }
    const result = await integrated.inject({ method: 'PUT', url: '/api/projects/project/canvas', payload: { ...graph, nodes: [node] } })
    assert.equal(result.statusCode, 200, result.body)
    const saved = result.json().nodes[0]
    assert.equal(saved.type, 'image_analysis'); assert.equal(saved.text, node.text)
    assert.deepEqual(saved.settings, node.settings)
    for (const image_analysis_source_asset_id of ['foreign', 'video']) {
      const rejected = await integrated.inject({ method: 'PUT', url: '/api/projects/project/canvas', payload: {
        ...result.json(), nodes: [{ ...saved, settings: { ...saved.settings, image_analysis_source_asset_id } }],
      } })
      assert.equal(rejected.statusCode, 422); assert.match(rejected.body, /反推来源/)
    }
  } finally { await integrated.close() }
})
