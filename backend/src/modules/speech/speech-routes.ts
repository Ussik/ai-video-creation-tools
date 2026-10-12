import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { all, db, newId, now, one, required, run } from '../../infrastructure/database/db.js'
import type { Asset, Job, ScriptScene } from '../../infrastructure/database/db.js'
import { decryptKey, encryptKey } from '../../infrastructure/security/secrets.js'
import { parseSpeechSceneEntries } from './speech-import.js'

export const standardSpeaker = 'zh_female_vv_uranus_bigtts'
interface SpeechConfig { id: string; enabled: number; key_ciphertext: string | null; default_speaker: string; speech_rate: number }
interface Voice { id: string; project_id: string; name: string; speaker: string; instructions: string; speech_rate: number; created_at: string; updated_at: string }
interface Line { id: string; project_id: string; voice_id: string | null; scene_id: string | null; position: number; text: string; instructions: string; context_text: string; selected_asset_id: string | null; source_key: string | null; created_at: string; updated_at: string }
interface Take { id: string; line_id: string; project_id: string; asset_id: string | null; job_id: string | null; settings: string; text: string; duration_ms: number | null; metadata: string; created_at: string }
export interface SpeechSnapshot { line_id: string; take_id: string; text: string; speaker: string; instructions: string; context_text: string; speech_rate: number }
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }
const speakerInput = z.string().trim().min(1).max(180).regex(/^[a-zA-Z0-9_-]+$/).refine(value => !/^S_/i.test(value), '请选择官方标准音色；当前不支持声音复刻音色')
const rate = z.number().int().min(-50).max(100)
const voiceInput = z.object({ name: z.string().trim().min(1).max(80), speaker: speakerInput, instructions: z.string().max(2000).default(''), speech_rate: rate.default(0) }).strict()
const lineInput = z.object({ voice_id: z.string().min(1).nullable().default(null), scene_id: z.string().min(1).nullable().default(null), text: z.string().max(5000).default(''), instructions: z.string().max(2000).default(''), context_text: z.string().max(5000).default(''), position: z.number().int().min(0).max(100000).optional() }).strict()
const voicePatch = z.object({name:voiceInput.shape.name.optional(),speaker:speakerInput.optional(),instructions:z.string().max(2000).optional(),speech_rate:rate.optional()}).strict()
const linePatch = z.object({voice_id:z.string().min(1).nullable().optional(),scene_id:z.string().min(1).nullable().optional(),text:z.string().max(5000).optional(),instructions:z.string().max(2000).optional(),context_text:z.string().max(5000).optional(),position:lineInput.shape.position}).strict()

export function initSpeechTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS speech_config (
      id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, key_ciphertext TEXT,
      default_speaker TEXT NOT NULL DEFAULT '${standardSpeaker}', speech_rate INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO speech_config (id) VALUES ('default');
    CREATE TABLE IF NOT EXISTS speech_voices (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, speaker TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      speech_rate INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id,name)
    );
    CREATE TABLE IF NOT EXISTS speech_lines (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      voice_id TEXT REFERENCES speech_voices(id) ON DELETE SET NULL,
      scene_id TEXT REFERENCES script_scenes(id) ON DELETE SET NULL,
      position INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
      context_text TEXT NOT NULL DEFAULT '', selected_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      source_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id,source_key)
    );
    CREATE TABLE IF NOT EXISTS speech_takes (
      id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES speech_lines(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      settings TEXT NOT NULL, text TEXT NOT NULL, duration_ms INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS speech_lines_project ON speech_lines(project_id,position);
    CREATE INDEX IF NOT EXISTS speech_takes_line ON speech_takes(line_id);
  `)
}
function configRow(): SpeechConfig { return one<SpeechConfig>("SELECT * FROM speech_config WHERE id='default'")! }
export function speechConfigPublic() {
  const config = configRow()
  return { enabled: Boolean(config.enabled), has_key: Boolean(config.key_ciphertext), default_speaker: config.default_speaker,
    speech_rate: config.speech_rate, endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', resource_id: 'seed-tts-2.0' }
}
export function speechCredentials(): string {
  const config = configRow()
  if (!config.enabled || !config.key_ciphertext) fail('请先启用语音服务并配置语音 API Key。')
  return decryptKey(config.key_ciphertext)
}
function scopedLine(projectId: string, id: string): Line {
  return one<Line>('SELECT * FROM speech_lines WHERE project_id=? AND id=?', projectId, id) || fail('台词不存在', 404)
}
function scopedVoice(projectId: string, id: string): Voice {
  return one<Voice>('SELECT * FROM speech_voices WHERE project_id=? AND id=?', projectId, id) || fail('角色声音不存在', 404)
}
function project(id: string): void { required('projects', id) }
function linePublic(line: Line) {
  const takes = all<Take>('SELECT * FROM speech_takes WHERE line_id=? ORDER BY created_at DESC, rowid DESC', line.id).map(take => {
    const job = take.job_id ? one<Job>('SELECT * FROM jobs WHERE id=?', take.job_id) : null
    const asset = take.asset_id ? one<Asset>('SELECT * FROM assets WHERE id=?', take.asset_id) : null
    const settings = JSON.parse(take.settings) as SpeechSnapshot
    return { id: take.id, line_id: take.line_id, job_id: take.job_id, asset_id: take.asset_id, text: take.text,
      speaker: settings.speaker, instructions: settings.instructions || '', context_text: settings.context_text || '', speech_rate: settings.speech_rate || 0,
      status: job?.status || (asset ? 'succeeded' : 'failed'), error: job?.error || null, duration_ms: take.duration_ms,
      metadata: JSON.parse(take.metadata), created_at: take.created_at, url: asset ? `/api/assets/${asset.id}/file` : null, filename: asset?.filename || null }
  })
  const { source_key: _sourceKey, ...fields } = line
  return { ...fields, takes }
}
function validateReferences(projectId: string, fields: {voice_id?: string | null; scene_id?: string | null}): void {
  if (fields.voice_id) scopedVoice(projectId, fields.voice_id)
  if (fields.scene_id && !one('SELECT 1 FROM script_scenes WHERE project_id=? AND id=?', projectId, fields.scene_id)) fail('场次不属于当前项目', 404)
}
function lineBusy(id: string): boolean {
  return Boolean(one("SELECT 1 FROM speech_takes t JOIN jobs j ON j.id=t.job_id WHERE t.line_id=? AND j.status IN ('queued','running')", id))
}
export function completeSpeechJob(job: Job, assetId: string, durationMs: number | null, metadata: object): void {
  const snapshot = (JSON.parse(job.request) as {tts?: SpeechSnapshot}).tts
  if (!snapshot) return
  run('UPDATE speech_takes SET asset_id=?, duration_ms=?, metadata=? WHERE id=? AND job_id=? AND project_id=?', assetId, durationMs, JSON.stringify(metadata), snapshot.take_id, job.id, job.project_id)
  // A generated take is a candidate. Selection is always the user's decision.
}

export function registerSpeechRoutes(app: FastifyInstance, deps: {touchProject: (id:string)=>void; jobPublic: (job:Job)=>unknown}): void {
  initSpeechTables()
  app.get('/api/speech/config', async () => speechConfigPublic())
  app.put('/api/speech/config', async request => {
    const input = z.object({ enabled: z.boolean().optional(), api_key: z.string().trim().max(2000).refine(value => !/[\r\n]/.test(value)).optional(), clear_key: z.boolean().optional(), default_speaker: speakerInput.optional(), speech_rate: rate.optional() }).strict().parse(request.body)
    const old = configRow()
    if (input.clear_key && input.api_key) fail('清除密钥和设置密钥不能同时使用')
    run("UPDATE speech_config SET enabled=?,key_ciphertext=?,default_speaker=?,speech_rate=? WHERE id='default'", input.enabled === undefined ? old.enabled : Number(input.enabled), input.clear_key ? null : input.api_key ? encryptKey(input.api_key) : old.key_ciphertext, input.default_speaker || old.default_speaker, input.speech_rate ?? old.speech_rate)
    return speechConfigPublic()
  })
  app.get<{Params:{projectId:string}}>('/api/projects/:projectId/speech', async request => {
    const {projectId} = request.params; project(projectId)
    return { voices: all<Voice>('SELECT * FROM speech_voices WHERE project_id=? ORDER BY created_at,rowid', projectId), lines: all<Line>('SELECT * FROM speech_lines WHERE project_id=? ORDER BY position,rowid', projectId).map(linePublic) }
  })
  app.post<{Params:{projectId:string}}>('/api/projects/:projectId/speech/voices', async request => {
    const {projectId} = request.params; project(projectId)
    const input = voiceInput.parse(request.body)
    if (one('SELECT 1 FROM speech_voices WHERE project_id=? AND name=?', projectId, input.name)) fail('该角色已有声音配置',409)
    const id = newId(), stamp = now()
    run('INSERT INTO speech_voices (id,project_id,name,speaker,instructions,speech_rate,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', id, projectId, input.name, input.speaker, input.instructions, input.speech_rate, stamp, stamp)
    deps.touchProject(projectId); return scopedVoice(projectId,id)
  })
  app.patch<{Params:{projectId:string;voiceId:string}}>('/api/projects/:projectId/speech/voices/:voiceId', async request => {
    const {projectId,voiceId} = request.params; const old = scopedVoice(projectId,voiceId)
    const input = voicePatch.parse(request.body), value = {...old,...input}
    if (one('SELECT 1 FROM speech_voices WHERE project_id=? AND name=? AND id<>?',projectId,value.name,voiceId)) fail('该角色已有声音配置',409)
    run('UPDATE speech_voices SET name=?,speaker=?,instructions=?,speech_rate=?,updated_at=? WHERE id=?',value.name,value.speaker,value.instructions,value.speech_rate,now(),voiceId)
    deps.touchProject(projectId); return scopedVoice(projectId,voiceId)
  })
  app.delete<{Params:{projectId:string;voiceId:string}}>('/api/projects/:projectId/speech/voices/:voiceId', async request => {
    const {projectId,voiceId} = request.params; scopedVoice(projectId,voiceId)
    if (one('SELECT 1 FROM speech_lines WHERE voice_id=?',voiceId)) fail('该角色还有台词，请先更换台词的角色声音',409)
    run('DELETE FROM speech_voices WHERE id=?',voiceId); deps.touchProject(projectId); return {ok:true}
  })
  app.post<{Params:{projectId:string}}>('/api/projects/:projectId/speech/lines', async request => {
    const {projectId} = request.params; project(projectId)
    const input = lineInput.parse(request.body); validateReferences(projectId,input)
    const id = newId(), stamp = now(), position = input.position ?? (one<{pos:number}>('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM speech_lines WHERE project_id=?', projectId)!.pos)
    run('INSERT INTO speech_lines (id,project_id,voice_id,scene_id,position,text,instructions,context_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',id,projectId,input.voice_id,input.scene_id,position,input.text,input.instructions,input.context_text,stamp,stamp)
    deps.touchProject(projectId); return linePublic(scopedLine(projectId,id))
  })
  app.patch<{Params:{projectId:string;lineId:string}}>('/api/projects/:projectId/speech/lines/:lineId', async request => {
    const {projectId,lineId} = request.params; const old = scopedLine(projectId,lineId)
    const input = linePatch.parse(request.body); validateReferences(projectId,input)
    const value = {...old,...input}
    run('UPDATE speech_lines SET voice_id=?,scene_id=?,position=?,text=?,instructions=?,context_text=?,updated_at=? WHERE id=?',value.voice_id,value.scene_id,value.position,value.text,value.instructions,value.context_text,now(),lineId)
    deps.touchProject(projectId); return linePublic(scopedLine(projectId,lineId))
  })
  app.delete<{Params:{projectId:string;lineId:string}}>('/api/projects/:projectId/speech/lines/:lineId', async request => {
    const {projectId,lineId} = request.params; scopedLine(projectId,lineId)
    if (lineBusy(lineId)) fail('该台词正在生成，请完成后再删除',409)
    run('DELETE FROM speech_lines WHERE id=?',lineId); deps.touchProject(projectId); return {ok:true}
  })
  app.post<{Params:{projectId:string;lineId:string}}>('/api/projects/:projectId/speech/lines/:lineId/generate', async request => {
    const {projectId,lineId} = request.params; const line = scopedLine(projectId,lineId)
    z.object({}).strict().parse(request.body || {})
    if (!line.text.trim()) fail('请输入需要合成的台词或旁白')
    if (!line.voice_id) fail('请先为台词选择角色声音')
    const voice = scopedVoice(projectId,line.voice_id!)
    if (voice.name === '待分配角色') fail('请先确认说话人并为台词选择角色声音')
    speakerInput.parse(voice.speaker); speechCredentials()
    if (lineBusy(lineId)) fail('该台词已有正在处理的生成任务',409)
    const jobId = newId(), takeId = newId(), stamp = now()
    const snapshot: SpeechSnapshot = {line_id:lineId,take_id:takeId,text:line.text,speaker:voice.speaker,instructions:[voice.instructions,line.instructions].filter(Boolean).join('\n'),context_text:line.context_text,speech_rate:voice.speech_rate}
    const payload = {tts:snapshot,prompt:line.text,modality:'audio',voice_name:voice.name}
    db.transaction(() => {
      run("INSERT INTO jobs (id,project_id,job_type,request,status,created_at,updated_at) VALUES (?,?,'generation',?,'queued',?,?)",jobId,projectId,JSON.stringify(payload),stamp,stamp)
      run('INSERT INTO speech_takes (id,line_id,project_id,job_id,settings,text,created_at) VALUES (?,?,?,?,?,?,?)',takeId,lineId,projectId,jobId,JSON.stringify(snapshot),line.text,stamp)
      deps.touchProject(projectId)
    })()
    return {job:deps.jobPublic(required<Job>('jobs',jobId))}
  })
  app.post<{Params:{projectId:string;lineId:string}}>('/api/projects/:projectId/speech/lines/:lineId/select', async request => {
    const {projectId,lineId} = request.params; scopedLine(projectId,lineId)
    const {asset_id} = z.object({asset_id:z.string().min(1)}).strict().parse(request.body)
    const take = one<Take>('SELECT * FROM speech_takes WHERE project_id=? AND line_id=? AND asset_id=?',projectId,lineId,asset_id)
    const asset = one<Asset>('SELECT * FROM assets WHERE id=? AND project_id=? AND kind=\'audio\'',asset_id,projectId)
    const job = take?.job_id ? one<Job>('SELECT * FROM jobs WHERE id=?',take.job_id) : null
    if (!take || !asset || (job && job.status !== 'succeeded')) fail('请选择当前台词已完成的音频候选')
    run('UPDATE speech_lines SET selected_asset_id=?,updated_at=? WHERE id=?',asset_id,now(),lineId)
    run('INSERT OR IGNORE INTO saved_assets (asset_id,project_id,created_at) VALUES (?,?,?)',asset_id,projectId,now())
    deps.touchProject(projectId); return linePublic(scopedLine(projectId,lineId))
  })
  app.post<{Params:{projectId:string}}>('/api/projects/:projectId/speech/import', async request => {
    const {projectId} = request.params; project(projectId)
    const input = z.object({scene_ids:z.array(z.string().min(1)).min(1).max(1000).optional()}).strict().parse(request.body || {})
    const scenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY episode_number,position,rowid',projectId)
    if (input.scene_ids?.some(id => !scenes.some(scene => scene.id===id))) fail('场次不属于当前项目',404)
    let added = 0, skipped = 0
    db.transaction(() => {
      let position = one<{pos:number}>('SELECT COALESCE(MAX(position),-1)+1 AS pos FROM speech_lines WHERE project_id=?', projectId)!.pos
      for (const scene of scenes.filter(scene => !input.scene_ids || input.scene_ids.includes(scene.id))) {
        const entries = parseSpeechSceneEntries(scene)
        for (const entry of entries) {
          const sourceKey = createHash('sha256').update(JSON.stringify([entry.key,entry.name,entry.text,entry.instructions])).digest('hex')
          if (one('SELECT 1 FROM speech_lines WHERE project_id=? AND source_key=?',projectId,sourceKey)) { skipped++; continue }
          let voice = one<Voice>('SELECT * FROM speech_voices WHERE project_id=? AND name=?',projectId,entry.name)
          const stamp = now()
          if (!voice) {
            const cfg = configRow(), id = newId()
            run('INSERT INTO speech_voices (id,project_id,name,speaker,instructions,speech_rate,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',id,projectId,entry.name,cfg.default_speaker,'',cfg.speech_rate,stamp,stamp)
            voice = scopedVoice(projectId,id)
          }
          lineInput.parse({voice_id:voice.id,scene_id:scene.id,text:entry.text,instructions:entry.instructions})
          run('INSERT INTO speech_lines (id,project_id,voice_id,scene_id,position,text,instructions,context_text,source_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',newId(),projectId,voice.id,scene.id,position++,entry.text,entry.instructions,'',sourceKey,stamp,stamp); added++
        }
      }
      if (added) deps.touchProject(projectId)
    })()
    return {added,skipped}
  })
}
