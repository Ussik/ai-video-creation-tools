import { isSceneSoundPlan, type SceneSoundPlan } from '../media/video-prompt-audio.js'

/** Accepted directing decisions travel with the shot; prose is their production projection. */
export interface StoryboardSceneDirection {
  anchors: string
  blocking: string
  axis: string
  dramatic_progression: string
  sound?: SceneSoundPlan
}
export interface StoryboardShotDirection {
  purpose: string
  camera: { movement: string; start_frame: string; trigger: string; path: string; end_frame: string; motivation: string }
  cut: {
    type: 'continuity' | 'action_match' | 'eyeline' | 'reaction' | 'insert' | 'ellipsis' | 'scene_change' | 'ending'
    cut_moment: string
    carry_over: string
    reason: string
  }
}
export interface StoryboardContinuityPlan {
  version: 1
  /** Edited snapshots remain evidence, never overrides of the current shot text. */
  status?: 'accepted' | 'edited'
  /** Internal continuous-scene group for a scriptless clip; never a script scene ID. */
  group_id?: string
  scene: StoryboardSceneDirection
  shot: StoryboardShotDirection
}

/** Legacy/malformed records remain unknown; loading them never invents accepted decisions. */
export function isStoryboardContinuityPlan(value: unknown): value is StoryboardContinuityPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  if (plan.version !== 1 || plan.status !== undefined && !['accepted', 'edited'].includes(String(plan.status)) || !plan.scene || typeof plan.scene !== 'object' || !plan.shot || typeof plan.shot !== 'object') return false
  const scene = plan.scene as Record<string, unknown>, shot = plan.shot as Record<string, unknown>
  if (scene.sound !== undefined && !isSceneSoundPlan(scene.sound)) return false
  const camera = shot.camera as Record<string, unknown> | undefined, cut = shot.cut as Record<string, unknown> | undefined
  return (plan.group_id === undefined || typeof plan.group_id === 'string')
    && ['anchors', 'blocking', 'axis', 'dramatic_progression'].every(key => typeof scene[key] === 'string')
    && typeof shot.purpose === 'string' && !!camera && !!cut
    && ['movement', 'start_frame', 'trigger', 'path', 'end_frame', 'motivation'].every(key => typeof camera[key] === 'string')
    && ['continuity', 'action_match', 'eyeline', 'reaction', 'insert', 'ellipsis', 'scene_change', 'ending'].includes(String(cut.type))
    && ['cut_moment', 'carry_over', 'reason'].every(key => typeof cut[key] === 'string')
}
