export type VisualTextReference = { key: string; label: string }
export type VisualTextIssue = { token: string; reason: 'unresolved' | 'ambiguous' }
export type VisualTextContext = {
  references: VisualTextReference[]
  /** Only an explicit stored relation can resolve a historical base draft key. */
  baseLabel?: string
}

const protectedText = /\[\[ref:[^\]\r\n]*\]\]|https?:\/\/[^\s<>"'，。；！？）】]+|(?:file|data|blob):[^\s<>"']+/gi
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const asciiKeyCharacter = /[A-Za-z0-9_-]/
// This is a narrowly identified prose role, not a guess based on an ID's shape.
const historicalBase = /(基础(?:版本|设定)?(?:为|是|[：:])\s*(?:本批|本轮)(?:草稿)?\s*[「“"`]?)([A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+){2,}(?:::[a-f0-9]{8})?)([」”"`]?)/g
const unresolvedReference = /((?:基础设定|关联设定|草稿)(?:ID|编号|标识)[：:]\s*[「“"`]?)([A-Za-z0-9_:-]{8,})([」”"`]?)/g

/** Derive readable prose without mutating persisted text or machine references. */
export function resolveVisualProfileDisplayText(text: string, context: VisualTextContext): { text: string; issues: VisualTextIssue[] } {
  const labels = new Map<string, string | null>()
  for (const { key, label } of context.references) {
    if (!key || !label || !text.includes(key)) continue
    labels.set(key, labels.has(key) && labels.get(key) !== label ? null : label)
  }
  const issues: VisualTextIssue[] = []
  const issue = (token: string, reason: VisualTextIssue['reason']) => {
    if (!issues.some(item => item.token === token && item.reason === reason)) issues.push({ token, reason })
  }
  const pattern = labels.size ? new RegExp([...labels.keys()].sort((a, b) => b.length - a.length).map(escaped).join('|'), 'g') : null
  const resolve = (source: string) => {
    let result = pattern ? source.replace(pattern, (key, offset: number) => {
      if (offset > 0 && asciiKeyCharacter.test(source[offset - 1]!) || asciiKeyCharacter.test(source[offset + key.length] || '')
        || source.slice(Math.max(0, offset - 2), offset) === '::' || source.slice(offset + key.length, offset + key.length + 2) === '::') return key
      const label = labels.get(key)
      if (label) return label
      issue(key, 'ambiguous')
      return '关联设定待核对'
    }) : source
    result = result.replace(historicalBase, (_match, prefix: string, key: string, suffix: string) => {
      if (context.baseLabel) return `${prefix}${context.baseLabel}${suffix}`
      issue(key, 'unresolved')
      return `${prefix}关联设定待核对${suffix}`
    })
    return result.replace(unresolvedReference, (_match, prefix: string, key: string, suffix: string) => {
      issue(key, 'unresolved')
      return `${prefix}关联设定待核对${suffix}`
    })
  }
  // Keep URLs and stable image-reference tokens byte-for-byte, even when an ID
  // inside them happens to match a project object or a draft key.
  let result = '', offset = 0
  for (const match of text.matchAll(protectedText)) {
    result += resolve(text.slice(offset, match.index)) + match[0]
    offset = match.index! + match[0].length
  }
  result += resolve(text.slice(offset))
  return { text: result, issues }
}

export const visualProfileTextInstructions = 'definition、view_requirements、state_delta及其他可读说明只使用人物/地点/道具名称、版本名称和镜头标题，不写裸ID、draft_key或base_draft_key。真实ID和草稿键仅填写对应结构化字段，基础关系仍通过base_profile_id或base_draft_key表达。'
