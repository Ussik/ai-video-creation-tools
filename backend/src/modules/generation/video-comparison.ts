import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { videoDurationPlan, type VideoComparison } from '@video-studio/shared/media/video-comparison'
import { all, db, mediaDir, newId, now, one, required, run, type Asset, type Job, type Model, type Provider, type Shot } from '../../infrastructure/database/db.js'
import { parse } from '../../infrastructure/http/request.js'

type FrozenRequest = Record<string, unknown> & { prompt: string; reference_asset_ids: string[]; duration: number }
type Row = { id: string; project_id: string; shot_id: string; label: string; baseline_job_id: string; baseline_asset_id: string;
  frozen_request: string; candidate_prompt: string; snapshot: string; model_name: string; model_id: string; shot_title: string;
  edit_duration: number; candidate_job_id: string | null; state: 'prepared' | 'starting'; error: string | null;
  created_at: string; started_at: string | null }

function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
const signature = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requiredComparison = (id: string): Row => one<Row>('SELECT * FROM video_comparisons WHERE id=?', id) ?? fail('对照记录不存在', 404)

/** Called alongside application migrations. Existing data and selections are untouched. */
export function initializeVideoComparisonSchema(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS video_comparisons (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
    label TEXT NOT NULL, baseline_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    baseline_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, frozen_request TEXT NOT NULL,
    candidate_prompt TEXT NOT NULL, snapshot TEXT NOT NULL, model_name TEXT NOT NULL,
    model_id TEXT NOT NULL, shot_title TEXT NOT NULL, edit_duration REAL NOT NULL,
    candidate_job_id TEXT, state TEXT NOT NULL DEFAULT 'prepared', error TEXT,
    created_at TEXT NOT NULL, started_at TEXT
  ); CREATE INDEX IF NOT EXISTS video_comparisons_project ON video_comparisons(project_id, created_at)`)
}

function readRequest(job: Job): FrozenRequest {
  let value: unknown
  try { value = JSON.parse(job.request) } catch { return fail('基准任务的生成参数无法读取') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('基准任务的生成参数无效')
  const request = value as Record<string, unknown>
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || !Array.isArray(request.reference_asset_ids)
    || request.reference_asset_ids.some(id => typeof id !== 'string') || typeof request.duration !== 'number'
    || !Number.isFinite(request.duration) || request.duration <= 0) fail('基准任务缺少完整的提示词、参考图或时长参数')
  return request as FrozenRequest
}

async function mediaFingerprint(asset: Asset, projectId: string): Promise<unknown> {
  if (asset.project_id !== projectId) fail('对照素材不属于当前项目')
  let path: string, root: string
  try { [path, root] = await Promise.all([realpath(asset.path), realpath(mediaDir)]) }
  catch { return fail('对照素材文件不存在，请重新选择基准素材', 409) }
  if (!path.startsWith(`${resolve(root)}${sep}`)) fail('对照素材必须位于项目素材目录')
  const info = await stat(path)
  if (!info.isFile() || info.size <= 0 || info.size > 300 * 1024 * 1024) fail('对照素材应为不超过 300 MB 的有效文件')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { id: asset.id, kind: asset.kind, bytes: info.size, sha256: hash.digest('hex') }
}

async function currentSnapshot(job: Job, asset: Asset, request: FrozenRequest): Promise<string> {
  const model = required<Model>('models', job.model_id!), provider = required<Provider>('providers', model.provider_id)
  const shot = required<Shot>('shots', job.shot_id!)
  const references: unknown[] = []
  for (const id of request.reference_asset_ids) {
    const reference = required<Asset>('assets', id)
    if (reference.kind !== 'image') fail('基准任务参考图类型已变化', 409)
    references.push(await mediaFingerprint(reference, job.project_id))
  }
  return JSON.stringify({
    baseline: signature({ id: job.id, request: job.request, model_id: job.model_id, shot_id: job.shot_id,
      result_asset_id: job.result_asset_id, status: job.status, asset: await mediaFingerprint(asset, job.project_id) }),
    model: signature({ ...model, provider }), references: signature(references),
    shot: signature({ id: shot.id, project_id: shot.project_id, storyboard_revision: shot.storyboard_revision,
      superseded_by: shot.superseded_by, video_prompt: shot.video_prompt, prompt: shot.prompt,
      start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note, duration: shot.duration }),
  })
}

async function staleReasons(row: Row): Promise<string[]> {
  try {
    const job = required<Job>('jobs', row.baseline_job_id), asset = required<Asset>('assets', row.baseline_asset_id)
    const before = JSON.parse(row.snapshot) as Record<string, string>, after = JSON.parse(await currentSnapshot(job, asset, readRequest(job))) as Record<string, string>
    const labels: Record<string, string> = { baseline: '基准任务或视频文件已变化', model: '模型或提供商配置已变化', references: '参考图片内容已变化', shot: '镜头剧情、状态或剪辑时长已变化' }
    return Object.keys(labels).filter(key => before[key] !== after[key]).map(key => labels[key]!)
  } catch (error) { return [error instanceof Error ? error.message : '对照输入已不可用'] }
}

async function publicComparison(row: Row): Promise<VideoComparison> {
  const request = JSON.parse(row.frozen_request) as FrozenRequest
  const candidate = row.candidate_job_id ? one<Job>('SELECT * FROM jobs WHERE id=?', row.candidate_job_id) : undefined
  const asset = candidate?.result_asset_id ? one<Asset>('SELECT * FROM assets WHERE id=?', candidate.result_asset_id) : undefined
  const publicAsset = asset ? (({ path: _path, remote_url: _remote, ...fields }) => ({ ...fields,
    remote_url: null, saved: !!one('SELECT 1 FROM saved_assets WHERE asset_id=?', asset.id), url: `/api/assets/${asset.id}/file` }))(asset) : null
  const reasons = await staleReasons(row), { generation_ms, edit_ms, trim_target_ms } = videoDurationPlan(request.duration, row.edit_duration)
  const { prompt: _prompt, prompt_body: _body, ...parameters } = request
  return { id: row.id, project_id: row.project_id, shot_id: row.shot_id, shot_title: row.shot_title, label: row.label,
    baseline_job_id: row.baseline_job_id, baseline_asset_id: row.baseline_asset_id, baseline_url: `/api/assets/${row.baseline_asset_id}/file`,
    baseline_prompt: request.prompt, candidate_prompt: row.candidate_prompt, candidate_job_id: row.candidate_job_id,
    candidate_asset_id: candidate?.result_asset_id || null,
    candidate_url: candidate?.result_asset_id ? `/api/assets/${candidate.result_asset_id}/file` : null,
    candidate_asset: publicAsset,
    status: candidate?.status || row.state, error: candidate?.error || row.error,
    model_id: row.model_id, model_name: row.model_name, parameters,
    generation_duration_ms: generation_ms, edit_duration_ms: edit_ms, trim_target_ms,
    seed_locked: request.seed !== undefined && request.seed !== null,
    changed_fields: ['prompt'], stale: reasons.length > 0, stale_reasons: reasons,
    created_at: row.created_at, started_at: row.started_at }
}

export type VideoComparisonDependencies = {
  /** Validate and insert this exact request into the existing generation queue.
   * Use jobId for idempotency. Do not rebuild prompts or replace references. */
  enqueue: (projectId: string, shotId: string, modelId: string, request: FrozenRequest, jobId: string) => Promise<Job>
}

export function registerVideoComparisonRoutes(app: FastifyInstance, dependencies: VideoComparisonDependencies): void {
  const active = new Set<string>()
  const projectParams = z.object({ id: z.string().min(1).max(100) })
  const startParams = projectParams.extend({ comparisonId: z.string().min(1).max(100) })
  app.get('/api/projects/:id/video-comparisons', async request => {
    const { id } = parse(projectParams, request.params)
    required('projects', id)
    const { asset_id } = parse(z.object({ asset_id: z.string().min(1).max(100).optional() }), request.query)
    const rows = all<Row>(`SELECT * FROM video_comparisons WHERE project_id=? ${asset_id ? 'AND baseline_asset_id=?' : ''} ORDER BY created_at DESC LIMIT 50`,
      ...[id, ...(asset_id ? [asset_id] : [])])
    return { comparisons: await Promise.all(rows.map(publicComparison)) }
  })
  app.post('/api/projects/:id/video-comparisons', async request => {
    const { id } = parse(projectParams, request.params)
    const input = parse(z.object({ baseline_asset_id: z.string().min(1).max(100), candidate_prompt: z.string().trim().min(1).max(80_000),
      label: z.string().trim().min(1).max(120).default('动作提示词对照') }).strict(), request.body)
    required('projects', id)
    const asset = required<Asset>('assets', input.baseline_asset_id)
    if (asset.project_id !== id || asset.kind !== 'video') fail('请选择当前项目中的视频基准素材')
    const job = one<Job>("SELECT * FROM jobs WHERE project_id=? AND result_asset_id=? AND job_type='generation' AND status='succeeded' ORDER BY created_at DESC LIMIT 1", id, asset.id)
    if (!job?.model_id || !job.shot_id) fail('基准视频需要关联已完成的生成任务与分镜，上传视频不能用于固定参数对照')
    const model = required<Model>('models', job.model_id), shot = required<Shot>('shots', job.shot_id)
    if (model.modality !== 'video' || shot.project_id !== id || asset.shot_id !== shot.id) fail('基准任务、模型与分镜关联不一致')
    const frozen = readRequest(job)
    if (frozen.prompt.trim() === input.candidate_prompt) fail('候选提示词与基准相同，请先明确本次动作修改')
    const snapshot = await currentSnapshot(job, asset, frozen), comparisonId = newId()
    run(`INSERT INTO video_comparisons (id,project_id,shot_id,label,baseline_job_id,baseline_asset_id,frozen_request,candidate_prompt,snapshot,
      model_name,model_id,shot_title,edit_duration,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      comparisonId, id, shot.id, input.label, job.id, asset.id, JSON.stringify(frozen), input.candidate_prompt, snapshot,
      model.name, model.id, shot.title, shot.duration, now())
    return publicComparison(requiredComparison(comparisonId))
  })
  app.post('/api/projects/:id/video-comparisons/:comparisonId/start', async request => {
    const { id, comparisonId } = parse(startParams, request.params)
    const row = requiredComparison(comparisonId)
    if (row.project_id !== id) fail('对照记录不属于当前项目')
    if (row.candidate_job_id && one('SELECT 1 FROM jobs WHERE id=?', row.candidate_job_id)) return publicComparison(row)
    if (active.has(comparisonId)) fail('该对照正在提交，请勿重复生成', 409)
    active.add(comparisonId)
    try {
      const reasons = await staleReasons(row)
      if (reasons.length) fail(`固定输入已变化，请重新准备对照：${reasons.join('；')}`, 409)
      const model = required<Model>('models', row.model_id), provider = required<Provider>('providers', model.provider_id)
      if (!model.enabled || model.archived || !provider.enabled || provider.archived || provider.adapter !== 'http') fail('基准模型或提供商当前不可用')
      const frozen = JSON.parse(row.frozen_request) as FrozenRequest
      const candidate: FrozenRequest = { ...frozen, prompt: row.candidate_prompt }
      // prompt_body is editor metadata, not a second independent generation variable.
      if ('prompt_body' in candidate) candidate.prompt_body = row.candidate_prompt
      const jobId = row.candidate_job_id || newId()
      run("UPDATE video_comparisons SET state='starting', candidate_job_id=?, started_at=?, error=NULL WHERE id=?", jobId, now(), row.id)
      try {
        const job = await dependencies.enqueue(id, row.shot_id, row.model_id, candidate, jobId)
        if (job.id !== jobId || job.project_id !== id || job.shot_id !== row.shot_id || job.model_id !== row.model_id
          || signature(readRequest(job)) !== signature(candidate)) fail('对照提交未保留固定生成条件，请检查生成队列适配', 500)
      } catch (error) {
        if (!one('SELECT 1 FROM jobs WHERE id=?', jobId)) run("UPDATE video_comparisons SET state='prepared',candidate_job_id=NULL,error=? WHERE id=?",
          error instanceof Error ? error.message : String(error), row.id)
        throw error
      }
      return publicComparison(requiredComparison(row.id))
    } finally { active.delete(comparisonId) }
  })
}
