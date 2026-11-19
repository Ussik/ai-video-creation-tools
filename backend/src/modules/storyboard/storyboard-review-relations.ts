import type { ReviewSequence, ScopedReviewIssue } from './storyboard-review-scope.js'

type Location = { scene_id: string; shot_index: number }
const same = (a: Location, b: Location) => a.scene_id === b.scene_id && a.shot_index === b.shot_index
export function storyboardReviewSequence(scenes: ReviewSequence) {
  const shots = scenes.flatMap(scene => scene.shots.map((_shot, shot_index) => ({ scene_id: scene.scene_id, shot_index })))
  return { shots, pairs: shots.slice(1).map((current, index) => ({ previous: shots[index]!, current })) }
}
export function storyboardReviewRelationDiagnostics(issues: ScopedReviewIssue[], scenes: ReviewSequence) {
  const { shots } = storyboardReviewSequence(scenes)
  return issues.flatMap((issue, issue_index) => {
    const current = shots.findIndex(shot => same(shot, issue))
    const related = issue.related_scene_id === null || issue.related_shot_index === null ? -1
      : shots.findIndex(shot => same(shot, { scene_id: issue.related_scene_id!, shot_index: issue.related_shot_index! }))
    const half = (issue.related_scene_id === null) !== (issue.related_shot_index === null)
    if (current >= 0 && !half && (issue.related_scene_id === null || related >= 0 && Math.abs(current - related) === 1)) return []
    return [{ issue_index, field_path: `issues[${issue_index}].${current < 0 ? 'shot_index' : 'related_shot_index'}`,
      scene_id: issue.scene_id, shot_index: issue.shot_index, related_scene_id: issue.related_scene_id,
      related_shot_index: issue.related_shot_index, reason: current < 0 ? 'unknown_primary_shot' : half ? 'incomplete_relation' : 'nonadjacent_relation',
      allowed_neighbors: current < 0 ? [] : [shots[current - 1], shots[current + 1]].filter((shot): shot is Location => !!shot) }]
  })
}
/** Relation validation never drops findings, rewrites text or manufactures evidence. */
export function validateStoryboardReviewRelations(issues: ScopedReviewIssue[], scenes: ReviewSequence): void {
  const diagnostics = storyboardReviewRelationDiagnostics(issues, scenes)
  const first = diagnostics[0]
  if (!first) return
  throw Object.assign(new Error(first.reason === 'unknown_primary_shot' ? '复核证据引用了本次规划范围之外的镜头'
    : first.reason === 'incomplete_relation' ? '复核的关联场次与镜头序号必须同时提供或同时为空'
    : '复核只能关联本次序列中直接相邻的镜头'), {
    statusCode: 422, code: 'storyboard_review_invalid', field_path: first.field_path,
    scene_id: first.scene_id, related_scene_id: first.related_scene_id, related_shot_index: first.related_shot_index,
    diagnostics: JSON.stringify(diagnostics), relation_diagnostics: diagnostics,
  })
}
/** A correction may choose a legal neighbour only if all original evidence/scopes still fit. */
export function storyboardReviewRelationChoices(issue: ScopedReviewIssue, scenes: ReviewSequence) {
  const { shots } = storyboardReviewSequence(scenes)
  const current = shots.findIndex(shot => same(shot, issue))
  if (current < 0) return []
  const references = [...(issue.evidence_refs || []), ...(issue.repair_scope || [])]
  const fits = (location: Location | null) => references.every(reference => reference.shot_index === null
    ? reference.scene_id === issue.scene_id || reference.scene_id === location?.scene_id
    : reference.scene_id === issue.scene_id && reference.shot_index === issue.shot_index
      || !!location && same(location, { scene_id: reference.scene_id, shot_index: reference.shot_index }))
  const choices: Array<{ relation_id: string; related_scene_id: string | null; related_shot_index: number | null }> = []
  for (const neighbor of [shots[current - 1], shots[current + 1]]) if (neighbor && fits(neighbor)) {
    choices.push({ relation_id: `neighbor_${choices.length}`, related_scene_id: neighbor.scene_id, related_shot_index: neighbor.shot_index })
  }
  // Cross-shot codes cannot be silently downgraded to local-shot findings.
  if (['camera_conflict', 'unmotivated_movement', 'unfilmable_motion', 'first_frame_conflict'].includes(issue.code) && fits(null)) {
    choices.push({ relation_id: 'single_shot', related_scene_id: null, related_shot_index: null })
  }
  return choices
}
