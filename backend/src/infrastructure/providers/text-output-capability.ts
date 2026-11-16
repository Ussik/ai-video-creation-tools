import { resolveTextCapabilities, scopeTextCapabilities } from '@video-studio/shared/models/text-capabilities'
import type { GenerationModel, GenerationProvider } from './providers.js'
import type { OutputContract } from '../../modules/generation/model-output.js'

type Generate = (model: GenerationModel, provider: GenerationProvider, prompt: string, contract?: OutputContract, signal?: AbortSignal) => Promise<string>
/** Selection is configuration, never proof of provider enforcement. Local
 * validation remains mandatory even after an HTTP 200 with native Schema. */
export function structuredOutputStrategy(model: GenerationModel, provider: GenerationProvider) {
  const settings = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
  const declared = resolveTextCapabilities(scopeTextCapabilities(settings, { base_url: typeof settings.api_base_url === 'string' ? settings.api_base_url : provider.base_url,
    protocol: model.protocol ?? '', remote_id: model.remote_id })).compatibility.structured_output
  const mode = settings.structured_output_mode || (declared ? declared.includes('json_schema') ? 'json_schema'
    : model.protocol !== 'anthropic_messages' && declared.includes('json_object') ? 'json_object' : declared.includes('tool_call') ? 'tool_call' : 'prompt' : 'json_schema')
  if (!['json_schema', 'json_object', 'prompt', 'tool_call'].includes(String(mode)) || model.protocol === 'anthropic_messages' && mode === 'json_object')
    throw new Error('当前协议不支持所配置的结构化输出策略；请明确选择 json_schema 或文本兼容策略')
  return { mode: mode as 'json_schema' | 'json_object' | 'prompt' | 'tool_call', source: settings.structured_output_mode ? 'configured' : declared ? 'declared' : 'default',
    enforcement: 'unverified' as const, settings }
}
export async function generateCompatibleStructuredText(model: GenerationModel, provider: GenerationProvider, prompt: string, contract: OutputContract,
  signal: AbortSignal | undefined, generate: Generate) {
  return withCompatibleStructuredSettings(model, provider, contract, signal, configured => generate(configured, provider, prompt, contract, signal))
}
/** One useful request, one fixed strategy. A rejection never authorizes a
 * probe, hidden downgrade, configuration mutation or another model. */
export async function withCompatibleStructuredSettings<T>(model: GenerationModel, provider: GenerationProvider, contract: OutputContract | undefined,
  signal: AbortSignal | undefined, generate: (configured: GenerationModel) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  if (!contract || !['responses', 'chat_completions', 'anthropic_messages'].includes(model.protocol || '')) return generate(model)
  const { mode, settings } = structuredOutputStrategy(model, provider)
  return generate({ ...model, settings: JSON.stringify({ ...settings, structured_output_mode: mode, _structured_strategy_source: structuredOutputStrategy(model, provider).source }) })
}
