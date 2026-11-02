/** Only provider-reported values belong in the actual token counters. Missing
 * usage remains in the estimate counters, including interrupted requests. */
export type ScriptRequestUsage = {
  /** Billable generation POSTs, distinct from background polling and cancel. */
  requests: number
  request_bytes: number
  transport_requests: number
  transport_request_bytes: number
  input_tokens: number
  output_tokens: number
  /** A subset of output_tokens, never added to the total a second time. */
  reasoning_tokens: number
  estimated_input_tokens: number
  estimated_output_tokens: number
  uncertain_requests: number
  /** A subset of input_tokens served from the provider cache. Only meaningful
   * for the requests counted by cache_read_reported_requests; a provider that
   * returns no cache field leaves it unknown instead of adding zero. */
  cache_read_tokens: number
  cache_read_reported_requests: number
  /** Tokens the provider reports as newly written to its cache. */
  cache_write_tokens: number
  cache_write_reported_requests: number
  /** Bounded IDs allow a resumed background response to replace its estimate. */
  pending_requests: Array<{ id: string; request_bytes: number; estimated_input_tokens: number;
    estimated_output_tokens: number; input_settled: boolean; output_settled: boolean; reasoning_tokens: number }>
}

export type ScriptRequestUsageLimits = {
  max_requests?: number
  max_tokens?: number
  /** Conservative reserve when the actual request has no output cap. */
  unknown_output_tokens?: number
}

export function createScriptRequestUsage(): ScriptRequestUsage {
  return { requests: 0, request_bytes: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    estimated_input_tokens: 0, estimated_output_tokens: 0, uncertain_requests: 0,
    cache_read_tokens: 0, cache_read_reported_requests: 0, cache_write_tokens: 0, cache_write_reported_requests: 0,
    transport_requests: 0, transport_request_bytes: 0, pending_requests: [] }
}

/** Estimated and actual counters are disjoint. Reasoning is already included
 * in the provider's completion/output total. */
export function scriptRequestUsageTokens(usage: ScriptRequestUsage): number {
  return usage.input_tokens + usage.output_tokens + usage.estimated_input_tokens + usage.estimated_output_tokens
}
