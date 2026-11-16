import { createHash } from 'node:crypto'
import { z } from 'zod'
import { fixedLocalRepair, type StructuredOutputLocalPlanner } from '../generation/model-output-local-repair.js'
import { createDraftRepairReferences, type DraftRepairReferenceSource } from './script-draft-repair-references.js'
import { frozenPassageReplacementFields } from './script-frozen-locators.js'
import { documentParagraphs, ScriptToolProblem } from './script-revision.js'
import { parseScriptSceneDurationReplacement } from './script-workflow.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Edit = { source_key: string; find?: string; paragraph_id?: string; replace: string; reason: string }

/** Retain independently valid proposed operations, including valid siblings
 * of schema-invalid edits. Conflict groups are corrected together. Nothing in
 * this planner changes the original document or approves creative semantics. */
export function draftLocalRepairPlanner(options: {
  sources: readonly DraftRepairReferenceSource[]
  references: ReturnType<typeof createDraftRepairReferences>
  editSchema: z.ZodType<Omit<Edit, 'source_key'> & { source_key?: string }>
  field?: 'edits' | 'source_edits'
  sourceKey?: string
  onPlan?: (state: unknown) => void
  decisions: unknown
  assertCurrent: () => void
}): StructuredOutputLocalPlanner {
  return (candidate, failure) => {
    options.assertCurrent()
    const field = options.field || 'edits'
    const envelope = z.object({ summary: z.string().trim().min(1).max(3000), [field]: z.array(z.unknown()).max(200) }).strict().safeParse(candidate)
    if (!envelope.success || !(envelope.data[field] as unknown[]).length) return
    const proposals = envelope.data[field] as unknown[], invalid = new Map<number, string>()
    const valid: Array<{ index: number; edit: Edit; start: number; end: number }> = []
    proposals.forEach((proposal, index) => {
      const parsed = options.editSchema.safeParse(proposal)
      if (!parsed.success) { invalid.set(index, '字段或引用不符合当前工作集契约'); return }
      const edit = { ...parsed.data, source_key: parsed.data.source_key || options.sourceKey || '' }, source = options.sources.find(source => source.key === edit.source_key)
      if (!source) { invalid.set(index, '来源不属于当前工作集'); return }
      try {
        const [resolved] = options.references.resolveEdits(source.key, [edit])
        if (/^scene:\d+:duration$/.test(source.key)) {
          try { parseScriptSceneDurationReplacement(source.content.slice(0, resolved!.start) + edit.replace + source.content.slice(resolved!.end)) }
          catch { invalid.set(index, 'invalid_scene_duration'); return }
        }
        valid.push({ index, edit, start: resolved!.start, end: resolved!.end })
      } catch (error) {
        if (!(error instanceof ScriptToolProblem)) throw error
        invalid.set(index, error.diagnostic.code)
      }
    })
    const conflicts: Array<[number, number]> = []
    for (const left of valid) for (const right of valid) if (left.index < right.index && left.edit.source_key === right.edit.source_key && left.start < right.end && right.start < left.end) {
      invalid.set(left.index, 'overlapping_passages'); invalid.set(right.index, 'overlapping_passages'); conflicts.push([left.index, right.index])
    }
    if (!invalid.size) return
    const targets = [...invalid.keys()].sort((a, b) => a - b)
    const needed = options.references.documents.flatMap(document => {
      const failed = targets.map(index => proposals[index]).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
        .filter(item => (item.source_key || options.sourceKey) === document.source_key)
      if (!failed.length && targets.every(index => !!proposals[index] && typeof proposals[index] === 'object' && options.sources.some(source => source.key === ((proposals[index] as Record<string, unknown>).source_key || options.sourceKey)))) return []
      const ids = new Set(failed.map(item => typeof item.ref_id === 'string' ? item.ref_id : typeof item.paragraph_id === 'string' ? options.references.referenceForParagraph(document.source_key, item.paragraph_id) : undefined))
      // No guessed correspondence for a malformed old quotation. Only that
      // workset expands to its full frozen blocks; no manuscript/history replay.
      const known = new Set(document.parts.filter((part): part is [string, string] => Array.isArray(part)).map(part => part[0]))
      const unknownTarget = !failed.length || [...ids].some(id => !id || !known.has(id))
      return [{ ...document, parts: unknownTarget ? document.parts : document.parts.filter(part => Array.isArray(part) && ids.has(part[0])) }]
    })
    const binding = hash(options.sources.map(source => [source.key, options.references.locatorVersion(source.key)]))
    const failed = targets.map(index => ({ key: `edit_${index}`, operation_id: hash([binding, index, proposals[index]]), path: `$.${field}[${index}]`, reason: invalid.get(index), proposal: proposals[index] }))
    const components: number[][] = []
    for (const [left, right] of conflicts) {
      const matches = components.filter(group => group.includes(left) || group.includes(right))
      const merged = [...new Set([left, right, ...matches.flat()])].sort((a, b) => a - b)
      for (const group of matches) components.splice(components.indexOf(group), 1)
      components.push(merged)
    }
    const conflictIndices = new Set(components.flat())
    options.onPlan?.({ binding, failed, conflict_groups: components, retained_indices: valid.filter(item => !invalid.has(item.index)).map(item => item.index), correction_limit: 1 })
    const prompt = '只修正以下程序固定失败项及已列冲突组，操作身份绑定当前冻结版本；不要删除操作，不改其他有效提案。' +
        '使用当前replace_ref或paragraph_id，不报告offset，不复制长旧文本，不调用不存在的工具；合并后的整包仍须原精确、冲突、版本、业务及独立语义检查。\n' +
        `固定方案和修订范围：${JSON.stringify(options.decisions)}\n失败目标：${JSON.stringify(failed)}\n必要冻结块：${JSON.stringify(needed)}\n` +
        `已保留的其他提案目标：${JSON.stringify(valid.filter(item => !invalid.has(item.index)).map(item => ({ index: item.index, source_key: item.edit.source_key, paragraph_id: item.edit.paragraph_id, reason: item.edit.reason })))}`

    if (!components.length) return fixedLocalRepair({ candidate, targets: targets.map(index => ({ key: `edit_${index}`, path: [field, index], schema: options.editSchema })), prompt })
    // A proven overlap group is one fixed correction target. Request exactly
    // one explicit merged operation covering every original trusted range;
    // independent valid operations cannot be deleted or rewritten.
    const groups = components.map(indices => {
      const ranges = indices.map(index => valid.find(item => item.index === index)!)
      const sourceKey = ranges[0]!.edit.source_key, source = options.sources.find(source => source.key === sourceKey)!
      const start = Math.min(...ranges.map(item => item.start)), end = Math.max(...ranges.map(item => item.end))
      const paragraph = documentParagraphs(source.content, options.references.locatorVersion(sourceKey)).find(item => item.start === start && item.end === end)
      const find = source.content.slice(start, end)
      if (!paragraph && (source.content.indexOf(find) !== start || source.content.lastIndexOf(find) !== start)) throw new Error('冲突组冻结范围不能唯一绑定，保留原提案并停止纠正')
      return { indices, key: `group_${indices.join('_')}`, sourceKey, start, end, text: find,
        locator: paragraph ? { paragraph_id: paragraph.id } : { find } }
    })
    const shape = Object.fromEntries([
      ...targets.filter(index => !conflictIndices.has(index)).map(index => [`edit_${index}`, options.editSchema] as const),
      ...groups.map(group => [group.key, z.object(frozenPassageReplacementFields).strict()] as const),
    ])
    const schema = z.object({ repairs: z.object(shape).strict() }).strict()
    const frozen = structuredClone(candidate) as { summary: string; edits?: unknown[]; source_edits?: unknown[] }
    return { schema,
      prompt: prompt + '\n已核实重叠组及程序固定原文：' + JSON.stringify(groups.map(({ key, indices, sourceKey, text }) => ({ key, indices, source_key: sourceKey, text }))) +
        '。每组仅返回{replace,reason}，replace为该固定原文范围的完整合并新值；不返回source、定位、offset或数组，不删除有效兄弟提案。程序按固定来源及范围合并该组，其他失败单项仍只返回固定edit_N。',
      apply(value) {
        options.assertCurrent()
        const patch = schema.parse(value), replacements = new Map<number, unknown>(), removed = new Set<number>()
        for (const index of targets.filter(index => !conflictIndices.has(index))) replacements.set(index, patch.repairs[`edit_${index}`])
        for (const group of groups) {
          const replacement = { ...group.locator, ...patch.repairs[group.key] as { replace: string; reason: string } }
          const [range] = options.references.resolveEdits(group.sourceKey, [{ ...replacement, source_key: group.sourceKey }])
          if (!range || range.start !== group.start || range.end !== group.end) throw new Error('合并编辑必须精确等于程序固定的冲突范围')
          const canonical = options.sourceKey ? replacement : { ...replacement, source_key: group.sourceKey }
          replacements.set(group.indices[0]!, canonical)
          for (const index of group.indices.slice(1)) removed.add(index)
        }
        const result = structuredClone(frozen)
        result[field] = proposals.flatMap((proposal, index) => removed.has(index) ? [] : [replacements.has(index) ? structuredClone(replacements.get(index)) : structuredClone(proposal)])
        return result
      },
    }

  }
}
