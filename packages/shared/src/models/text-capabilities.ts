export type TextBudgetMode = 'shared' | 'separate' | 'unknown'
export type TextModelLimits = {
  budget_mode: TextBudgetMode
  context_tokens?: number
  input_tokens?: number
  output_tokens?: number
  output_includes_reasoning?: boolean
}
export type TextCapabilityScope = { base_url: string; protocol: string; remote_id: string }
export type TextCompatibilityCapabilities = {
  structured_output?: Array<'json_schema' | 'json_object' | 'prompt'>
  tools?: boolean
  stream_usage?: boolean
  encrypted_reasoning?: boolean
  reasoning?: { mode: 'fixed' | 'adaptive' | 'effort'; effort_values?: string[]; minimum_budget_tokens?: number }
}
export type TextCapabilityDiscovery = { limits: TextModelLimits; compatibility?: TextCompatibilityCapabilities; source: 'provider'; fetched_at: string; scope: TextCapabilityScope }
export type TextCapabilities = {
  version: 1
  discovered?: TextCapabilityDiscovery
  override?: Partial<TextModelLimits> & { compatibility?: TextCompatibilityCapabilities }
}
export type TextCapabilitySource = 'override' | 'provider' | 'legacy' | 'unknown'
export type ResolvedTextCapabilities = {
  limits: TextModelLimits
  compatibility: TextCompatibilityCapabilities
  sources: Partial<Record<keyof TextModelLimits, TextCapabilitySource>>
  source: TextCapabilitySource
  configured: boolean
}

const fields = ['budget_mode', 'context_tokens', 'input_tokens', 'output_tokens', 'output_includes_reasoning'] as const
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function limitsError(value: unknown, partial: boolean): string | null {
  if (!record(value) || Object.keys(value).some(key => !(fields as readonly string[]).includes(key) && !(partial && key === 'compatibility'))) return '文本模型能力必须使用有效的能力字段'
  if ((!partial || value.budget_mode !== undefined) && !['shared', 'separate', 'unknown'].includes(String(value.budget_mode))) return '文本模型预算模式必须为 shared、separate 或 unknown'
  for (const key of ['context_tokens', 'input_tokens', 'output_tokens'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] <= 0)) return '文本模型能力上限必须为正整数 token 数；未知时请留空'
  }
  if (value.output_includes_reasoning !== undefined && typeof value.output_includes_reasoning !== 'boolean') return '思考是否计入生成额度必须为布尔值；未知时请留空'
  if (value.compatibility !== undefined) return compatibilityError(value.compatibility)
  return null
}

function compatibilityError(value: unknown): string | null {
  if (!record(value) || Object.keys(value).some(key => !['structured_output', 'tools', 'stream_usage', 'encrypted_reasoning', 'reasoning'].includes(key))) return '文本兼容能力包含未知字段'
  for (const key of ['tools', 'stream_usage', 'encrypted_reasoning']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return '文本兼容能力开关必须为布尔值'
  if (value.structured_output !== undefined && (!Array.isArray(value.structured_output) || value.structured_output.some(item => !['json_schema', 'json_object', 'prompt'].includes(String(item))))) return '结构化兼容能力必须使用已支持的格式列表'
  const thinking = value.reasoning
  if (thinking !== undefined && (!record(thinking) || Object.keys(thinking).some(key => !['mode', 'effort_values', 'minimum_budget_tokens'].includes(key)) || !['fixed', 'adaptive', 'effort'].includes(String(thinking.mode)) ||
    thinking.effort_values !== undefined && (!Array.isArray(thinking.effort_values) || thinking.effort_values.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(item))) ||
    thinking.minimum_budget_tokens !== undefined && (typeof thinking.minimum_budget_tokens !== 'number' || !Number.isSafeInteger(thinking.minimum_budget_tokens) || thinking.minimum_budget_tokens < 1))) return '推理兼容能力模式或预算无效'
  return null
}

export function textCapabilitiesConfigError(settings: Record<string, unknown>): string | null {
  const value = settings.text_capabilities
  if (value === undefined) return null
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'discovered', 'override'].includes(key))) return '文本模型能力配置版本或结构无效'
  if (value.override !== undefined) { const issue = limitsError(value.override, true); if (issue) return issue }
  if (value.discovered !== undefined) {
    const discovered = value.discovered
    if (!record(discovered) || Object.keys(discovered).some(key => !['limits', 'compatibility', 'source', 'fetched_at', 'scope'].includes(key)) || discovered.source !== 'provider'
      || typeof discovered.fetched_at !== 'string' || !Number.isFinite(Date.parse(discovered.fetched_at))) return '渠道能力必须包含来源与有效的获取时间'
    if (discovered.compatibility !== undefined) { const issue = compatibilityError(discovered.compatibility); if (issue) return issue }
    const issue = limitsError(discovered.limits, false)
    if (issue) return issue
    const scope = discovered.scope
    if (!record(scope) || Object.keys(scope).some(key => !['base_url', 'protocol', 'remote_id'].includes(key))
      || ['base_url', 'protocol', 'remote_id'].some(key => typeof scope[key] !== 'string' || !(scope[key] as string).trim())) return '渠道能力必须绑定 API 地址、协议与模型 ID'
    try { if (!['http:', 'https:'].includes(new URL(scope.base_url as string).protocol)) return '渠道能力的 API 地址必须为 HTTP 或 HTTPS 地址' }
    catch { return '渠道能力的 API 地址必须为 HTTP 或 HTTPS 地址' }
  }
  return null
}

/** Only discovery is channel-bound. Explicit user overrides remain visible and
 * authoritative when editing a connection; refreshing discovery never changes them. */
export function scopeTextCapabilities(settings: Record<string, unknown>, scope: TextCapabilityScope): Record<string, unknown> {
  const configured = settings.text_capabilities
  if (!record(configured) || !record(configured.discovered) || !record(configured.discovered.scope)) return settings
  const discoveredScope = configured.discovered.scope
  const normalize = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : value
  if (normalize(discoveredScope.base_url) === normalize(scope.base_url) && discoveredScope.protocol === scope.protocol && discoveredScope.remote_id === scope.remote_id) return settings
  const next = { ...configured }
  delete next.discovered
  return { ...settings, text_capabilities: next }
}

/** Absence of the new configuration retains the historical shared-window
 * contract. Unknown new capability fields never inherit unrelated legacy data. */
export function resolveTextCapabilities(settings: Record<string, unknown>): ResolvedTextCapabilities {
  const issue = textCapabilitiesConfigError(settings)
  if (issue) throw new Error(issue)
  const configured = settings.text_capabilities as TextCapabilities | undefined
  const limits: TextModelLimits = { budget_mode: 'unknown' }
  const compatibility = { ...configured?.discovered?.compatibility, ...configured?.override?.compatibility }
  const sources: ResolvedTextCapabilities['sources'] = { budget_mode: 'unknown' }
  if (!configured) {
    if (typeof settings.context_window_tokens === 'number' && Number.isSafeInteger(settings.context_window_tokens) && settings.context_window_tokens > 0) {
      limits.budget_mode = 'shared'; limits.context_tokens = settings.context_window_tokens
      sources.budget_mode = 'legacy'; sources.context_tokens = 'legacy'
      return { limits, compatibility, sources, source: 'legacy', configured: false }
    }
    return { limits, compatibility, sources, source: 'unknown', configured: false }
  }
  for (const [values, source] of [[configured.discovered?.limits, 'provider'], [configured.override, 'override']] as const) {
    if (!values) continue
    for (const field of fields) if (values[field] !== undefined) {
      Object.assign(limits, { [field]: values[field] })
      sources[field] = source
    }
  }
  const source = Object.values(sources).includes('override') ? 'override' : Object.values(sources).includes('provider') ? 'provider' : 'unknown'
  return { limits, compatibility, sources, source, configured: true }
}
