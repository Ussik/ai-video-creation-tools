import { resolveVisualProfileDisplayText } from '@video-studio/shared/visuals/visual-profile-display-text'
import type { VisualTextContext } from '@video-studio/shared/visuals/visual-profile-display-text'
import type { ProjectDetail, VisualProfile } from '../../shared/api/api'

/** Build the same project/name context as the board-preview endpoint. This is
 * derived text only: edited source, URLs and stable reference tokens stay saved.
 */
export function resolveCanvasProfileDisplayText(text: string, profile: VisualProfile, detail: Pick<ProjectDetail, 'visual_profiles' | 'shots'>): string {
  const profiles = (detail.visual_profiles || []).filter(value => value.project_id === profile.project_id)
  const label = (value: Pick<VisualProfile, 'name' | 'variant'>) => `${value.name}（${value.variant}）`
  const references: VisualTextContext['references'] = profiles.map(value => ({ key: value.id, label: label(value) }))
  for (const value of profiles) {
    if (!value.source_draft_key || (value.design_id || null) !== (profile.design_id || null)) continue
    references.push({ key: value.source_draft_key, label: label(value) })
    references.push({ key: value.source_draft_key.replace(/::[a-f0-9]{8}$/, ''), label: label(value) })
  }
  for (const shot of detail.shots || []) {
    if (shot.project_id !== profile.project_id) continue
    references.push({ key: shot.id, label: `镜头「${shot.title}」` })
  }
  const base = profiles.find(value => value.id === profile.base_profile_id && value.kind && (value.design_id || null) === (profile.design_id || null))
  return resolveVisualProfileDisplayText(text, { references, baseLabel: base ? label(base) : undefined }).text
}
