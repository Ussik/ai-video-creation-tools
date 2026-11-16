import { sourceStructuredPolicy } from '../generation/source-structured-policy.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { TextOutputLimitError } from '../../infrastructure/providers/text-errors.js'
import { generateStructuredOutput, outputContract, restoreOptionalNulls, type StructuredGenerator } from '../generation/model-output.js'
import { normalizeSourceOutput } from '../generation/source-output-normalization.js'
import { createGenerationSteps } from './script-generation-steps.js'
import { generatePagedReviewItems } from './script-review-pagination.js'
import { sourceMapSchema, legacySourceMapSchema, sourceMapSectionSchema, sourceSectionRanges, type SourceMapResult, type SourcePassage } from './script-source-map.js'
import { sourceMapSyntaxRepair } from './script-source-map-syntax-repair.js'
import { sourceMapLocalRepairPlanner } from './script-source-map-local-repair.js'
import { recoverArrayStream } from './script-streamed-units.js'

type Checkpoint = NonNullable<NonNullable<ScriptSourceAnalysis['work']>[number]['output_checkpoint']>
type Section = SourceMapResult['sections'][number]
const pageId = 'source-map:pages'

/** Keep the normal one-request path. A confirmed text limit switches only the
 * output contract to closed sections, while every request still sees the full
 * source. Prefixes never imply coverage: the last section has no known end
 * until the complete window and its successor boundaries have been returned. */
export async function generateSourceMapOutput(prompt: string, selected: SourcePassage[], generate: StructuredGenerator, options: {
  signal: AbortSignal; budgetMs?: number; checkpoint: Checkpoint; persist: () => void;
  allPassages?: SourcePassage[]; localRepairOnly?: boolean;
  onAttempt?: (attempt: number) => void; onProgress?: (count: number) => void;
}): Promise<SourceMapResult> {
  const { checkpoint, signal } = options
  const currentPrompt = prompt.replace('【原文片段】',
    '【当前证据与存储协议】\n前文160字符、24条等属于旧检索展示建议，不是事实存储或剧本质量门禁；保留全部真实内容，不截字或删前提。独立事件可自然拆分，无需为展示数量合并或丢弃。' +
    '人物evidence.unit_id证明身份等事实，跨章时另给本章occurrence_unit_id证明出现；事件unit_id必须属于本章，辅助背景不得冒充发生位置。supporting_unit_ids保留其他真实证据，不机械丢弃多证据。坐标通过后仍须独立核对事实语义。\n【原文片段】')
  signal.throwIfAborted()
  let seed: Section[] = []
  if (checkpoint.seed) {
    if (checkpoint.pages || checkpoint.raw !== undefined || checkpoint.correction || checkpoint.seed.input_hash !== createHash('sha256').update(prompt).digest('hex')) {
      throw Object.assign(new Error('目录续传前缀与当前任务资料不一致，已保留原断点，不能重新生成或覆盖。'), { statusCode: 422, code: 'source_map_seed_conflict' })
    }
    seed = sourceMapSchema.parse({ sections: checkpoint.seed.sections }).sections
    const resolved = sourceSectionRanges({ sections: seed }, selected)
    if (!resolved.length) throw new Error('目录续传前缀不能为空')
    checkpoint.pages = { steps: {} }
  }
  if (!checkpoint.pages) {
    try {
      return await generateStructuredOutput('script_source_map', sourceMapSchema, generate, currentPrompt, {
        signal, budgetMs: options.budgetMs, localRepairOnly: options.localRepairOnly, structuralRepair: true, ...sourceStructuredPolicy(options.localRepairOnly), planSyntaxRepair: sourceMapSyntaxRepair, planLocalRepair: sourceMapLocalRepairPlanner(selected, false, false, options.allPassages || selected), checkpoint,
        preserveInputIdentity: true, completedInputs: [{ schema: outputContract('script_source_map', legacySourceMapSchema).schema, prompt }],
        persistCheckpoint: options.persist, onAttempt: options.onAttempt,
      })
    } catch (issue) {
      signal.throwIfAborted()
      // A complete candidate awaiting a format patch has its own durable
      // recovery. Its truncated patch is not a new directory item stream.
      if (!(issue instanceof TextOutputLimitError) || issue.outputLimitKind !== 'text' || checkpoint.raw !== undefined) throw issue
      const closed = recoverArrayStream(issue.partialText, 'sections')
      if (closed.length) {
        const normalized = normalizeSourceOutput('script_source_map', { sections: closed })
        seed = sourceMapSchema.parse(restoreOptionalNulls(normalized,
          z.toJSONSchema(sourceMapSchema, { io: 'input', unrepresentable: 'any' }))).sections
        sourceSectionRanges({ sections: seed }, selected)
      }
      checkpoint.pages = { steps: {} }
    }
  }
  const seededThrough = seed.length ? Math.max(...seed.flatMap(section => [section.start_unit, ...section.events.map(item => item.evidence.unit_id), ...section.characters.map(item => item.evidence.occurrence_unit_id ?? item.evidence.unit_id)]).filter(id => selected.some(p => p.units.some(u => u.id === id)))) : -1
  const steps = createGenerationSteps({ checkpoint: checkpoint.pages, signal, save: pages => {
    checkpoint.pages = pages
    delete checkpoint.seed
    const value = pages.steps[pageId]?.value as { items?: unknown[] } | undefined
    options.onProgress?.(value?.items?.length ?? 0)
    options.persist()
  } })
  const sections = await generatePagedReviewItems({ id: pageId, name: 'script_source_map', purpose: 'generation',
    itemSchema: sourceMapSectionSchema, prompt: currentPrompt + '\n【目录条目续传】\n' +
      'items每项对应原sections中的一个完整目录条目，沿用原output_window及全部事实和证据要求。' +
      `已保留前缀的事实至少延伸至unit_id=${seededThrough}；新增目录起点必须在此之后，不能把已保留事件切给新条目。\n` +
      '从已保留的最后一项之后继续，按真实语义补齐剩余章节，不重复、不改写、不合并已保留条目。' +
      '已保留条目只是本页前缀，最后一项尚无确定结束边界；不能据此认定后续原文已覆盖。' +
      '只有指定范围内全部章节、事件和人物均已完整列出，才可complete=true；不得为适应额度而概括或省略。',
    generate, signal, steps, initialItems: seed, maxItems: 1000, syntaxRecovery: true, localRepairOnly: options.localRepairOnly,
    preserveCheckpointIdentity: true, localRepairPlanner: () => sourceMapLocalRepairPlanner(selected, true, false, options.allPassages || selected),
    recoverOutputLimit: issue => issue.outputLimitKind === 'text',
    normalizeRecoveredItem: item => (normalizeSourceOutput('script_source_map_page', { items: [item] }) as { items: unknown[] }).items[0],
    validateItems: (items, complete) => {
      if (seed.length && items.slice(seed.length).some(item => item.start_unit <= seededThrough)) throw new Error('续传目录边界切入已保留前缀的事件范围，原候选未采用')
      if (items.length) sourceSectionRanges({ sections: items }, selected)
      if (complete) sourceMapSchema.parse({ sections: items })
    },
  })
  return sourceMapSchema.parse({ sections })
}
