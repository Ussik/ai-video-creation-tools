import type { Shot } from '../../infrastructure/database/db.js'
import type { HandoffConflict, HandoffConflictLocation } from '@video-studio/shared/media/video-handoff-conflict'
import { creativeInputHash } from '../skills/creative-model-state.js'
import { videoSourceVersion } from './video-source-version.js'
export function handoffConflictPayload(input: { source_signature: string; image_body: string; shot_video_prompt: string }, shot: Shot | null,
  candidate: { motion_prompt: string; audio_plan: HandoffConflict['candidate']['audio_plan']; boundary_conflicts?: Array<{ message: string; evidence: string[]; suggestion: string }> },
  neighbors: { previous: { id: string; end_state: string } | null; next: { id: string; start_state: string } | null }, reuse: boolean, requests: number): HandoffConflict {
  const fields: Array<{ field_path: string; value: string; shot_id?: string }> = [
    { field_path: 'image_body', value: input.image_body },
    ...(shot ? [ { field_path: 'video_prompt', value: shot.video_prompt, shot_id: shot.id },
      { field_path: 'start_state', value: shot.start_state, shot_id: shot.id }, { field_path: 'end_state', value: shot.end_state, shot_id: shot.id },
      { field_path: 'cut_note', value: shot.cut_note, shot_id: shot.id },
      ...(shot.audio_plan?.sound_effects.map((value, index) => ({ field_path: `audio_plan.sound_effects.${index}`, value, shot_id: shot.id })) || []) ] : []),
    ...(neighbors.previous ? [{ field_path: 'previous.end_state', value: neighbors.previous.end_state, shot_id: neighbors.previous.id }] : []),
    ...(neighbors.next ? [{ field_path: 'next.start_state', value: neighbors.next.start_state, shot_id: neighbors.next.id }] : []),
  ]
  const conflicts = (candidate.boundary_conflicts || []).map(issue => ({ ...issue, locations: issue.evidence.flatMap(quote => {
    const matches: HandoffConflictLocation[] = []
    for (const field of fields) { let from = 0, start: number
      while ((start = field.value.indexOf(quote, from)) >= 0) {
        matches.push({ field_path: field.field_path, quote, start, end: start + quote.length, ...(field.shot_id ? { shot_id: field.shot_id } : {}) }); from = start + quote.length
      }
    }
    return matches
  }) }))
  return { status: 'needs_confirmation', source_signature: input.source_signature, candidate_version: creativeInputHash([input, shot && videoSourceVersion(shot), candidate]),
    shot_version: shot ? videoSourceVersion(shot) : '', shot_id: shot?.id || null, local_reuse: reuse, model_request_count: requests, conflicts,
    sources: { video_prompt: shot?.video_prompt || '', audio_plan: shot?.audio_plan || null, image_body: input.image_body },
    candidate: { motion_prompt: candidate.motion_prompt, audio_plan: candidate.audio_plan } }
}
