import { createHash } from 'node:crypto'
import type { Shot } from '../../infrastructure/database/db.js'
export function videoSourceVersion(shot: Shot): string {
  return createHash('sha256').update(JSON.stringify({ id: shot.id, project_id: shot.project_id, title: shot.title, duration: shot.duration, position: shot.position,
    design_id: shot.design_id, source_scene_id: shot.source_scene_id, video_prompt: shot.video_prompt, audio_plan: shot.audio_plan,
    start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note, image_prompt: shot.image_prompt,
    storyboard_revision: shot.storyboard_revision, continuity_plan: shot.continuity_plan })).digest('hex')
}
