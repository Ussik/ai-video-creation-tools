import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import sharp from 'sharp'
import { db, mediaDir, now, one, run, type Job } from '../../infrastructure/database/db.js'
import { validateVideoResult } from '../../infrastructure/media/media-result-validation.js'
import { mediaExecutionSignal, type LocalMediaResult } from '../../infrastructure/providers/media-execution.js'
import { probeSpeechDurationMs } from '../speech/speech-audio.js'

type Stage = { request_hash: string; path: string; kind: LocalMediaResult['kind']; state: 'writing' | 'ready'; bytes: number | null; digest: string | null; metadata: string }
type Execution = { phase: 'prepared' | 'dispatched'; request_id: string; owner: string | null }
export function initJobLocalResults() {
  db.exec(`CREATE TABLE IF NOT EXISTS job_local_results (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, request_hash TEXT NOT NULL,
    path TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER, digest TEXT,
    metadata TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_media_execution (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, phase TEXT NOT NULL,
    request_id TEXT NOT NULL, owner TEXT, updated_at TEXT NOT NULL);`)
}
export function mediaJobExecution(jobId: string) { initJobLocalResults(); return one<Execution>('SELECT * FROM job_media_execution WHERE job_id=?', jobId) }
export function prepareMediaJob(jobId: string) {
  initJobLocalResults()
  const legacy = one('SELECT 1 FROM job_generation_attempts WHERE job_id=?', jobId) || one('SELECT 1 FROM jobs WHERE id=? AND external_id IS NOT NULL', jobId)
    || one('SELECT 1 FROM job_image_recovery WHERE job_id=? UNION ALL SELECT 1 FROM job_video_recovery WHERE job_id=?', jobId, jobId)
  run("INSERT OR IGNORE INTO job_media_execution (job_id,phase,request_id,owner,updated_at) VALUES (?,?,?,NULL,?)", jobId, legacy ? 'dispatched' : 'prepared', randomUUID(), now())
  return mediaJobExecution(jobId)!
}
export function claimMediaJob(job: Job): string {
  initJobLocalResults()
  const token = randomUUID()
  run('UPDATE job_media_execution SET owner=?,updated_at=? WHERE job_id=?', token, now(), job.id)
  return token
}
export function assertMediaJobOwner(job: Job, token: string) {
  mediaExecutionSignal()?.throwIfAborted()
  const current = one<{ status: string; request: string }>('SELECT status,request FROM jobs WHERE id=?', job.id)
  const execution = mediaJobExecution(job.id)
  if (!current || current.status !== 'running' || current.request !== job.request || execution?.owner !== token) {
    throw Object.assign(new Error('任务状态或执行归属已变化，已保留成果并停止写入。'), { statusCode: 409, code: 'job_execution_changed' })
  }
}
export function markMediaJobDispatch(job: Job, token: string, requestId?: string) {
  db.transaction(() => {
    assertMediaJobOwner(job, token)
    const previous = mediaJobExecution(job.id)!
    if (previous.phase === 'dispatched') throw new Error('原任务可能已派发，不能再次提交付费生成。')
    if (requestId && previous.request_id !== requestId) throw new Error('付费请求编号与原任务不一致，未派发。')
    run("UPDATE job_media_execution SET phase='dispatched',updated_at=? WHERE job_id=? AND owner=?", now(), job.id, token)
  }).immediate()
}
const identity = (job: Job) => createHash('sha256').update(job.request).digest('hex')
function confined(job: Job, path: string, root = resolve(mediaDir, job.project_id)) {
  const delta = relative(root, resolve(path))
  if (!delta || delta.startsWith('..') || isAbsolute(delta)) throw new Error('本地成果路径超出当前项目媒体目录。')
}
async function confinedRealPath(job: Job, path: string) {
  const projectRoot = await realpath(resolve(mediaDir, job.project_id))
  confined(job, projectRoot, await realpath(mediaDir))
  const resolved = await realpath(path)
  confined(job, resolved, projectRoot)
  return resolved
}
export function localJobResultKind(job: Job): LocalMediaResult['kind'] | undefined {
  initJobLocalResults()
  const stage = one<Stage>('SELECT * FROM job_local_results WHERE job_id=?', job.id)
  return stage?.request_hash === identity(job) ? stage.kind : undefined
}
export const hasLocalJobResult = (job: Job) => !!localJobResultKind(job)
export function stageLocalJobWriting(job: Job, token: string, result: LocalMediaResult) {
  assertMediaJobOwner(job, token); confined(job, result.path)
  run(`INSERT INTO job_local_results (job_id,request_hash,path,kind,state,bytes,digest,metadata,updated_at)
    VALUES (?,?,?,?,'writing',NULL,NULL,?,?) ON CONFLICT(job_id) DO UPDATE SET
    request_hash=excluded.request_hash,path=excluded.path,kind=excluded.kind,state='writing',bytes=NULL,digest=NULL,metadata=excluded.metadata,updated_at=excluded.updated_at`,
    job.id, identity(job), result.path, result.kind, JSON.stringify(result.metadata || {}), now())
}
async function digestFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) { mediaExecutionSignal()?.throwIfAborted(); hash.update(chunk) }
  return hash.digest('hex')
}
export async function stageLocalJobReady(job: Job, token: string, result: LocalMediaResult) {
  assertMediaJobOwner(job, token); confined(job, result.path)
  const resolved = await confinedRealPath(job, result.path)
  const file = await stat(resolved)
  if (!file.isFile() || file.size <= 0) throw new Error('本地成果为空，尚未接管。')
  const digest = await digestFile(resolved)
  assertMediaJobOwner(job, token)
  run(`UPDATE job_local_results SET state='ready',bytes=?,digest=?,metadata=?,updated_at=? WHERE job_id=? AND request_hash=? AND path=?`,
    file.size, digest, JSON.stringify(result.metadata || {}), now(), job.id, identity(job), result.path)
  const stage = one<Stage>('SELECT * FROM job_local_results WHERE job_id=?', job.id)
  if (!stage || stage.state !== 'ready' || stage.digest !== digest) throw new Error('本地成果登记未完成，已停止落库。')
}
export async function recoverLocalJobResult(job: Job, token: string): Promise<LocalMediaResult | undefined> {
  initJobLocalResults()
  const stage = one<Stage>('SELECT * FROM job_local_results WHERE job_id=?', job.id)
  if (!stage) return
  if (stage.request_hash !== identity(job)) throw new Error('本地成果所属请求已变化，不能用于当前任务。')
  confined(job, stage.path)
  let file
  try { await confinedRealPath(job, stage.path); file = await stat(stage.path) }
  catch { throw new Error('已登记的本地成果文件丢失，已保留原任务；请先核对恢复记录。') }
  if (!file.isFile() || file.size <= 0 || stage.state === 'ready' && (file.size !== stage.bytes || await digestFile(stage.path) !== stage.digest)) {
    throw new Error('本地成果校验摘要不一致，未采用该文件，也不会重新付费生成。')
  }
  const metadata = JSON.parse(stage.metadata) as Record<string, unknown>
  if (stage.kind === 'video') Object.assign(metadata, await validateVideoResult(stage.path))
  else if (stage.kind === 'image') await sharp(stage.path).stats()
  else if (stage.kind === 'audio') metadata.duration_ms = await probeSpeechDurationMs(stage.path)
  const result = { path: stage.path, kind: stage.kind, metadata }
  assertMediaJobOwner(job, token)
  if (stage.state === 'writing') await stageLocalJobReady(job, token, result)
  return result
}
export function clearLocalJobResult(jobId: string) { run('DELETE FROM job_local_results WHERE job_id=?', jobId) }
