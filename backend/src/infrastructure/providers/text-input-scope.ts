import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { currentModelRequestContext } from '../../modules/generation/model-task-policy.js'
import { estimateTextRequestTokens, textRequestInput } from './text-context.js'

export type TextInputScopeDiagnostics = { input_scope_hash: string; input_scene_count: number; input_shot_count: number;
  input_scope_chars: number; input_rules_chars: number; input_facts_chars: number; input_profiles_chars: number; input_original_chars: number;
  input_scope_stage: 'catalog' | 'profile' | 'coverage'; input_boundary: 'assembly' | 'transport'; input_scope_present: boolean;
  input_transport_chars?: number; input_transport_estimated_tokens?: number; input_schema_hash?: string; input_schema_present?: boolean }
type Scope = { evidence: string; diagnostics: Omit<TextInputScopeDiagnostics, 'input_boundary' | 'input_scope_present'> }
const scopes = new AsyncLocalStorage<Scope>()
export function withTextInputScope<T>(input: Omit<Scope, 'diagnostics'> & { diagnostics: Omit<Scope['diagnostics'], 'input_scope_hash' | 'input_scope_chars'> },
  prompt: string, work: () => T): T {
  const scope: Scope = { evidence: input.evidence, diagnostics: { ...input.diagnostics,
    input_scope_chars: input.evidence.length, input_scope_hash: createHash('sha256').update(input.evidence).digest('hex') } }
  return scopes.run(scope, () => { verify([prompt], 'assembly'); return work() })
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
export class TextInputScopeError extends Error {
  readonly statusCode = 422
  readonly retryable = false
  readonly delivery = 'not_sent'
  constructor(public readonly code: 'visual_input_assembly_missing' | 'visual_input_transport_missing', public readonly failure_stage: TextInputScopeDiagnostics['input_boundary']) {
    super(failure_stage === 'assembly' ? '视觉输入组装缺少本次完整场次/镜头数据，未发送请求' : '请求模板转换丢失本次场次/镜头数据，未发送请求')
  }
}
function verify(content: unknown, boundary: TextInputScopeDiagnostics['input_boundary']) {
  const scope = scopes.getStore()
  if (!scope) return
  const present = strings(content).some(text => text.includes(scope.evidence))
  const event = { phase: 'structure' as const, status: present ? 'valid' as const : 'invalid_business' as const,
    ...scope.diagnostics, input_boundary: boundary, input_scope_present: present,
    ...(!present ? { failure_code: boundary === 'assembly' ? 'visual_input_assembly_missing' : 'visual_input_transport_missing' } : {}) }
  if (!present) {
    try { currentModelRequestContext()?.onResult?.(event) } catch { /* Diagnostics do not authorize requests. */ }
    throw new TextInputScopeError(boundary === 'assembly' ? 'visual_input_assembly_missing' : 'visual_input_transport_missing', boundary)
  }
}
/** Verify the final planned model input, not schema/metadata containing coincident IDs. */
export function assertTextInputScopeBody(body: unknown) {
  const scope = scopes.getStore()
  if (!scope) return
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const actual = textRequestInput(body)
  scope.diagnostics.input_transport_chars = JSON.stringify(actual).length
  scope.diagnostics.input_transport_estimated_tokens = estimateTextRequestTokens(actual)
  const native = (value.output_config as any)?.format?.schema || (value.text as any)?.format?.schema || (value.response_format as any)?.json_schema?.schema
  scope.diagnostics.input_schema_present = !!native
  if (native) scope.diagnostics.input_schema_hash = createHash('sha256').update(JSON.stringify(native)).digest('hex')
  verify([value.input, value.messages, value.prompt, value.system], 'transport')
}
export function textInputScopeDiagnostics(): Partial<TextInputScopeDiagnostics> {
  const scope = scopes.getStore()
  return scope ? { ...scope.diagnostics, input_boundary: 'transport', input_scope_present: true } : {}
}
