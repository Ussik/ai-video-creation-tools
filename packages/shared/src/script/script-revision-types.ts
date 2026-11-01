/** Public persisted revision state. No server/runtime dependencies. */
export type RevisionAssessment = { document_id: string; version: string; draft_snapshot?: string; scene_snapshot?: string; conclusion: 'resolved' | 'unchanged' | 'needs_change'; explanation: string;
  findings: Array<{ category: 'pending' | 'missing' | 'contradiction' | 'intentional_suspense'; quote: string; explanation: string }> }
export type RevisionReferenceReview = { kind: 'document' | 'scene' | 'shot' | 'visual_profile'; id: string; version: string;
  conclusion: 'consistent' | 'needs_change'; explanation: string; draft_snapshot: string }
export type RevisionTask = {
  id: string; summary: string; source_text: string; created_at: string; updated_at: string; scope?: 'selected' | 'all_documents';
  status: 'in_progress' | 'needs_attention' | 'ready';
  context_version?: string;
  documents: Array<{ id: string; title: string; source_version: string; status: 'pending' | 'revised' | 'verified' | 'unchanged' | 'blocked'; note?: string; assessment?: RevisionAssessment }>;
  decisions: Array<{ topic: string; choice: string; reason: string }>;
  references: Array<{ kind: 'document' | 'scene' | 'shot' | 'visual_profile'; id: string; title: string; status: 'pending' | 'verified' | 'blocked'; note?: string; review?: RevisionReferenceReview }>;
  batches: number;
}
