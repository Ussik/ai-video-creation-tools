import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-asset-range-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, now, run } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

test('asset file streams full and partial content for video seeking', async () => {
  const projectResponse = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Range 测试' } })
  assert.equal(projectResponse.statusCode, 200)
  const project = projectResponse.json<{ id: string }>()
  const path = join(testData, 'seek.mp4')
  const content = Buffer.from('0123456789abcdef')
  await writeFile(path, content)
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, NULL, 'video', 'seek.mp4', ?, 'upload', NULL, NULL, NULL, ?)`,
    'seek-video', project.id, path, now())

  const url = '/api/assets/seek-video/file'
  const full = await app.inject({ method: 'GET', url })
  assert.equal(full.statusCode, 200)
  assert.equal(full.headers['content-type'], 'video/mp4')
  assert.equal(full.headers['accept-ranges'], 'bytes')
  assert.equal(full.headers['content-length'], '16')
  assert.equal(full.headers['content-range'], undefined)
  assert.deepEqual(full.rawPayload, content)

  for (const [range, expectedRange, expectedBody] of [
    ['bytes=5-8', 'bytes 5-8/16', '5678'],
    ['bytes=10-', 'bytes 10-15/16', 'abcdef'],
    ['bytes=-4', 'bytes 12-15/16', 'cdef'],
    ['bytes=0-0', 'bytes 0-0/16', '0'],
    ['bytes=0-999', 'bytes 0-15/16', content.toString()],
    ['bytes=-99', 'bytes 0-15/16', content.toString()],
  ]) {
    const response = await app.inject({ method: 'GET', url, headers: { range } })
    assert.equal(response.statusCode, 206, range)
    assert.equal(response.headers['content-range'], expectedRange, range)
    assert.equal(response.headers['content-length'], String(expectedBody.length), range)
    assert.equal(response.headers['accept-ranges'], 'bytes', range)
    assert.equal(response.body, expectedBody, range)
  }

  for (const range of ['bytes=16-', 'bytes=8-4', 'bytes=-0', 'bytes=', 'bytes=0-1,4-5', 'bytes=99999999999999999999-']) {
    const response = await app.inject({ method: 'GET', url, headers: { range } })
    assert.equal(response.statusCode, 416, range)
    assert.equal(response.headers['content-range'], 'bytes */16', range)
    assert.equal(response.body, '', range)
  }

  const head = await app.inject({ method: 'HEAD', url })
  assert.equal(head.statusCode, 200)
  assert.equal(head.headers['content-length'], '16')
  assert.equal(head.body, '')
  const rangedHead = await app.inject({ method: 'HEAD', url, headers: { range: 'bytes=5-8' } })
  assert.equal(rangedHead.statusCode, 206)
  assert.equal(rangedHead.headers['content-range'], 'bytes 5-8/16')
  assert.equal(rangedHead.headers['content-length'], '4')
  assert.equal(rangedHead.body, '')

  const missing = await app.inject({ method: 'GET', url: '/api/assets/unknown/file', headers: { range: 'bytes=0-1' } })
  assert.equal(missing.statusCode, 404)

  const shotResponse = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/shots`, payload: { title: '长视频片段' } })
  assert.equal(shotResponse.statusCode, 200)
  const shot = shotResponse.json<{ id: string }>()
  run(`INSERT INTO timeline_clips (id, project_id, shot_id, asset_id, in_ms, out_ms, source_duration_ms)
    VALUES (?, ?, ?, ?, 0, 5000, 720000)`, 'long-clip', project.id, shot.id, 'seek-video')
  const longClip = await app.inject({ method: 'PATCH', url: '/api/timeline-clips/long-clip', payload: { in_ms: 610000, out_ms: 612000 } })
  assert.equal(longClip.statusCode, 200, longClip.body)
  assert.deepEqual([longClip.json<{ in_ms: number; out_ms: number }>().in_ms,
    longClip.json<{ in_ms: number; out_ms: number }>().out_ms], [610000, 612000])
  const overEnd = await app.inject({ method: 'PATCH', url: '/api/timeline-clips/long-clip', payload: { out_ms: 720001 } })
  assert.equal(overEnd.statusCode, 422)
})
