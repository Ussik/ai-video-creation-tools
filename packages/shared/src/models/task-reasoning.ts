import { resolveTextCapabilities } from './text-capabilities.js'
import { textApiConfigError, textReasoningLevels, type StandardTextApiSettings } from './text-api-settings.js'

export const taskReasoningChoices = ['inherit', 'auto', 'fixed', ...textReasoningLevels] as const
export type TaskReasoningChoice = typeof taskReasoningChoices[number]
export type TextGenerationOptions = { reasoning?: TaskReasoningChoice }
export type TaskReasoningDecision = { settings: Record<string, unknown>; requested: TaskReasoningChoice; effective: string; source: 'task' | 'model_default' | 'upstream' }

export function taskReasoningOptions(settings: Record<string, unknown>, protocol: string) {
  const api = settings.text_api as StandardTextApiSettings | undefined
  const reasoning = api?.reasoning
  if (api?.mode !== 'standard' || !reasoning?.enabled || textApiConfigError(settings, protocol)) return []
  const compatibility = resolveTextCapabilities(settings).compatibility.reasoning
  const mode = reasoning.mode ?? (protocol === 'anthropic_messages' ? 'adaptive' : 'effort')
  const off = protocol === 'anthropic_messages' || !compatibility?.effort_values || compatibility.effort_values.includes('none')
  if (mode === 'fixed') return [{ value: 'fixed' as const, budget_tokens: reasoning.budget_tokens! }, ...(off ? [{ value: 'off' as const }] : [])]
  return reasoning.levels.filter(mapping => mapping.level !== 'off' || off).map(mapping => ({ value: mapping.level, budget_tokens: undefined }))
}

export function resolveTaskReasoning(settings: Record<string, unknown>, protocol: string, requested?: TaskReasoningChoice): TaskReasoningDecision {
  const api = settings.text_api as StandardTextApiSettings | undefined
  const reasoning = api?.mode === 'standard' ? api.reasoning : undefined
  if (!requested || requested === 'inherit' || requested === 'auto') {
    const effective = reasoning?.enabled
      ? reasoning.mode === 'fixed' && reasoning.default_level !== 'off' ? 'fixed' : reasoning.default_level
      : api?.mode === 'standard' && !reasoning && (api.reasoning_effort || api.thinking) ? 'configured' : 'upstream'
    return { settings, requested: requested ?? 'inherit', effective, source: effective === 'upstream' ? 'upstream' : 'model_default' }
  }
  if (!reasoning || !taskReasoningOptions(settings, protocol).some(option => option.value === requested)) {
    throw Object.assign(new Error('所选模型未声明此推理等级，请重新选择'), { statusCode: 422 })
  }
  return {
    settings: { ...settings, text_api: { ...api, reasoning: { ...reasoning,
      default_level: requested === 'fixed' ? 'medium' : requested,
    } } }, requested, effective: requested, source: 'task',
  }
}
