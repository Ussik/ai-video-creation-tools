import type { ScriptSourceAnalysis, ScriptSourceCharacterEvidenceIssue, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'

const nameKey = (name: string) => name.normalize('NFKC').trim()
// Only a pair of complete name-shaped labels can be represented as name + alias.
// Ages, lists, nested annotations and explicit unknowns are not alias labels.
// This syntax check never establishes an identity; the model supplies that
// interpretation in one character record, and the independent audit retains it.
export function compoundNames(label: string): [string, string] | undefined {
  const match = /^([^()/]+)\(([^()/]+)\)$/u.exec(label) || /^([^()/]+)\/([^()/]+)$/u.exec(label)
  if (!match) return
  const pair = [match[1]!.trim(), match[2]!.trim()] as [string, string]
  const name = /^[\p{L}\p{M}·・.'’\-]+(?: [\p{L}\p{M}·・.'’\-]+)*$/u
  if (pair.some(value => value.length < 2 || !name.test(value) ||
    /^(?:[零〇一二三四五六七八九十百两]+(?:余|多)?岁(?:半)?|(?:身份|姓名|本名|原名|真名|年龄)(?:不明|不详|未知|待定)|不明|未知|待定)$/u.test(value))) return
  return pair[0] !== pair[1] ? pair : undefined
}

/** Directory mentions and the exact source ranges are alternative evidence.
 * A directory omission must never hide a name actually present in that range.
 * These matches locate names; they do not prove that two names are one person. */
export function createSourceCharacterEvidence(state: Pick<ScriptSourceAnalysis, 'sections'>, source: { content: string }) {
  const sections = state.sections.map(section => ({
    text: source.content.slice(section.offset, section.offset + section.length).normalize('NFKC'),
    names: new Set(section.characters.map(character => character.name.normalize('NFKC').trim())),
  }))
  const matches = new Map<string, number[]>()
  const sectionsFor = (name: string): number[] => {
    const key = name.normalize('NFKC').trim()
    if (!key) return []
    let ids = matches.get(key)
    if (!ids) {
      ids = sections.flatMap((section, id) => section.names.has(key) || section.text.includes(key) ? [id] : [])
      matches.set(key, ids)
    }
    return [...ids]
  }
  const supports = (name: string, sectionIds: number[]) => {
    if (!sectionIds.length || new Set(sectionIds).size !== sectionIds.length ||
      sectionIds.some(id => !Number.isInteger(id) || id < 0 || id >= sections.length)) return false
    const candidates = new Set(sectionsFor(name))
    return sectionIds.some(id => candidates.has(id))
  }
  const directoryNames = new Set(state.sections.flatMap(section => section.characters.map(character => nameKey(character.name))))
  const isLikelyOccupationalSuffix = (suffix: string) => {
    // Heuristic: likely occupational if contains common role-indicating suffixes
    // and is not an explicit identity clarification
    const hasRoleIndicator = /(?:长|主|柜|官|员|师|手|者|人|工)$/.test(suffix)
    const notIdentityClarification = !/(?:又名|真名|本名|化名|实为|即为|未知|不详|本人|就是)/.test(suffix)
    const reasonableLength = suffix.length >= 2 && suffix.length <= 8
    return hasRoleIndicator && notIdentityClarification && reasonableLength
  }

  const coversDirectoryName = (character: Pick<ScriptSourceStory['characters'][number], 'name' | 'aliases' | 'section_ids'>, target: string) => {
    const key = nameKey(target), names = new Set([character.name, ...character.aliases].map(nameKey))
    if (names.has(key)) return true
    if (!directoryNames.has(key)) return false
    const role = /^([^()/]+)\(([^()/]+)\)$/u.exec(key)
    // Exact head + exact source heading in the record's own cited section.
    // Use heuristic validation for occupational suffixes instead of hardcoded whitelist.
    // This accepts "实习调查员", "副科长", "资深掌柜" etc.
    if (role && isLikelyOccupationalSuffix(role[2]!.trim()) &&
      names.has(role[1]!.trim()) &&
      supports(role[1]!.trim(), character.section_ids) && character.section_ids.some(id => sections[id]?.text.includes(key))) return true
    const pair = compoundNames(key)
    // Do not split targets or combine different characters. The entire label
    // must be literal source in this model record's own cited sections, and
    // both complete spellings must already occur in that same record.
    return !!pair && pair.every(name => names.has(name) && supports(name, character.section_ids)) &&
      character.section_ids.some(id => sections[id]?.text.includes(key))
  }
  const describe = (ids: number[]) => ids.slice(0, 8).map(id => `${id}「${state.sections[id]?.title.slice(0, 48) || '未知章节'}」`).join('、') +
    (ids.length > 8 ? `等共 ${ids.length} 处` : '')
  const issue = (taskKey: string, characterName: string, name: string, sectionIds: number[]) => {
    const evidenceIds = sectionsFor(name)
    const details: ScriptSourceCharacterEvidenceIssue = { task_key: taskKey, character_name: characterName, name,
      section_ids: [...sectionIds], evidence_section_ids: evidenceIds }
    const message = `人物任务「${taskKey}」中「${characterName}」的姓名或别名「${name}」没有所引章节的原文或目录证据。` +
      `已引用章节ID：${describe(sectionIds) || '无'}。` + (evidenceIds.length
        ? `可核验该名称的章节ID：${describe(evidenceIds)}。请依据完整原文核对身份关系，修正或补齐真实来源章节；名称出现不代表属于同一人物。`
        : '完整原文与目录中均未找到该名称，请核对名称写法、来源和身份关系。')
    return { message, details }
  }
  return { sectionsFor, supports, coversDirectoryName, issue }
}
