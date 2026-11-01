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

function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
const clauses = (text: string) => text.split(/[。！？!?；;\n]/).map(value => value.trim()).filter(Boolean)
const additionPattern = /(?:加入|新增|增加|添加|引入|入镜|出镜|进入画面|出现在画面)/
const negatedAdditionPattern = /(?:不|不要|无需|禁止|避免|取消|移除|删除)[^，,。；;\n]{0,8}(?:加入|新增|增加|添加|引入|入镜|出镜)/

export interface AddedReferenceCharacter {
  name: string
  asset_ids: string[]
  image_numbers: number[]
}

/** A name in a reference-use sentence is not evidence of an on-screen role. */
function hasCharacterSceneDepiction(body: string, characterName: string): boolean {
  const name = escapePattern(characterName)
  const action = '(?:位于|置于|处于|站在|站立|坐在|坐于|蹲|跪|躺|走|跑|奔|迈|抬|低头|转身|回头|注视|望向|看向|握|持|伸手|倚|靠在|左侧|右侧|中央|中心|前景|中景|远景|身旁|身后|前方|后方|并肩)'
  const depiction = new RegExp(`${name}[^，,。；;\\n]{0,24}${action}|(?:左侧|右侧|中央|中心|前景|中景|远景|身旁|身后|前方|后方)[^，,。；;\\n]{0,12}${name}`)
  return clauses(body).some(clause => clause.includes(characterName)
    && !new RegExp(`(?:不出现|不加入|不入镜|不出镜|无需|禁止|避免|移除|删除|没有)[^，,。；;\\n]{0,8}${name}|${name}[^，,。；;\\n]{0,8}(?:不入镜|不出镜|不在画面|不出现|仅作参考|仅作为参考)`).test(clause)
    && depiction.test(clause))
}

/** Check only explicit, identifiable additions. Ordinary edits need not list
 * every selected image or every character in the shot's historical bindings.
 */
export function requestedReferenceCharacters(adjustment: string, body: string, identities: RefinementReferenceIdentity[]): AddedReferenceCharacter[] {
  const positive = clauses(adjustment).filter(clause => additionPattern.test(clause) && !negatedAdditionPattern.test(clause))
  if (!positive.length) return []
  const addsCharacter = positive.some(clause => /(?:加入|新增|增加|添加|引入)(?:这个|该|此|这位|这名|一个)?新?(?:角色|人物)/.test(clause))
  const result = new Map<string, AddedReferenceCharacter>()
  for (const identity of identities) for (const profile of identity.profiles) {
    if (profile.kind !== 'character' || !profile.name.trim()) continue
    const imageLabel = new RegExp(`(?:参考图|图片)\\s*${identity.image_number}(?!\\d)`)
    const selectedAddition = new RegExp(`(?:加入|新增|增加|添加|引入)[^，,。；;\\n]{0,4}(?:参考图|图片)\\s*${identity.image_number}(?!\\d)(?:中|里|所示)?(?:的)?(?:人物|角色)|(?:参考图|图片)\\s*${identity.image_number}(?!\\d)(?:中|里|所示)?(?:的)?(?:人物|角色)[^，,。；;\\n]{0,8}(?:加入|入镜|出镜|进入画面)`)
    const selectedCharacter = imageLabel.test(adjustment) && (positive.some(clause => selectedAddition.test(clause))
      || positive.some(clause => /(?:加入|新增|增加|添加|引入)(?:这个|该|此|这位|这名|一个)?新?角色/.test(clause)))
    if (!adjustment.includes(profile.name) && !selectedCharacter) continue
    const name = escapePattern(profile.name)
    const directlyAdded = positive.some(clause => new RegExp(`(?:加入|新增|增加|添加|引入)(?:(?!参考图|图片|作为)[^，,。；;\\n]){0,12}${name}(?!(?:的)?参考图)|${name}[^，,。；;\\n]{0,12}(?:入镜|出镜|进入画面|出现在画面)`).test(clause))
    if (!directlyAdded && hasCharacterSceneDepiction(body, profile.name)) continue
    if (!directlyAdded && !selectedCharacter && !addsCharacter) continue
    const entry = result.get(profile.name) || { name: profile.name, asset_ids: [], image_numbers: [] }
    if (!entry.asset_ids.includes(identity.asset_id)) { entry.asset_ids.push(identity.asset_id); entry.image_numbers.push(identity.image_number) }
    result.set(profile.name, entry)
  }
  return [...result.values()]
}

/** Only unambiguous identity assignments are checked. Sharing a composition,
 * lighting or material reference across different characters remains valid.
 */
export function referenceIdentityAssignmentIssue(text: string, identities: RefinementReferenceIdentity[]): string | null {
  const characters = [...new Set(identities.flatMap(identity => identity.profiles.filter(profile => profile.kind === 'character').map(profile => profile.name)).filter(Boolean))]
  for (const clause of clauses(text)) for (const identity of identities) {
    if (!identity.profiles.some(profile => profile.kind === 'character')) continue
    const label = `(?:参考图|图片)\\s*${identity.image_number}(?!\\d)`
    for (const name of characters) {
      if (identity.profiles.some(profile => profile.name === name)) continue
      const person = escapePattern(name)
      const assignment = new RegExp(`${label}[^，,。；;\\n]{0,24}(?:作为|用于|用作)[^，,。；;\\n]{0,10}${person}(?:的)?(?:人物|身份|面部|五官|发型|服装|外观)|${person}(?:的)?(?:人物|身份|面部|五官|发型|服装|外观)[^，,。；;\\n]{0,20}${label}`)
      const matched = assignment.exec(clause)?.[0]
      if (matched && !/(?:不(?:要|能|可|应)?|无需|禁止|避免)[^，,。；;\n]{0,5}(?:作为|用于|用作|参考|依据|使用|采用)/.test(matched)) return `图片身份对应错误：${name} 的人物参考不能指向参考图 ${identity.image_number}（${identity.profiles.map(profile => profile.name).join(' / ') || '其他素材'}），请使用其实际人物参考图`
    }
  }
  return null
}

export function addedReferenceCharacterIssue(body: string, characters: AddedReferenceCharacter[]): string | null {
  for (const character of characters) {
    if (!hasCharacterSceneDepiction(body, character.name)) return `未落实新增人物“${character.name}”：必须在正文的当前画面中写明其位置或动作，不能只追加参考用途或否定其入镜`
    const associated = clauses(body).some(clause => clause.includes(character.name) && character.image_numbers.some(number => new RegExp(`(?:参考图|图片)\\s*${number}(?!\\d)`).test(clause)))
    if (!associated) return `新增人物“${character.name}”必须明确关联其实际参考图 ${character.image_numbers.join(' / ')}，不能使用其他人物图片`
  }
  return null
}
