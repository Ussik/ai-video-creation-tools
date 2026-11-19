import { storyboardEvidenceCatalog, type ReviewSequence } from './storyboard-review-scope.js'
import { storyboardReviewSequence } from './storyboard-review-relations.js'

/** Store primitive shot text once, alongside its application-owned reference.
 * Keep structured scene direction, audio and every uncatalogued value intact. */
export function storyboardOutlineReviewContext(scenes: ReviewSequence) {
  const evidence_catalog = storyboardEvidenceCatalog(scenes)
  return { sequence: storyboardReviewSequence(scenes),
    outline_index: { scenes: scenes.map(scene => ({ ...scene, shots: scene.shots.map((shot, shot_index) => {
      const indexed: Record<string, unknown> = { ...shot, shot_index }
      const field_refs: Record<string, string> = {}
      for (const field of ['prompt', 'start_state', 'end_state', 'cut_note']) {
        const value = shot[field]
        const entry = typeof value === 'string' && evidence_catalog.find(reference => reference.scene_id === scene.scene_id
          && reference.shot_index === shot_index && reference.field === field && reference.quote === value)
        if (entry) { delete indexed[field]; field_refs[field] = entry.ref_id }
      }
      return { ...indexed, field_refs }
    }) })) }, evidence_catalog }
}
