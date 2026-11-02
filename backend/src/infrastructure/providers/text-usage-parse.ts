export type ParsedTextUsage = {
  input_tokens?: number; output_tokens?: number; reasoning_tokens?: number
  cache_read_tokens?: number; cache_write_tokens?: number; cache_miss_tokens?: number
}

const metric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Reads a provider `usage` object. Only documented protocols are interpreted:
 * - OpenAI Responses/Chat: `*_tokens_details.cached_tokens` (a subset of input)
 * - OpenAI-compatible gateways: `*_tokens_details.cache_write_tokens` when present
 * - DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (sum to input)
 * A field the provider did not return stays undefined: unknown is never zero. */
export function parseTextUsage(usageValue: unknown): ParsedTextUsage {
  const usage = record(usageValue)
  if (!usage) return {}
  const input = metric(usage.input_tokens ?? usage.prompt_tokens), output = metric(usage.output_tokens ?? usage.completion_tokens)
  const outDetails = record(usage.output_tokens_details ?? usage.completion_tokens_details)
  const inDetails = record(usage.input_tokens_details ?? usage.prompt_tokens_details)
  const reasoning = metric(outDetails?.reasoning_tokens)
  const read = metric(usage.prompt_cache_hit_tokens) ?? metric(inDetails?.cached_tokens)
  const write = metric(inDetails?.cache_write_tokens)
  const miss = metric(usage.prompt_cache_miss_tokens)
  return { ...(input === undefined ? {} : { input_tokens: input }), ...(output === undefined ? {} : { output_tokens: output }),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
    ...(read === undefined ? {} : { cache_read_tokens: input === undefined ? read : Math.min(read, input) }),
    ...(write === undefined ? {} : { cache_write_tokens: write }), ...(miss === undefined ? {} : { cache_miss_tokens: miss }) }
}

/** What a request was for, derived from the structured contract it carries.
 * Contracts not listed keep their own name, so nothing is mislabelled. */
const purposeByContract: Record<string, string> = {
  workflow_draft: 'generation', script_draft: 'generation', script_stage_draft: 'generation',
  script_draft_completeness: 'review', script_draft_review_grouping: 'review', script_review: 'review',
  script_draft_evidence_repair: 'repair', reply_classification: 'classification',
  creation_skill_selection: 'skill_selection', tool_context_checkpoint: 'context_compaction',
}
export function requestPurpose(contractName: string | undefined): string {
  return contractName ? purposeByContract[contractName] ?? contractName.slice(0, 60) : 'text'
}
