import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-api-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp, startWorker } = await import('../src/app.js')
const { one, run, initDb, db } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
const stopWorker = startWorker()

after(async () => {
  stopWorker()
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

async function finished(projectId: string, jobId: string): Promise<{ status: string; result_asset_id: string | null; error: string | null }> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const detail = await call<{ jobs: Array<{ id: string; status: string; result_asset_id: string | null; error: string | null }> }>('GET', `/api/projects/${projectId}`)
    const job = detail.jobs.find(item => item.id === jobId)
    if (job?.status === 'succeeded' || job?.status === 'failed') return job
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`任务 ${jobId} 未在 45 秒内完成`)
}

test('configurable providers, project generation and MP4 export work end to end', async t => {
  assert.deepEqual(await call('GET', '/api/providers'), [])
  assert.deepEqual(await call('GET', '/api/models'), [])
  assert.equal(one('SELECT id FROM providers WHERE adapter=?', 'demo'), undefined)
  const provider = await call<{ id: string; has_key: boolean; base_url: string }>('POST', '/api/providers', {
    name: 'DeepSeek', adapter: 'http', base_url: 'https://api.deepseek.com/v1',
    auth_header: 'Authorization', auth_prefix: 'Bearer ', api_key: 'local-test-secret',
  })
  assert.equal(provider.has_key, true)
  assert.equal(JSON.stringify(provider).includes('local-test-secret'), false)
  const stored = one<{ key_ciphertext: string }>('SELECT key_ciphertext FROM providers WHERE id=?', provider.id)
  assert.ok(stored?.key_ciphertext)
  assert.equal(stored?.key_ciphertext.includes('local-test-secret'), false)
  const disabled = await call<{ enabled: boolean }>('PATCH', `/api/providers/${provider.id}`, { enabled: false })
  assert.equal(disabled.enabled, false)
  assert.equal((await call<Array<{ id: string; enabled: boolean }>>('GET', '/api/providers')).find(item => item.id === provider.id)?.enabled, false)
  const enabled = await call<{ enabled: boolean }>('PATCH', `/api/providers/${provider.id}`, { enabled: true })
  assert.equal(enabled.enabled, true)

  const model = await call<{ id: string; settings: Record<string, unknown> }>('POST', '/api/models', {
    provider_id: provider.id, name: 'DeepSeek Chat', remote_id: 'deepseek-chat',
    modality: 'text', protocol: 'chat_completions', settings: {
      request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
      text_path: 'choices.0.message.content',
    },
  })
  assert.equal(model.settings.request_path, 'chat/completions')
  const changed = await call<{ name: string }>('PATCH', `/api/models/${model.id}`, { name: 'DeepSeek Script' })
  assert.equal(changed.name, 'DeepSeek Script')

  const project = await call<{ id: string }>('POST', '/api/projects', { name: '雨夜列车', brief: '演示项目', ratio: '16:9' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '进站', prompt: '雨夜列车进入站台', duration: 1 })
  const editedProject = await call<{ brief: string; ratio: string }>('PATCH', `/api/projects/${project.id}`, { ratio: '9:16' })
  assert.equal(editedProject.brief, '演示项目')
  assert.equal(editedProject.ratio, '9:16')
  const editedShot = await call<{ prompt: string; duration: number }>('PATCH', `/api/shots/${shot.id}`, { title: '列车进站' })
  assert.equal(editedShot.prompt, '雨夜列车进入站台')
  assert.equal(editedShot.duration, 1)

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#d95741' } }).png().toBuffer()
  const imageApi = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise<void>(resolve => imageApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    imageApi.closeAllConnections()
    await new Promise<void>(resolve => imageApi.close(() => resolve()))
  })
  const address = imageApi.address()
  if (!address || typeof address === 'string') throw new Error('测试模型地址不可用')
  const imageProvider = await call<{ id: string }>('POST', '/api/providers', {
    name: '测试图片服务', base_url: `http://127.0.0.1:${address.port}/v1`,
  })
  const imageModel = await call<{ id: string }>('POST', '/api/models', {
    provider_id: imageProvider.id, name: '测试图片', remote_id: 'test-image',
    modality: 'image', protocol: 'image_generations', settings: {
      request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' },
      image_base64_path: 'data.0.b64_json', resolutions: ['1.5K'],
    },
  })
  const boundary = '----studio-test'
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="shot_id"\r\n\r\n${shot.id}\r\n--${boundary}--\r\n`),
  ])
  const upload = await app.inject({
    method: 'POST', url: `/api/projects/${project.id}/assets`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart,
  })
  assert.equal(upload.statusCode, 200, upload.body)
  assert.equal(upload.json<{ shot_id: string }>().shot_id, shot.id)

  const generation = {
    shot_id: shot.id, model_id: imageModel.id, prompt: '雨夜列车进入站台',
    mode: 'text', reference_asset_ids: [], resolution: '1.5K', duration: 4, ratio: '16:9',
  }
  await call('PATCH', `/api/providers/${imageProvider.id}`, { enabled: false })
  const unavailable = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate`, payload: generation })
  assert.equal(unavailable.statusCode, 422)
  await call('PATCH', `/api/providers/${imageProvider.id}`, { enabled: true })
  const job = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, generation)
  const generated = await finished(project.id, job.id)
  assert.equal(generated.status, 'succeeded', generated.error || '')
  assert.ok(generated.result_asset_id)
  await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: generated.result_asset_id })
  const exportJob = await call<{ id: string }>('POST', `/api/projects/${project.id}/export`)
  const exported = await finished(project.id, exportJob.id)
  assert.equal(exported.status, 'succeeded', exported.error || '')
  const file = one<{ path: string }>('SELECT path FROM assets WHERE id=?', exported.result_asset_id)
  assert.ok(file)
  assert.ok((await stat(file.path)).size > 1000)
  assert.equal((await readFile(file.path)).subarray(4, 8).toString(), 'ftyp')
})

test('legacy demo entries stay in history but cannot be listed or used', async () => {
  const timestamp = new Date().toISOString()
  run('INSERT INTO providers (id, name, adapter, base_url, created_at) VALUES (?, ?, ?, ?, ?)', 'demo', '本地演示', 'demo', 'local://demo', timestamp)
  run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'demo-image', 'demo', '演示图片', 'demo-image', 'image', 'image_generations', '{}')
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '历史项目' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '旧镜头' })
  const assetPath = join(testData, 'legacy.png')
  await writeFile(assetPath, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#31786c' } }).png().toBuffer())
  run("INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,model_id,prompt,remote_url,created_at) VALUES (?, ?, ?, 'image', ?, ?, 'generated', ?, ?, NULL, ?)",
    'legacy-asset', project.id, shot.id, 'legacy.png', assetPath, 'demo-image', '历史提示词', timestamp)
  run("INSERT INTO jobs VALUES (?, ?, ?, ?, 'generation', '{}', 'succeeded', NULL, ?, NULL, ?, ?)",
    'legacy-job', project.id, shot.id, 'demo-image', 'legacy-asset', timestamp, timestamp)
  run("INSERT INTO jobs VALUES (?, ?, ?, ?, 'generation', '{}', 'failed', NULL, NULL, ?, ?, ?)",
    'legacy-failed-job', project.id, shot.id, 'demo-image', '旧任务失败', timestamp, timestamp)
  initDb()
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/providers')).some(item => item.id === 'demo'), false)
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/models')).some(item => item.id === 'demo-image'), false)
  const detail = await call<{ jobs: Array<{ id: string; model_id: string | null }>; assets: Array<{ id: string; model_id: string | null }> }>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.jobs.find(item => item.id === 'legacy-job')?.model_id, 'demo-image')
  assert.equal(detail.assets.find(item => item.id === 'legacy-asset')?.model_id, 'demo-image')
  const blocked = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate`, payload: {
    shot_id: shot.id, model_id: 'demo-image', prompt: '再次生成',
  } })
  assert.equal(blocked.statusCode, 422)
  assert.equal((await app.inject({ method: 'POST', url: '/api/jobs/legacy-failed-job/retry' })).statusCode, 422)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/providers/demo' })).statusCode, 422)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/models/demo-image' })).statusCode, 422)
  assert.equal(one<{ id: string }>('SELECT id FROM jobs WHERE id=?', 'legacy-job')?.id, 'legacy-job')
  assert.equal((await app.inject({ method: 'POST', url: '/api/providers', payload: {
    name: '演示', adapter: 'demo', base_url: 'local://demo',
  } })).statusCode, 422)
})

test('unchanged legacy built-ins are archived while history and edited configurations are preserved', async () => {
  const timestamp = new Date().toISOString()
  const settings = JSON.stringify({
    request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' },
    text_paths: ['output_text', 'output.0.content.0.text'],
  })
  run('INSERT INTO providers (id, name, adapter, base_url, auth_header, auth_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'ark', '火山方舟（预设）', 'http', 'https://ark.cn-beijing.volces.com/api/v3', 'Authorization', 'Bearer ', timestamp)
  run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'ark-text', 'ark', 'Doubao Seed 2.1 Pro', 'doubao-seed-2-1-pro-260628', 'text', 'responses', settings)
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '已有任务' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '旧分镜' })
  run("INSERT INTO jobs VALUES (?, ?, ?, ?, 'generation', '{}', 'succeeded', NULL, NULL, NULL, ?, ?)",
    'ark-history-job', project.id, shot.id, 'ark-text', timestamp, timestamp)

  db.pragma('user_version = 1')
  initDb()
  assert.equal(one<{ archived: number }>('SELECT archived FROM providers WHERE id=?', 'ark')?.archived, 1)
  assert.equal(one<{ archived: number }>('SELECT archived FROM models WHERE id=?', 'ark-text')?.archived, 1)
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/providers')).some(item => item.id === 'ark'), false)
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/models')).some(item => item.id === 'ark-text'), false)
  const detail = await call<{ jobs: Array<{ id: string; model_id: string | null }> }>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.jobs.find(item => item.id === 'ark-history-job')?.model_id, 'ark-text')
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate`, payload: {
    shot_id: shot.id, model_id: 'ark-text', prompt: '再生成一次',
  } })).statusCode, 422)
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/models/ark-text', payload: { name: '新名称' } })).statusCode, 422)

  run('UPDATE providers SET archived=0 WHERE id=?', 'ark')
  run('UPDATE models SET archived=0, settings=? WHERE id=?', JSON.stringify({ ...JSON.parse(settings), text_path: 'custom.path' }), 'ark-text')
  db.pragma('user_version = 1')
  initDb()
  assert.equal(one<{ archived: number }>('SELECT archived FROM models WHERE id=?', 'ark-text')?.archived, 0)
  assert.equal(one<{ archived: number }>('SELECT archived FROM providers WHERE id=?', 'ark')?.archived, 0)
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/models')).some(item => item.id === 'ark-text'), true)

  run('UPDATE models SET settings=? WHERE id=?', settings, 'ark-text')
  run('UPDATE providers SET key_ciphertext=? WHERE id=?', 'user-configured-key', 'ark')
  db.pragma('user_version = 2')
  initDb()
  assert.equal(one<{ archived: number }>('SELECT archived FROM models WHERE id=?', 'ark-text')?.archived, 1)
  assert.equal(one<{ archived: number }>('SELECT archived FROM providers WHERE id=?', 'ark')?.archived, 0)
  assert.equal(Number(db.pragma('user_version', { simple: true })), 3)
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/providers')).some(item => item.id === 'ark'), true)
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/models')).some(item => item.id === 'ark-text'), false)

  run('UPDATE models SET archived=0 WHERE id=?', 'ark-text')
  run('UPDATE providers SET key_ciphertext=NULL, base_url=? WHERE id=?', 'https://custom.example.com/v1', 'ark')
  db.pragma('user_version = 2')
  initDb()
  assert.equal(one<{ archived: number }>('SELECT archived FROM models WHERE id=?', 'ark-text')?.archived, 1)
  assert.equal(one<{ archived: number }>('SELECT archived FROM providers WHERE id=?', 'ark')?.archived, 0)
})

test('configured model catalog previews and imports without overwriting existing models', async t => {
  const requests: Array<{ url: string | undefined; auth: string | undefined }> = []
  const catalogApi = createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers['x-api-key'] as string | undefined })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ result: { entries: [
      { key: 'manual-text', label: '远端新名称', kind: 'text' },
      { key: 'image-v1', label: '图片模型', kind: 'image' },
      { key: 'image-v1', label: '重复图片', kind: 'image' },
      { key: 'video-v1', kind: 'video' },
      { key: 'unknown-v1', kind: 'other' },
    ] } }))
  })
  await new Promise<void>(resolve => catalogApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    catalogApi.closeAllConnections()
    await new Promise<void>(resolve => catalogApi.close(() => resolve()))
  })
  const address = catalogApi.address()
  if (!address || typeof address === 'string') throw new Error('测试目录地址不可用')
  const provider = await call<{ id: string; model_catalog: { path: string } }>('POST', '/api/providers', {
    name: '目录测试', base_url: `http://127.0.0.1:${address.port}/v1`,
    auth_header: 'X-API-Key', auth_prefix: '', api_key: 'catalog-secret',
    model_catalog: { path: 'catalog/list', list_path: 'result.entries', id_path: 'key', name_path: 'label', modality_path: 'kind' },
  })
  assert.equal(provider.model_catalog.path, 'catalog/list')
  const originalSettings = { request_path: 'chat/completions', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, text_path: 'output.text' }
  const original = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, remote_id: 'manual-text', name: '手动模型', modality: 'text',
    protocol: 'chat_completions', settings: originalSettings,
  })
  const preview = await call<{ models: Array<{ remote_id: string; name: string; modality_hint: string | null; existing: boolean }>; total: number }>('GET', `/api/providers/${provider.id}/model-catalog`)
  assert.equal(preview.total, 4)
  assert.deepEqual(preview.models.map(model => [model.remote_id, model.modality_hint, model.existing]), [
    ['manual-text', 'text', true], ['image-v1', 'image', false], ['video-v1', 'video', false], ['unknown-v1', null, false],
  ])
  assert.equal(preview.models[2]?.name, 'video-v1')
  assert.deepEqual(requests, [{ url: '/v1/catalog/list', auth: 'catalog-secret' }])
  assert.equal((await call<Array<{ id: string }>>('GET', '/api/models')).filter(model => model.id === original.id).length, 1)

  const imported = await call<{ imported: Array<{ id: string; remote_id: string; enabled: boolean; settings: Record<string, unknown> }>; skipped: Array<{ remote_id: string; reason: string }> }>(
    'POST', `/api/providers/${provider.id}/model-catalog/import`, { models: [
      { remote_id: 'manual-text', name: '不得覆盖', modality: 'text', protocol: 'responses' },
      { remote_id: 'image-v1', name: '图片模型', modality: 'image', protocol: 'image_generations' },
      { remote_id: 'image-v1', name: '重复图片', modality: 'image', protocol: 'image_generations' },
    ] },
  )
  assert.deepEqual(imported.skipped, [
    { remote_id: 'manual-text', reason: 'existing' }, { remote_id: 'image-v1', reason: 'duplicate' },
  ])
  assert.equal(imported.imported.length, 1)
  assert.equal(imported.imported[0]?.enabled, false)
  assert.deepEqual(imported.imported[0]?.settings, {})
  assert.equal(requests.length, 1)
  const longRemoteId = `model-${'x'.repeat(260)}`
  const longIdImport = await call<{ imported: Array<{ remote_id: string }> }>(
    'POST', `/api/providers/${provider.id}/model-catalog/import`, { models: [
      { remote_id: longRemoteId, name: '长模型 ID', modality: 'text', protocol: 'responses' },
    ] },
  )
  assert.equal(longIdImport.imported[0]?.remote_id, longRemoteId)
  const originalAfter = await call<Array<{ id: string; name: string; settings: Record<string, unknown> }>>('GET', '/api/models')
  assert.equal(originalAfter.find(model => model.id === original.id)?.name, '手动模型')
  assert.deepEqual(originalAfter.find(model => model.id === original.id)?.settings, originalSettings)
  const importedId = imported.imported[0]?.id
  assert.ok(importedId)
  const renamed = await call<{ name: string }>('PATCH', `/api/models/${importedId}`, { name: '已检查图片模型' })
  assert.equal(renamed.name, '已检查图片模型')
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/models/${importedId}`, payload: { enabled: true } })).statusCode, 422)
  const configured = await call<{ enabled: boolean }>('PATCH', `/api/models/${importedId}`, {
    settings: { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, image_url_path: 'data.0.url' },
    enabled: true,
  })
  assert.equal(configured.enabled, true)

  await call('PATCH', `/api/providers/${provider.id}`, { model_catalog: { path: '../models' } })
  assert.equal((await app.inject({ method: 'GET', url: `/api/providers/${provider.id}/model-catalog` })).statusCode, 422)
  assert.equal(requests.length, 1)
})

test('model catalog errors identify website pages, redirects, and wrong API paths', async t => {
  const catalogApi = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<html><body>Website</body></html>')
    } else if (request.url === '/v1/redirect') {
      response.writeHead(302, { Location: '/v1/models' })
      response.end()
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>(resolve => catalogApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    catalogApi.closeAllConnections()
    await new Promise<void>(resolve => catalogApi.close(() => resolve()))
  })
  const address = catalogApi.address()
  if (!address || typeof address === 'string') throw new Error('测试目录地址不可用')
  const provider = await call<{ id: string }>('POST', '/api/providers', {
    name: '错误提示测试', base_url: `http://127.0.0.1:${address.port}/v1`,
  })
  const catalogUrl = `/api/providers/${provider.id}/model-catalog`
  const website = await app.inject({ method: 'GET', url: catalogUrl })
  assert.equal(website.statusCode, 502)
  assert.match(website.body, /返回网页而非 JSON/)
  assert.match(website.body, /\/v1\/models/)

  await call('PATCH', `/api/providers/${provider.id}`, { model_catalog: { path: 'redirect' } })
  const redirect = await app.inject({ method: 'GET', url: catalogUrl })
  assert.equal(redirect.statusCode, 422)
  assert.match(redirect.body, /HTTP 302 跳转/)

  await call('PATCH', `/api/providers/${provider.id}`, { model_catalog: { path: 'missing' } })
  const missing = await app.inject({ method: 'GET', url: catalogUrl })
  assert.equal(missing.statusCode, 502)
  assert.match(missing.body, /HTTP 404/)
  assert.match(missing.body, /API 地址是否为接口根地址/)
})

test('failed image download resumes from an encrypted URL without generating again', async t => {
  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#cc5544' } }).png().toBuffer()
  const signature = 'private-signed-image-token'
  let generationCalls = 0
  let downloadCalls = 0
  let disconnectDownload = true
  const imageApi = createServer((request, response) => {
    const address = imageApi.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
    if (request.url === '/v1/images/generations') {
      generationCalls++
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${address.port}/result.png?signature=${signature}` }] }))
    } else if (request.url === `/result.png?signature=${signature}`) {
      downloadCalls++
      if (disconnectDownload) request.socket.destroy()
      else { response.setHeader('Content-Type', 'image/png'); response.end(png) }
    } else response.writeHead(404).end()
  })
  await new Promise<void>(resolve => imageApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    imageApi.closeAllConnections()
    await new Promise<void>(resolve => imageApi.close(() => resolve()))
  })
  const address = imageApi.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  const provider = await call<{ id: string }>('POST', '/api/providers', {
    name: '图片恢复测试', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'private-api-key',
  })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '图片恢复模型', remote_id: 'image-test', modality: 'image', protocol: 'image_generations',
    settings: { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, image_url_path: 'data.0.url' },
  })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '图片恢复项目' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '测试镜头' })
  const job = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, {
    shot_id: shot.id, model_id: model.id, prompt: '测试图片',
  })
  const failed = await finished(project.id, job.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error || '', /阶段：结果图片下载/)
  assert.match(failed.error || '', /错误码：[A-Z0-9_]+/)
  assert.match(failed.error || '', /耗时：\d+\.\d 秒/)
  assert.equal(generationCalls, 1)
  assert.equal(downloadCalls, 1)
  const saved = one<{ result_url_ciphertext: string }>('SELECT result_url_ciphertext FROM job_image_recovery WHERE job_id=?', job.id)
  assert.ok(saved?.result_url_ciphertext)
  assert.equal(saved.result_url_ciphertext.includes(signature), false)
  initDb()
  const detail = await call<{ jobs: Array<{ id: string; recovery_available: boolean }>; assets: unknown[] }>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.jobs.find(item => item.id === job.id)?.recovery_available, true)
  assert.equal(JSON.stringify(detail).includes(signature), false)
  assert.equal(JSON.stringify(detail).includes('private-api-key'), false)

  disconnectDownload = false
  await call('POST', `/api/jobs/${job.id}/retry`)
  const completed = await finished(project.id, job.id)
  assert.equal(completed.status, 'succeeded')
  assert.ok(completed.result_asset_id)
  assert.equal(generationCalls, 1)
  assert.equal(downloadCalls, 2)
  assert.equal(one('SELECT 1 FROM job_image_recovery WHERE job_id=?', job.id), undefined)
  const result = await call<{ assets: Array<{ id: string; remote_url: string | null }> }>('GET', `/api/projects/${project.id}`)
  assert.equal(result.assets.find(asset => asset.id === completed.result_asset_id)?.remote_url, null)
  assert.equal(one<{ remote_url: string | null }>('SELECT remote_url FROM assets WHERE id=?', completed.result_asset_id)?.remote_url, null)
  assert.equal(JSON.stringify(result).includes(signature), false)

  disconnectDownload = true
  const restartJob = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, {
    shot_id: shot.id, model_id: model.id, prompt: '重启恢复测试',
  })
  assert.equal((await finished(project.id, restartJob.id)).status, 'failed')
  assert.equal(generationCalls, 2)
  run("UPDATE jobs SET status='running' WHERE id=?", restartJob.id)
  disconnectDownload = false
  initDb()
  const restarted = await finished(project.id, restartJob.id)
  assert.equal(restarted.status, 'succeeded')
  assert.equal(generationCalls, 2)
  assert.equal(downloadCalls, 4)
  assert.equal(one('SELECT 1 FROM job_image_recovery WHERE job_id=?', restartJob.id), undefined)
})

test('image request disconnect is diagnosed and cannot be retried automatically', async t => {
  let generationCalls = 0
  const imageApi = createServer((request) => {
    generationCalls++
    request.socket.destroy()
  })
  await new Promise<void>(resolve => imageApi.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    imageApi.closeAllConnections()
    await new Promise<void>(resolve => imageApi.close(() => resolve()))
  })
  const address = imageApi.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用')
  const provider = await call<{ id: string }>('POST', '/api/providers', {
    name: '图片断线测试', base_url: `http://127.0.0.1:${address.port}/v1`,
  })
  const model = await call<{ id: string }>('POST', '/api/models', {
    provider_id: provider.id, name: '图片断线模型', remote_id: 'image-disconnect', modality: 'image', protocol: 'image_generations',
    settings: { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, image_url_path: 'data.0.url' },
  })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '图片断线项目' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '测试镜头' })
  const job = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, {
    shot_id: shot.id, model_id: model.id, prompt: '测试图片',
  })
  const failed = await finished(project.id, job.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error || '', /阶段：厂商请求/)
  assert.match(failed.error || '', /错误码：[A-Z0-9_]+/)
  assert.match(failed.error || '', /耗时：\d+\.\d 秒/)
  assert.equal(one('SELECT 1 FROM job_image_recovery WHERE job_id=?', job.id), undefined)
  const retry = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` })
  assert.equal(retry.statusCode, 422)
  assert.match(retry.body, /先核对厂商记录/)
  run("UPDATE jobs SET status='running', error=NULL WHERE id=?", job.id)
  initDb()
  const interrupted = one<{ status: string; error: string | null }>('SELECT status, error FROM jobs WHERE id=?', job.id)
  assert.equal(interrupted?.status, 'failed')
  assert.match(interrupted?.error || '', /未找到可恢复图片链接/)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(generationCalls, 1)
})
