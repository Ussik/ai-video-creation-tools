export const visualReferenceViews = ['face', 'front', 'three_quarter', 'side', 'back', 'wide', 'reverse', 'layout', 'detail'] as const
export const visualReferencePurposes = ['identity', 'costume', 'space', 'structure', 'detail'] as const
export type VisualReferenceView = typeof visualReferenceViews[number]
export type VisualReferencePurpose = typeof visualReferencePurposes[number]
export type VisualReferenceStatus = 'candidate' | 'confirmed' | 'archived'

/** Immutable metadata copied to a shot when its references are selected. */
export interface VisualReferenceSnapshot {
  id: string
  asset_id: string
  view: VisualReferenceView
  purpose: VisualReferencePurpose
  label: string
  revision: number
  style_version: string | null
}

export interface VisualReferenceAsset extends VisualReferenceSnapshot {
  profile_id: string
  status: VisualReferenceStatus
  is_default: boolean
  source_asset_id: string | null
  source_job_id: string | null
  created_at: string
  updated_at: string
}

export const visualReferenceViewLabels: Record<VisualReferenceView, string> = {
  face: '面部特写', front: '正面', three_quarter: '四分之三视角', side: '侧面', back: '背面',
  wide: '空间全景', reverse: '反打视角', layout: '空间布局', detail: '局部细节',
}
export const visualReferencePurposeLabels: Record<VisualReferencePurpose, string> = {
  identity: '身份与外貌', costume: '服装与身体比例', space: '空间关系', structure: '结构与材质', detail: '局部细节',
}
