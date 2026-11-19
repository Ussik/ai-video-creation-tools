import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { all, db, now, one, required, type Job } from '../../infrastructure/database/db.js'
import type { MediaInputManifest, MediaInputRejection } from '../../infrastructure/providers/media-input-manifest.js'
function init() { db.exec(`CREATE TABLE IF NOT EXISTS job_provider_inputs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, manifest TEXT NOT NULL, rejection TEXT, updated_at TEXT NOT NULL)` ) }
export function recordJobProviderManifest(job: Job, manifest: MediaInputManifest) {
  init()
  const current = one<Job>('SELECT * FROM jobs WHERE id=?', job.id)
  if (current?.status !== 'running' || current.request !== job.request) throw new Error('任务已变化，未发送媒体请求')
  db.prepare('INSERT INTO job_provider_inputs (job_id,manifest,updated_at) VALUES (?,?,?) ON CONFLICT(job_id) DO UPDATE SET manifest=excluded.manifest,rejection=NULL,updated_at=excluded.updated_at')
    .run(job.id, JSON.stringify(manifest), now())
}
export function recordJobProviderRejection(job: Job, rejection: MediaInputRejection) {
  init()
  const current = one<Job>('SELECT * FROM jobs WHERE id=?', job.id)
  if (current?.status !== 'running' || current.request !== job.request) return
  db.prepare('UPDATE job_provider_inputs SET rejection=?,updated_at=? WHERE job_id=?').run(JSON.stringify(rejection), now(), job.id)
}
export function registerJobProviderInputRoutes(app: FastifyInstance) {
  app.get('/api/jobs/:id/provider-inputs', request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params), job = required<Job>('jobs', id)
    if (!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_provider_inputs'")) return { manifest: null, rejection: null }
    const row = one<{ manifest: string; rejection: string | null }>('SELECT manifest,rejection FROM job_provider_inputs WHERE job_id=?', id)
    if (!row) return { manifest: null, rejection: null }
    const manifest = JSON.parse(row.manifest) as MediaInputManifest, rejection = row.rejection ? JSON.parse(row.rejection) : null
    const assets = new Set(manifest.entries.flatMap(entry => entry.asset_ids))
    const nodes = all<{ id: string; title: string; asset_id: string | null; canvas_id: string | null; shot_id: string | null }>(
      `SELECT n.id,n.title,COALESCE(n.asset_id,j.result_asset_id) AS asset_id,n.canvas_id,n.shot_id
       FROM canvas_nodes n LEFT JOIN jobs j ON j.id=n.job_id WHERE n.project_id=?`, job.project_id)
    return { manifest, rejection, source_nodes: nodes.filter(node => node.asset_id && assets.has(node.asset_id)) }
  })
}
