import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'

const directory = await mkdtemp(join(tmpdir(), 'speech-final-cut-scope-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { initSpeechTimeline, speechExportPlan } = await import('../src/modules/speech/speech-timeline.js')
const { resolveFinalCutScope } = await import('../src/modules/final-cut/final-cut-scope.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const audioFile = join(directory, 'voice.wav'), stillFile = join(directory, 'still.png')
const audio = spawnSync(ffmpegPath!, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', audioFile], { encoding: 'utf8', timeout: 30000 })
assert.equal(audio.status, 0, audio.stderr)
await writeFile(stillFile, await sharp({ create: { width: 80, height: 45, channels: 3, background: '#37352f' } }).png().toBuffer())

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function denied(method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, response.body)
  return response
}
async function fixture(oldDesign = false) {
  const project = await call('POST', '/api/projects', { name: '配音方案隔离' })
  const root = `/api/projects/${project.id}`, speech = `${root}/speech`
  const [originalCanvas] = await call('GET', `${root}/canvases`)
  const oldShot = await call('POST', `${root}/shots`, { title: '原方案', duration: 3 })
  const newCanvas = await call('POST', `${root}/canvases`, { name: '新分镜方案' })
  const newDesignId = newId(), oldDesignId = oldDesign ? newId() : null
  for (const [id, canvas] of [[oldDesignId, originalCanvas], [newDesignId, newCanvas]] as const) {
    if (id) run('INSERT INTO storyboard_designs (id,project_id,canvas_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?,?)', id, project.id, canvas.id, canvas.name, '[]', '', now())
  }
  const newShot = await call('POST', `${root}/shots`, { title: '新方案', duration: 3 })
  run('UPDATE shots SET design_id=?,superseded_by=? WHERE id=?', oldDesignId, newDesignId, oldShot.id)
  run('UPDATE shots SET design_id=? WHERE id=?', newDesignId, newShot.id)
  for (const shot of [oldShot, newShot]) {
    const id = newId()
    run("INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,'image','still.png',?,'upload',?)", id, project.id, shot.id, stillFile, now())
    run('UPDATE shots SET selected_asset_id=? WHERE id=?', id, shot.id)
    run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,in_ms,out_ms,source_duration_ms) VALUES (?,?,?,?,0,3000,NULL)', newId(), project.id, shot.id, id)
  }
  const voice = await call('POST', `${speech}/voices`, { name: '旁白', speaker: 'zh_female_vv_uranus_bigtts' })
  const line = await call('POST', `${speech}/lines`, { text: '两套方案共享这一句旁白。', voice_id: voice.id })
  const assetId = newId()
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'audio','voice.wav',?,'generated',?)", assetId, project.id, audioFile, now())
  run('INSERT INTO speech_takes (id,line_id,project_id,asset_id,settings,text,duration_ms,created_at) VALUES (?,?,?,?,?,?,1000,?)', newId(), line.id, project.id, assetId,
    JSON.stringify({ speaker: voice.speaker, instructions: '', context_text: '', speech_rate: 0 }), line.text, now())
  await call('POST', `${speech}/lines/${line.id}/select`, { asset_id: assetId })
  const placement = `${speech}/lines/${line.id}/placement`
  const inCanvas = (path: string, canvasId: string) => `${path}?canvas_id=${canvasId}`
  return { project, root, speech, line, assetId, placement, oldShot, newShot, originalCanvas, newCanvas, oldDesignId, newDesignId, inCanvas }
}

test('legacy placement migration keeps its original design, audio, trim and identity, and is repeatable', async () => {
  const f = await fixture(true), id = newId(), stamp = now()
  db.exec(`DROP TABLE speech_placements;
    CREATE TABLE speech_placements (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      line_id TEXT NOT NULL UNIQUE REFERENCES speech_lines(id) ON DELETE CASCADE,
      shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      offset_ms INTEGER NOT NULL DEFAULT 0, in_ms INTEGER NOT NULL DEFAULT 0,
      out_ms INTEGER NOT NULL, gain REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );`)
  run('INSERT INTO speech_placements VALUES (?,?,?,?,?,?,?,?,?,?)', id, f.project.id, f.line.id, f.oldShot.id, f.assetId, 250, 100, 900, 0.7, stamp)
  initSpeechTimeline()
  const migrated = one<any>('SELECT * FROM speech_placements WHERE id=?', id)!
  assert.equal(migrated.scope_key, f.oldDesignId)
  assert.deepEqual([migrated.shot_id, migrated.asset_id, migrated.offset_ms, migrated.in_ms, migrated.out_ms, migrated.gain, migrated.updated_at], [f.oldShot.id, f.assetId, 250, 100, 900, 0.7, stamp])
  assert.equal((await call('GET', f.inCanvas(f.speech, f.originalCanvas.id))).placements[0].id, id)
  assert.deepEqual((await call('GET', f.inCanvas(f.speech, f.newCanvas.id))).placements, [])
  await call('PUT', f.inCanvas(f.placement, f.newCanvas.id), { shot_id: f.newShot.id, offset_ms: 500 })
  assert.equal(all('SELECT * FROM speech_placements WHERE line_id=?', f.line.id).length, 2)
  assert.deepEqual(one('SELECT * FROM speech_placements WHERE id=?', id), migrated)
  initSpeechTimeline()
  assert.deepEqual(one('SELECT * FROM speech_placements WHERE id=?', id), migrated)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('one shared line has independent placement per canvas, including historical legacy shots and exports', async () => {
  const f = await fixture()
  const oldPath = f.inCanvas(f.placement, f.originalCanvas.id), newPath = f.inCanvas(f.placement, f.newCanvas.id)
  const oldPlacement = await call('PUT', oldPath, { shot_id: f.oldShot.id, offset_ms: 200 })
  const initialNew = await call('GET', f.inCanvas(f.speech, f.newCanvas.id))
  assert.equal(initialNew.lines[0].selected_asset_id, f.assetId, 'audio candidate and role remain shared')
  assert.deepEqual(initialNew.placements, [], 'a new plan does not inherit the old playback position')
  const newPlacement = await call('PUT', newPath, { shot_id: f.newShot.id, offset_ms: 800, gain: 0.6 })
  assert.notEqual(newPlacement.id, oldPlacement.id)
  const oldDetail = await call('GET', f.inCanvas(f.root, f.originalCanvas.id))
  assert.equal(oldDetail.shots[0].superseded_by, f.newDesignId)
  assert.equal(oldDetail.speech.placements[0].offset_ms, 200)
  const scope = resolveFinalCutScope(f.project.id, f.originalCanvas.id)
  const plan = speechExportPlan(f.project.id, scope.shots, scope.clips, f.originalCanvas.id)
  assert.equal(plan.issues.length, 0)
  assert.equal(plan.audio[0]!.start_ms, 200)
  const oldExport = JSON.parse((await call('POST', f.inCanvas(`${f.root}/export`, f.originalCanvas.id), {})).request)
  const newExport = JSON.parse((await call('POST', f.inCanvas(`${f.root}/export`, f.newCanvas.id), {})).request)
  assert.equal(oldExport.speech_audio[0].shot_id, f.oldShot.id)
  assert.equal(oldExport.speech_audio[0].start_ms, 200)
  assert.equal(newExport.speech_audio[0].shot_id, f.newShot.id)
  assert.equal(newExport.speech_audio[0].start_ms, 800)
  await call('DELETE', newPath)
  assert.deepEqual((await call('GET', f.inCanvas(f.speech, f.newCanvas.id))).placements, [])
  assert.equal((await call('GET', f.inCanvas(f.speech, f.originalCanvas.id))).placements[0].id, oldPlacement.id)
})

test('canvas read, write and deletion reject foreign scope and shots without touching other placements', async () => {
  const f = await fixture(), foreign = await fixture()
  await call('PUT', f.inCanvas(f.placement, f.originalCanvas.id), { shot_id: f.oldShot.id })
  await call('PUT', f.inCanvas(f.placement, f.newCanvas.id), { shot_id: f.newShot.id })
  const before = all('SELECT * FROM speech_placements WHERE project_id=? ORDER BY id', f.project.id)
  await denied('GET', f.inCanvas(f.speech, foreign.newCanvas.id))
  await denied('PUT', f.inCanvas(f.placement, foreign.newCanvas.id), { shot_id: f.newShot.id })
  await denied('DELETE', f.inCanvas(f.placement, foreign.newCanvas.id))
  await denied('PUT', f.inCanvas(f.placement, f.newCanvas.id), { shot_id: f.oldShot.id })
  await denied('PUT', f.inCanvas(f.placement, f.originalCanvas.id), { shot_id: f.newShot.id })
  await denied('GET', `${f.speech}?canvas_id=`)
  assert.deepEqual(all('SELECT * FROM speech_placements WHERE project_id=? ORDER BY id', f.project.id), before)
})

test('unscoped clients continue using active placements while preserving historical plans', async () => {
  const f = await fixture()
  const old = await call('PUT', f.inCanvas(f.placement, f.originalCanvas.id), { shot_id: f.oldShot.id, offset_ms: 100 })
  await denied('PUT', f.placement, { shot_id: f.oldShot.id })
  await call('PUT', f.placement, { shot_id: f.newShot.id, offset_ms: 300 })
  const active = await call('GET', f.speech)
  assert.equal(active.placements.length, 1)
  assert.equal(active.placements[0].shot_id, f.newShot.id)
  await call('DELETE', f.placement)
  assert.deepEqual((await call('GET', f.speech)).placements, [])
  assert.equal((await call('GET', f.inCanvas(f.speech, f.originalCanvas.id))).placements[0].id, old.id)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('a deleted historical anchor remains recoverable only inside its own scheme', async () => {
  const f = await fixture(true)
  const old = await call('PUT', f.inCanvas(f.placement, f.originalCanvas.id), { shot_id: f.oldShot.id })
  run('DELETE FROM shots WHERE id=?', f.oldShot.id)
  const historical = await call('GET', f.inCanvas(f.speech, f.originalCanvas.id))
  assert.equal(historical.placements[0].id, old.id)
  assert.equal(historical.placements[0].shot_id, null)
  assert.equal(historical.lines[0].takes[0].asset_id, f.assetId)
  assert.deepEqual((await call('GET', f.inCanvas(f.speech, f.newCanvas.id))).placements, [])
  assert.deepEqual((await call('GET', f.speech)).placements, [])
  const scope = resolveFinalCutScope(f.project.id, f.originalCanvas.id)
  assert.match(speechExportPlan(f.project.id, scope.shots, scope.clips, f.originalCanvas.id).issues[0]!.message, /镜头已不存在/)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
