import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import { seedance2VideoSettings, seedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { normalizeSeedance25Request } from '@video-studio/shared/media/seedance25-request'

const testData = await mkdtemp(join(tmpdir(), 'seedance25-provider-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { generate, validateVideoReferenceRequest } = await import('../src/infrastructure/providers/providers.js')
const { buildApp } = await import('../src/app.js')
const { db, run, now } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
const imagePath = join(testData, 'reference.png')
await sharp({ create: { width: 300, height: 400, channels: 3, background: '#447766' } }).png().toFile(imagePath)
const image = { kind: 'image' as const, path: imagePath }
const provider = { adapter: 'http' as const, base_url: 'https://video.invalid/api/v3' }
const model = (settings: Record<string, unknown> = seedance25VideoSettings()) => ({ id: 'seedance25', remote_id: 'doubao-seedance-2-5-260628', modality: 'video' as const, settings: { ...settings, poll_seconds: 0.001 } })
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

test('Seedance 2.5 sends the official contract for all supported modes and keeps audio selections', async t => {
  const submissions: Array<Record<string, any>> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { submissions.push(JSON.parse(String(init.body))); return Response.json({ id: 'task-25' }) }
    if (String(url).includes('/tasks/')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.invalid/result.mp4' } })
    return new Response('mock video result')
  })
  for (const mode of ['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend'] as const) {
    const references = mode === 'text' ? [] : mode === 'first_last_frame' ? [image, image] : [image]
    const reference_video_url = ['reference', 'edit', 'extend'].includes(mode) ? 'asset://reference-video-25' : undefined
    const result = await generate(model(), provider, { prompt: '保持人物一致，连续转身。', mode, ratio: '9:16', resolution: '1080p', duration: 30, generate_audio: false, reference_video_url }, references, 'fixture', () => {})
    assert.equal(await readFile(result.path, 'utf8'), 'mock video result')
    const payload = submissions.at(-1)!
    assert.equal(payload.model, 'doubao-seedance-2-5-260628')
    assert.equal(payload.ratio, ['text', 'reference'].includes(mode) ? '9:16' : 'adaptive')
    assert.equal(payload.resolution, '1080p')
    assert.equal(payload.duration, mode === 'edit' ? -1 : 30)
    assert.equal(payload.generate_audio, false)
    assert.equal('draft' in payload, false)
    assert.equal(payload.omni_reference_task_type, ['reference', 'edit', 'extend'].includes(mode) ? mode : undefined)
    const content = payload.content as Array<Record<string, any>>
    assert.equal(content[0]!.type, 'text')
    assert.deepEqual(content.filter(item => item.type === 'image_url').map(item => item.role), mode === 'first_frame' ? ['first_frame'] : mode === 'first_last_frame' ? ['first_frame', 'last_frame'] : references.map(() => 'reference_image'))
    if (reference_video_url) assert.deepEqual(content.at(-1), { type: 'video_url', video_url: { url: reference_video_url }, role: 'reference_video' })
  }
  assert.equal(submissions.length, 6)
})

test('Seedance 2.5 mandatory dimensions and draft resolution override stale mode defaults', async t => {
  let payload: Record<string, unknown> = {}
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { payload = JSON.parse(String(init.body)); return Response.json({ id: 'draft-25' }) }
    if (String(url).includes('/tasks/')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.invalid/draft.mp4' } })
    return new Response('draft video')
  })
  const settings = { ...seedance25VideoSettings(), mode_variables: { edit: { ratio: '16:9', duration: 5, omni_reference_task_type: 'auto' } }, draft_variables: { resolution: '1080p' } }
  await generate(model(settings), provider, { prompt: '编辑原片', mode: 'edit', duration: 20, ratio: '9:16', resolution: '720p', draft: true, reference_video_url: 'https://media.invalid/source.mov' }, [], 'fixture', () => {})
  assert.equal(payload.ratio, 'adaptive')
  assert.equal(payload.duration, -1)
  assert.equal(payload.omni_reference_task_type, 'edit')
  assert.equal(payload.resolution, '480p')
  assert.equal(payload.draft, true)
})

test('Seedance 2.5 preflight rejects unsupported parameters, dropped video and malformed templates before a network request', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not call network') })
  const settings = seedance25VideoSettings()
  const cleanedTextParameters = await validateVideoReferenceRequest({ ...settings, mode_variables: { text: { omni_reference_task_type: 'auto' } } }, [], { prompt: '动作', mode: 'text' }, 'configured')
  assert.equal(cleanedTextParameters?.omni_reference_task_type, undefined)
  const cases = [
    { request: { prompt: '动作', mode: 'text' as const, resolution: '4k' }, pattern: /仅支持 480p/ },
    { request: { prompt: '动作', mode: 'text' as const, duration: 31 }, pattern: /4 到 30/ },
    { request: { prompt: '动作', mode: 'first_frame' as const, reference_video_url: 'https://media.invalid/source.mp4' }, pattern: /互斥/, references: [image] },
    { request: { prompt: '动作', mode: 'edit' as const }, pattern: /需要参考视频/ },
    { request: { prompt: '动作', mode: 'reference' as const }, pattern: /参考模式需要/ },
    { request: { prompt: '动作', mode: 'reference' as const, reference_video_url: 'file:///tmp/source.mp4' }, pattern: /不支持 file/ },
  ]
  for (const item of cases) await assert.rejects(generate(model(), provider, item.request, item.references ?? [], 'fixture', () => {}), item.pattern)
  const dropped = { ...settings, video_reference_template: undefined }
  await assert.rejects(validateVideoReferenceRequest(dropped, [], { prompt: '动作', mode: 'reference', reference_video_url: 'asset://source' }, 'configured'), /未传递参考视频/)
  const wrongTaskType = { ...settings, request_templates: { edit: { model: '{{model}}', content: '{{content}}', ratio: '{{ratio}}', duration: '{{duration}}', resolution: '{{resolution}}', omni_reference_task_type: 'auto' } } }
  await assert.rejects(validateVideoReferenceRequest(wrongTaskType, [], { prompt: '动作', mode: 'edit', reference_video_url: 'asset://source' }, 'configured'), /正确传递 omni_reference_task_type/)
  const duplicatedContent = { ...settings, content_template: [{ type: 'text', text: '{{prompt}}' }, '{{image_references}}', '{{image_references}}'] }
  await assert.rejects(validateVideoReferenceRequest(duplicatedContent, [image], { prompt: '动作', mode: 'first_frame' }, 'configured'), /正确角色传递全部参考图片/)
  const imagesOutsideContent = { ...settings, request_template: { ...(settings.request_template as Record<string, unknown>), image_references: '{{image_references}}', content: [] } }
  await assert.rejects(validateVideoReferenceRequest(imagesOutsideContent, [image], { prompt: '动作', mode: 'first_frame' }, 'configured'), /正确角色传递全部参考图片/)
  const wrongRenderedRole = { ...settings, image_reference_template: { ...(settings.image_reference_template as Record<string, unknown>), role: 'wrong-{{role}}' } }
  await assert.rejects(validateVideoReferenceRequest(wrongRenderedRole, [image], { prompt: '动作', mode: 'first_frame' }, 'configured'), /正确角色传递全部参考图片/)
  const missingAudio = { ...settings, request_template: { ...(settings.request_template as Record<string, unknown>), generate_audio: undefined } }
  await assert.rejects(validateVideoReferenceRequest(missingAudio, [], { prompt: '动作', mode: 'text', generate_audio: false }, 'configured'), /正确传递 generate_audio/)
  const forcedDraft = { ...settings, request_template: { ...(settings.request_template as Record<string, unknown>), draft: true } }
  await assert.rejects(validateVideoReferenceRequest(forcedDraft, [], { prompt: '动作', mode: 'text', draft: false }, 'configured'), /关闭样片时启用 draft/)
  assert.equal(requests, 0)
})

test('Seedance 2.5 preserves disabled audio and draft against stale mode overrides', async t => {
  let payload: Record<string, unknown> = {}
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { payload = JSON.parse(String(init.body)); return Response.json({ id: 'audio-selection-25' }) }
    if (String(url).includes('/tasks/')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.invalid/silent.mp4' } })
    return new Response('silent final video')
  })
  const settings = { ...seedance25VideoSettings(), mode_variables: { text: { generate_audio: true, draft: true } } }
  await generate(model(settings), provider, { prompt: '无声街景', mode: 'text', generate_audio: false, draft: false, resolution: '1080p' }, [], 'fixture', () => {})
  assert.equal(payload.generate_audio, false)
  assert.equal('draft' in payload, false)
  assert.equal(payload.resolution, '1080p')
})

test('Seedance 2.5 media preflight validates decoded formats and the exact encoded request budget', async () => {
  const small = join(testData, 'small.png')
  await sharp({ create: { width: 299, height: 400, channels: 3, background: '#447766' } }).png().toFile(small)
  await assert.rejects(validateVideoReferenceRequest(seedance25VideoSettings(), [{ kind: 'image', path: small }], { prompt: '动作', mode: 'first_frame' }, 'configured'), /300 到 6000/)
  const svg = join(testData, 'unsupported.png')
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"></svg>')
  await assert.rejects(validateVideoReferenceRequest(seedance25VideoSettings(), [{ kind: 'image', path: svg }], { prompt: '动作', mode: 'first_frame' }, 'configured'), /图片格式/)
  const large = join(testData, 'large.png')
  const bytes = await readFile(imagePath)
  await writeFile(large, Buffer.concat([bytes, Buffer.alloc(25 * 1024 * 1024 - bytes.length)]))
  await assert.rejects(validateVideoReferenceRequest(seedance25VideoSettings(), [{ kind: 'image', path: large }, { kind: 'image', path: large }], { prompt: '动作', mode: 'reference' }, 'configured'), /64 MB/)
})

test('cancelled Seedance tasks stop and an existing task resumes without reading references or submitting again', async t => {
  let created = 0
  let cancelled = true
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { created++; return Response.json({ id: 'known-25' }) }
    if (String(url).includes('/tasks/')) return Response.json(cancelled ? { status: 'cancelled', error: { message: 'creator cancelled' } } : { status: 'succeeded', content: { video_url: 'https://video.invalid/known.mp4' } })
    return new Response('resumed video')
  })
  let externalId = ''
  await assert.rejects(generate(model(), provider, { prompt: '动作', mode: 'text' }, [], 'fixture', id => { externalId = id }), /creator cancelled/)
  cancelled = false
  await generate(model(), provider, { prompt: '动作', _external_id: externalId, mode: 'first_frame', resolution: '4k' }, [{ kind: 'image', path: '/does-not-exist.png' }], 'fixture', () => { throw new Error('must not submit again') })
  assert.equal(created, 1)
})

test('profile constraints leave generic and Seedance 2.0 request dimensions unchanged', async () => {
  const request = { prompt: '动作', mode: 'first_frame', ratio: '9:16', resolution: '1080p', duration: 5 }
  assert.equal(normalizeSeedance25Request({}, request), request)
  assert.equal(normalizeSeedance25Request(seedance2VideoSettings(), request), request)
  const generic = { supported_modes: ['reference'], request_template: { prompt: '{{prompt}}' }, video_reference_schemes: ['asset:'] }
  await assert.rejects(validateVideoReferenceRequest(generic, [], { prompt: '动作', mode: 'reference', reference_video_url: 'https://media.invalid/source.mp4' }, 'configured'), /未传递参考视频/)
})

test('API preview accepts 30 Seedance 2.5 references, rejects lower profile limits and exposes effective edit parameters without negative planned duration', async () => {
  async function create(url: string, payload: unknown) {
    const response = await app.inject({ method: 'POST', url, payload })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as { id: string }
  }
  const project = await create('/api/projects', { name: 'Seedance 2.5 preview' })
  const source = await create('/api/providers', { name: 'fixture', adapter: 'http', base_url: provider.base_url })
  const video = await create('/api/models', { provider_id: source.id, name: 'Seedance 2.5', remote_id: model().remote_id, modality: 'video', protocol: 'async_video', settings: seedance25VideoSettings() })
  const ids = Array.from({ length: 30 }, (_, index) => `seedance25-ref-${index}`)
  for (const id of ids) run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,?,'upload',?)", id, project.id, `${id}.png`, imagePath, now())
  const preview = (payload: unknown) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload })
  const response = await preview({ model_id: video.id, prompt: '人物连续转身', mode: 'reference', duration: 30, reference_asset_ids: ids, explicit_reference_asset_ids: ids, video_reference_usages: ids.map(asset_id => ({ asset_id, usage: 'identity' })) })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().reference_asset_ids.length, 30)
  const edit = await preview({ model_id: video.id, prompt: '编辑原片', mode: 'edit', duration: 20, ratio: '9:16', resolution: '1080p', reference_video_url: 'asset://source' })
  assert.equal(edit.statusCode, 200, edit.body)
  assert.equal(edit.json().duration, 20)
  assert.equal(edit.json().ratio, 'adaptive')
  assert.equal(edit.json().video_request_parameters.duration, -1)
  assert.equal(edit.json().video_request_parameters.omni_reference_task_type, 'edit')
  const sourceDuration = await preview({ model_id: video.id, prompt: '视频时长：20秒\n保持原片时长，编辑画面中的人物服装。', mode: 'edit', duration: 5, reference_video_url: 'asset://twenty-second-source' })
  assert.equal(sourceDuration.statusCode, 200, sourceDuration.body)
  assert.equal(sourceDuration.json().duration, 5)
  assert.equal(sourceDuration.json().video_request_parameters.duration, -1)
  const oldVideo = await create('/api/models', { provider_id: source.id, name: 'Seedance 2.0', remote_id: 'old', modality: 'video', protocol: 'async_video', settings: seedance2VideoSettings() })
  assert.equal((await preview({ model_id: oldVideo.id, prompt: '动作', mode: 'reference', reference_asset_ids: ids.slice(0, 10) })).statusCode, 422)
  const generic = await create('/api/models', { provider_id: source.id, name: 'Generic', remote_id: 'generic', modality: 'video', protocol: 'async_video', settings: { create_path: 'tasks', get_path: 'tasks/{id}', supported_modes: ['reference'], request_template: { images: '{{images}}' } } })
  assert.equal((await preview({ model_id: generic.id, prompt: '动作', mode: 'reference', reference_asset_ids: ids.slice(0, 11) })).statusCode, 422)
  const imageModel = await create('/api/models', { provider_id: source.id, name: 'Image', remote_id: 'image', modality: 'image', protocol: 'image_generations', settings: { request_path: 'images', image_url_path: 'data.0.url', request_template: { images: '{{images}}' } } })
  assert.equal((await preview({ model_id: imageModel.id, prompt: '动作', mode: 'reference', reference_asset_ids: ids.slice(0, 11) })).statusCode, 422)
})
