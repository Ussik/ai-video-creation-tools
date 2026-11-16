import { z } from 'zod'
import { quotedLineSyntaxRepair, proposeQuotedLineSyntax, reasonedQuotedLineRepair } from '../generation/model-output-syntax-repair.js'
import { restoreOptionalNulls } from '../generation/model-output.js'
import { normalizeSourceOutput } from '../generation/source-output-normalization.js'
import { sourceMapSchema, sourceMapSectionSchema } from './script-source-map.js'
import type { StructuredOutputLocalRepair } from '../generation/model-output-local-repair.js'

/** Combine syntax confirmation and already-visible locator-length failures in
 * the same one correction. All facts, knowledge and evidence stay frozen.
 * Unknown fields/types or source errors do not gain an automatic repair. */
export function legacySourceMapSyntaxRepair(raw: string): StructuredOutputLocalRepair | undefined {
  const proposal = proposeQuotedLineSyntax(raw), syntax = quotedLineSyntaxRepair(raw)
  if (!proposal || !syntax) return
  const originalSchema = z.toJSONSchema(sourceMapSchema, { io: 'input', unrepresentable: 'any' })
  const candidate = restoreOptionalNulls(normalizeSourceOutput('script_source_map', proposal.value), originalSchema) as { sections?: Array<Record<string, unknown>> }
  const parsed = sourceMapSchema.safeParse(candidate)
  if (parsed.success) return syntax
  const indexes = new Set<number>()
  for (const issue of parsed.error.issues) {
    if (issue.code !== 'too_big' || issue.path.length !== 3 || issue.path[0] !== 'sections' || typeof issue.path[1] !== 'number' || issue.path[2] !== 'summary') return
    indexes.add(issue.path[1])
  }
  if (!indexes.size || indexes.size > 20) return
  const targets = [...indexes].map(index => ({ key: `section_${index}_summary`, index, original: candidate.sections![index]!.summary }))
  const schema = z.object({ candidate_hash: z.literal(proposal.audit.original_hash), approve: z.boolean(),
    repairs: z.object(Object.fromEntries(targets.map(target => [target.key, sourceMapSectionSchema.shape.summary]))).strict() }).strict()
  return {
    schema, syntaxAudit: proposal.audit,
    prompt: syntax.prompt + '\n【同一次固定字段纠正】以下定位摘要超过1200字符。只将列出的summary收敛为80–240字符的定位说明。' +
      '原文正文、人物、事件、知识及引用全部由程序冻结，不返回也不删除。不得新增事实或将推测改成事实。' +
      '语法补丁如有歧义仍返回approve=false；本次不增加纠正额度。\n' + JSON.stringify({ targets }),
    apply(patch) {
      const value = schema.parse(patch)
      syntax.apply({ candidate_hash: value.candidate_hash, approve: value.approve })
      const merged = structuredClone(candidate)
      for (const target of targets) merged.sections![target.index]!.summary = value.repairs[target.key]
      return merged
    },
  }
}

/** Only for fresh unresolved syntax. Legacy approvals are exact completed
 * response replay shapes, not an additional approval request. */
export function sourceMapSyntaxRepair(raw: string): StructuredOutputLocalRepair | undefined {
  const plan = reasonedQuotedLineRepair(raw)
  if (!plan) return
  const legacy = legacySourceMapSyntaxRepair(raw)
  if (legacy) plan.completedReplay = [legacy]
  return plan
}
