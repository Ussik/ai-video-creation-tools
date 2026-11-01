import { createHash } from 'node:crypto'
import { z } from 'zod'
import { db, now, one, run } from '../../infrastructure/database/db.js'
import type { Job, Shot } from '../../infrastructure/database/db.js'

type SubmissionScope = 'generation' | 'shot'
type SubmissionResource<S extends SubmissionScope> = S extends 'generation' ? Job : Shot
type Submission = { request_hash: string; resource_id: string }

export const submissionKeyInput = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, '提交标识必须为 8 至 128 位字母、数字、下划线或连字符')

export function submissionKey(value: unknown): string | undefined {
  return value === undefined ? undefined : submissionKeyInput.parse(value)
}

// Object key order is irrelevant; array order remains significant for references.
// Callers parse their existing input schema first, so defaults and stripped fields
// have the same identity as the request actually accepted by the route.
export function submissionRequestHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, canonical(entry)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function findSubmission<S extends SubmissionScope>(projectId: string, scope: S, key: string, hash?: string): SubmissionResource<S> | undefined {
  const entry = one<Submission>('SELECT request_hash,resource_id FROM resource_submissions WHERE project_id=? AND scope=? AND submission_key=?', projectId, scope, key)
  if (!entry) return
  if (hash !== undefined && entry.request_hash !== hash) {
    throw Object.assign(new Error('此提交标识已用于不同内容，请找回原任务；主动重新生成须使用新的提交标识'), { statusCode: 409 })
  }
  const table = scope === 'generation' ? 'jobs' : 'shots'
  const resource = one<SubmissionResource<S>>(`SELECT * FROM ${table} WHERE id=? AND project_id=?`, entry.resource_id, projectId)
  // Keep the key after a resource is deleted: it must never create another task.
  if (!resource) throw Object.assign(new Error('此提交已被接受，但对应记录已删除，无法再次提交；请刷新项目'), { statusCode: 409 })
  return resource
}

export function createSubmission<S extends SubmissionScope>(projectId: string, scope: S, key: string | undefined, hash: string,
  create: () => SubmissionResource<S>): SubmissionResource<S> {
  return db.transaction(() => {
    // Generation validation can await file checks. Recheck under the write lock
    // after it returns, before atomically creating both the task and its key.
    const existing = key === undefined ? undefined : findSubmission(projectId, scope, key, hash)
    if (existing) return existing
    const resource = create()
    if (key !== undefined) run(`INSERT INTO resource_submissions (project_id,scope,submission_key,request_hash,resource_id,created_at)
      VALUES (?,?,?,?,?,?)`, projectId, scope, key, hash, resource.id, now())
    return resource
  }).immediate()
}

export function jobSubmissionKey(job: Job): string | null {
  return one<{ submission_key: string }>("SELECT submission_key FROM resource_submissions WHERE project_id=? AND scope='generation' AND resource_id=?", job.project_id, job.id)?.submission_key ?? null
}
