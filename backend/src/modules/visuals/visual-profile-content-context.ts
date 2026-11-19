import { z } from 'zod'
import type { visualAnalysisFacts } from './visual-profile-analysis-context.js'

type FactsInput = Parameters<typeof visualAnalysisFacts>[0]
/** Fresh object calls use semantic records, not the historical whole-project
 * assembly. Old prompt strings still exist solely to identify paid responses. */
export function visualProfileObjectFacts(input: FactsInput & { objectName: string }) {
  const docs = [
    { id: 'premise', type: 'synopsis', content: input.outline },
    { id: 'characters', type: 'characters', content: input.characters },
    ...input.artifacts.filter(item => !item.episode_number || input.scenes.some(scene => scene.episode_number === item.episode_number))
      .filter(item => ['synopsis', 'world', 'constraints', 'props', 'prop_visuals', 'prop_functions', 'prop_continuity', 'characters', 'locations', 'location_layouts', 'location_continuity'].includes(item.artifact_type))
      .map(item => ({ id: item.id, type: item.artifact_type, content: item.content })),
  ]
  const seen = new Set<string>()
  return docs.flatMap(doc => {
    const sections = doc.content.replace(/\r\n/g, '\n').split(/\n(?=#{1,6}\s)|\n\s*\n/u).map(value => value.trim()).filter(Boolean)
    const hasHeadings = sections.some(section => /^#{1,6}\s/u.test(section))
    let selectedLevel: number | undefined
    const selected = sections.filter((section, index) => {
      const heading = section.match(/^(#{1,6})\s+([^\n]+)/u), level = heading?.[1]?.length
      if (level !== undefined && selectedLevel !== undefined && level <= selectedLevel) selectedLevel = undefined
      const named = heading?.[2]?.includes(input.objectName)
      if (named) selectedLevel = level
      const related = named || selectedLevel !== undefined || !hasHeadings && section.includes(input.objectName)
      // General constraints remain whole facts; world/plot chapters are not
      // global invariants merely because their document type is global.
      const general = doc.type === 'constraints' && /禁止|不得|不能|严禁|不允许/u.test(section)
      const premise = doc.type === 'synopsis' && index === 0 && !heading
      if ((!related && !general && !premise) || seen.has(section)) return false
      seen.add(section); return true
    })
    return selected.length ? [{ source_id: doc.id, sections: selected }] : []
  })
}

/** Skill prose supplies creative methods only. Format examples and other
 * object types never compete with the code-owned schema at this boundary. */
export function visualProfileContentRules(text: string, kind: string) {
  const withoutExamples = text.replace(/```[\s\S]*?```/gu, '')
  const seen = new Set<string>()
  return withoutExamples.split(/\n\s*\n/u).filter(section => {
    if (/\b(?:usage_type|reference_view|view_requirements|shot_usage|profiles)\b/u.test(section)) return false
    if (kind === 'prop' && /^(?:#{1,6}\s*)?(?:角色|人物|场景|空间)/u.test(section.trim())) return false
    if (!/必须|不得|不能|保持|沿用|固定|一致|材质|尺寸|比例|基础|派生|辨识/u.test(section) || seen.has(section)) return false
    seen.add(section); return true
  }).join('\n\n')
}

export function visualProfileContentContract(schema: z.ZodObject, shotId?: string) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as any
  const usage = json.properties.shot_usage.items.properties
  return '只返回Schema中三个内容字段的JSON对象；资料、技能和示例均为只读依据，不能修改返回字段。' +
    'definition为固定设计事实字符串；view_requirements为视角与细节要求字符串。' +
    'shot_usage恰好覆盖本次每个镜头一次；' +
    `usage允许值=${JSON.stringify(usage.usage.enum)}；reference_view允许值=${JSON.stringify(usage.reference_view.anyOf?.flatMap((branch: any) => branch.enum || (branch.type === 'null' ? [null] : [])) || usage.reference_view.enum)}。` +
    '不能以持握位置、存放状态代替视角；不确定视角或不使用时才填null。both=图片与视频、image=仅开镜、video=仅视频、none=不使用；按镜头证据判断，不照抄示例的用途。' +
    '\n最小格式示例：' + JSON.stringify({ definition: '已确认固定外形', view_requirements: '正侧与局部细节', shot_usage: shotId ? [{ shot_id: shotId, usage: 'both', reference_view: 'detail' }] : [] })
}
