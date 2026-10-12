import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-speech-worker-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp, startWorker } = await import('../src/app.js')
const { all, db, initDb, mediaDir, one, run } = await import('../src/infrastructure/database/db.js')
const { probeSpeechDurationMs } = await import('../src/modules/speech/speech-audio.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

const secret = 'speech-worker-only-fake-api-key'
const stockSpeaker = 'zh_female_vv_uranus_bigtts'
const encoded = spawnSync(ffmpegPath!, [
  '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.8',
  '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1',
], { timeout: 15_000, maxBuffer: 1024 * 1024 })
assert.equal(encoded.status, 0, encoded.stderr.toString())
const audio = encoded.stdout
assert.ok(audio.length > 100)

async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function setup() {
  await call('PUT', '/api/speech/config', { api_key: secret })
  const p = await call<{ id: string }>('POST', '/api/projects', { name: '离线配音任务' })
  const url = `/api/projects/${p.id}/speech`
  const voice = await call<{ id: string }>('POST', `${url}/voices`, { name: '林晚', speaker: stockSpeaker, instructions: '低沉但温柔', speech_rate: -8 })
  const line = await call<{ id: string }>('POST', `${url}/lines`, {
    voice_id: voice.id, text: '我会一直陪着你。', instructions: '最后几个字轻声说', context_text: '陈默：你会离开吗？',
  })
  const { job } = await call<{ job: { id: string } }>('POST', `${url}/lines/${line.id}/generate`, {})
  return { p, url, voice, line, job }
}
function stream(messages: object[]): Response {
  const bytes = new TextEncoder().encode(messages.map(message => JSON.stringify(message)).join('\n') + '\n')
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 127) controller.enqueue(bytes.slice(offset, offset + 127))
      controller.close()
    },
  }), { headers: { 'content-type': 'application/json' } })
}
async function finished(jobId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const job = one<{ status: string; result_asset_id: string | null; error: string | null; request: string }>('SELECT status,result_asset_id,error,request FROM jobs WHERE id=?', jobId)!
    if (job.status === 'succeeded' || job.status === 'failed') return job
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('mock speech job did not complete within five seconds')
}

test('worker saves an audio candidate and measured duration from the queued snapshot without auto-selecting it', async t => {
  const f = await setup()
  const requests: Array<{ url: string; init: RequestInit; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) })
    return stream([
      { code: 0, data: audio.subarray(0, 1000).toString('base64'), sentence: { words: [{ word: '我会', startTime: 0, endTime: 0.3 }] } },
      { code: 0, data: audio.subarray(1000).toString('base64') },
      { code: 20_000_000, usage: { text_words: 8 } },
    ])
  })
  // Edits after enqueue affect later candidates, never the in-flight request.
  await call('PATCH', `${f.url}/lines/${f.line.id}`, { text: '这是修改后的下一版台词。', instructions: '更坚定' })
  await call('PATCH', `${f.url}/voices/${f.voice.id}`, { speaker: 'zh_male_m191_uranus_bigtts', speech_rate: 20 })
  const stop = startWorker()
  try {
    const job = await finished(f.job.id)
    assert.equal(job.status, 'succeeded', job.error || '')
    assert.ok(job.result_asset_id)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
    const headers = new Headers(requests[0]!.init.headers)
    assert.equal(headers.get('X-Api-Key'), secret)
    assert.equal(headers.get('X-Api-Resource-Id'), 'seed-tts-2.0')
    const request = requests[0]!.body.req_params
    assert.equal(request.text, '我会一直陪着你。')
    assert.equal(request.speaker, stockSpeaker)
    assert.equal(request.audio_params.speech_rate, -8)
    assert.match(request.additions, /低沉但温柔/)
    assert.match(request.additions, /最后几个字轻声说/)
    assert.match(request.additions, /陈默：你会离开吗/)
    const asset = one<{ kind: string; source: string; path: string; prompt: string }>('SELECT kind,source,path,prompt FROM assets WHERE id=?', job.result_asset_id)!
    assert.equal(asset.kind, 'audio')
    assert.equal(asset.source, 'generated')
    assert.equal(asset.prompt, '我会一直陪着你。')
    assert.deepEqual(await readFile(asset.path), audio)
    const take = one<{ asset_id: string; text: string; settings: string; metadata: string; duration_ms: number }>('SELECT asset_id,text,settings,metadata,duration_ms FROM speech_takes WHERE job_id=?', f.job.id)!
    assert.equal(take.asset_id, job.result_asset_id)
    assert.equal(take.text, '我会一直陪着你。')
    assert.equal(JSON.parse(take.settings).speaker, stockSpeaker)
    assert.ok(take.duration_ms >= 700 && take.duration_ms <= 1200, `actual MP3 duration was ${take.duration_ms}`)
    const metadata = JSON.parse(take.metadata)
    assert.deepEqual(metadata.subtitles, [{ text: '我会', start_ms: 0, end_ms: 300 }])
    assert.equal(metadata.usage_characters, 8)
    assert.equal(metadata.request_id, headers.get('X-Api-Request-Id'))
    assert.equal(JSON.stringify({ job, take }).includes(secret), false)
    const state = await call<{ lines: Array<{ id: string; selected_asset_id: string | null; takes: Array<{ status: string; url: string }> }> }>('GET', f.url)
    const line = state.lines.find(item => item.id === f.line.id)!
    assert.equal(line.selected_asset_id, null)
    assert.equal(line.takes[0]?.status, 'succeeded')
    assert.equal(all('SELECT * FROM saved_assets WHERE project_id=?', f.p.id).length, 0)
    const file = await app.inject({ method: 'GET', url: line.takes[0]!.url })
    assert.equal(file.statusCode, 200)
    assert.match(file.headers['content-type'] || '', /audio\/mpeg/)
    assert.deepEqual(file.rawPayload, audio)
  } finally { stop() }
})

test('provider stream failure produces a failed candidate, no asset and no automatic or generic retry', async t => {
  const f = await setup()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return stream([
      { code: 0, data: audio.toString('base64') },
      { code: 45_000_001, message: `provider private details ${secret}` },
    ])
  })
  const stop = startWorker()
  try {
    const job = await finished(f.job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.result_asset_id, null)
    assert.match(job.error || '', /45000001/)
    assert.equal((job.error || '').includes(secret), false)
    assert.equal(all('SELECT * FROM assets WHERE project_id=?', f.p.id).length, 0)
    const state = await call<{ lines: Array<{ takes: Array<{ status: string; error: string; asset_id: string | null }> }> }>('GET', f.url)
    assert.equal(state.lines[0]?.takes[0]?.status, 'failed')
    assert.equal(state.lines[0]?.takes[0]?.asset_id, null)
    assert.equal(state.lines[0]?.takes[0]?.error.includes(secret), false)
    const retry = await app.inject({ method: 'POST', url: `/api/jobs/${f.job.id}/retry`, payload: {} })
    assert.equal(retry.statusCode, 422, retry.body)
    await new Promise(resolve => setTimeout(resolve, 1150))
    assert.equal(requests, 1)
    assert.equal(all('SELECT id FROM jobs WHERE project_id=?', f.p.id).length, 1)
  } finally { stop() }
})

test('a success marker with an undecodable audio payload cannot produce a successful asset', async t => {
  const f = await setup()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return stream([{ code: 0, data: Buffer.from('this-is-not-an-mp3').toString('base64') }, { code: 20_000_000 }])
  })
  const stop = startWorker()
  try {
    const job = await finished(f.job.id)
    assert.equal(job.status, 'failed')
    assert.equal(job.result_asset_id, null)
    assert.match(job.error || '', /有效音频|解码/)
    assert.equal(requests, 1)
    assert.equal(all('SELECT * FROM assets WHERE project_id=?', f.p.id).length, 0)
    assert.equal(one<{ asset_id: string | null }>('SELECT asset_id FROM speech_takes WHERE job_id=?', f.job.id)?.asset_id, null)
    assert.deepEqual(await readdir(join(mediaDir, f.p.id)).catch(() => []), [], 'invalid downloaded files are removed')
  } finally { stop() }
})

test('audio duration probe rejects missing or non-audio media and measures a playable MP3', async () => {
  const valid = join(testData, 'probe.mp3'), invalid = join(testData, 'invalid.mp3')
  await writeFile(valid, audio)
  await writeFile(invalid, 'invalid audio')
  const duration = await probeSpeechDurationMs(valid)
  assert.ok(duration >= 700 && duration <= 1200)
  await assert.rejects(probeSpeechDurationMs(invalid), /有效音频|解码/)
  await assert.rejects(probeSpeechDurationMs(join(testData, 'missing.mp3')), /有效音频|解码/)
})

test('restart fails interrupted speech without resubmission and leaves unstarted queued speech intact', async () => {
  const interrupted = await setup(), unstarted = await setup()
  run("UPDATE jobs SET status='running' WHERE id=?", interrupted.job.id)
  const queuedRequest = one<{ request: string }>('SELECT request FROM jobs WHERE id=?', unstarted.job.id)!.request
  initDb()
  const stopped = one<{ status: string; error: string; result_asset_id: string | null }>('SELECT status,error,result_asset_id FROM jobs WHERE id=?', interrupted.job.id)!
  assert.equal(stopped.status, 'failed')
  assert.equal(stopped.result_asset_id, null)
  assert.match(stopped.error, /重启中断.*可能已计费/)
  assert.deepEqual(one('SELECT status,request FROM jobs WHERE id=?', unstarted.job.id), { status: 'queued', request: queuedRequest })
  const state = await call<{ lines: Array<{ takes: Array<{ status: string; error: string }> }> }>('GET', interrupted.url)
  assert.equal(state.lines[0]?.takes[0]?.status, 'failed')
  assert.match(state.lines[0]?.takes[0]?.error || '', /重启中断/)
  const retry = await app.inject({ method: 'POST', url: `/api/jobs/${interrupted.job.id}/retry`, payload: {} })
  assert.equal(retry.statusCode, 422, retry.body)
  assert.equal(all('SELECT * FROM assets WHERE project_id=?', interrupted.p.id).length, 0)
})
