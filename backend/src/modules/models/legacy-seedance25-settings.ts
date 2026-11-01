import { isDeepStrictEqual } from 'node:util'
import { applySeedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'

const legacyStarterSettings: Record<string, unknown> = {
  create_path: 'contents/generations/tasks',
  get_path: 'contents/generations/tasks/{id}',
  request_template: { model: '{{model}}', content: '{{content}}', duration: '{{duration}}', ratio: '{{ratio}}', resolution: '{{resolution}}' },
  content_template: [{ type: 'text', text: '{{prompt}}' }],
  id_path: 'id', status_path: 'status', result_path: 'content.video_url',
  ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
  resolutions: ['480p', '720p', '1080p', '4k'], default_resolution: '480p',
}

const preservedMetadata = new Set(['pricing', 'api_base_url'])

/** Only repair the known untouched generic starter, never infer a custom model's capabilities. */
export function upgradeLegacySeedance25Settings(model: {
  remote_id: string; modality: string; protocol: string; settings: string
}): string | null {
  if (model.remote_id !== 'doubao-seedance-2-5-260628' || model.modality !== 'video' || model.protocol !== 'async_video') return null
  let parsed: unknown
  try { parsed = JSON.parse(model.settings) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const settings = parsed as Record<string, unknown>
  if (Object.keys(settings).some(key => !Object.hasOwn(legacyStarterSettings, key) && !preservedMetadata.has(key))) return null
  for (const [key, value] of Object.entries(legacyStarterSettings)) {
    if (!isDeepStrictEqual(settings[key], value)) return null
  }
  return JSON.stringify(applySeedance25VideoSettings(settings))
}
