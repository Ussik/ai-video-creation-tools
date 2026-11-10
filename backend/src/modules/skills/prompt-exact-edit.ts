import { createHash } from 'node:crypto'
import { z } from 'zod'
import { modelStepSignal } from '../generation/model-execution.js'
import { modelContextFor, modelTaskPolicies, withModelRequestContext } from '../generation/model-task-policy.js'
import type { StructuredGenerator } from '../generation/model-output.js'
import { generatePagedReviewItems } from '../script/script-review-pagination.js'
import type { GenerationSteps } from '../script/script-generation-steps.js'

export type PromptExactPatch = {
  id: string; source_hash: string; find: string; replace: string
  anchor?: { paragraph_id: string; paragraph_hash: string }
}
export const promptSourceHash = (source: string) => createHash('sha256').update(source).digest('hex')
export function promptParagraphs(source: string) {
  const paragraphs: { id: string; hash: string; start: number; end: number }[] = []
  let start = 0
  for (const separator of source.matchAll(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/gu)) {
    if (separator.index > start) paragraphs.push({ id: `p${paragraphs.length + 1}`, hash: promptSourceHash(source.slice(start, separator.index)), start, end: separator.index })
    start = separator.index + separator[0].length
  }
  if (start < source.length) paragraphs.push({ id: `p${paragraphs.length + 1}`, hash: promptSourceHash(source.slice(start)), start, end: source.length })
  return paragraphs
}
function invalid(message: string): never { throw Object.assign(new Error(`提示词精确编辑未采用：${message}`), { statusCode: 422 }) }

/** Every edit addresses the immutable original. Resolve all positions first,
 * then apply backwards so repeated words and earlier edits cannot shift scope. */
export function applyExactPromptPatches(source: string, patches: readonly PromptExactPatch[], maxLength = 80_000): string {
  const sourceHash = promptSourceHash(source), paragraphs = promptParagraphs(source)
  const ids = new Set<string>()
  const edits = patches.map(patch => {
    if (patch.source_hash !== sourceHash) invalid('原文哈希不一致，请使用当前完整原文')
    if (!patch.id || ids.has(patch.id)) invalid('补丁 ID 必须稳定且唯一')
    ids.add(patch.id)
    if (!patch.find || patch.find.length > 4000 || patch.replace.length > 6000) invalid('每次只替换一个不超过 4000 字的原文片段，替换结果最多 6000 字')
    if (patch.find === patch.replace) invalid('补丁没有实际修改')
    let start = 0, end = source.length
    if (patch.anchor) {
      const paragraph = paragraphs.find(item => item.id === patch.anchor!.paragraph_id)
      if (!paragraph || paragraph.hash !== patch.anchor.paragraph_hash) invalid('段落锚点与原文不一致')
      start = paragraph.start; end = paragraph.end
    }
    const scope = source.slice(start, end), index = scope.indexOf(patch.find)
    if (index < 0) invalid('find 必须逐字匹配原文，不得改写、归一化空白或补省略号')
    if (scope.indexOf(patch.find, index + 1) >= 0) invalid('find 在目标范围内出现多次，请扩大上下文或指定唯一段落锚点')
    return { start: start + index, end: start + index + patch.find.length, replace: patch.replace }
  }).sort((left, right) => left.start - right.start)
  for (let index = 1; index < edits.length; index++) if (edits[index]!.start < edits[index - 1]!.end) invalid('补丁范围不能重叠，所有 find 均针对同一份原文')
  let candidate = source
  for (const edit of [...edits].reverse()) candidate = candidate.slice(0, edit.start) + edit.replace + candidate.slice(edit.end)
  if (!candidate.trim() || candidate.length > maxLength) invalid('完整候选正文为空或超过业务长度上限')
  return candidate
}

/** Long bodies stay intact in the model context. Only exact changes are paged;
 * each retained page must produce a complete candidate satisfying the same
 * deterministic contracts as the short whole-body path. */
export async function generateExactPromptEdits(options: {
  source: string; prompt: string; generate: StructuredGenerator; steps: GenerationSteps; signal?: AbortSignal;
  validate: (candidate: string) => void; maxLength?: number
}): Promise<{ prompt: string }> {
  const sourceHash = promptSourceHash(options.source), paragraphs = promptParagraphs(options.source)
  const patch = z.object({ id: z.string().trim().min(1).max(160), source_hash: z.literal(sourceHash),
    find: z.string().min(1).max(4000), replace: z.string().max(6000),
    anchor: z.object({ paragraph_id: z.string().regex(/^p[1-9]\d*$/u), paragraph_hash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional() }).strict()
  const prompt = options.prompt + '\n【长正文精确编辑协议】保留上方完整基稿、全部规则、实际参考图及调整要求。' +
    '只返回本次需要的局部 find/replace 补丁，不重写或复述整篇正文，不缩减原稿。原任务中的 prompt 外壳在本协议中改为 items 和 complete。' +
    `每项 source_hash 固定为 ${sourceHash}；find 必须逐字摘取原文的连续片段（最多 4000 字），replace 为完整替换结果（最多 6000 字），空串表示删除。` +
    '所有补丁始终针对同一份未修改的原始基稿，id 稳定唯一，位置不得重叠；不得匹配前一补丁的替换结果。' +
    'find 在全文唯一时不必提供 anchor；短句重复时，可用下方完整段落的 id 和 hash 限定范围，且 find 在该段内必须唯一。' +
    '未涉及的文本、标点、段落和对白由程序原样保留。新增内容可通过替换相邻的唯一原文片段插入。没有实际变化的补丁无效。' +
    '每页补丁合并到原文后都必须满足既有对白、参考图、参数和系统区块规则；必须配对的移动或替换放在同一页，先落实强制约束。' +
    '完整调整全部完成才 complete=true；无需修改可返回 items:[]、complete:true，不得用完成标志代替未完成调整。' +
    `\n原文哈希：${sourceHash}\n原文段落锚点（位置从 0 开始，end 不含末字；原文仍以上方完整基稿为准）：${JSON.stringify(paragraphs)}`
  return withModelRequestContext({ ...modelContextFor('refined_prompt'), policy: modelTaskPolicies.prompt, signal: modelStepSignal(options.signal) }, async () => {
    const patches = await generatePagedReviewItems({ id: 'candidate:exact-patches', name: 'refined_prompt', purpose: 'generation',
      itemSchema: patch, prompt, generate: options.generate, steps: options.steps, signal: options.signal, maxItems: 2000,
      validateItems: (values, complete) => {
        const candidate = applyExactPromptPatches(options.source, values, options.maxLength)
        // The empty seed has not proposed a page yet. An explicit empty final
        // page must still satisfy every current candidate constraint.
        if (values.length || complete) options.validate(candidate)
      } })
    const candidate = applyExactPromptPatches(options.source, patches, options.maxLength)
    options.validate(candidate)
    return { prompt: candidate }
  })
}
