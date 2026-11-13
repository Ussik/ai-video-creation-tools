import { resolveTextCapabilities, textCapabilitiesConfigError } from './text-capabilities.js'

/** Explicit provider/model limits only. Model names and remote IDs are not
 * evidence of capacity; leaving these unset preserves an unknown capacity. */
export type TextContextSettings = { context_window_tokens?: number; output_reserve_tokens?: number }
type ContextValidationOptions = { outputLimitKnown?: boolean }
function hasConfiguredOutput(settings: Record<string, unknown>): boolean {
  const api = settings.text_api
  if (api && typeof api === 'object' && !Array.isArray(api) && (api as Record<string, unknown>).mode === 'standard') {
    const selected = api as Record<string, unknown>
    if (selected.output_mode === 'auto') return true
    return selected.output_mode !== 'upstream' && typeof selected.max_output_tokens === 'number' && Number.isSafeInteger(selected.max_output_tokens) && selected.max_output_tokens > 0
  }
  return [settings.request_template, settings.stream_request_template].some(template => template && typeof template === 'object' && !Array.isArray(template)
    && ['max_output_tokens', 'max_completion_tokens', 'max_tokens'].some(key => {
      const value = (template as Record<string, unknown>)[key]
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    }))
}

export function textContextConfigError(settings: Record<string, unknown>, options: ContextValidationOptions = {}): string | null {
  const capabilityIssue = textCapabilitiesConfigError(settings)
  if (capabilityIssue) return capabilityIssue
  for (const [key, label] of [['context_window_tokens', '上下文容量'], ['output_reserve_tokens', '输出预留']] as const) {
    const value = settings[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) return `${label}必须为正整数 token 数；未知时请留空`
  }
  const { limits } = resolveTextCapabilities(settings)
  if (!options.outputLimitKnown && !hasConfiguredOutput(settings) && limits.budget_mode === 'shared' && limits.context_tokens !== undefined && typeof settings.output_reserve_tokens === 'number'
    && settings.output_reserve_tokens >= limits.context_tokens) return '输出预留必须小于上下文容量，才能容纳输入'
  return null
}

export function textContextSettings(settings: Record<string, unknown>, options: ContextValidationOptions = {}): TextContextSettings {
  const issue = textContextConfigError(settings, options)
  if (issue) throw new Error(issue)
  return { ...(settings.context_window_tokens === undefined ? {} : { context_window_tokens: settings.context_window_tokens as number }),
    ...(settings.output_reserve_tokens === undefined ? {} : { output_reserve_tokens: settings.output_reserve_tokens as number }) }
}
