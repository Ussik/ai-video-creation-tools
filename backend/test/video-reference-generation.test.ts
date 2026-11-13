import { validVideo } from './fixtures/valid-video.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import { seedance2VideoSettings } from '@video-studio/shared/models/seedance-video-settings'

const testData = await mkdtemp(join(tmpdir(), 'video-reference-generation-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, run, now } = await import('../src/infrastructure/database/db.js')
const { generate, validateVideoReferenceRequest } = await import('../src/infrastructure/providers/providers.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown) {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function asset(projectId: string, id: string, width = 600, height = 900) {
  const path = join(testData, `${id}.png`)
  const color = id.split('').reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) & 0xffffff, 0)
  await sharp({ create: { width, height, channels: 3, background: `#${color.toString(16).padStart(6, '0')}` } }).png().toFile(path)
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,?,'upload',?)", id, projectId, `${id}.png`, path, now())
  return { id, kind: 'image' as const, path }
}
async function setup() {
  const project = await call('POST', '/api/projects', { name: '视频多图参考' })
  const provider = await call('POST', '/api/providers', { name: '官方配置测试', adapter: 'http', base_url: 'https://video.invalid/api/v3' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '不依赖名称', remote_id: 'configured-id', modality: 'video', protocol: 'async_video', settings: seedance2VideoSettings() })
  const data = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'character', name: '林晚', variant: '雨衣', definition: '深绿雨衣，银色纽扣', view_requirements: '正侧背、面部细节' },
    { kind: 'prop', name: '铜钥匙', variant: '旧铜', definition: '弯曲铜钥匙', view_requirements: '三视图' },
  ] })
  const profiles = data.visual_profiles as Array<{ id: string; kind: string }>
  const required = profiles.find(profile => profile.kind === 'character')!
  const optional = profiles.find(profile => profile.kind === 'prop')!
  await asset(project.id, `hero-${project.id}`)
  await asset(project.id, `prop-${project.id}`)
  await asset(project.id, `frame-${project.id}`)
  await call('PATCH', `/api/visual-profiles/${required.id}`, { expected_revision: 1, board_asset_id: `hero-${project.id}` })
  await call('PATCH', `/api/visual-profiles/${optional.id}`, { expected_revision: 1, board_asset_id: `prop-${project.id}` })
  const shot = await call('POST', `/api/projects/${project.id}/shots`, { title: '林晚转身', duration_ms: 5000 })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: required.id, required: true }, { profile_id: optional.id, required: false }] })
  const input = { shot_id: shot.id, model_id: model.id, prompt: '林晚停顿后转身，镜头向左平移', mode: 'reference', visual_reference_mode: 'profiles',
    reference_asset_ids: [`frame-${project.id}`], storyboard_reference_asset_id: `frame-${project.id}`, resolution: '480p', ratio: '9:16' }
  const preview = (payload: unknown) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload })
  return { project, model, shot, required, optional, input, preview }
}

test('video preview inherits boards with stable purpose mapping; optional image exclusion retains its text', async () => {
  const { project, optional, input, preview } = await setup()
  const response = await preview({ ...input, excluded_visual_profile_ids: [optional.id] })
  assert.equal(response.statusCode, 200, response.body)
  const data = response.json()
  assert.deepEqual(data.reference_asset_ids, [`frame-${project.id}`, `hero-${project.id}`])
  assert.match(data.prompt, /图片1：分镜构图/)
  assert.match(data.prompt, /图片2：林晚（雨衣）/)
  assert.match(data.prompt, /弯曲铜钥匙/)
  assert.doesNotMatch(data.prompt, /图片3/)
  const edited = data.prompt.replace('镜头向左平移', '镜头缓慢推近')
  const rechecked = await preview({ ...data, prompt: edited, prompt_is_final: true })
  assert.equal(rechecked.statusCode, 200, rechecked.body)
  assert.equal(rechecked.json().prompt, edited)
  assert.equal((edited.match(/【视频参考图用途】/g) || []).length, 1)
})

test('preview excludes optional profile identity when its image remains required by another profile or storyboard', async () => {
  for (const sharesStoryboard of [false, true]) {
    const { project, shot, required, optional, input, preview } = await setup()
    const sharedId = `${sharesStoryboard ? 'frame' : 'hero'}-${project.id}`
    await call('PATCH', `/api/visual-profiles/${optional.id}`, { expected_revision: 1, board_asset_id: sharedId })
    await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: required.id, required: true }, { profile_id: optional.id, required: false }] })
    const response = await preview({ ...input, excluded_visual_profile_ids: [optional.id] })
    assert.equal(response.statusCode, 200, response.body)
    const data = response.json()
    assert.deepEqual(data.reference_asset_ids, [`frame-${project.id}`, `hero-${project.id}`])
    const [body, mapping] = data.prompt.split('【视频参考图用途】') as string[]
    assert.match(body!, /弯曲铜钥匙/)
    assert.match(mapping!, /林晚（雨衣）/)
    assert.doesNotMatch(mapping!, /铜钥匙|旧铜/)
  }
})

test('foreign/required exclusions and missing storyboard image are rejected before generation', async () => {
  const { required, input, preview } = await setup()
  for (const overrides of [{ excluded_visual_profile_ids: [required.id] }, { excluded_visual_profile_ids: ['foreign'] },
    { excluded_visual_profile_ids: ['foreign', 'foreign'] }, { storyboard_reference_asset_id: 'not-in-request' }]) {
    const response = await preview({ ...input, ...overrides })
    assert.equal(response.statusCode, 422, response.body)
  }
  const response = await preview({ ...input, mode: 'first_frame', visual_reference_mode: 'profiles' })
  assert.equal(response.statusCode, 422)
  assert.match(response.body, /首帧/)
  const mixed = await preview({ ...input, mode: 'first_frame', visual_reference_mode: 'keyframe', reference_video_url: 'https://video.invalid/reference.mp4' })
  assert.equal(mixed.statusCode, 422)
  assert.match(mixed.body, /互斥/)
})

test('Seedance media validation runs at preview; generic provider configurations keep their own media limits', async () => {
  const { project, model, input, preview } = await setup()
  await asset(project.id, `too-small-${project.id}`, 299, 400)
  const response = await preview({ ...input, reference_asset_ids: [`too-small-${project.id}`], storyboard_reference_asset_id: `too-small-${project.id}` })
  assert.equal(response.statusCode, 422)
  assert.match(response.body, /300 到 6000/)
  await call('PATCH', `/api/models/${model.id}`, { settings: { ...seedance2VideoSettings(), video_reference_profile: undefined } })
  const generic = await preview({ ...input, reference_asset_ids: [`too-small-${project.id}`], storyboard_reference_asset_id: `too-small-${project.id}` })
  assert.equal(generic.statusCode, 200, generic.body)
})

test('Seedance provider sends storyboard plus character/scene/prop images with reference roles and exact dimensions', async t => {
  const projectId = (await call('POST', '/api/projects', { name: 'Provider 多图映射' })).id as string
  const references = await Promise.all(['frame', 'hero', 'location', 'prop'].map(id => asset(projectId, `${projectId}-${id}`)))
  const submissions: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { submissions.push(JSON.parse(String(init.body))); return Response.json({ id: 'video-ref-task' }) }
    if (String(url).includes('/tasks/')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.invalid/generated.mp4' } })
    return new Response(validVideo, { headers: { 'Content-Type': 'video/mp4' } })
  })
  const settings = { ...seedance2VideoSettings(), poll_seconds: 0.001, mode_variables: { reference: { ratio: 'adaptive', resolution: '720p' } } }
  const result = await generate({ id: 'test', remote_id: 'declared', modality: 'video', settings },
    { adapter: 'http', base_url: 'https://video.invalid/api/v3' },
    { prompt: '图片1是构图，图片2人物，图片3场景，图片4道具。镜头缓慢推近。', mode: 'reference', ratio: '9:16', resolution: '480p' }, references,
    projectId, () => {})
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0]!.ratio, '9:16')
  assert.equal(submissions[0]!.resolution, '480p')
  const content = submissions[0]!.content as Array<{ type: string; role?: string; image_url?: { url: string } }>
  assert.equal(content.length, 5)
  assert.deepEqual(content.slice(1).map(item => item.role), ['reference_image', 'reference_image', 'reference_image', 'reference_image'])
  for (let index = 0; index < references.length; index++) assert.equal(content[index + 1]!.image_url!.url, `data:image/png;base64,${(await readFile(references[index]!.path)).toString('base64')}`)
  assert.deepEqual(await readFile(result.path), validVideo)
})

test('preflight rejects the exact Base64 request above 64 MB before submitting any provider request', async () => {
  const path = join(testData, 'large-valid.png')
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#667766' } }).png().toBuffer()
  await writeFile(path, Buffer.concat([png, Buffer.alloc(25 * 1024 * 1024 - png.length)]))
  await assert.rejects(validateVideoReferenceRequest(seedance2VideoSettings(),
    [{ kind: 'image', path }, { kind: 'image', path }], { prompt: '连续动作', mode: 'reference' }, 'configured'), /超过 64 MB.*Base64/)
})

test('actual decoded MIME survives incorrect filename extensions and unsupported SVG is rejected', async t => {
  const tiffPath = join(testData, 'actually-tiff.png')
  const svgPath = join(testData, 'unsupported-svg.png')
  await sharp({ create: { width: 300, height: 400, channels: 3, background: '#664433' } }).tiff().toFile(tiffPath)
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="red"/></svg>')
  const settings = { ...seedance2VideoSettings(), poll_seconds: 0.001 }
  await assert.rejects(validateVideoReferenceRequest(settings, [{ kind: 'image', path: svgPath }], { prompt: '动作', mode: 'first_frame' }, 'configured'), /图片格式/)
  let receivedUrl = ''
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body))
      receivedUrl = payload.content[1].image_url.url
      return Response.json({ id: 'mime-task' })
    }
    if (String(url).includes('/tasks/')) return Response.json({ status: 'succeeded', content: { video_url: 'https://video.invalid/mime.mp4' } })
    return new Response(validVideo, { headers: { 'Content-Type': 'video/mp4' } })
  })
  await generate({ id: 'mime-test', remote_id: 'configured', modality: 'video', settings },
    { adapter: 'http', base_url: 'https://video.invalid/api/v3' }, { prompt: '动作', mode: 'first_frame' },
    [{ kind: 'image', path: tiffPath }], 'mime-project', () => {})
  assert.match(receivedUrl, /^data:image\/tiff;base64,/)
  assert.equal(receivedUrl.split(',')[1], (await readFile(tiffPath)).toString('base64'))
})
