import { resolveTextCapabilities, textCapabilitiesConfigError } from './text-capabilities.js'

export type TextApiProtocol = 'responses' | 'chat_completions' | 'anthropic_messages'
export type TextOutputMode = 'auto' | 'fixed' | 'upstream'
export const textReasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type TextReasoningLevel = typeof textReasoningLevels[number]
export type TextReasoningSettings = {
  enabled: boolean
  default_level: TextReasoningLevel
  levels: Array<{ level: TextReasoningLevel; api_value: string }>
}
export type StandardTextApiSettings = {
  mode: 'standard'
  output_mode?: TextOutputMode
  max_output_tokens?: number
  chat_output_field?: 'max_completion_tokens' | 'max_tokens'
  reasoning_effort?: string
  thinking?: 'enabled' | 'disabled' | 'auto'
  reasoning?: TextReasoningSettings
  request_parameters?: Record<string, unknown>
}

export const textApiManagedFields = ['request_path', 'request_template', 'request_templates', 'stream_request_template', 'text_path', 'text_paths', 'stream_text_paths'] as const
const managedFields = textApiManagedFields
const reservedParameters = new Set(['model', 'input', 'messages', 'prompt', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'reasoning', 'reasoning_effort', 'thinking', 'output_config', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'text'])
const standardOptions = new Set(['mode', 'output_mode', 'max_output_tokens', 'chat_output_field', 'reasoning_effort', 'thinking', 'reasoning', 'request_parameters'])
const migratableParameters = new Set(['temperature', 'top_p', 'seed', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 'service_tier', 'store', 'metadata', 'verbosity'])
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function hasTemplate(value: unknown): boolean { return /\{\{/.test(JSON.stringify(value) ?? '') }

export function standardTextSettings(_protocol?: TextApiProtocol): Record<string, unknown> { return { text_api: { mode: 'standard' } } }

/** Historical explicit caps remain fixed; historical empty caps keep the
 * upstream default. Automatic allocation is always an explicit choice. */
export function textOutputMode(settings: Record<string, unknown>): TextOutputMode {
  const api = record(settings.text_api) ? settings.text_api : undefined
  return api?.output_mode as TextOutputMode | undefined ?? (api?.max_output_tokens === undefined ? 'upstream' : 'fixed')
}

/** Managed forms have one source of truth. An advanced template must be explicitly custom. */
export function textApiConfigError(settings: Record<string, unknown>, protocol?: string): string | null {
  if (settings.text_api === undefined) return null
  if (protocol !== undefined && !['responses', 'chat_completions', 'anthropic_messages'].includes(protocol)) return '标准文本接口仅支持 Responses、Chat Completions 或 Anthropic Messages'
  const api = settings.text_api
  if (!record(api) || !['standard', 'custom'].includes(String(api.mode))) return '文本接口模式必须为 standard 或 custom'
  if (api.mode === 'custom') return Object.keys(api).some(key => key !== 'mode') ? '自定义接口的请求参数请配置在自定义模板中' : null
  const conflict = managedFields.find(key => settings[key] !== undefined)
  if (conflict) return `标准接口由表单生成 ${conflict}，请移除重复模板配置，或切换自定义接口`
  if (Object.keys(api).some(key => !standardOptions.has(key))) return '文本标准接口包含未知选项，请使用高级自定义接口配置'
  if (api.output_mode !== undefined && !['auto', 'fixed', 'upstream'].includes(String(api.output_mode))) return '生成额度模式必须为 auto、fixed 或 upstream'
  if (api.max_output_tokens !== undefined && (typeof api.max_output_tokens !== 'number' || !Number.isSafeInteger(api.max_output_tokens) || api.max_output_tokens <= 0)) return '最大输出必须为正整数 token 数；沿用上游默认时请留空'
  const outputMode = textOutputMode(settings)
  if (outputMode === 'fixed' && api.max_output_tokens === undefined) return '固定生成额度必须明确填写最大输出 token 数'
  if (protocol === 'anthropic_messages' && outputMode === 'upstream') return 'Anthropic Messages 必须明确填写最大输出 token 数，或选择自动安排'
  const capabilityIssue = textCapabilitiesConfigError(settings)
  if (capabilityIssue) return capabilityIssue
  const { limits } = resolveTextCapabilities(settings)
  if (outputMode === 'fixed' && typeof api.max_output_tokens === 'number') {
    if (limits.output_tokens !== undefined && api.max_output_tokens > limits.output_tokens) return '固定最大输出超过已配置的模型生成上限，请调整额度或核对渠道能力'
    if (limits.budget_mode === 'shared' && limits.context_tokens !== undefined && api.max_output_tokens >= limits.context_tokens) return '最大输出必须小于上下文容量，才能容纳输入'
  }
  if (api.chat_output_field !== undefined && !['max_completion_tokens', 'max_tokens'].includes(String(api.chat_output_field))) return 'Chat 输出参数必须为 max_completion_tokens 或 max_tokens'
  if (api.reasoning_effort !== undefined && (typeof api.reasoning_effort !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(api.reasoning_effort))) return '推理强度必须为接口支持的非空参数值；沿用上游默认时请留空'
  if (api.thinking !== undefined && !['enabled', 'disabled', 'auto'].includes(String(api.thinking))) return 'thinking 开关必须为 enabled、disabled 或 auto'
  if (api.reasoning !== undefined) {
    const reasoning = api.reasoning
    if (!record(reasoning) || Object.keys(reasoning).some(key => !['enabled', 'default_level', 'levels'].includes(key)) ||
      typeof reasoning.enabled !== 'boolean' || !(textReasoningLevels as readonly unknown[]).includes(reasoning.default_level) || !Array.isArray(reasoning.levels) ||
      reasoning.levels.length > textReasoningLevels.length) return '推理设置必须包含开关、默认档位与档位 API 值映射'
    const seen = new Set<string>()
    for (const mapping of reasoning.levels) {
      if (!record(mapping) || Object.keys(mapping).some(key => !['level', 'api_value'].includes(key)) ||
        !(textReasoningLevels as readonly unknown[]).includes(mapping.level) || typeof mapping.api_value !== 'string' ||
        mapping.api_value.length > 40 || mapping.api_value !== '' && !/^[a-zA-Z0-9_-]+$/.test(mapping.api_value) || seen.has(String(mapping.level))) return '推理档位不能重复，API 值必须为接口支持的参数标识'
      seen.add(String(mapping.level))
    }
    if (reasoning.enabled && (!seen.has(String(reasoning.default_level)) || reasoning.levels.some(mapping =>
      (mapping as { level: unknown; api_value: string }).level !== 'off' && !(mapping as { api_value: string }).api_value))) return '启用推理时必须配置默认档位及所有已添加档位的 API 值'
  }
  if (api.request_parameters !== undefined) {
    if (!record(api.request_parameters)) return '标准接口附加参数必须为对象'
    if (Object.keys(api.request_parameters).some(key => reservedParameters.has(key))) return '输出、推理及协议字段应使用表单设置，不能在附加参数中重复配置'
    if (hasTemplate(api.request_parameters)) return '附加参数不能包含请求模板变量，请切换高级自定义接口'
  }
  return null
}

export function resolveTextApiSettings(settings: Record<string, unknown>, protocol: string): Record<string, unknown> {
  const issue = textApiConfigError(settings, protocol)
  if (issue) throw new Error(issue)
  if (!record(settings.text_api) || settings.text_api.mode !== 'standard') return settings
  const api = settings.text_api as StandardTextApiSettings
  const body: Record<string, unknown> = { ...api.request_parameters, model: '{{model}}', ...(protocol === 'responses'
    ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) }
  if (textOutputMode(settings) === 'fixed') body[protocol === 'responses' ? 'max_output_tokens' : protocol === 'anthropic_messages' ? 'max_tokens' : api.chat_output_field ?? 'max_completion_tokens'] = api.max_output_tokens
  if (api.reasoning) {
    if (api.reasoning.enabled) {
      const selected = api.reasoning.levels.find(mapping => mapping.level === api.reasoning!.default_level)!
      if (selected.level === 'off') {
        if (protocol === 'anthropic_messages') body.thinking = { type: 'disabled' }
        else if (protocol === 'responses') body.reasoning = { effort: 'none' }
        else body.reasoning_effort = 'none'
      }
      else if (protocol === 'anthropic_messages') {
        body.thinking = { type: 'adaptive' }; body.output_config = { effort: selected.api_value }
      } else if (protocol === 'responses') body.reasoning = { effort: selected.api_value }
      else body.reasoning_effort = selected.api_value
    }
  } else if (api.reasoning_effort !== undefined) {
    if (protocol === 'responses') body.reasoning = { effort: api.reasoning_effort }
    else if (protocol === 'anthropic_messages') { body.thinking = { type: 'adaptive' }; body.output_config = { effort: api.reasoning_effort } }
    else body.reasoning_effort = api.reasoning_effort
  }
  if (!api.reasoning && api.thinking !== undefined) body.thinking = { type: protocol === 'anthropic_messages' && api.thinking !== 'disabled' ? 'adaptive' : api.thinking }
  return { ...settings, request_path: protocol === 'responses' ? 'responses' : protocol === 'anthropic_messages' ? 'messages' : 'chat/completions', request_template: body,
    ...(protocol === 'responses' ? { text_paths: ['output_text', 'output'] } : protocol === 'anthropic_messages' ? { text_path: 'content' } : { text_path: 'choices.0.message.content' }) }
}

/** Only unambiguous legacy envelopes are adopted. Unknown contracts remain custom. */
export function migrateStandardTextSettings(settings: Record<string, unknown>, protocol: TextApiProtocol): Record<string, unknown> | null {
  if (record(settings.text_api)) return settings.text_api.mode === 'standard' ? { ...settings } : null
  if (settings.text_api !== undefined || settings.request_path !== (protocol === 'responses' ? 'responses' : protocol === 'anthropic_messages' ? 'messages' : 'chat/completions')
    || settings.stream_request_template !== undefined || settings.stream_text_paths !== undefined || settings.request_templates !== undefined) return null
  if (protocol === 'responses') {
    if (!(settings.text_path === 'output_text' && settings.text_paths === undefined || settings.text_path === undefined &&
      (same(settings.text_paths, ['output_text', 'output']) || same(settings.text_paths, ['output_text'])))) return null
  } else if (settings.text_path !== (protocol === 'anthropic_messages' ? 'content' : 'choices.0.message.content') || settings.text_paths !== undefined) return null
  if (!record(settings.request_template)) return null
  const body = { ...settings.request_template }
  if (body.model !== '{{model}}') return null
  delete body.model
  if (protocol === 'responses') { if (body.input !== '{{prompt}}') return null; delete body.input }
  else { if (!same(body.messages, [{ role: 'user', content: '{{prompt}}' }])) return null; delete body.messages }
  const api: StandardTextApiSettings = { mode: 'standard' }
  const capKeys = ['max_output_tokens', 'max_completion_tokens', 'max_tokens'].filter(key => body[key] !== undefined)
  if (capKeys.length > 1 || capKeys.some(key => protocol === 'responses' ? key !== 'max_output_tokens' : protocol === 'anthropic_messages' ? key !== 'max_tokens' : key === 'max_output_tokens')) return null
  if (capKeys[0]) {
    api.max_output_tokens = body[capKeys[0]] as number
    if (protocol === 'chat_completions') api.chat_output_field = capKeys[0] as 'max_completion_tokens' | 'max_tokens'
    delete body[capKeys[0]]
  }
  if (protocol === 'responses' && body.reasoning !== undefined) {
    if (!record(body.reasoning) || Object.keys(body.reasoning).length !== 1 || body.reasoning.effort === undefined) return null
    api.reasoning_effort = body.reasoning.effort as string; delete body.reasoning
  } else if (protocol === 'chat_completions' && body.reasoning_effort !== undefined) { api.reasoning_effort = body.reasoning_effort as string; delete body.reasoning_effort }
  if (body.thinking !== undefined) {
    if (!record(body.thinking) || Object.keys(body.thinking).length !== 1 || body.thinking.type === undefined) return null
    api.thinking = body.thinking.type as StandardTextApiSettings['thinking']; delete body.thinking
  }
  if (Object.keys(body).some(key => !migratableParameters.has(key)) || hasTemplate(body)) return null
  if (Object.keys(body).length) api.request_parameters = body
  const result: Record<string, unknown> = { ...settings, text_api: api }
  for (const key of managedFields) delete result[key]
  return textApiConfigError(result, protocol) ? null : result
}

export function textApiMode(settings: Record<string, unknown>, protocol: TextApiProtocol): 'standard' | 'custom' {
  return migrateStandardTextSettings(settings, protocol) ? 'standard' : 'custom'
}

/** Explicit user action to rebuild a custom contract, retaining model metadata. */
export function applyStandardTextSettings(settings: Record<string, unknown>, protocol: TextApiProtocol): Record<string, unknown> {
  const migrated = migrateStandardTextSettings(settings, protocol)
  if (migrated) return migrated
  const result = { ...settings, ...standardTextSettings(protocol) }
  for (const key of managedFields) delete result[key]
  return result
}
