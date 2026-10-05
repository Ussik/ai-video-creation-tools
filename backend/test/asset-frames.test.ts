import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-asset-frames-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, now, run } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

test('extracts requested first and last frames into ordered project image assets', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '首尾帧项目' } })).json() as { id: string }
  const shot = (await app.inject({ method: 'POST', url: `/api/projects/${project.id}/shots`, payload: { title: '动作镜头' } })).json() as { id: string }
  const videoPath = join(testData, 'source.mp4')
  const generated = spawnSync(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, 'video', 'source.mp4', ?, 'upload', NULL, NULL, NULL, ?)`,
  'source-video', project.id, shot.id, videoPath, now())

  const response = await app.inject({ method: 'POST', url: '/api/assets/source-video/frames', payload: { frames: ['first', 'last'] } })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json() as { assets: Array<{ id: string; kind: string; filename: string; shot_id: string | null; url: string }> }
  assert.equal(body.assets.length, 2)
  assert.deepEqual(body.assets.map(asset => asset.filename.split('-frame-')[0]), ['first', 'last'])
  assert.deepEqual(body.assets.map(asset => asset.kind), ['image', 'image'])
  assert.deepEqual(body.assets.map(asset => asset.shot_id), [shot.id, shot.id])

  for (const asset of body.assets) {
    const file = await app.inject({ method: 'GET', url: asset.url })
    assert.equal(file.statusCode, 200, file.body)
    assert.match(file.headers['content-type'] || '', /image\/jpeg/)
    assert.ok(file.rawPayload.length > 100)
  }
})

test('rejects frame extraction for non-video assets without creating images', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '静态素材项目' } })).json() as { id: string }
  const imagePath = join(testData, 'source.png')
  await writeFile(imagePath, await sharp({ create: { width: 16, height: 9, channels: 3, background: '#bd392e' } }).png().toBuffer())
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, NULL, 'image', 'source.png', ?, 'upload', NULL, NULL, NULL, ?)`,
  'source-image', project.id, imagePath, now())

  const response = await app.inject({ method: 'POST', url: '/api/assets/source-image/frames', payload: { frames: ['first'] } })
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /视频素材/)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}` })).json().assets.length, 1)
})
