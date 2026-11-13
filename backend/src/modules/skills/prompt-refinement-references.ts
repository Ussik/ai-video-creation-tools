import { extractPromptReferenceIds, resolvePromptReferences, tokenizePromptReferenceNumbers, type PromptReferenceOverrides } from '@video-studio/shared/visuals/prompt-references'

export interface RefinementReferenceIdentity {
  asset_id: string
  image_number: number
  profiles: Array<{ profile_id: string; kind: 'character' | 'location' | 'prop'; name: string; variant: string }>
}

/** Resolve against the prepared list without the shared compiler's implicit append.
 * A textual request can describe a selected image; it cannot select another image.
 */
export function compileRefinementReferences(text: string, referenceAssetIds: string[], options: {
  suppliedReferenceIds?: string[]; overrides?: PromptReferenceOverrides; referenceLabel?: '参考图' | '图片'
} = {}): string {
  const tokenized = tokenizePromptReferenceNumbers(text, options.suppliedReferenceIds || referenceAssetIds)
  const ids = extractPromptReferenceIds(tokenized)
  for (const id of ids) {
    const target = Object.hasOwn(options.overrides || {}, id) ? options.overrides![id] : id
    if (!target || !referenceAssetIds.includes(target)) throw new Error('调整要求或整理结果中的参考已断开或未在当前模式生效，请重新选择图片')
  }
  const resolved = resolvePromptReferences({ prompt: tokenized, referenceAssetIds, overrides: options.overrides, referenceLabel: options.referenceLabel })
  if (resolved.referenceAssetIds.length !== referenceAssetIds.length || resolved.referenceAssetIds.some((id, index) => id !== referenceAssetIds[index])) {
    throw new Error('整理提示词不能新增未连接的图片，请先加入参考')
  }
  for (const match of resolved.prompt.matchAll(/(?:参考图|图片)\s*(\d+)(?!\d)/g)) {
    if (!referenceAssetIds[Number(match[1]) - 1]) throw new Error(`参考图 ${match[1]} 不在实际参考列表中，请重新选择图片`)
  }
  return resolved.prompt
}
