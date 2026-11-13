import { run, type Shot } from '../../infrastructure/database/db.js'

const directingFields = new Set(['prompt', 'image_prompt', 'video_prompt', 'duration', 'start_state', 'end_state', 'cut_note', 'audio_plan', 'position'])

/** Keep the old decisions as history after a creative edit; never reapply them. */
export function markShotContinuityEdited(shot: Shot, changedFields: Iterable<string>): void {
  if (!shot.continuity_plan || shot.continuity_plan.status === 'edited') return
  if (![...changedFields].some(field => directingFields.has(field))) return
  run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify({ ...shot.continuity_plan, status: 'edited' }), shot.id)
}

/** Position renumbering is harmless; a different predecessor or successor is not. */
export function markChangedShotAdjacency(before: readonly Shot[], after: readonly Shot[]): void {
  const adjacency = (shots: readonly Shot[]) => {
    const groups = new Map<string, Shot[]>()
    for (const shot of shots.filter(item => !item.deleted_at && !item.superseded_by)) {
      const key = JSON.stringify([shot.project_id, shot.design_id || null])
      const group = groups.get(key) || []
      group.push(shot)
      groups.set(key, group)
    }
    const result = new Map<string, string>()
    for (const group of groups.values()) {
      group.sort((left, right) => left.position - right.position || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      group.forEach((shot, index) => result.set(shot.id, JSON.stringify([group[index - 1]?.id || null, group[index + 1]?.id || null])))
    }
    return result
  }
  const previous = adjacency(before), current = adjacency(after)
  for (const shot of after) {
    if (previous.has(shot.id) && previous.get(shot.id) !== current.get(shot.id)) markShotContinuityEdited(shot, ['position'])
  }
}
