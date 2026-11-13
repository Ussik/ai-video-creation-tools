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
  const nativeStoryboard = model.protocol === 'anthropic_messages' &&
    ['controlled_storyboard', 'clip_storyboard', 'storyboard_scene_plan', 'storyboard_shot_batch', 'storyboard_directing_review'].includes(contract.name)
  if (settings.structured_output_mode || !nativeStoryboard && !['responses', 'chat_completions'].includes(model.protocol || '')) return generate(model, provider, prompt, contract, signal)
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
    const schemaProblem = /invalid[_ ]schema|schema[^\n]{0,80}(?:invalid|not[_ ]valid|too[_ ]large|too[_ ]long|size|complex|limit|keyword|propert|constraint)|(?:too[_ ]large|too[_ ]long|complex|keyword|constraint)[^\n]{0,80}schema|unsupported[_ ]keyword|无效.*schema/i.test(message)
    const unsupported = !schemaProblem &&
      /(?:返回|HTTP)\s*(?:400|422)\b/i.test(message) && /json_schema|response_format|text[. ]format|output_config(?:[. ]format)?|structured.output/i.test(message) &&
      /not.support|unsupported|unrecognized|unknown.parameter|not.allowed|不支持|无法识别/i.test(message)
    if (mode !== 'json_schema' || !unsupported) throw issue
    remember(key, 'prompt')
    claimModelAttempt()
    return generate({ ...model, settings: JSON.stringify({ ...settings, structured_output_mode: 'prompt' }) }, provider, prompt, contract, signal)
  }
}
