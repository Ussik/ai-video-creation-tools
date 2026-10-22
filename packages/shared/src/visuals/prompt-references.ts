/** Prompt references persist asset identities, never a position in a mutable list. */
const tokenPattern = /\[\[ref:([^\]\r\n]+)\]\]/g
const validId = /^[a-zA-Z0-9_-]{1,100}$/
export type PromptReferenceOverrides = Record<string, string | null>

export function promptReferenceToken(assetId: string): string {
  if (!validId.test(assetId)) throw new Error('参考图片标识无效，请重新选择')
  return `[[ref:${assetId}]]`
}

export function extractPromptReferenceIds(prompt: string): string[] {
  const ids = [...prompt.matchAll(tokenPattern)].map(match => match[1]!)
  if (ids.some(id => !validId.test(id)) || prompt.replace(tokenPattern, '').includes('[[ref:')) {
    throw new Error('提示词中存在无效的图片引用，请重新选择')
  }
  return [...new Set(ids)]
}

export function tokenizePromptReferenceNumbers(prompt: string, referenceAssetIds: string[]): string {
  // Bare 图 N is a common image label too. Do not interpret resolution, decimal
  // values or compounds such as 地图1/构图1/绘图1 as a positional reference.
  return prompt.replace(/(?:参考图\s*|图片\s*|(?<![A-Za-z0-9_地蓝构绘插示视意图])图\s*)(\d+(?:\s*[、,，/和及]\s*\d+)*)(?![\dA-Za-z]|\.\d)/g, (label, numbers: string) => {
    if (![...numbers.matchAll(/\d+/g)].some(match => referenceAssetIds[Number(match[0]) - 1])) return label
    return numbers.replace(/\d+/g, number => {
      const id = referenceAssetIds[Number(number) - 1]
      return id ? promptReferenceToken(id) : `${label.startsWith('图片') ? '图片' : label.startsWith('参考图') ? '参考图' : '图'} ${number}`
    })
  })
}

export function resolvePromptReferences(input: {
  prompt: string; referenceAssetIds: string[]; overrides?: PromptReferenceOverrides;
  requiredAssetIds?: string[]; referenceLabel?: '参考图' | '图片'
}): { prompt: string; referenceAssetIds: string[]; replacements: PromptReferenceOverrides } {
  if ([...input.referenceAssetIds, ...(input.requiredAssetIds || [])].some(id => !validId.test(id))) {
    throw new Error('参考图片标识无效，请重新选择')
  }
  const explicitIds = extractPromptReferenceIds(input.prompt)
  const supplied = input.overrides || {}
  const replacements: PromptReferenceOverrides = {}
  for (const [source, target] of Object.entries(supplied)) {
    if (!validId.test(source) || target !== null && !validId.test(target)) throw new Error('参考图片标识无效，请重新选择')
    let current = target
    const seen = new Set([source])
    while (current && current !== source && Object.hasOwn(supplied, current) && supplied[current] !== current) {
      if (seen.has(current)) throw new Error('参考图片替换存在循环，请重新选择')
      seen.add(current)
      current = supplied[current]!
    }
    if (current === source && target !== source) throw new Error('参考图片替换存在循环，请重新选择')
    Object.defineProperty(replacements, source, { value: current, enumerable: true, writable: true, configurable: true })
  }
  for (const id of input.requiredAssetIds || []) {
    if (Object.hasOwn(replacements, id) && replacements[id] !== id) throw new Error('基础身份参考图必须保留，请在基础设定中调整')
  }
  // Collapse chains so submitting an already compiled preview is idempotent.
  const replace = (id: string) => Object.hasOwn(replacements, id) ? replacements[id] : id
  const ids = [...input.referenceAssetIds, ...explicitIds].flatMap(id => {
    const target = replace(id)
    return target ? [target] : []
  })
  const referenceAssetIds = [...new Set(ids)]
  if (input.requiredAssetIds?.some(id => !referenceAssetIds.includes(id))) {
    throw new Error('基础身份参考图缺失，请重新选择基础设定')
  }
  // Migrate legacy positions before replacement/removal changes their meaning.
  // Already compiled previews keep their final list and remain idempotent.
  const source = input.referenceAssetIds.some((id, index) => referenceAssetIds[index] !== id)
    ? tokenizePromptReferenceNumbers(input.prompt, input.referenceAssetIds) : input.prompt
  const prompt = source.replace(tokenPattern, (_token, id: string) => {
    const target = replace(id)
    return target ? `${input.referenceLabel || '参考图'} ${referenceAssetIds.indexOf(target) + 1}` : ''
  })
  return { prompt, referenceAssetIds, replacements }
}
