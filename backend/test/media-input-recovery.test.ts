import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import sharp from 'sharp'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mediaInputManifest, mediaInputRejection } from '../src/infrastructure/providers/media-input-manifest.js'
import { referenceBase64 } from '../src/infrastructure/providers/reference-encoding-cache.js'
import { seedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { withMediaExecution } from '../src/infrastructure/providers/media-execution.js'
const directory = await mkdtemp(join(tmpdir(), 'media-input-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
process.env.LANGFUSE_TRACING = 'false'
const { buildApp } = await import('../src/app.js')
const { db, run, now, required } = await import('../src/infrastructure/database/db.js')
const { recordJobProviderManifest, recordJobProviderRejection } = await import('../src/modules/jobs/job-provider-inputs.js')
const { videoSourceVersion } = await import('../src/modules/canvas/video-source-version.js')
const { generate } = await import('../src/infrastructure/providers/providers.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const refs = [{ id: 'a', kind: 'image' as const }, { id: 'b', kind: 'image' as const }, { id: 'duplicate', kind: 'image' as const }]
test('actual rendered paths account for text offsets and identical-byte ambiguity without exposing images', () => {
  const image = 'data:image/png;base64,AAAA', second = 'https://media.invalid/image'
  const body = { content: [{ type: 'text', text: 'private plot' }, { type: 'text', text: 'reference descriptions' },
    { image_url: { url: image } }, { image_url: { url: second } }, { image_url: { url: image } }] }
  const manifest = mediaInputManifest(body, [image, second, image], refs)
  assert.deepEqual(manifest.entries.map(input => input.content_index), [2, 3, 4])
  assert.deepEqual(manifest.entries[0]!.asset_ids, ['a', 'duplicate'])
  assert.equal(manifest.entries[0]!.field_path, 'content[2].image_url.url')
  assert.equal(manifest.request_bytes, Buffer.byteLength(JSON.stringify(body)))
  assert.equal(manifest.duplicate_image_occurrences, 1)
  assert.ok(!JSON.stringify(manifest).includes('AAAA')); assert.ok(!JSON.stringify(manifest).includes('private plot'))
  const rejection = mediaInputRejection(JSON.stringify({ error: { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: 'rejected content[2] and content[3]' } }), new Response('', { status: 400, headers: { 'x-request-id': 'upstream-12' } }), manifest)
  assert.equal(rejection.mapping_status, 'matched'); assert.equal(rejection.provider_request_id, 'upstream-12')
  assert.deepEqual(rejection.inputs.flatMap(input => input.asset_ids), ['a', 'duplicate', 'b'])
  assert.equal(mediaInputRejection('not-json content[2]', new Response('', { status: 400 }), manifest).mapping_status, 'unmapped')
  assert.equal(mediaInputRejection(JSON.stringify({ Message: 'content[2] and content[99]', Code: 'Rejected', RequestId: 'body-id' }), new Response('', { status: 400 }), manifest).mapping_status, 'partial')
  assert.equal(mediaInputRejection(JSON.stringify({ error: { message: 'content[99]' } }), new Response('', { status: 400 }), manifest).inputs.length, 0)
})
test('concurrent encoding preserves exact bytes, invalidates changed files, and recovers after read failure', async () => {
  const path = join(directory, 'bytes.png'), a = Buffer.from([0, 1, 2, 255, 4])
  await writeFile(path, a)
  assert.deepEqual(await Promise.all([referenceBase64(path), referenceBase64(path)]), [a.toString('base64'), a.toString('base64')])
  const b = Buffer.from([8, 7, 6, 5, 4, 3]); await writeFile(path, b)
  assert.equal(await referenceBase64(path), b.toString('base64')); assert.deepEqual(await readFile(path), b)
  await rm(path); await assert.rejects(referenceBase64(path)); await writeFile(path, a)
  assert.equal(await referenceBase64(path), a.toString('base64'))
})
async function project() {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'isolated recovery' } })
  assert.equal(response.statusCode, 200, response.body); return response.json().id as string
}
test('a definite provider rejection makes one POST and persists final content mapping for the normal read API', async t => {
  const projectId = await project(), jobId = 'rejected-job', timestamp = now(), imagePath = join(directory, 'input.png')
  await sharp({ create: { width: 300, height: 400, channels: 3, background: '#447766' } }).png().toFile(imagePath)
  run('INSERT INTO jobs (id,project_id,job_type,status,request,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', jobId, projectId, 'generate', 'running', '{}', timestamp, timestamp)
  const job = required<any>('jobs', jobId)
  let count = 0, sent: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    count++; assert.equal(init?.method, 'POST'); sent = JSON.parse(String(init?.body))
    return Response.json({ error: { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: 'content[1] refused' } }, { status: 400, headers: { 'x-request-id': 'provider-request' } })
  })
  await assert.rejects(withMediaExecution({ onRequestManifest: value => recordJobProviderManifest(job, value), onProviderRejected: value => recordJobProviderRejection(job, value) },
    () => generate({ id: 'fixture', modality: 'video', remote_id: 'doubao-seedance-2-5-260628', settings: seedance25VideoSettings() },
      { adapter: 'http', base_url: 'https://fixture.invalid/api/v3' }, { prompt: '动作', mode: 'first_frame', duration: 8 }, [{ id: 'exact-image', kind: 'image', path: imagePath }], projectId, () => {})), /400/)
  assert.equal(count, 1)
  const response = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/provider-inputs` })
  assert.equal(response.statusCode, 200); const data = response.json()
  assert.equal(data.manifest.request_bytes, Buffer.byteLength(JSON.stringify(sent)))
  assert.deepEqual(data.rejection.inputs[0].asset_ids, ['exact-image'])
  assert.equal(data.rejection.provider_request_id, 'provider-request')
  assert.equal(data.rejection.mapping_status, 'matched')
  assert.ok(!response.body.includes('base64'))
  run('UPDATE jobs SET status=? WHERE id=?', 'succeeded', jobId)
  assert.throws(() => recordJobProviderManifest(job, data.manifest), /任务已变化/)
})
test('normal shot save checks source version and rolls video and audio back together on write failure', async () => {
  const projectId = await project(), created = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/shots`, payload: { title: '灯管', video_prompt: '闪烁一次', duration: 8,
    audio_plan: { version: 1, speech: [], sound_effects: ['两次啪啪声'], music: '', silent: false } } })
  assert.equal(created.statusCode, 200, created.body)
  const shot = created.json(), version = videoSourceVersion(shot)
  db.exec(`CREATE TEMP TRIGGER fail_audio BEFORE UPDATE OF audio_plan ON shots BEGIN SELECT RAISE(ABORT, 'test atomic audio failure'); END`)
  const payload = { video_prompt: '闪烁两次', audio_plan: { ...shot.audio_plan, sound_effects: ['两次啪啪声'] }, expected_video_source_version: version }
  const failed = await app.inject({ method: 'PATCH', url: `/api/shots/${shot.id}`, payload })
  assert.equal(failed.statusCode, 500); assert.equal(required<any>('shots', shot.id).video_prompt, shot.video_prompt)
  db.exec('DROP TRIGGER fail_audio')
  const saved = await app.inject({ method: 'PATCH', url: `/api/shots/${shot.id}`, payload })
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().video_prompt, '闪烁两次')
  assert.deepEqual(saved.json().audio_plan, payload.audio_plan)
  const stale = await app.inject({ method: 'PATCH', url: `/api/shots/${shot.id}`, payload: { ...payload, video_prompt: '旧窗口覆盖' } })
  assert.equal(stale.statusCode, 409); assert.equal(required<any>('shots', shot.id).video_prompt, '闪烁两次')
})
