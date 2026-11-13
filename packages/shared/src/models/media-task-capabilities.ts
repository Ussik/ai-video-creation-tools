type Settings = Record<string, unknown>
export type MediaTaskCapabilities = Readonly<{
  asynchronous: boolean
  query_existing: boolean
  download_result: boolean
  local_stop: true
  remote_cancel: false
  terminal_status: boolean
}>
/** Facts come from the selected adapter settings, never model names. Local
 * abort does not imply provider cancellation; no current media adapter declares
 * a remote cancellation endpoint. Speech is a single paid stream, not a task API. */
export function resolveMediaTaskCapabilities(modality: 'image' | 'video' | 'audio', settings: Settings): MediaTaskCapabilities {
  const asynchronous = modality === 'video' || modality === 'image' && settings.async_image === true
  const configured = (key: string) => typeof settings[key] === 'string' && !!String(settings[key]).trim()
  return { asynchronous, query_existing: asynchronous && configured('get_path'),
    download_result: modality === 'video' || modality === 'image' && configured('image_url_path'),
    local_stop: true, remote_cancel: false,
    terminal_status: asynchronous && (configured('status_path') || settings.status_path === undefined) }
}
