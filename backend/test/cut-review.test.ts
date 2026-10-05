import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-cut-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, initDb, now, one, run } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

interface CutSide {
  shot_id: string
  asset_id: string | null
  clip_id: string | null
  in_ms: number | null
  out_ms: number | null
  frame_url: string | null
}

interface Cut {
  from_shot_id: string
  to_shot_id: string
  from: CutSide
  to: CutSide
  status: 'pending' | 'approved' | 'needs_work'
  saved_status: 'pending' | 'approved' | 'needs_work' | null
  note: string
  stale: boolean
  signature: string
  reviewed_at: string | null
  ready: boolean
}

interface CutList {
  production_range: { start_shot_id: string | null; end_shot_id: string | null }
  cuts: Cut[]
}

function insertAsset(id: string, projectId: string, shotId: string, kind: 'image' | 'video', path: string): void {
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'upload', NULL, NULL, NULL, ?)`,
    id, projectId, shotId, kind, `${id}.${kind === 'video' ? 'mp4' : 'png'}`, path, now())
}

test('cut reviews persist and become stale after either clip is trimmed or a selected asset changes', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '接镜审核' })
  const shots: Array<{ id: string }> = []
  for (const title of ['起势', '接招', '落点', '后续']) {
    shots.push(await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title, duration: 2 }))
  }
  const [first, second, third, fourth] = shots as [{ id: string }, { id: string }, { id: string }, { id: string }]

  const videoPath = join(testData, 'cut.mp4')
  const ffmpeg = spawnSync(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ], { encoding: 'utf8' })
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr)
  const imagePath = join(testData, 'cut.png')
  await writeFile(imagePath, await sharp({ create: { width: 16, height: 9, channels: 3, background: '#e02020' } }).png().toBuffer())
  insertAsset('first-video', project.id, first.id, 'video', videoPath)
  insertAsset('second-video', project.id, second.id, 'video', videoPath)
  insertAsset('alternate-video', project.id, second.id, 'video', videoPath)
  insertAsset('third-image', project.id, third.id, 'image', imagePath)
  insertAsset('fourth-image', project.id, fourth.id, 'image', imagePath)
  for (const [shot, assetId] of [[first, 'first-video'], [second, 'second-video'],
    [third, 'third-image'], [fourth, 'fourth-image']] as const) {
    await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: assetId })
  }
  await call('PUT', `/api/projects/${project.id}/production-range`,
    { start_shot_id: first.id, end_shot_id: third.id })

  const initial = await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)
  assert.deepEqual(initial.cuts.map(cut => [cut.from_shot_id, cut.to_shot_id]),
    [[first.id, second.id], [second.id, third.id]])
  assert.equal(initial.cuts[0]?.ready, true)
  assert.equal(initial.cuts[0]?.saved_status, null)
  assert.equal(initial.cuts[0]?.from.frame_url, '/api/assets/first-video/frame?time_ms=1950')
  assert.equal(initial.cuts[0]?.to.frame_url, '/api/assets/second-video/frame?time_ms=0')
  assert.equal(initial.cuts[1]?.to.frame_url, '/api/assets/third-image/file')
  const frame = await app.inject({ method: 'GET', url: initial.cuts[0]!.from.frame_url! })
  assert.equal(frame.statusCode, 200, frame.body)
  assert.match(frame.headers['content-type'] || '', /image\/jpeg/)

  const approved = await call<Cut>('PUT', `/api/projects/${project.id}/cut-reviews`, {
    from_shot_id: first.id, to_shot_id: second.id, signature: initial.cuts[0]!.signature,
    status: 'approved', note: '动作方向和站位衔接自然',
  })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.stale, false)
  assert.ok(approved.reviewed_at)
  initDb()
  assert.equal((await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[0]?.status, 'approved')
  const stored = one<{ from_selected_asset_id: string; to_selected_asset_id: string; from_out_ms: number; to_in_ms: number }>(
    'SELECT * FROM cut_reviews WHERE project_id=? AND from_shot_id=? AND to_shot_id=?', project.id, first.id, second.id)
  assert.deepEqual([stored?.from_selected_asset_id, stored?.to_selected_asset_id, stored?.from_out_ms, stored?.to_in_ms],
    ['first-video', 'second-video', 2000, 0])

  await call('PATCH', `/api/timeline-clips/${initial.cuts[0]!.to.clip_id}`, { in_ms: 250, out_ms: 1750 })
  let changed = (await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[0]!
  assert.equal(changed.status, 'pending')
  assert.equal(changed.saved_status, 'approved')
  assert.equal(changed.note, '动作方向和站位衔接自然')
  assert.equal(changed.stale, true)
  assert.equal(changed.to.frame_url, '/api/assets/second-video/frame?time_ms=250')
  assert.notEqual(changed.signature, initial.cuts[0]!.signature)
  const outdated = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-reviews`, payload: {
    from_shot_id: first.id, to_shot_id: second.id, signature: initial.cuts[0]!.signature,
    status: 'approved', note: '',
  } })
  assert.equal(outdated.statusCode, 409)

  await call('PUT', `/api/projects/${project.id}/cut-reviews`, {
    from_shot_id: first.id, to_shot_id: second.id, signature: changed.signature,
    status: 'approved', note: '调整切点后通过',
  })
  await call('PATCH', `/api/timeline-clips/${initial.cuts[0]!.from.clip_id}`, { in_ms: 100, out_ms: 1800 })
  changed = (await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[0]!
  assert.equal(changed.stale, true)
  assert.equal(changed.from.frame_url, '/api/assets/first-video/frame?time_ms=1750')
  await call('PUT', `/api/projects/${project.id}/cut-reviews`, {
    from_shot_id: first.id, to_shot_id: second.id, signature: changed.signature,
    status: 'approved', note: '再次通过',
  })
  await call('PUT', `/api/shots/${second.id}/selection`, { asset_id: 'alternate-video' })
  changed = (await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[0]!
  assert.equal(changed.stale, true)
  assert.equal(changed.to.asset_id, 'alternate-video')
  await call('PUT', `/api/projects/${project.id}/cut-reviews`, {
    from_shot_id: first.id, to_shot_id: second.id, signature: changed.signature,
    status: 'approved', note: '替换素材后通过',
  })
  await call('PATCH', `/api/timeline-clips/${changed.to.clip_id}`, { source_audio_gain: 0.5 })
  assert.equal((await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[0]?.status, 'approved',
    '只调整原声音量不会改变画面接镜审核')

  await call('PUT', `/api/projects/${project.id}/production-range`,
    { start_shot_id: second.id, end_shot_id: third.id })
  const narrower = await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)
  assert.deepEqual(narrower.cuts.map(cut => [cut.from_shot_id, cut.to_shot_id]), [[second.id, third.id]])
  assert.equal(narrower.cuts[0]?.status, 'pending')
})

test('only adjacent cuts in the current range can be reviewed and approval needs both frames', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '审核约束' })
  const first = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '无素材一' })
  const second = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '无素材二' })
  const third = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '无素材三' })
  const cuts = await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)
  assert.equal(cuts.cuts.length, 2)
  assert.equal(cuts.cuts[0]?.ready, false)
  const base = {
    from_shot_id: first.id, to_shot_id: second.id, signature: cuts.cuts[0]!.signature,
    note: '这两个镜头还没有可供审核的画面',
  }
  const invalidApproval = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-reviews`,
    payload: { ...base, status: 'approved' } })
  assert.equal(invalidApproval.statusCode, 422)
  const missingProblem = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-reviews`,
    payload: { ...base, status: 'needs_work', note: '  ' } })
  assert.equal(missingProblem.statusCode, 422)
  const needsWork = await call<Cut>('PUT', `/api/projects/${project.id}/cut-reviews`,
    { ...base, status: 'needs_work' })
  assert.equal(needsWork.status, 'needs_work')
  assert.equal(needsWork.note, base.note)

  for (const [fromShot, toShot] of [[first.id, third.id], [second.id, first.id]]) {
    const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-reviews`,
      payload: { ...base, from_shot_id: fromShot, to_shot_id: toShot, status: 'needs_work' } })
    assert.equal(response.statusCode, 422)
  }
  await call('PUT', `/api/projects/${project.id}/production-range`,
    { start_shot_id: second.id, end_shot_id: third.id })
  const outside = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-reviews`,
    payload: { ...base, status: 'needs_work' } })
  assert.equal(outside.statusCode, 422)
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/missing-project/cut-reviews' })).statusCode, 404)

  await call('DELETE', `/api/projects/${project.id}`)
  assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM cut_reviews WHERE project_id=?', project.id)?.count, 0)
})

test('cut points update both adjacent video clips and invalidate the prior review', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '接镜切点' })
  const first = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '镜一', duration: 2 })
  const second = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '镜二', duration: 2 })
  const image = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '静图', duration: 2 })
  const fourth = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '范围外', duration: 2 })
  const videoPath = join(testData, 'cut-points.mp4')
  const ffmpeg = spawnSync(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ], { encoding: 'utf8' })
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr)
  const imagePath = join(testData, 'cut-points.png')
  await writeFile(imagePath, await sharp({ create: { width: 16, height: 9, channels: 3, background: '#e02020' } }).png().toBuffer())
  insertAsset('points-first', project.id, first.id, 'video', videoPath)
  insertAsset('points-second', project.id, second.id, 'video', videoPath)
  insertAsset('points-image', project.id, image.id, 'image', imagePath)
  for (const [shot, assetId] of [[first, 'points-first'], [second, 'points-second'], [image, 'points-image']] as const) {
    await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: assetId })
  }
  await call('PUT', `/api/projects/${project.id}/production-range`,
    { start_shot_id: first.id, end_shot_id: image.id })
  const initial = (await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[0]!
  await call('PUT', `/api/projects/${project.id}/cut-reviews`, {
    from_shot_id: first.id, to_shot_id: second.id, signature: initial.signature,
    status: 'approved', note: '初版接镜通过',
  })
  const payload = {
    from_shot_id: first.id, to_shot_id: second.id, signature: initial.signature,
    from_out_ms: 1800, to_in_ms: 250,
  }
  const updated = await call<Cut>('PUT', `/api/projects/${project.id}/cut-points`, payload)
  assert.equal(updated.from.out_ms, 1800)
  assert.equal(updated.to.in_ms, 250)
  assert.equal(updated.from.frame_url, '/api/assets/points-first/frame?time_ms=1750')
  assert.equal(updated.to.frame_url, '/api/assets/points-second/frame?time_ms=250')
  assert.notEqual(updated.signature, initial.signature)
  assert.equal(updated.status, 'pending')
  assert.equal(updated.saved_status, 'approved')
  assert.equal(updated.stale, true)
  assert.deepEqual([
    one<{ out_ms: number }>('SELECT out_ms FROM timeline_clips WHERE shot_id=?', first.id)?.out_ms,
    one<{ in_ms: number }>('SELECT in_ms FROM timeline_clips WHERE shot_id=?', second.id)?.in_ms,
  ], [1800, 250])

  const stale = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-points`, payload })
  assert.equal(stale.statusCode, 409)
  const invalidSecond = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-points`,
    payload: { ...payload, signature: updated.signature, from_out_ms: 1500, to_in_ms: 1900 } })
  assert.equal(invalidSecond.statusCode, 422)
  const invalidFirst = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-points`,
    payload: { ...payload, signature: updated.signature, from_out_ms: 100, to_in_ms: 300 } })
  assert.equal(invalidFirst.statusCode, 422)
  assert.deepEqual([
    one<{ out_ms: number }>('SELECT out_ms FROM timeline_clips WHERE shot_id=?', first.id)?.out_ms,
    one<{ in_ms: number }>('SELECT in_ms FROM timeline_clips WHERE shot_id=?', second.id)?.in_ms,
  ], [1800, 250], '任一侧无效时另一侧保持原值')

  const secondCut = (await call<CutList>('GET', `/api/projects/${project.id}/cut-reviews`)).cuts[1]!
  const imageUnchanged = await call<Cut>('PUT', `/api/projects/${project.id}/cut-points`, {
    from_shot_id: second.id, to_shot_id: image.id, signature: secondCut.signature,
    from_out_ms: 1700, to_in_ms: 0,
  })
  assert.equal(imageUnchanged.to.in_ms, 0)
  assert.equal(imageUnchanged.from.out_ms, 1700)
  const imageChanged = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-points`, payload: {
    from_shot_id: second.id, to_shot_id: image.id, signature: imageUnchanged.signature,
    from_out_ms: 1600, to_in_ms: 100,
  } })
  assert.equal(imageChanged.statusCode, 422)
  assert.equal(one<{ out_ms: number }>('SELECT out_ms FROM timeline_clips WHERE shot_id=?', second.id)?.out_ms, 1700)

  const otherProject = await call<{ id: string }>('POST', '/api/projects', { name: '其他项目' })
  for (const [url, fromShot, toShot, signature] of [
    [`/api/projects/${otherProject.id}/cut-points`, first.id, second.id, updated.signature],
    [`/api/projects/${project.id}/cut-points`, first.id, image.id, updated.signature],
    [`/api/projects/${project.id}/cut-points`, image.id, fourth.id, updated.signature],
  ] as const) {
    const response = await app.inject({ method: 'PUT', url, payload: {
      from_shot_id: fromShot, to_shot_id: toShot, signature, from_out_ms: 1200, to_in_ms: 0,
    } })
    assert.equal(response.statusCode, 422)
  }
  await call('PUT', `/api/projects/${project.id}/production-range`,
    { start_shot_id: first.id, end_shot_id: second.id })
  const outside = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/cut-points`, payload: {
    from_shot_id: second.id, to_shot_id: image.id, signature: imageUnchanged.signature,
    from_out_ms: 1500, to_in_ms: 0,
  } })
  assert.equal(outside.statusCode, 422)
})
