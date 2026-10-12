import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-speech-routes-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface SpeechLine {
  id: string; project_id: string; text: string; instructions: string; context_text: string;
  scene_id: string | null; voice_id: string | null; selected_asset_id?: string | null;
  takes?: Array<{ id: string; asset_id: string | null; status: string }>
}
interface SpeechState {
  voices: Array<{ id: string; name: string; speaker: string; speech_rate: number; instructions: string }>
  lines: SpeechLine[]
}
const stockSpeaker = 'zh_female_vv_uranus_bigtts'
const alternateStockSpeaker = 'zh_male_m191_uranus_bigtts'
const secret = 'speech-route-test-secret-DO-NOT-EXPOSE'

async function call<T = any>(method: Method, url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function rejected(method: Method, url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body)
  return response
}
async function project(name = '配音测试') {
  const value = await call<{ id: string }>('POST', '/api/projects', { name })
  return { ...value, url: `/api/projects/${value.id}/speech` }
}
async function line(url: string, overrides: Partial<SpeechLine> = {}) {
  return call<SpeechLine>('POST', `${url}/lines`, { text: '别过去，我会想办法。', ...overrides })
}
async function bindVoice(url: string, name = '林晚', speakerId = stockSpeaker, speechRate = 0) {
  const previous = (await call<SpeechState>('GET', url)).voices.find(item => item.name === name)
  if (previous) await call('PATCH', `${url}/voices/${previous.id}`, { speaker: speakerId, speech_rate: speechRate })
  else await call('POST', `${url}/voices`, { name, speaker: speakerId, speech_rate: speechRate })
  const state = await call<SpeechState>('GET', url)
  const voice = state.voices.find(item => item.name === name)!
  for (const item of state.lines.filter(item => !item.voice_id || item.voice_id === voice.id)) {
    await call('PATCH', `${url}/lines/${item.id}`, { voice_id: voice.id })
  }
  return voice
}
async function queue(url: string, lineId: string) {
  const result = await call<{ job: { id: string; status: string } }>('POST', `${url}/lines/${lineId}/generate`, {})
  assert.ok(result.job?.id, 'generation returns the queued job')
  assert.equal(result.job.status, 'queued')
  return result.job
}
function jobRequest(jobId: string) {
  const row = one<{ request: string; status: string }>('SELECT request,status FROM jobs WHERE id=?', jobId)!
  return { ...row, request: JSON.parse(row.request) }
}
function fixtureTake(projectId: string, lineId: string, assetId: string, kind = 'audio', takeId = `${assetId}-take`) {
  const stamp = now()
  run(`INSERT INTO assets (id,project_id,kind,filename,path,source,created_at)
    VALUES (?,?,?,?,?,'generated',?)`, assetId, projectId, kind, `${assetId}.wav`, join(testData, `${assetId}.wav`), stamp)
  run(`INSERT INTO speech_takes (id,line_id,project_id,asset_id,job_id,settings,text,duration_ms,created_at)
    VALUES (?,?,?,?,NULL,?,?,?,?)`, takeId, lineId, projectId, assetId, JSON.stringify({ speaker: stockSpeaker }), '候选台词', 2000, stamp)
  return takeId
}

test('speech configuration encrypts the key and never returns it through public config or project responses', async () => {
  const empty = await call<{ has_key: boolean }>('GET', '/api/speech/config')
  assert.equal(empty.has_key, false)
  const saved = await call<{ has_key: boolean }>('PUT', '/api/speech/config', { api_key: secret })
  assert.equal(saved.has_key, true)
  const persisted = one<{ key_ciphertext: string }>("SELECT key_ciphertext FROM speech_config WHERE id='default'")!
  assert.ok(persisted.key_ciphertext)
  assert.notEqual(persisted.key_ciphertext, secret)
  assert.equal(persisted.key_ciphertext.includes(secret), false)
  await rejected('PUT', '/api/speech/config', { default_speaker: 'S_paid_clone_voice' })
  assert.equal(one<{ key_ciphertext: string }>("SELECT key_ciphertext FROM speech_config WHERE id='default'")!.key_ciphertext, persisted.key_ciphertext)
  const restarted = buildApp()
  try {
    const config = await restarted.inject({ method: 'GET', url: '/api/speech/config' })
    assert.equal(config.statusCode, 200, config.body)
    assert.equal(config.json().has_key, true)
    assert.equal(config.body.includes(secret), false)
    assert.equal(config.body.includes('key_ciphertext'), false)
    assert.equal(config.body.includes('api_key'), false)
    const p = await project()
    const state = await restarted.inject({ method: 'GET', url: p.url })
    assert.equal(state.statusCode, 200, state.body)
    assert.equal(state.body.includes(secret), false)
    assert.equal(state.body.includes(persisted.key_ciphertext), false)
  } finally { await restarted.close() }
})

test('line CRUD preserves spoken text, performance instructions and ownership', async () => {
  const p = await project(), other = await project('另一个项目')
  const scene = await call<{ id: string }>('POST', `/api/projects/${p.id}/script/scenes`, { heading: '地下站厅' })
  const voice = await bindVoice(p.url)
  const created = await line(p.url, { scene_id: scene.id, voice_id: voice.id, instructions: '压低声音，担心但坚定', context_text: '陈默：出口塌了。' })
  assert.ok(created.id)
  let stored = (await call<SpeechState>('GET', p.url)).lines.find(item => item.id === created.id)!
  assert.equal(stored.text, '别过去，我会想办法。')
  assert.equal(stored.instructions, '压低声音，担心但坚定')
  assert.equal(stored.context_text, '陈默：出口塌了。')
  assert.equal(stored.scene_id, scene.id)
  assert.equal(stored.voice_id, voice.id)
  assert.deepEqual((await call<SpeechState>('GET', other.url)).lines, [])
  await rejected('PATCH', `${other.url}/lines/${created.id}`, { text: '不能跨项目修改' })
  await rejected('DELETE', `${other.url}/lines/${created.id}`)
  await call('PATCH', `${p.url}/lines/${created.id}`, { text: '站在这里等我。', instructions: '坚定，不要喊叫' })
  stored = (await call<SpeechState>('GET', p.url)).lines.find(item => item.id === created.id)!
  assert.equal(stored.text, '站在这里等我。')
  assert.equal(stored.instructions, '坚定，不要喊叫')
  assert.equal(stored.context_text, '陈默：出口塌了。')
  await call('DELETE', `${p.url}/lines/${created.id}`)
  assert.deepEqual((await call<SpeechState>('GET', p.url)).lines, [])
})

test('blank drafts remain editable while invalid performance values and foreign references are rejected', async () => {
  const p = await project(), other = await project()
  const foreignScene = await call<{ id: string }>('POST', `/api/projects/${other.id}/script/scenes`, { heading: '外部场次' })
  const foreignVoice = await bindVoice(other.url)
  const base = { text: '有效台词' }
  for (const invalid of [{ position: -1 }, { position: 1.5 }, { scene_id: foreignScene.id }, { voice_id: foreignVoice.id }]) {
    await rejected('POST', `${p.url}/lines`, { ...base, ...invalid })
  }
  const created = await line(p.url)
  await call('PATCH', `${p.url}/lines/${created.id}`, { text: '' })
  assert.equal((await call<SpeechState>('GET', p.url)).lines[0]?.text, '')
  await rejected('PATCH', `${p.url}/lines/${created.id}`, { scene_id: foreignScene.id })
  await rejected('PATCH', `${p.url}/lines/${created.id}`, { voice_id: foreignVoice.id })
  assert.equal((await call<SpeechState>('GET', p.url)).lines[0]?.text, '')
  const blank = await line(p.url, { text: '' })
  const voice = await bindVoice(p.url)
  for (const speech_rate of [-51, 101, 1.5]) await rejected('PATCH', `${p.url}/voices/${voice.id}`, { speech_rate })
  await rejected('POST', `${p.url}/lines/${blank.id}/generate`, {})
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', p.id).length, 0)
})

test('standard voices bind independently per project and reject paid clone speaker IDs', async () => {
  const p = await project(), other = await project()
  await bindVoice(p.url)
  const state = await call<SpeechState>('GET', p.url)
  assert.equal(state.voices.find(voice => voice.name === '林晚')?.speaker, stockSpeaker)
  assert.equal((await call<SpeechState>('GET', other.url)).voices.some(voice => voice.name === '林晚'), false)
  await rejected('POST', `${p.url}/voices`, { name: '新角色', speaker: 'S_paid_clone_voice' })
  await rejected('POST', `${p.url}/voices`, { name: '新角色', speaker: '' })
  await rejected('POST', `${p.url}/voices`, { name: '', speaker: stockSpeaker })
  await rejected('PATCH', `${p.url}/voices/${state.voices.find(voice => voice.name === '林晚')!.id}`, { speaker: 'S_paid_clone_voice' })
  await rejected('PATCH', `${other.url}/voices/${state.voices.find(voice => voice.name === '林晚')!.id}`, { speaker: alternateStockSpeaker })
  assert.equal((await call<SpeechState>('GET', p.url)).voices.find(voice => voice.name === '林晚')?.speaker, stockSpeaker)
  const voiceId = state.voices.find(voice => voice.name === '林晚')!.id
  await call('PATCH', `${p.url}/voices/${voiceId}`, { instructions: '自然克制，声音偏低', speech_rate: -20 })
  await call('PATCH', `${p.url}/voices/${voiceId}`, { speaker: alternateStockSpeaker })
  const edited = (await call<SpeechState>('GET', p.url)).voices.find(voice => voice.id === voiceId)!
  assert.equal(edited.name, '林晚')
  assert.equal(edited.instructions, '自然克制，声音偏低')
  assert.equal(edited.speech_rate, -20)
})

test('script import is explicit, conservative and idempotent without generating any audio', async () => {
  const p = await project(), other = await project()
  const scene = await call<{ id: string }>('POST', `/api/projects/${p.id}/script/scenes`, {
    heading: '地下站厅',
    dialogue: '林晚：别过去。\n我们得离开这里。\n陈默: 我会守住出口。',
    narration: '灯光熄灭，站厅陷入寂静。',
  })
  const foreign = await call<{ id: string }>('POST', `/api/projects/${other.id}/script/scenes`, { heading: '外部场次', dialogue: '别人：不可导入' })
  await call('POST', `${p.url}/import`, { scene_ids: [scene.id] })
  const imported = await call<SpeechState>('GET', p.url)
  const first = imported.lines
  const roleName = (item: SpeechLine | undefined) => imported.voices.find(voice => voice.id === item?.voice_id)?.name
  assert.equal(roleName(first.find(item => item.text === '别过去。')), '林晚')
  assert.equal(roleName(first.find(item => item.text === '我会守住出口。')), '陈默')
  assert.equal(roleName(first.find(item => item.text === '我们得离开这里。')), '待分配角色')
  const narration = first.find(item => item.text === '灯光熄灭，站厅陷入寂静。')!
  assert.equal(roleName(narration), '旁白')
  assert.ok(first.every(item => item.scene_id === scene.id))
  await call('POST', `${p.url}/import`, { scene_ids: [scene.id] })
  assert.deepEqual((await call<SpeechState>('GET', p.url)).lines.map(item => item.id).sort(), first.map(item => item.id).sort())
  await rejected('POST', `${p.url}/import`, { scene_ids: [scene.id, foreign.id] })
  assert.deepEqual((await call<SpeechState>('GET', p.url)).lines.map(item => item.id).sort(), first.map(item => item.id).sort())
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', p.id).length, 0)
  assert.equal(all('SELECT id FROM assets WHERE project_id=?', p.id).length, 0)
})

test('generation requires a key and a resolved role with a bound standard voice', async () => {
  const p = await project()
  const created = await line(p.url)
  await bindVoice(p.url)
  run("UPDATE speech_config SET key_ciphertext=NULL WHERE id='default'")
  try {
    await rejected('POST', `${p.url}/lines/${created.id}/generate`, {})
    assert.equal(all('SELECT id FROM jobs WHERE project_id=?', p.id).length, 0)
  } finally { await call('PUT', '/api/speech/config', { api_key: secret }) }
  const unresolvedVoice = await bindVoice(p.url, '待分配角色')
  const unresolved = await line(p.url, { voice_id: unresolvedVoice.id, text: '我是谁说的？' })
  await rejected('POST', `${p.url}/lines/${unresolved.id}/generate`, {})
  const unbound = await line(p.url, { text: '我还没有选择声音。' })
  await rejected('POST', `${p.url}/lines/${unbound.id}/generate`, {})
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', p.id).length, 0)
})

test('generation snapshots the literal line, voice and performance without exposing credentials', async () => {
  const p = await project(), other = await project()
  const created = await line(p.url, { text: '站在这里等我。', instructions: '克制地安慰对方', context_text: '陈默：我很害怕。' })
  await bindVoice(p.url, '林晚', stockSpeaker, -15)
  await rejected('POST', `${other.url}/lines/${created.id}/generate`, {})
  const job = await queue(p.url, created.id)
  const snapshot = jobRequest(job.id)
  assert.equal(snapshot.status, 'queued')
  assert.equal(snapshot.request.tts.text, '站在这里等我。')
  assert.equal(snapshot.request.tts.speaker, stockSpeaker)
  assert.equal(snapshot.request.tts.instructions, '克制地安慰对方')
  assert.equal(snapshot.request.tts.context_text, '陈默：我很害怕。')
  assert.equal(snapshot.request.tts.speech_rate, -15)
  assert.equal(JSON.stringify(snapshot.request).includes(secret), false)
  assert.equal(all('SELECT id FROM assets WHERE project_id=?', p.id).length, 0, 'enqueue does not synthesize remotely')
  const queuedTake = (await call<SpeechState>('GET', p.url)).lines.find(item => item.id === created.id)?.takes?.[0]
  assert.equal(queuedTake?.status, 'queued')
  assert.equal(queuedTake?.asset_id, null)
  run("UPDATE jobs SET status='failed' WHERE id=?", job.id)
  await call('PATCH', `${p.url}/lines/${created.id}`, { text: '修改后的台词', instructions: '更坚定' })
  await bindVoice(p.url, '林晚', alternateStockSpeaker)
  assert.deepEqual(jobRequest(job.id).request, snapshot.request, 'later edits cannot change an earlier request')
  const next = await queue(p.url, created.id)
  assert.equal(jobRequest(next.id).request.tts.text, '修改后的台词')
  assert.equal(jobRequest(next.id).request.tts.speaker, alternateStockSpeaker)
  const state = await call<SpeechState>('GET', p.url)
  assert.equal(state.lines.find(item => item.id === created.id)?.takes?.length, 2)
})

test('repeated generate clicks cannot create another queued or running speech job', async () => {
  const p = await project()
  const created = await line(p.url)
  await bindVoice(p.url)
  const job = await queue(p.url, created.id)
  await rejected('POST', `${p.url}/lines/${created.id}/generate`, {})
  run("UPDATE jobs SET status='running' WHERE id=?", job.id)
  await rejected('POST', `${p.url}/lines/${created.id}/generate`, {})
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', p.id).length, 1)
  run("UPDATE jobs SET status='failed' WHERE id=?", job.id)
  const retry = await queue(p.url, created.id)
  assert.notEqual(retry.id, job.id)
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', p.id).length, 2)
})

test('only an audio take belonging to the requested line and project can be selected', async () => {
  const p = await project(), other = await project()
  const first = await line(p.url), second = await line(p.url, { text: '第二句对白' }), foreign = await line(other.url)
  fixtureTake(p.id, first.id, 'speech-own-audio')
  fixtureTake(p.id, second.id, 'speech-other-line-audio')
  fixtureTake(other.id, foreign.id, 'speech-foreign-audio')
  fixtureTake(p.id, first.id, 'speech-own-image', 'image')
  await rejected('POST', `${p.url}/lines/${first.id}/select`, { asset_id: 'speech-other-line-audio' })
  await rejected('POST', `${p.url}/lines/${first.id}/select`, { asset_id: 'speech-foreign-audio' })
  await rejected('POST', `${p.url}/lines/${first.id}/select`, { asset_id: 'speech-own-image' })
  await call('POST', `${p.url}/lines/${first.id}/select`, { asset_id: 'speech-own-audio' })
  const state = await call<SpeechState>('GET', p.url)
  const selected = state.lines.find(item => item.id === first.id)!
  assert.equal(selected.selected_asset_id, 'speech-own-audio')
  assert.ok(selected.takes?.some(take => take.asset_id === 'speech-own-audio'))
  assert.equal(state.lines.find(item => item.id === second.id)?.selected_asset_id, null)
})

test('project deletion cascades voices, lines and takes while retaining other project speech and global config', async () => {
  const p = await project(), kept = await project()
  const removedLine = await line(p.url), keptLine = await line(kept.url)
  await bindVoice(p.url)
  await bindVoice(kept.url)
  fixtureTake(p.id, removedLine.id, 'speech-deletion-audio')
  fixtureTake(kept.id, keptLine.id, 'speech-kept-audio')
  const expected = await call<SpeechState>('GET', kept.url)
  await call('DELETE', `/api/projects/${p.id}`)
  for (const table of ['speech_voices', 'speech_lines', 'speech_takes']) {
    assert.deepEqual(all(`SELECT * FROM ${table} WHERE project_id=?`, p.id), [])
  }
  assert.deepEqual(await call<SpeechState>('GET', kept.url), expected)
  assert.equal((await call<{ has_key: boolean }>('GET', '/api/speech/config')).has_key, true)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  await rejected('GET', p.url)
})
