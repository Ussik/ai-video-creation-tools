export type CandidateQualityStatus = 'pending_review' | 'passed' | 'warnings' | 'needs_work' | 'inconclusive' | 'edited'
export interface CandidateEvidenceResolution {
  id: string
  disposition: 'confirmed' | 'withdrawn' | 'unresolved'
  reason: string
  source_key?: 'source' | 'adjustment' | 'candidate'
  quote?: string
}
export interface CandidateQuality {
  status: CandidateQualityStatus
  review_id?: string
  content_signature: string
  source_signature?: string
  reviewed_at?: string
  evidence?: CandidateEvidenceResolution[]
  error?: { code: string; message: string; retryable?: boolean }
}
export const candidateQualityAccepted = (quality?: Pick<CandidateQuality, 'status' | 'review_id'>) =>
  !!quality?.review_id && (quality.status === 'passed' || quality.status === 'warnings')
