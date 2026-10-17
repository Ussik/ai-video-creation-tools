import { createHash } from 'node:crypto'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { generateStructuredOutput, type StructuredGenerator } from '../generation/model-output.js'
import { workflowEnvelope, workflowGenerationDraftSchema, type WorkflowDraft, type workflowRequest } from './script-workflow.js'
import { completeSourceEvidence } from './script-source-material.js'
import { createGenerationSteps, type GenerationSteps } from './script-generation-steps.js'
import type { z } from 'zod'

/** Kept for existing callers. Manuscript size no longer selects a different
 * authoring pipeline: the entire stage is generated from the entire source. */
export async function generateLongStageDraft(request: z.infer<typeof workflowRequest>, prompt: string, source: ScriptSourceDocument,
  generate: StructuredGenerator, options: { signal?: AbortSignal; steps?: GenerationSteps; authoringPrompt?: string } = {}): Promise<WorkflowDraft> {
  const evidence = completeSourceEvidence(source)
  const steps = options.steps || createGenerationSteps({ signal: options.signal })
  const fullPrompt = (options.authoringPrompt ?? prompt) + `\n当前有效稿完整原文证据：${JSON.stringify(evidence)}` +
    '\n本次一次输出当前阶段全部栏目和完整分集大纲，保持人物、集数、主线、因果与结局一致，不截断、不省略、不保存。'
  const sourceKey = createHash('sha256').update(JSON.stringify(source)).digest('hex')
  const parse = (value: unknown) => workflowGenerationDraftSchema.parse({ ...(value as object), ...request })
  return steps.run('draft:whole', '编写阶段草稿', { strategy: 'whole-source-v1', prompt: fullPrompt, sourceKey, request },
    async () => parse(await generateStructuredOutput('workflow_draft', workflowEnvelope, generate, fullPrompt, { signal: options.signal, validate: parse })), parse)
}
