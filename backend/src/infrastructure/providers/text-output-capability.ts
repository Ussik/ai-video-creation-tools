import { claimModelAttempt } from '../../modules/generation/model-execution.js'
import { createHash } from 'node:crypto'
import type { GenerationModel, GenerationProvider } from './providers.js'
import type { OutputContract } from '../../modules/generation/model-output.js'

type Generate = (model: GenerationModel, provider: GenerationProvider, prompt: string, contract?: OutputContract, signal?: AbortSignal) => Promise<string>
const compatibility = new Map<string, 'json_schema' | 'prompt'>()
function remember(key: string, mode: 'json_schema' | 'prompt') {
  if (compatibility.size >= 30 && !compatibility.has(key)) compatibility.delete(compatibility.keys().next().value!)
  compatibility.set(key, mode)
}

/** Detect support on the first useful read-only request. Never change the
 * user's model configuration or retry network/auth/invalid-schema failures. */
export async function generateCompatibleStructuredText(model: GenerationModel, provider: GenerationProvider, prompt: string, contract: OutputContract,
  signal: AbortSignal | undefined, generate: Generate) {
  const settings = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
  if (settings.structured_output_mode || !['responses', 'chat_completions'].includes(model.protocol || '')) return generate(model, provider, prompt, contract, signal)
  const key = createHash('sha256').update(JSON.stringify([model.id, model.remote_id, model.protocol, model.settings, provider.base_url, provider.key_ciphertext])).digest('hex')
  const mode = compatibility.get(key) || 'json_schema'
  const configured = { ...model, settings: JSON.stringify({ ...settings, structured_output_mode: mode }) }
  try {
    const result = await generate(configured, provider, prompt, contract, signal)
    remember(key, mode)
    return result
  } catch (issue) {
    signal?.throwIfAborted()
    const message = issue instanceof Error ? issue.message : String(issue)
    const unsupported = !/invalid[_ ]schema|schema[^\n]{0,60}(?:invalid|not[_ ]valid)|无效.*schema/i.test(message) &&
      /(?:返回|HTTP)\s*(?:400|422)\b/i.test(message) && /json_schema|response_format|text[. ]format|structured.output/i.test(message) &&
      /not.support|unsupported|unrecognized|unknown.parameter|not.allowed|不支持|无法识别/i.test(message)
    if (mode !== 'json_schema' || !unsupported) throw issue
    remember(key, 'prompt')
    claimModelAttempt()
    return generate({ ...model, settings: JSON.stringify({ ...settings, structured_output_mode: 'prompt' }) }, provider, prompt, contract, signal)
  }
}
