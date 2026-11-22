import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { scopeTextCapabilities } from '@video-studio/shared/models/text-capabilities'
import { resolveTaskReasoning, taskReasoningChoices, taskReasoningOptions, type TextGenerationOptions } from '@video-studio/shared/models/task-reasoning'
import type { GenerationModel, GenerationProvider } from './providers.js'
import { required, type Model, type Provider } from '../database/db.js'

export const textGenerationOptionsInput = z.object({ reasoning: z.enum(taskReasoningChoices).optional() }).strict().optional()

type Decision = ReturnType<typeof resolveTaskReasoning>
const task = new AsyncLocalStorage<{ modelId: string; decision: Decision; raw: string; endpoint: string }>()

function scopedSettings(model: Pick<GenerationModel, 'settings' | 'protocol' | 'remote_id'>, provider: Pick<GenerationProvider, 'base_url'>) {
  const settings = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
  return scopeTextCapabilities(settings, {
    base_url: typeof settings.api_base_url === 'string' ? settings.api_base_url : provider.base_url,
    protocol: model.protocol ?? '', remote_id: model.remote_id,
  })
}

export function availableTaskReasoning(model: Pick<GenerationModel, 'settings' | 'protocol' | 'remote_id'>, provider: Pick<GenerationProvider, 'base_url'>) {
  return taskReasoningOptions(scopedSettings(model, provider), model.protocol ?? '')
}

function modelSettingsKey(model: GenerationModel) {
  const settings = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
  const { structured_output_mode, _structured_strategy_source, ...rest } = settings
  return JSON.stringify([model.protocol, model.remote_id, rest])
}

export function bindTaskReasoning(model: GenerationModel, provider: GenerationProvider, options?: TextGenerationOptions) {
  const decision = resolveTaskReasoning(scopedSettings(model, provider), model.protocol ?? '', options?.reasoning)
  const context = { modelId: model.id, decision, raw: modelSettingsKey(model), endpoint: provider.base_url }
  return <Result>(execute: () => Result): Result => task.run(context, execute)
}

export function bindTaskReasoningById(modelId: string, options?: TextGenerationOptions) {
  if (!options?.reasoning) return <Result>(execute: () => Result): Result => execute()
  const model = required<Model>('models', modelId)
  if (model.modality !== 'text') throw Object.assign(new Error('推理等级仅适用于文本模型'), { statusCode: 422 })
  return bindTaskReasoning(model, required<Provider>('providers', model.provider_id), options)
}

export function currentTaskReasoning(model: GenerationModel, provider: GenerationProvider): Decision {
  const current = task.getStore()
  if (current?.modelId === model.id) {
    if (current.raw !== modelSettingsKey(model) || current.endpoint !== provider.base_url) {
      throw Object.assign(new Error('任务运行期间文本模型配置已变化，请重新发起任务'), { statusCode: 409 })
    }
    const settings = scopedSettings(model, provider)
    return { ...current.decision, settings: { ...settings, ...(current.decision.source === 'task' ? { text_api: current.decision.settings.text_api } : {}) } }
  }
  return resolveTaskReasoning(scopedSettings(model, provider), model.protocol ?? '')
}

export function reasoningMetrics(decision: Decision, policyOverride = false) {
  return { reasoning_requested: decision.requested, reasoning_effective: policyOverride ? 'off' : decision.effective,
    reasoning_source: policyOverride ? 'policy' : decision.source }
}
