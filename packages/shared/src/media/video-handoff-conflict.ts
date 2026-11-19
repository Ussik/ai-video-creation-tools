import type { VideoAudioPlan } from './video-prompt-audio.js'
export type HandoffConflictLocation = { field_path: string; quote: string; start: number; end: number; shot_id?: string }
export type HandoffConflict = {
  status: 'needs_confirmation'; source_signature: string; candidate_version: string; shot_version: string;
  shot_id: string | null; local_reuse: boolean; model_request_count: number;
  conflicts: Array<{ message: string; evidence: string[]; suggestion: string; locations: HandoffConflictLocation[] }>;
  sources: { video_prompt: string; audio_plan: VideoAudioPlan | null; image_body: string };
  candidate: { motion_prompt: string; audio_plan: VideoAudioPlan };
}
export type HandoffSourceEdit = { video_prompt: string; audio_plan: VideoAudioPlan | null }

/** A creator-selected count changes only exact, located evidence spans. This
 * proposes a preview, never infers which event occurred or saves implicitly. */
export function handoffCountChoice(conflict: HandoffConflict, count: '一' | '两'): HandoffSourceEdit | undefined {
  const source = conflict.sources, audio = source.audio_plan && structuredClone(source.audio_plan)
  const locations = conflict.conflicts.flatMap(issue => issue.locations).filter(location => location.field_path === 'video_prompt' || /^audio_plan.sound_effects\.\d+$/.test(location.field_path))
  const counts = new Set(locations.flatMap(location => [...location.quote.matchAll(/([一二两三四五六七八九十\d]+)次/g)].map(match => match[1])))
  if (counts.size < 2 || [...counts].some(value => !['一', '二', '两', '1', '2'].includes(value!))) return
  for (let i = 0; i < locations.length; i++) for (const other of locations.slice(i + 1)) {
    const a = locations[i]!
    if (a.field_path === other.field_path && a.start < other.end && other.start < a.end
      && !(a.start <= other.start && a.end >= other.end) && !(other.start <= a.start && other.end >= a.end)) return
  }
  const rewrite = (value: string, field: string) => {
    const ranges = locations.filter(location => location.field_path === field && value.slice(location.start, location.end) === location.quote)
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .filter((location, index, all) => !all.slice(0, index).some(previous => previous.start <= location.start && previous.end >= location.end))
    let result = value
    for (const location of ranges.reverse()) result = result.slice(0, location.start) + location.quote.replace(/(?:一|二|两|1|2)次/g, `${count}次`) + result.slice(location.end)
    return result
  }
  const video_prompt = rewrite(source.video_prompt, 'video_prompt')
  if (audio) audio.sound_effects = audio.sound_effects.map((effect, index) => rewrite(effect, `audio_plan.sound_effects.${index}`))
  // Every saved event effect must have an exact located occurrence too; a
  // partial choice would merely move the same contradiction downstream.
  if (audio?.sound_effects.some((effect, index) => /(?:一|二|两|1|2)次/.test(effect)
    && !locations.some(location => location.field_path === `audio_plan.sound_effects.${index}`))) return
  return { video_prompt, audio_plan: audio }
}
