import { ProviderExecutionError } from '../src/infrastructure/providers/provider-failure.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validVideo } from './fixtures/valid-video.js'
import { validateVideoResult } from '../src/infrastructure/media/media-result-validation.js'
import { withMediaExecution, MediaDownloadError } from '../src/infrastructure/providers/media-execution.js'

const directory = await mkdtemp(join(tmpdir(), 'validated-video-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { recoverVideo } = await import('../src/infrastructure/providers/providers.js')
test('a real complete MP4 has decoded frames and positive duration', async () => {
 const path = join(directory, 'valid.mp4'); await writeFile(path, validVideo)
 const result = await validateVideoResult(path)
 assert.equal(result.frames, 3); assert.ok(result.duration_ms > 0)
})
test('HTML, JSON, empty, corrupt, truncated and audio-only results cannot be delivered as video', async t => {
 const wav = Buffer.alloc(44 + 960); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
 wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24)
 wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(960, 40)
 for (const [name, bytes] of [['html', Buffer.from('<html>gateway error</html>')], ['json', Buffer.from('{"error":"not ready"}')],
  ['empty', Buffer.alloc(0)], ['corrupt', Buffer.from('bad video')], ['truncated', validVideo.subarray(0, validVideo.length / 2)], ['audio', wav]] as const) {
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } }))
  await assert.rejects(recoverVideo(name, 'https://cdn.invalid/result.mp4?signature=secret'), issue => issue instanceof ProviderExecutionError && issue.reason === 'media_validation' && issue.delivery === 'completed')
  assert.deepEqual(await readdir(join(directory, 'media', name)), [])
  t.mock.restoreAll()
 }
})
test('download errors retain only structured safe HTTP status and a decode abort preserves its reason', async t => {
 t.mock.method(globalThis, 'fetch', async () => new Response('expired', { status: 403 }))
 await assert.rejects(recoverVideo('expiry', 'https://cdn.invalid/video?secret=private'), error => {
  assert.ok(error instanceof MediaDownloadError); assert.equal(error.http_status, 403); assert.doesNotMatch(String(error), /private/); return true
 })
 const controller = new AbortController(), reason = new Error('user stopped probe')
 const path = join(directory, 'valid.mp4')
 const pending = withMediaExecution({ signal: controller.signal }, () => validateVideoResult(path))
 controller.abort(reason); await assert.rejects(pending, issue => issue === reason)
 await assert.rejects(validateVideoResult(path, { timeoutMs: 0 }), /超时/)
})
test.after(() => rm(directory, { recursive: true, force: true }))
