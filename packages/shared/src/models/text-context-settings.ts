/** Explicit provider/model limits only. Model names and remote IDs are not
 * evidence of capacity; leaving these unset preserves an unknown capacity. */
export type TextContextSettings = { context_window_tokens?: number; output_reserve_tokens?: number }

export function textContextConfigError(settings: Record<string, unknown>): string | null {
  for (const [key, label] of [['context_window_tokens', '上下文容量'], ['output_reserve_tokens', '输出预留']] as const) {
    const value = settings[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) return `${label}必须为正整数 token 数；未知时请留空`
  }
  if (typeof settings.context_window_tokens === 'number' && typeof settings.output_reserve_tokens === 'number'
    && settings.output_reserve_tokens >= settings.context_window_tokens) return '输出预留必须小于上下文容量，才能容纳输入'
  return null
}

export function textContextSettings(settings: Record<string, unknown>): TextContextSettings {
  const issue = textContextConfigError(settings)
  if (issue) throw new Error(issue)
  return { ...(settings.context_window_tokens === undefined ? {} : { context_window_tokens: settings.context_window_tokens as number }),
    ...(settings.output_reserve_tokens === undefined ? {} : { output_reserve_tokens: settings.output_reserve_tokens as number }) }
}
