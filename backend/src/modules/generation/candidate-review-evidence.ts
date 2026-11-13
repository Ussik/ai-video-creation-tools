import { createHash, randomUUID } from 'node:crypto'
import { db, now, one, run } from '../../infrastructure/database/db.js'
import type { CandidateQuality } from '@video-studio/shared/api/ai-candidate-quality'

export const candidateSignature = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function reviewModelSignature(modelId: string) {
  const model = one<{ provider_id: string }>('SELECT * FROM models WHERE id=?', modelId)
  return candidateSignature({ model_id: modelId, model, provider: model ? one('SELECT * FROM providers WHERE id=?', model.provider_id) : undefined })
}
function initialize() {
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_review_evidence (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    family TEXT NOT NULL, candidate_signature TEXT NOT NULL, source_signature TEXT NOT NULL,
    model_id TEXT NOT NULL, model_signature TEXT NOT NULL, status TEXT NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL)`)
}
type ReviewRow = { id: string; project_id: string; family: string; candidate_signature: string; source_signature: string;
  model_id: string; model_signature: string; status: CandidateQuality['status']; report: string; created_at: string }
/** Immutable evidence is an artifact of an existing operation, never a task owner. */
export function retainCandidateReview(input: { projectId: string; family: string; candidate: unknown; source: string; modelId: string;
  status: CandidateQuality['status']; report: unknown }): CandidateQuality {
  initialize()
  const id = randomUUID(), createdAt = now(), signature = candidateSignature(input.candidate)
  run('INSERT INTO candidate_review_evidence VALUES (?,?,?,?,?,?,?,?,?,?)', id, input.projectId, input.family, signature,
    input.source, input.modelId, reviewModelSignature(input.modelId), input.status, JSON.stringify(input.report), createdAt)
  return { review_id: id, content_signature: signature, source_signature: input.source, status: input.status, reviewed_at: createdAt }
}
export function readCandidateReview(input: { projectId: string; family: string; reviewId?: string; candidate: unknown; source: string; accepted?: boolean }) {
  initialize()
  const row = input.reviewId ? one<ReviewRow>('SELECT * FROM candidate_review_evidence WHERE id=? AND project_id=? AND family=?', input.reviewId, input.projectId, input.family) : undefined
  if (!row || row.candidate_signature !== candidateSignature(input.candidate) || row.source_signature !== input.source
    || row.model_signature !== reviewModelSignature(row.model_id) || input.accepted && !['passed', 'warnings'].includes(row.status)) {
    throw Object.assign(new Error('当前草稿缺少与正文、来源及模型配置一致的通过复核记录，请复查当前草稿后保存。'), { statusCode: 409, code: 'candidate_review_required' })
  }
  return { ...row, report: JSON.parse(row.report) as unknown }
}
