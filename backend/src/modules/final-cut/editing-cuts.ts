import { existsSync, statSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { wrapEditingCutCaption, type EditingCut, type EditingCutInput } from '@video-studio/shared/media/editing-cut'
import { defaultAudioMix, type SpeechAudioClip } from '@video-studio/shared/media/speech-timeline'
import { all, db, newId, now, one, required, run, type Asset, type Job, type Project } from '../../infrastructure/database/db.js'
import { invalid } from '../../infrastructure/http/request.js'
import { probeVideoDurationMs, type RenderClip } from '../../infrastructure/media/render.js'
import { canvasRecord } from '../canvas/project-canvases.js'
import { probeSpeechDurationMs } from '../speech/speech-audio.js'

const maxDuration = 6 * 60 * 60 * 1000
const id = z.string().trim().min(1).max(120)
const time = z.number().int().min(0).max(maxDuration)
const params = z.object({ id, cutId: id })
const clipSchema = z.object({
  id, asset_id: id, title: z.string().max(160), in_ms: time, out_ms: time,
  source_audio_gain: z.number().min(0).max(2), source_audio_fade_ms: z.number().int().min(0).max(500),
}).strict()
const speechSchema = z.object({
  id, asset_id: id, label: z.string().max(500), start_ms: time, in_ms: time, out_ms: time,
  gain: z.number().min(0).max(2),
}).strict()
const captionSchema = z.object({ id, start_ms: time, end_ms: time, text: z.string().trim().min(1).max(1000) }).strict()
const inputSchema = z.object({
  name: z.string().trim().min(1).max(120), source_canvas_id: id.nullable(), revision: z.number().int().min(1),
  ratio: z.enum(['16:9', '9:16']), clips: z.array(clipSchema).max(500), speech: z.array(speechSchema).max(1000),
  music_asset_id: id.nullable(), audio_settings: z.object({
    music_gain: z.number().min(0).max(1), duck_music: z.boolean(), duck_source: z.boolean(),
  }).strict(), captions: z.array(captionSchema).max(1000),
}).strict()

interface CutRecord {
  id: string; project_id: string; name: string; source_canvas_id: string | null; revision: number
  document: string; created_at: string; updated_at: string
}
type CutDocument = Pick<EditingCut, 'ratio' | 'clips' | 'speech' | 'music_asset_id' | 'audio_settings' | 'captions'>
const document = (cut: CutDocument): CutDocument => ({ ratio: cut.ratio, clips: cut.clips, speech: cut.speech,
  music_asset_id: cut.music_asset_id, audio_settings: cut.audio_settings, captions: cut.captions })
function publicCut(row: CutRecord): EditingCut {
  const { document: stored, ...metadata } = row
  return { ...JSON.parse(stored) as CutDocument, ...metadata }
}
function cutRecord(projectId: string, cutId: string): CutRecord {
  required<Project>('projects', projectId)
  const row = one<CutRecord>('SELECT * FROM editing_cuts WHERE id=? AND project_id=?', cutId, projectId)
  if (!row) throw Object.assign(new Error('剪辑稿不存在'), { statusCode: 404 })
  return row
}
function assertRevision(row: CutRecord, revision: number): void {
  if (row.revision !== revision) throw Object.assign(new Error('剪辑稿已在其他窗口更新，请刷新后再操作'), { statusCode: 409 })
}

const audioDurationCache = new Map<string, number>()
async function audioDuration(asset: Asset): Promise<number> {
  const file = statSync(asset.path)
  const key = `${asset.path}:${file.size}:${file.mtimeMs}`
  const cached = audioDurationCache.get(key)
  if (cached !== undefined) return cached
  let duration: number
  try { duration = await probeSpeechDurationMs(asset.path) }
  catch { invalid(`音频「${asset.filename}」无法解码，请更换素材`) }
  if (audioDurationCache.size >= 128) audioDurationCache.clear()
  audioDurationCache.set(key, duration)
  return duration
}

/** Validate independent references without changing shots, speech selections or project settings. */
async function validateCut(projectId: string, cut: EditingCutInput, exporting: boolean): Promise<RenderClip[]> {
  if (cut.source_canvas_id) canvasRecord(projectId, cut.source_canvas_id)
  const assets = new Map(all<Asset>('SELECT * FROM assets WHERE project_id=? AND deleted_at IS NULL', projectId).map(asset => [asset.id, asset]))
  function assetFor(assetId: string, kinds: Asset['kind'][], label: string): Asset {
    const asset = assets.get(assetId)
    if (!asset || !kinds.includes(asset.kind)) invalid(`${label}必须使用当前项目的${kinds.includes('video') ? '图片或视频' : '音频'}素材`)
    if (!existsSync(asset.path)) invalid(`${label}的素材文件不存在，请更换素材`)
    return asset
  }
  for (const [label, items] of [['画面', cut.clips], ['配音', cut.speech], ['字幕', cut.captions]] as const) {
    if (new Set(items.map(item => item.id)).size !== items.length) invalid(`${label}片段 ID 不能重复`)
  }
  let totalMs = 0
  const renderClips = cut.clips.map(clip => {
    const name = clip.title || '未命名片段'
    const asset = assetFor(clip.asset_id, ['image', 'video'], `片段「${name}」`)
    if (clip.out_ms - clip.in_ms < 200) invalid(`片段「${name}」时长至少为 0.2 秒`)
    let sourceDuration: number | null = null
    if (asset.kind === 'image') {
      if (clip.in_ms !== 0) invalid(`图片「${name}」的入点必须为 0`)
    } else {
      try { sourceDuration = probeVideoDurationMs(asset.path) }
      catch { invalid(`片段「${name}」无法读取视频时长，请更换素材`) }
      if (clip.out_ms > sourceDuration) invalid(`片段「${name}」的出点超出视频实际时长`)
    }
    totalMs += clip.out_ms - clip.in_ms
    return { ...clip, source_duration_ms: sourceDuration }
  })
  if (totalMs > maxDuration) invalid('剪辑稿总时长不能超过 6 小时')
  if (exporting && !cut.clips.length) invalid('请先添加至少一个画面片段')
  for (const audio of cut.speech) {
    const name = audio.label || '配音'
    const asset = assetFor(audio.asset_id, ['audio'], `配音「${name}」`)
    if (audio.out_ms <= audio.in_ms) invalid(`配音「${name}」的取段区间无效`)
    if (audio.out_ms > await audioDuration(asset)) invalid(`配音「${name}」的出点超出音频实际时长`)
    if (exporting && audio.start_ms + audio.out_ms - audio.in_ms > totalMs) invalid(`配音「${name}」超出成片时长，请调整播放位置或取段`)
  }
  if (cut.music_asset_id) await audioDuration(assetFor(cut.music_asset_id, ['audio'], '背景音乐'))
  for (const caption of cut.captions) {
    if (caption.end_ms <= caption.start_ms) invalid('字幕结束时间必须晚于开始时间')
    if (exporting && caption.end_ms > totalMs) invalid(`字幕「${caption.text.slice(0, 20)}」超出成片时长，请调整显示时间`)
    if (exporting && wrapEditingCutCaption(caption.text, cut.ratio).split('\n').length > 4) invalid('字幕过长，请拆分成多条字幕（每条最多4行）')
  }
  return renderClips
}

export function registerEditingCutRoutes(app: FastifyInstance): void {
  const base = '/api/projects/:id/editing-cuts'
  app.get(base, async request => {
    const { id: projectId } = z.object({ id }).parse(request.params)
    required<Project>('projects', projectId)
    return { cuts: all<CutRecord>('SELECT * FROM editing_cuts WHERE project_id=? ORDER BY updated_at DESC, id', projectId).map(publicCut) }
  })
  app.get(`${base}/:cutId`, async request => {
    const { id: projectId, cutId } = params.parse(request.params)
    return publicCut(cutRecord(projectId, cutId))
  })
  app.post(base, async request => {
    const { id: projectId } = z.object({ id }).parse(request.params)
    const project = required<Project>('projects', projectId)
    const data = z.object({ name: z.string().trim().min(1).max(120), source_canvas_id: id.nullable().optional(), ratio: z.enum(['16:9', '9:16']).optional() }).strict().parse(request.body)
    if (data.source_canvas_id) canvasRecord(projectId, data.source_canvas_id)
    const cutId = newId(), timestamp = now()
    const initial: CutDocument = { ratio: data.ratio ?? project.ratio, clips: [], speech: [], music_asset_id: null,
      audio_settings: { ...defaultAudioMix }, captions: [] }
    run(`INSERT INTO editing_cuts (id, project_id, name, source_canvas_id, revision, document, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`, cutId, projectId, data.name, data.source_canvas_id ?? null, JSON.stringify(initial), timestamp, timestamp)
    return publicCut(cutRecord(projectId, cutId))
  })
  app.put(`${base}/:cutId`, async request => {
    const { id: projectId, cutId } = params.parse(request.params)
    const data: EditingCutInput = inputSchema.parse(request.body)
    assertRevision(cutRecord(projectId, cutId), data.revision)
    await validateCut(projectId, data, false)
    return db.transaction(() => {
      assertRevision(cutRecord(projectId, cutId), data.revision)
      run(`UPDATE editing_cuts SET name=?, source_canvas_id=?, revision=revision+1, document=?, updated_at=? WHERE id=? AND project_id=? AND revision=?`,
        data.name, data.source_canvas_id, JSON.stringify(document(data)), now(), cutId, projectId, data.revision)
      return publicCut(cutRecord(projectId, cutId))
    }).immediate()
  })
  app.post(`${base}/:cutId/export`, async request => {
    const { id: projectId, cutId } = params.parse(request.params)
    const { revision } = z.object({ revision: z.number().int().min(1) }).strict().parse(request.body)
    const row = cutRecord(projectId, cutId)
    assertRevision(row, revision)
    const cut = publicCut(row)
    const clips = await validateCut(projectId, cut, true)
    const speech: SpeechAudioClip[] = cut.speech.map(audio => ({ ...audio, project_id: projectId, line_id: audio.id,
      shot_id: null, offset_ms: audio.start_ms, text: audio.label, voice_name: audio.label, stale: false,
      end_ms: audio.start_ms + audio.out_ms - audio.in_ms }))
    return db.transaction(() => {
      assertRevision(cutRecord(projectId, cutId), revision)
      const jobId = newId(), timestamp = now()
      const snapshot = { editing_cut_id: cut.id, editing_cut_revision: cut.revision, editing_cut_name: cut.name,
        project: { id: projectId, ratio: cut.ratio, music_asset_id: cut.music_asset_id }, clips, speech_audio: speech,
        audio_settings: cut.audio_settings, captions: cut.captions }
      run(`INSERT INTO jobs (id, project_id, shot_id, model_id, job_type, request, status, external_id, result_asset_id, error, created_at, updated_at)
        VALUES (?, ?, NULL, NULL, 'export', ?, 'queued', NULL, NULL, NULL, ?, ?)`, jobId, projectId, JSON.stringify(snapshot), timestamp, timestamp)
      return required<Job>('jobs', jobId)
    }).immediate()
  })
}
