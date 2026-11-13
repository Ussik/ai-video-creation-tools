import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { DocumentReview } from '@video-studio/shared/script/script-review-types'
import { scriptReviewGuidance } from '@video-studio/shared/script/script-quality'
import { one } from '../../infrastructure/database/db.js'
import { streamText, type GenerationModel, type GenerationProvider } from '../../infrastructure/providers/providers.js'
import { activityPreview, type activityRecorder } from './script-activity.js'
import type { ToolDocument } from './script-document-tools.js'
import { documentReviewInput, documentReviewSchema, projectReferences } from './script-document-review.js'
import { generationCheckpointStore } from './script-generation-checkpoints.js'
import { createGenerationSteps } from './script-generation-steps.js'
import { generatePagedReviewItems } from './script-review-pagination.js'

type ReviewTools = {
  execute: (name: string, args: unknown) => Promise<unknown>
  assertSourceUnchanged: () => void
  reviewRules: () => string
}

/** Only explicit review actions may enter this recovery. A failed native tool
 * call contributes no arguments; the report is regenerated as validated pages
 * and committed once through the existing version/read-coverage barrier. */
export function createDocumentReviewRecovery(options: {
  projectId: string; documentIds: string[]; documents: () => ToolDocument[]; prompt: string;
  context: () => unknown;
  model: GenerationModel & { name?: string }; provider: GenerationProvider;
  resolveKey: (provider: GenerationProvider) => string; tools: ReviewTools;
  activity: ReturnType<typeof activityRecorder>; signal?: AbortSignal;
}) {
  const selected = options.documentIds.map(id => {
    const document = options.documents().find(item => item.id === id)
    if (!document) throw new Error('审读目标文档已不存在，请重新选择')
    return document
  })
  const targets = selected.map(({ id, version }) => ({ id, version }))
  const recoveryContext = options.context()
  const contextHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const capturedContextHash = contextHash(recoveryContext)
  const identity = { version: 2, prompt: options.prompt, targets, context: recoveryContext,
    model: options.model, provider: options.provider }
  const store = generationCheckpointStore(options.projectId, identity, 'document-review-output')
  const steps = createGenerationSteps({ checkpoint: store.checkpoint, save: state => store.save(state), signal: options.signal })
  const strategyId = 'document-review:strategy'
  const strategy = z.literal('pages')
  const assertCurrent = () => {
    options.signal?.throwIfAborted()
    options.tools.assertSourceUnchanged()
    if (contextHash(options.context()) !== capturedContextHash) {
      throw Object.assign(new Error('审读依据或目标文档版本已变化，已停止提交，请基于当前版本重新审读'), { statusCode: 409 })
    }
    const current = options.documents()
    if (selected.some(document => current.find(item => item.id === document.id)?.version !== document.version)) {
      throw Object.assign(new Error('审读目标文档版本已变化，已停止提交，请基于当前版本重新审读'), { statusCode: 409 })
    }
  }
  const validateSubmitted = (value: unknown) => {
    assertCurrent()
    const report = documentReviewSchema.parse(value)
    if (report.documents.length !== targets.length || targets.some(target => !report.documents.some(item => item.id === target.id && item.version === target.version))) {
      throw new Error('审读提交断点与本轮选定文档不一致')
    }
    for (const target of targets) {
      const row = one<{ payload: string }>('SELECT payload FROM script_document_reviews WHERE project_id=? AND document_id=? AND document_version=?', options.projectId, target.id, target.version)
      if (!row || (JSON.parse(row.payload) as { id?: string }).id !== report.id) throw new Error('已提交的审读报告已变化，需重新提交当前结果')
    }
    return report
  }
  return {
    pending: steps.checkpoint.steps[strategyId]?.value === 'pages',
    async run(): Promise<DocumentReview> {
      assertCurrent()
      steps.retain(strategyId, '输出超限后分批完成文档审读', identity, 'pages', value => strategy.parse(value))
      const parent = options.activity.start({ kind: 'context', scope: 'step', label: '分批完成文档审读',
        summary: '沿用完整文稿和创作者要求，保留完整问题，全部核对完成后统一提交报告' })
      try {
        // Replay a successful commit without creating another report or asking
        // the model for a new summary after the original tool session failed.
        const saved = steps.checkpoint.steps['document-review:submitted']
        if (saved) {
          try {
            const report = validateSubmitted(saved.value)
            options.activity.finish(parent, 'succeeded', { summary: report.summary })
            return report
          } catch { steps.forget('document-review:submitted'); assertCurrent() }
        }
        const pending: Array<Record<string, unknown>> = selected.map(document => ({ document_ids: [document.id], source: 'saved', offset: 0, length: 20_000, scene_offset: 0, scene_limit: 3 }))
        while (pending.length) {
          assertCurrent()
          const result = await options.tools.execute('read_documents', pending.shift()!) as { continuations: Array<Record<string, unknown>> }
          pending.push(...result.continuations)
        }
        const references = projectReferences(options.projectId, options.documents())
        const reviewContext = await options.tools.execute('get_document_review_context', { document_ids: options.documentIds })
        const loadedRules = await steps.run('document-review:rules', '沿用已加载的审读规则及参考资料', identity,
          async () => options.tools.reviewRules(), value => z.string().max(100_000).parse(value), parent.id)
        const schema = documentReviewInput.shape.findings.element
        const validateFinding = (finding: z.infer<typeof schema>) => {
          assertCurrent()
          const document = selected.find(item => item.id === finding.document_id && item.version === finding.document_version)
          if (!document || !document.content.includes(finding.quote)) throw new Error('审读证据必须逐字来自本轮选定文档的当前原文')
          if (finding.related.some(related => !references.some(item => item.kind === related.kind && item.id === related.id))) throw new Error('审读关联对象不存在或不属于当前项目')
        }
        const prompt = options.prompt + '\n【输出超限后的文档审读】\n' +
          '之前截断的工具参数未执行。本轮只审读，不修订、保存正文或提出操作函数。完整阅读所给目标文档和上下文，按照下方质量规则逐项返回有原文证据的实质问题。' +
          '问题条目不包含报告summary或documents外壳；仅使用指定目标的真实document_id和document_version，quote逐字摘录，关联对象使用真实目录。' +
          '按事实、因果、人物、结构、对白和已明确的创作者要求核查；不为凑数编造问题，不将未授权的创作偏好升级为错误。\n' +
          scriptReviewGuidance + '\n已加载的审读规则及参考资料：\n' + loadedRules + '\n' +
          JSON.stringify({ documents: selected, complete_context: recoveryContext, review_context: reviewContext, references })
        const findings = await generatePagedReviewItems({ id: 'document-review:pages', name: 'script_document_review', itemSchema: schema,
          prompt, maxItems: 80, signal: options.signal, steps, parentId: parent.id, validateItem: validateFinding,
          generate: async (text, contract) => {
            assertCurrent()
            const entry = options.activity.start({ kind: 'model', parent_id: parent.id, name: options.model.name || options.model.remote_id,
              label: '生成审读报告分页', summary: '核对完整文稿，只返回尚未完成的问题条目' })
            try {
              const raw = await streamText(options.model, options.provider, { prompt: text, structured_output: contract }, options.resolveKey,
                undefined, options.signal, metrics => options.activity.update(entry, metrics))
              assertCurrent()
              options.activity.finish(entry, 'succeeded', { ...activityPreview(raw, 'output') })
              return raw
            } catch (issue) {
              options.activity.finish(entry, options.signal?.aborted ? 'cancelled' : 'failed', { summary: issue instanceof Error ? issue.message : String(issue) })
              throw issue
            }
          } })
        assertCurrent()
        const reportInput = documentReviewInput.parse({ documents: targets, findings,
          summary: `已完成 ${targets.length} 份文档的专业审读，${findings.length ? `发现 ${findings.length} 项有原文证据的问题或建议` : '未发现需要报告的实质问题'}。` })
        const report = await steps.run('document-review:submitted', '统一提交完整审读报告', { identity, reportInput }, async () => {
          assertCurrent()
          const result = await options.tools.execute('submit_document_review', reportInput) as { review: DocumentReview }
          return result.review
        }, validateSubmitted, parent.id)
        options.activity.finish(parent, 'succeeded', { summary: report.summary })
        return report
      } catch (issue) {
        options.activity.finish(parent, options.signal?.aborted ? 'cancelled' : 'failed', { summary: issue instanceof Error ? issue.message : String(issue) })
        throw issue
      }
    },
  }
}
