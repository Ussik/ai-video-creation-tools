/** Sparse, source-attributed assertions. Technical validation never proves truth. */
export type ScriptSourceKnowledge = {
  category: 'identity' | 'motive' | 'causality' | 'death' | 'world_rule' | 'foreshadowing' | 'ending'
  statement: string
  kind: 'fact' | 'statement' | 'inference' | 'plan'
  holder: string | null
  status: 'confirmed' | 'unconfirmed' | 'refuted'
  at_unit_id: number
  unit_ids: number[]
  story_time?: string
  updates?: Array<{ status: 'confirmed' | 'refuted'; at_unit_id: number; unit_ids: number[]; story_time?: string }>
}

/** Auxiliary annotations are retained verbatim but never treated as accepted
 * facts until their coordinates and attribution are independently resolved. */
export type ScriptSourceKnowledgePending = {
  candidate: unknown
  code: 'invalid_coordinate' | 'evidence_span_unresolved' | 'later_disclosure_evidence' | 'unattributed_plan' | 'invalid_annotation'
  message: string
}
