import type { ScriptSourceAnalysis, ScriptSourceCharacterEvidenceIssue } from '@video-studio/shared/script/script-source-document'

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
  return { sectionsFor, supports, issue }
}
