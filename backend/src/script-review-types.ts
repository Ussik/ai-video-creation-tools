export type ProjectReference = { kind: 'document' | 'scene' | 'shot' | 'visual_profile'; id: string; title: string }
export type DocumentFinding = { document_id: string; document_version: string; category: 'pending' | 'missing' | 'contradiction' | 'downstream_impact';
  severity: 'info' | 'warning' | 'error'; quote: string; explanation: string; suggestion: string; related: ProjectReference[] }
export type DocumentReview = { id: string; summary: string; documents: Array<{ id: string; version: string }>; findings: DocumentFinding[]; created_at: string }
export type DocumentHealth = { document_id: string; version: string; status: 'unreviewed' | 'reviewed' | 'needs_attention' | 'stale';
  pending_markers: Array<{ offset: number; excerpt: string }>; findings: DocumentFinding[] }
export type DraftImpact = ProjectReference & { basis: 'stage_dependency' | 'scene_link' | 'visual_binding' | 'text_match'; explanation: string }
