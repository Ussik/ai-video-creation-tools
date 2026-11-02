import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { defaultAudioMix, isSpeechTakeCurrent, resolveSpeechTimeline, type AudioMixSettings, type SpeechLineDraft, type SpeechPlacement, type SpeechVoice } from '@video-studio/shared/media/speech-timeline'
import { all, db, newId, now, one, required, run } from '../../infrastructure/database/db.js'
import type { Shot, TimelineClip } from '../../infrastructure/database/db.js'
import { probeSpeechDurationMs } from './speech-audio.js'
import { speechSourceStatus } from './speech-sync.js'
import { finalCutCanvasId, resolveFinalCutScope } from '../final-cut/final-cut-scope.js'

interface StoredPlacement extends Omit<SpeechPlacement, 'text' | 'voice_name' | 'stale'> { scope_key: string }
interface PlacementLine extends SpeechLineDraft { id: string; selected_asset_id: string | null; source_key: string | null; source_snapshot: string | null; archived: number }
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }) }

export function initSpeechTimeline(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS speech_placements (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    line_id TEXT NOT NULL REFERENCES speech_lines(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL DEFAULT '',
    shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    offset_ms INTEGER NOT NULL DEFAULT 0, in_ms INTEGER NOT NULL DEFAULT 0,
    out_ms INTEGER NOT NULL, gain REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, UNIQUE(line_id,scope_key)
  );
  CREATE TABLE IF NOT EXISTS project_audio_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    music_gain REAL NOT NULL DEFAULT 0.24, duck_music INTEGER NOT NULL DEFAULT 1,
    duck_source INTEGER NOT NULL DEFAULT 1
  );`)
  const columns = db.pragma('table_info(speech_placements)') as Array<{ name: string }>
  if (!columns.some(column => column.name === 'scope_key')) {
    // The former line_id UNIQUE constraint would overwrite another plan's
    // placement. Rebuild atomically and retain each original shot's plan.
    db.transaction(() => {
      db.exec(`CREATE TABLE speech_placements_scoped (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        line_id TEXT NOT NULL REFERENCES speech_lines(id) ON DELETE CASCADE,
        scope_key TEXT NOT NULL DEFAULT '', shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        offset_ms INTEGER NOT NULL DEFAULT 0, in_ms INTEGER NOT NULL DEFAULT 0,
        out_ms INTEGER NOT NULL, gain REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        UNIQUE(line_id,scope_key)
      );
      INSERT INTO speech_placements_scoped (id,project_id,line_id,scope_key,shot_id,asset_id,offset_ms,in_ms,out_ms,gain,updated_at)
        SELECT id,project_id,line_id,COALESCE((SELECT design_id FROM shots WHERE shots.id=speech_placements.shot_id),''),
          shot_id,asset_id,offset_ms,in_ms,out_ms,gain,updated_at FROM speech_placements;
      DROP TABLE speech_placements;
      ALTER TABLE speech_placements_scoped RENAME TO speech_placements;`)
    }).immediate()
  }
  db.exec('CREATE INDEX IF NOT EXISTS speech_placements_project ON speech_placements(project_id)')
}

export function projectAudioSettings(projectId: string): AudioMixSettings {
  const settings = one<{ music_gain: number; duck_music: number; duck_source: number }>('SELECT * FROM project_audio_settings WHERE project_id=?', projectId)
  return settings ? { music_gain: settings.music_gain, duck_music: !!settings.duck_music, duck_source: !!settings.duck_source } : { ...defaultAudioMix }
}

export function projectSpeechPlacements(projectId: string, canvasId?: string): SpeechPlacement[] {
  const scope = resolveFinalCutScope(projectId, canvasId)
  const shotIds = new Set(scope.shots.map(shot => shot.id))
  const placements = canvasId === undefined
    ? all<StoredPlacement>('SELECT * FROM speech_placements WHERE project_id=? ORDER BY rowid', projectId)
      .filter(placement => placement.shot_id ? shotIds.has(placement.shot_id) : placement.scope_key === '')
    : all<StoredPlacement>('SELECT * FROM speech_placements WHERE project_id=? AND scope_key=? ORDER BY rowid', projectId, scope.designId || '')
  return placements.map(({ scope_key: _scopeKey, ...placement }) => {
    const line = one<PlacementLine>('SELECT * FROM speech_lines WHERE id=?', placement.line_id)!
    const voice = line.voice_id ? one<SpeechVoice>('SELECT * FROM speech_voices WHERE id=?', line.voice_id) : undefined
    const take = one<{ text: string; settings: string }>('SELECT text,settings FROM speech_takes WHERE line_id=? AND asset_id=?', line.id, placement.asset_id)
    const snapshot = take ? { ...JSON.parse(take.settings), text: take.text } : null
    return { ...placement, text: take?.text || line.text, voice_name: voice?.name || '待分配角色',
      stale: line.selected_asset_id !== placement.asset_id || !snapshot || !isSpeechTakeCurrent(snapshot, line, voice) || ['changed', 'removed'].includes(speechSourceStatus(line)) }
  })
}

export function speechExportPlan(projectId: string, shots: Shot[], clips: TimelineClip[], canvasId?: string) {
  return resolveSpeechTimeline(shots, clips, projectSpeechPlacements(projectId, canvasId))
}

export function registerSpeechTimelineRoutes(app: FastifyInstance, touchProject: (id: string) => void): void {
  initSpeechTimeline()
  const placementInput = z.object({ shot_id: z.string().min(1), offset_ms: z.number().int().min(-600000).max(600000).default(0),
    in_ms: z.number().int().min(0).default(0), out_ms: z.number().int().min(1).optional(), gain: z.number().min(0).max(2).default(1) }).strict()
  app.put<{ Params: { projectId: string; lineId: string } }>('/api/projects/:projectId/speech/lines/:lineId/placement', async request => {
    const { projectId, lineId } = request.params
    const canvasId = finalCutCanvasId(request.query)
    const scope = resolveFinalCutScope(projectId, canvasId)
    const input = placementInput.parse(request.body)
    const line = one<PlacementLine>('SELECT * FROM speech_lines WHERE project_id=? AND id=?', projectId, lineId) || fail('台词不存在', 404)
    if (['changed', 'removed'].includes(speechSourceStatus(line))) fail('请先同步剧本变化，或保留为手动台词')
    if (!one('SELECT 1 FROM shots WHERE project_id=? AND id=? AND deleted_at IS NULL', projectId, input.shot_id)) fail('入片镜头不属于当前项目', 404)
    const shot = scope.shots.find(item => item.id === input.shot_id) || fail('入片镜头不属于当前成片方案', 422)
    const scopeKey = shot.design_id || ''
    const take = one<{ text: string; settings: string; duration_ms: number | null }>('SELECT text,settings,duration_ms FROM speech_takes WHERE project_id=? AND line_id=? AND asset_id=?', projectId, lineId, line.selected_asset_id) || fail('请先选用已完成的配音')
    const voice = line.voice_id ? one<SpeechVoice>('SELECT * FROM speech_voices WHERE id=?', line.voice_id) : undefined
    if (!take || !isSpeechTakeCurrent({ ...JSON.parse(take.settings), text: take.text }, line, voice)) fail('请先选用与当前台词和声音设置一致的配音')
    const asset = one<{ path: string }>("SELECT path FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL AND kind='audio'", line.selected_asset_id, projectId) || fail('配音素材不存在', 404)
    const duration = await probeSpeechDurationMs(asset.path).catch(() => fail('配音素材无法读取或解码，请重新生成可用音频'))
    const latest = one<PlacementLine>('SELECT * FROM speech_lines WHERE project_id=? AND id=?', projectId, lineId)
    const currentVoice = latest?.voice_id ? one<SpeechVoice>('SELECT * FROM speech_voices WHERE id=?', latest.voice_id) : undefined
    if (!latest || latest.selected_asset_id !== line.selected_asset_id || ['changed', 'removed'].includes(speechSourceStatus(latest)) ||
      !resolveFinalCutScope(projectId, canvasId).shots.some(item => item.id === input.shot_id && (item.design_id || '') === scopeKey) ||
      !isSpeechTakeCurrent({ ...JSON.parse(take.settings), text: take.text }, latest, currentVoice)) fail('校验期间剧本、声音或镜头已变化，请刷新后重新设置', 409)
    const outMs = input.out_ms ?? duration
    if (input.in_ms >= outMs || outMs > duration) fail('配音取段超出音频时长，出点必须晚于入点')
    run('UPDATE speech_takes SET duration_ms=? WHERE line_id=? AND asset_id=?', duration, lineId, line.selected_asset_id)
    run(`INSERT INTO speech_placements (id,project_id,line_id,scope_key,shot_id,asset_id,offset_ms,in_ms,out_ms,gain,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(line_id,scope_key) DO UPDATE SET shot_id=excluded.shot_id,
      asset_id=excluded.asset_id,offset_ms=excluded.offset_ms,in_ms=excluded.in_ms,out_ms=excluded.out_ms,gain=excluded.gain,updated_at=excluded.updated_at`,
      newId(), projectId, lineId, scopeKey, input.shot_id, line.selected_asset_id, input.offset_ms, input.in_ms, outMs, input.gain, now())
    touchProject(projectId)
    return projectSpeechPlacements(projectId, canvasId).find(item => item.line_id === lineId && item.shot_id === input.shot_id)
  })
  app.delete<{ Params: { projectId: string; lineId: string } }>('/api/projects/:projectId/speech/lines/:lineId/placement', async request => {
    const { projectId, lineId } = request.params
    const canvasId = finalCutCanvasId(request.query)
    const scope = resolveFinalCutScope(projectId, canvasId)
    if (!one('SELECT 1 FROM speech_lines WHERE project_id=? AND id=?', projectId, lineId)) fail('台词不存在', 404)
    if (canvasId !== undefined) run('DELETE FROM speech_placements WHERE project_id=? AND line_id=? AND scope_key=?', projectId, lineId, scope.designId || '')
    else {
      const ids = projectSpeechPlacements(projectId).filter(item => item.line_id === lineId).map(item => item.id)
      db.transaction(() => { for (const id of ids) run('DELETE FROM speech_placements WHERE id=? AND project_id=?', id, projectId) })()
    }
    touchProject(projectId)
    return { ok: true }
  })
  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/audio-settings', async request => {
    const { projectId } = request.params
    required('projects', projectId)
    const value = z.object({ music_gain: z.number().min(0).max(1), duck_music: z.boolean(), duck_source: z.boolean(),
      ratio: z.enum(['16:9', '9:16']).optional(), music_asset_id: z.string().min(1).nullable().optional() }).strict().parse(request.body)
    if (value.music_asset_id && !one("SELECT 1 FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL AND kind='audio'", value.music_asset_id, projectId)) fail('配乐素材不属于当前项目或不是音频')
    db.transaction(() => {
      run(`INSERT INTO project_audio_settings (project_id,music_gain,duck_music,duck_source) VALUES (?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET music_gain=excluded.music_gain,duck_music=excluded.duck_music,duck_source=excluded.duck_source`,
        projectId, value.music_gain, Number(value.duck_music), Number(value.duck_source))
      if (value.ratio !== undefined) run('UPDATE projects SET ratio=? WHERE id=?', value.ratio, projectId)
      if (value.music_asset_id !== undefined) run('UPDATE projects SET music_asset_id=? WHERE id=?', value.music_asset_id, projectId)
    })()
    touchProject(projectId)
    return projectAudioSettings(projectId)
  })
}
