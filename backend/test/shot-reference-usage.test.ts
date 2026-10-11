import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'shot-reference-usage-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/server.js')
const { db, run, now, all } = await import('../src/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call(method: 'POST' | 'PUT' | 'PATCH' | 'GET', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('a corpse establishing image uses four objects while its video also needs the entering technician and terminal', async () => {
  const project = await call('POST', '/api/projects', { name: '独立出镜用途' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '废楼房间' })
  const names = ['尸体', '房间', '符字', '警示灯', '技术人员', '终端', '沈砚', '封锁带', '记录本']
  const result = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: names.map((name, index) => ({
    kind: index === 1 ? 'location' : [0, 4, 6].includes(index) ? 'character' : 'prop', name,
    definition: `${name}的固定外观`, view_requirements: '正侧背三视图；面部特写；信息图色板', scene_ids: [scene.id],
  })) })
  const profiles = names.map(name => result.visual_profiles.find((profile: any) => profile.name === name))
  const shot = await call('POST', `/api/projects/${project.id}/shots`, { title: '尸体与符字', source_scene_id: scene.id,
    image_prompt: '广角低机位，尸体与墙面符字、房间、警示灯', video_prompt: '缓慢推进，技术人员进入操作终端' })
  const bindings = profiles.map((profile, index) => ({ profile_id: profile.id, required: true, usage: index < 4 ? 'both' : index < 6 ? 'video' : 'none' }))
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings })
  const provider = await call('POST', '/api/providers', { name: '隔离', base_url: 'https://example.invalid', adapter: 'http' })
  const createModel = (video: boolean) => call('POST', '/api/models', { provider_id: provider.id, name: video ? '视频' : '图片', remote_id: 'mock',
    modality: video ? 'video' : 'image', protocol: video ? 'async_video' : 'image_generations', settings: {
      ...(video ? { create_path: '/video', get_path: '/video/{id}', supported_modes: ['reference'] } : { request_path: '/image', image_base64_path: 'data.0.b64_json' }),
      request_template: { prompt: '{{prompt}}', images: '{{images}}' },
    } })
  const imageModel = await createModel(false), videoModel = await createModel(true)
  const imageInput = { shot_id: shot.id, model_id: imageModel.id, prompt: shot.image_prompt, mode: 'text' }
  const approve = async (index: number) => {
    const id = `scope-board-${index}`
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','ref.png','/tmp/ref.png','upload',?)", id, project.id, now())
    await call('PATCH', `/api/visual-profiles/${profiles[index].id}`, { expected_revision: 1, board_asset_id: id })
    return id
  }
  const absent = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: imageInput })
  assert.equal(absent.statusCode, 422)
  assert.match(absent.body, /尸体/); assert.doesNotMatch(absent.body, /技术人员|终端|沈砚|记录本|封锁带/)
  const imageIds: string[] = []
  for (let index = 0; index < 4; index++) imageIds.push(await approve(index))
  const image = await call('POST', `/api/projects/${project.id}/generate/preview`, imageInput)
  assert.deepEqual([...image.reference_asset_ids].sort(), imageIds.sort())
  assert.match(image.prompt, /尸体的固定外观/)
  assert.doesNotMatch(image.prompt, /技术人员的固定外观|沈砚的固定外观|正侧背三视图|面部特写|信息图色板/)
  const videoInput = { ...imageInput, model_id: videoModel.id, mode: 'reference', prompt: shot.video_prompt }
  const missingVideo = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: videoInput })
  assert.equal(missingVideo.statusCode, 422)
  assert.match(missingVideo.body, /技术人员/); assert.match(missingVideo.body, /终端/)
  assert.doesNotMatch(missingVideo.body, /沈砚|封锁带|记录本/)
  const extraIds = [await approve(4), await approve(5)]
  const video = await call('POST', `/api/projects/${project.id}/generate/preview`, videoInput)
  assert.deepEqual([...video.reference_asset_ids].sort(), [...imageIds, ...extraIds].sort())
  assert.match(video.prompt, /技术人员的固定外观/); assert.doesNotMatch(video.prompt, /沈砚的固定外观/)
  const inactiveId = await approve(6)
  const filtered = await call('POST', `/api/projects/${project.id}/generate/preview`, { ...imageInput, reference_asset_ids: [extraIds[0], inactiveId] })
  assert.deepEqual([...filtered.reference_asset_ids].sort(), imageIds.sort())
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: bindings.map((binding, index) => index === 4 ? { ...binding, usage: 'both' } : binding) })
  const stale = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate`, payload: { ...imageInput, visual_signature: image.visual_signature } })
  assert.equal(stale.statusCode, 409)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})
