/** Explicit model decisions about actual visible objects, never inferred from names. */
export interface VisualReferenceCoverage {
  scene_id: string
  shot_id: string | null
  source_excerpt: string
  objects: Array<{
    kind: 'character' | 'location' | 'prop'
    name: string
    variant: string
    usage: 'image' | 'video' | 'both'
    requires_profile: boolean
    reason: string
  }>
  no_reference_reason: string
}
