import type { Model } from '../../shared/api/api'
import { withVisualProfilePrompt, type VisualProfilePromptDefinition, type VisualProfilePromptReference } from '@video-studio/shared/visuals/visual-profile-prompt'
import { withVisualSettingTemplate, type VisualSettingKind } from '@video-studio/shared/visuals/visual-setting-template'
import { visualGenerationPrompt, type PromptVisualBinding, type VideoReferencePromptOptions } from '@video-studio/shared/visuals/visual-prompt'
import { withProjectStyle, type ProjectVisualStyle } from '@video-studio/shared/visuals/visual-style'
import { tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { imagePreferencePrompt } from './canvas-model-parameters'
import { videoPreferencePrompt } from './canvas-prompt-draft'

/** Only inputs which can change generated requirement text belong here. The
 * composer memoizes this snapshot independently of authored text and canvas UI. */
export type CanvasPromptCompilerInput = {
  profile?: VisualProfilePromptDefinition
  profileReferences: VisualProfilePromptReference[]
  templateKind?: VisualSettingKind
  referenceIds: string[]
  referenceNames: string[]
  model?: Pick<Model, 'modality' | 'settings'>
  ratio: string
  resolution: string | null
  clarity: string | null
  quality: string | null
  background: string | null
  duration: number
  durationFollowsSource: boolean
  mode: string
  bindings: PromptVisualBinding[]
  visualReferenceMode: string
  videoOptions?: VideoReferencePromptOptions
  excludedProfileIds?: string[]
  style?: ProjectVisualStyle
}

export function compileCanvasPrompt(body: string, input: CanvasPromptCompilerInput): string {
  const references = input.referenceIds.map((asset_id, index) => ({ asset_id, name: input.referenceNames[index] || '参考图片' }))
  const profilePrompt = input.profile ? withVisualProfilePrompt(body, input.profile, input.profileReferences)
    : input.templateKind ? withVisualSettingTemplate(body, input.templateKind, references) : body
  if (!input.model || input.model.modality === 'text') return tokenizePromptReferenceNumbers(profilePrompt, input.referenceIds)
  const preferencePrompt = input.model.modality === 'image' ? imagePreferencePrompt(input.model, profilePrompt, {
    ratio: input.ratio, resolution: input.resolution, clarity: input.clarity, quality: input.quality, background: input.background,
  }, input.referenceIds.length ? 'reference' : 'text') : videoPreferencePrompt(profilePrompt, input.mode, input.duration, {
    ratio: input.ratio, resolution: input.resolution || undefined, durationFollowsSource: input.durationFollowsSource,
  })
  const prompt = withProjectStyle(input.profile || input.templateKind ? preferencePrompt : visualGenerationPrompt(preferencePrompt,
    input.bindings, input.referenceIds, input.visualReferenceMode, input.videoOptions || { excluded_visual_profile_ids: input.excludedProfileIds }), input.style)
  return tokenizePromptReferenceNumbers(prompt, input.referenceIds)
}
