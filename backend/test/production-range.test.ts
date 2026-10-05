import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-production-range-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, now, run } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

test('production range limits export and stays stable across project edits', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '完整故事，先做开场' })
  const shots = []
  for (const title of ['开场', '交锋', '后续']) {
    shots.push(await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title, duration: 3 }))
  }
  const [first, second, third] = shots as [{ id: string }, { id: string }, { id: string }]
  const defaultDetail = await call<{ production_range: { start_shot_id: string | null; end_shot_id: string | null } }>(
    'GET', `/api/projects/${project.id}`)
  assert.deepEqual(defaultDetail.production_range, { start_shot_id: null, end_shot_id: null })

  const imagePath = join(testData, 'frame.png')
  await writeFile(imagePath, await sharp({ create: { width: 16, height: 9, channels: 3, background: '#e02020' } }).png().toBuffer())
  for (const shot of [first, second]) {
    const assetId = `asset-${shot.id}`
    run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
      VALUES (?, ?, ?, 'image', 'frame.png', ?, 'upload', NULL, NULL, NULL, ?)`,
    assetId, project.id, shot.id, imagePath, now())
    await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: assetId })
  }

  const missing = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export` })
  assert.equal(missing.statusCode, 422)
  assert.match(missing.body, /未选定素材/)

  const range = await call<{ start_shot_id: string | null; end_shot_id: string | null }>(
    'PUT', `/api/projects/${project.id}/production-range`, { start_shot_id: null, end_shot_id: second.id })
  assert.deepEqual(range, { start_shot_id: null, end_shot_id: second.id })
  const exportJob = await call<{ request: string }>('POST', `/api/projects/${project.id}/export`)
  const request = JSON.parse(exportJob.request) as { clips: Array<{ title: string }>; production_range: typeof range }
  assert.deepEqual(request.clips.map(clip => clip.title), ['开场', '交锋'])
  assert.deepEqual(request.production_range, range)

  const other = await call<{ id: string }>('POST', '/api/projects', { name: '其他项目' })
  const foreign = await call<{ id: string }>('POST', `/api/projects/${other.id}/shots`, { title: '外部镜头' })
  for (const invalidRange of [
    { start_shot_id: third.id, end_shot_id: second.id },
    { start_shot_id: foreign.id, end_shot_id: null },
    { start_shot_id: 'missing-shot', end_shot_id: null },
  ]) {
    const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/production-range`, payload: invalidRange })
    assert.equal(response.statusCode, 422)
  }
  assert.deepEqual((await call<{ production_range: typeof range }>('GET', `/api/projects/${project.id}`)).production_range, range)

  await call('PUT', `/api/projects/${project.id}/production-range`,
    { start_shot_id: first.id, end_shot_id: second.id })
  const deleteBoundary = await app.inject({ method: 'DELETE', url: `/api/shots/${second.id}` })
  assert.equal(deleteBoundary.statusCode, 422)
  const reversedOrder = await app.inject({ method: 'PATCH', url: `/api/shots/${first.id}`, payload: { position: 2 } })
  assert.equal(reversedOrder.statusCode, 422)
  assert.deepEqual((await call<{ shots: Array<{ id: string }> }>('GET', `/api/projects/${project.id}`)).shots.map(shot => shot.id),
    [first.id, second.id, third.id])

  await call('PUT', `/api/projects/${project.id}/production-range`, { start_shot_id: null, end_shot_id: null })
  const allShotsMissing = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/export` })
  assert.equal(allShotsMissing.statusCode, 422)
  assert.match(allShotsMissing.body, /未选定素材/)
})
