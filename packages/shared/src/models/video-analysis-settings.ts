export type VideoInputFormat = 'chat_video_url' | 'doubao_ark'

function settingsObject(value: unknown): Record<string, unknown> | null {
  try {
    const settings: unknown = typeof value === 'string' ? JSON.parse(value) : value
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings as Record<string, unknown> : null
  } catch { return null }
}

export function videoInputConfigError(value: unknown): string | null {
  const settings = settingsObject(value)
  if (!settings) return '模型配置必须为 JSON 对象'
  if (settings.video_input_format !== undefined && (typeof settings.video_input_format !== 'string' || !['chat_video_url', 'doubao_ark'].includes(settings.video_input_format))) {
    return '视频输入格式必须为 chat_video_url 或 doubao_ark'
  }
  return null
}

/** A model name does not establish provider support for native video input. */
export function supportsDoubaoVideoAnalysis(model: { modality: string; protocol?: string; settings: unknown }): boolean {
  const settings = settingsObject(model.settings)
  return !!settings && model.modality === 'text' && settings.supports_video === true && settings.video_input_format === 'doubao_ark'
    && (model.protocol === 'chat_completions' || model.protocol === 'responses')
}
