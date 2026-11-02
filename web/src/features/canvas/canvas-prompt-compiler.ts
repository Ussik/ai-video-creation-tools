import type { Model } from '../../shared/api/api'
import { withVisualProfilePrompt, type VisualProfilePromptDefinition, type VisualProfilePromptReference } from '@video-studio/shared/visuals/visual-profile-prompt'
import { withVisualSettingTemplate, type VisualSettingKind } from '@video-studio/shared/visuals/visual-setting-template'
import { visualGenerationPrompt, type PromptVisualBinding, type VideoReferencePromptOptions } from '@video-studio/shared/visuals/visual-prompt'
import { withProjectStyle, type ProjectVisualStyle } from '@video-studio/shared/visuals/visual-style'
import { extractPromptReferenceIds, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { imagePreferencePrompt } from './canvas-model-parameters'
import { videoPreferencePrompt } from './canvas-prompt-draft'

/** Only inputs which can change generated requirement text belong here. The
 * composer memoizes this snapshot independently of authored text and canvas UI. */
export type CanvasPromptCompilerInput = {
  profile?: VisualProfilePromptDefinition
  profileReferences: VisualProfilePromptReference[]
  templateKind?: VisualSettingKind
  /** Independent copied boards retain their source task without following the original profile. */
  boardTemplate?: string
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
  let profilePrompt = input.profile ? withVisualProfilePrompt(body, input.profile, input.profileReferences)
    : input.templateKind ? withVisualSettingTemplate(body, input.templateKind, references) : body
  if (input.templateKind && input.boardTemplate) {
    const primary = getManagedPromptBlocks(input.boardTemplate, ['设定图固定要求'])[0]
    const generatedPrimary = getManagedPromptBlocks(profilePrompt, ['设定图固定要求'])[0]
    if (primary && generatedPrimary) profilePrompt = profilePrompt.replace(generatedPrimary, () => primary)
    const sourceReferences = getManagedPromptBlocks(input.boardTemplate, ['生成参考图'])[0]
    const sourceIds = sourceReferences ? extractPromptReferenceIds(sourceReferences) : []
    // The fixed reference identity survives copying. Rebuild the reference
    // descriptions only after the creator actually changes the input order.
    if (sourceReferences && sourceIds.length === input.referenceIds.length && sourceIds.every((id, index) => id === input.referenceIds[index])) {
      const generatedReferences = getManagedPromptBlocks(profilePrompt, ['生成参考图'])[0]
      if (generatedReferences) profilePrompt = profilePrompt.replace(generatedReferences, () => sourceReferences)
    }
    const baseContext = getManagedPromptBlocks(input.boardTemplate, ['基础版本与本次状态变化', '基础身份参考'])
      .filter(block => extractPromptReferenceIds(block).every(id => input.referenceIds.includes(id)))
    if (baseContext.length) profilePrompt = [profilePrompt, ...baseContext].join('\n\n')
  }
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
