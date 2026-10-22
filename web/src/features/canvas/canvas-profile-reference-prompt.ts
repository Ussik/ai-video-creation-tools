import { promptReferenceToken } from '@video-studio/shared/visuals/prompt-references'

// Only this exact generated block is managed. Edited prose, including text
// between similar markers, belongs to the user and must survive synchronization.
const managedBaseReference = /(?:\n\n)?【基础身份参考】\n\[\[ref:([a-zA-Z0-9_-]{1,100})\]\] 用于保持基础版本身份与未变特征。\n【基础身份参考结束】/g

/** Remove the generated reference context before saving the editable body. */
export function stripVisualProfileBaseReference(prompt: string): string {
  return prompt.replace(managedBaseReference, '')
}

/** Keep a visible, stable mention of the confirmed identity image. References
 * to other images and all surrounding user text remain unchanged. A known old
 * base mention follows a newly confirmed base rather than becoming a stale @.
 */
export function withVisualProfileBaseReference(prompt: string, baseAssetId?: string | null, previousBaseAssetId?: string | null): string {
  const previousIds = new Set([...prompt.matchAll(managedBaseReference)].map(match => match[1]!))
  if (previousBaseAssetId) previousIds.add(previousBaseAssetId)
  let body = stripVisualProfileBaseReference(prompt)
  if (!baseAssetId) return body
  const token = promptReferenceToken(baseAssetId)
  for (const previousId of previousIds) {
    if (previousId !== baseAssetId) body = body.replaceAll(promptReferenceToken(previousId), token)
  }
  // A user's own mention already provides the visible reference. Do not add a
  // second managed copy, or rewrite their wording around the existing mention.
  if (body.includes(token)) return body
  return `${body}${body ? '\n\n' : ''}【基础身份参考】\n${token} 用于保持基础版本身份与未变特征。\n【基础身份参考结束】`
}
