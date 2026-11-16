import { z } from 'zod'
import type { ScriptSourceKnowledge, ScriptSourceKnowledgePending } from '@video-studio/shared/script/script-source-knowledge'
const refs = z.array(z.number().int().min(0)).min(1)
const update = z.object({ status: z.enum(['confirmed', 'refuted']), at_unit_id: z.number().int().min(0), unit_ids: refs,
  story_time: z.string().min(1).max(200).optional() }).strict()
export const sourceKnowledgeSchema = z.array(z.object({
  category: z.enum(['identity', 'motive', 'causality', 'death', 'world_rule', 'foreshadowing', 'ending']),
  statement: z.string().trim().min(1).max(1200), kind: z.enum(['fact', 'statement', 'inference', 'plan']),
  holder: z.string().trim().min(1).max(80).nullable(), status: z.enum(['confirmed', 'unconfirmed', 'refuted']),
  at_unit_id: z.number().int().min(0), unit_ids: refs, story_time: z.string().min(1).max(200).optional(), updates: z.array(update).optional(),
}).strict())
type Unit = { id: number; offset: number; text: string }
export const knowledgeInstructions = '重要身份、动机、因果、死亡、规则、伏笔、结局用稀疏knowledge条目保留认识状态：kind区分fact/statement/inference/plan，holder填写原文实际说话或判断者，未知为null；status描述当时是否确认。' +
  '人物说法不等于事实，推测保留归属与未确认状态，计划不等于已经发生。unit_ids引用真实依据，at_unit_id为本章首次披露位置；后文确认或推翻写入updates及后文证据，不能改写此前判断。story_time仅记原文明示时间。' +
  'unit_ids每条证据必须已在at_unit_id时披露，禁止引用更大的unit编号来倒灌后文；首次位置不能机械取多条依据的最小编号，后续确认或推翻必须放入updates并保留对应时点，不把最终真相写成早期已知。' +
  'at_unit_id指完整结论在原文首次成立的位置，不是句子开头、剧情发生时间或角色知情时点。若规则跨连续多句，须读完全部限定才确定结论成立位置；不能机械用引用最小或最大ID。' +
  '作者在分集梗概明确叙述的发生事件仍是该作品内的叙事事实，不因文体是企划/梗概就标为角色plan或unconfirmed。只有原文人物的打算/未遂意图才是plan，holder填实际主体；作者将来创作的备选方案须明确区别，不能把所有梗概降格。作者叙述不代表当时角色知情；story_time仅是剧情时间，不能用unit坐标代替。' +
  'knowledge_pending是未采用的辅助候选，不能作为事实或角色知识复用；遇到疑问按原文回查，不通过修改正文或反复审核才能制作。' +
  'knowledge仅整理重要约束，不逐句拆分；summary、事件和下游大纲同时保留否定、推测、说法和计划限定。缺字段的旧资料认识状态未知，不能自动视为已确认；坐标和schema通过不证明语义真实。后揭示的真相不能反向赋予前期角色知识。'
export function validateSourceKnowledge(input: unknown, units: Unit[], range: { offset: number; length: number }): ScriptSourceKnowledge[] | undefined {
  if (input === undefined) return
  const result = sourceKnowledgeSchema.parse(input), byId = new Map(units.map(unit => [unit.id, unit]))
  const exists = (id: number) => {
    const unit = byId.get(id)
    if (!unit?.text.trim()) throw new Error(`knowledge.unit_ids引用不存在或空白unit：${id}`)
    return unit
  }
  for (const claim of result) {
    const at = exists(claim.at_unit_id)
    if (at.offset < range.offset || at.offset >= range.offset + range.length) throw new Error('knowledge.at_unit_id不在所属章节')
    const check = (value: { unit_ids: number[]; at_unit_id: number }) => {
      const point = exists(value.at_unit_id)
      if (new Set(value.unit_ids).size !== value.unit_ids.length) throw new Error('knowledge.unit_ids重复')
      for (const id of value.unit_ids) if (exists(id).offset > point.offset) throw new Error('knowledge.unit_ids晚于本次披露时点')
      return point.offset
    }
    let prior = check(claim)
    for (const item of claim.updates || []) { const next = check(item); if (next <= prior) throw new Error('knowledge.updates揭示unit必须严格晚于此前状态'); prior = next }
  }
  return result
}
/** Auxiliary knowledge must never veto an otherwise valid source map. This
 * partitions annotations, never edits facts, shifts IDs, or spends a model call. */
export function assessSourceKnowledge(input: unknown, units: Unit[], range: { offset: number; length: number }) {
  const accepted: ScriptSourceKnowledge[] = [], pending: ScriptSourceKnowledgePending[] = []
  if (input === undefined) return { accepted, pending }
  const candidates = Array.isArray(input) ? input : [input]
  for (const candidate of candidates) {
    const parsed = sourceKnowledgeSchema.element.safeParse(candidate)
    if (!parsed.success) {
      pending.push({ candidate: structuredClone(candidate), code: 'invalid_annotation', message: '辅助知识字段不合法，原候选保留，不作为事实复用' }); continue
    }
    const claim = parsed.data
    try {
      validateSourceKnowledge([claim], units, range)
      if (claim.kind === 'plan' && claim.holder === null) {
        pending.push({ candidate: structuredClone(candidate), code: 'unattributed_plan', message: '计划未说明主体，可能混淆作者叙述与角色意图；未自动改成事实' }); continue
      }
      accepted.push(claim)
    } catch (error) {
      const byId = new Map(units.map(unit => [unit.id, unit]))
      const refs = [...new Set(claim.unit_ids)].sort((a, b) => a - b)
      const forward = refs.some(id => (byId.get(id)?.offset ?? -1) > (byId.get(claim.at_unit_id)?.offset ?? Infinity))
      // Adjacent evidence is a span interpretation question, not permission to
      // silently move the disclosure. Sparse later evidence stays quarantined.
      const nonblank = units.filter(unit => unit.text.trim()), positions = new Map(nonblank.map((unit, index) => [unit.id, index]))
      const contiguous = refs.includes(claim.at_unit_id) && refs.every((id, i) => i === 0 || positions.get(id) === (positions.get(refs[i - 1]!) ?? -2) + 1) &&
        refs.every(id => { const u = byId.get(id); return u && u.offset >= range.offset && u.offset + u.text.length <= range.offset + range.length })
      pending.push({ candidate: structuredClone(candidate),
        code: forward ? contiguous ? 'evidence_span_unresolved' : 'later_disclosure_evidence' : 'invalid_coordinate',
        message: error instanceof Error ? error.message : '辅助知识引用无效' })
    }
  }
  return { accepted, pending }
}
export function knowledgeContext(sections: Array<{ offset: number; length: number; knowledge?: ScriptSourceKnowledge[]; knowledge_pending?: ScriptSourceKnowledgePending[] }>, units: Unit[]) {
  const annotated = sections.filter(section => section.knowledge !== undefined).length
  const assessed = sections.map(section => assessSourceKnowledge(section.knowledge, units, section))
  const claims = assessed.flatMap((item, section_id) => item.accepted.map(claim => ({ section_id, ...claim })))
  const pending = sections.flatMap((section, section_id) => [...(section.knowledge_pending || []), ...assessed[section_id]!.pending]
    .map(item => ({ section_id, ...item, usage: 'not_accepted_do_not_use_as_fact' as const })))
  const used = new Set(claims.flatMap(claim => [claim.at_unit_id, ...claim.unit_ids, ...(claim.updates || []).flatMap(item => [item.at_unit_id, ...item.unit_ids])]))
  return { schema_version: 1, semantic_verification: 'not_performed' as const,
    coverage: annotated === 0 ? 'unannotated' : annotated === sections.length ? 'annotated' : 'partial',
    instructions: knowledgeInstructions, claims, pending, annotation_status: pending.length ? 'needs_attention' as const : 'checked_coordinates_only' as const,
    units: units.filter(unit => used.has(unit.id)).map(unit => ({ unit_id: unit.id, offset: unit.offset, length: unit.text.length })),
    advisory: claims.filter(claim => claim.kind === 'fact' && /怀疑|据说|传闻|打算|计划|否认/.test(claim.statement))
      .map(claim => ({ section_id: claim.section_id, code: 'qualifier_may_be_missing' })),
  }
}
