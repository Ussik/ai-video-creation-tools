type Settings = Record<string, unknown>

function isRecord(value: unknown): value is Settings {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export const defaultImageRequestTimeoutSeconds = 600

/** Standard Images transport, independent of model name and provider URL. */
export function imagesApiSettings(existing: Settings = {}): Settings {
  const json = imagesReferenceSettings(existing)
  function request(previous: unknown): Settings {
    const { image: _image, size: _size, ...fields } = isRecord(previous) ? previous : {}
    return { ...fields, size: '{{size}}', 'image[]': '{{images}}' }
  }
  const overrides = isRecord(json.request_templates) ? json.request_templates : {}
  return { ...json, image_api_profile: 'images_api', image_reference_transport: 'multipart',
    image_reference_path: existing.image_reference_path || 'images/edits',
    image_size_mode: 'auto', default_resolution: 'auto',
    request_template: request(json.request_template), request_templates: Object.fromEntries(Object.entries(overrides).map(([mode, template]) => [mode, request(template)])),
    request_timeout_seconds: existing.request_timeout_seconds ?? defaultImageRequestTimeoutSeconds }
}

/** User-selected JSON Images profile. Endpoint and credentials remain provider configuration. */
export function imagesReferenceSettings(existing: Settings = {}): Settings {
  const obsolete = new Set(['mode_variables', 'content_template', 'image_reference_template', 'reference_roles'])
  const retained = Object.fromEntries(Object.entries(existing).filter(([key]) => !obsolete.has(key)))
  function request(previous: unknown): Settings {
    const fields = isRecord(previous) ? Object.fromEntries(Object.entries(previous).filter(([key, value]) =>
      !['image', 'image[]', 'images', 'content', 'size', 'ratio', 'aspectRatio', 'async'].includes(key)
      && !/\{\{(?:image|images|image_references|content|ratio)\}\}/.test(JSON.stringify(value) || ''))) : {}
    return { ...fields, model: '{{model}}', prompt: '{{prompt}}', n: fields.n ?? 1,
      size: '{{ratio}}', image: '{{images}}', ...(existing.async_image === true ? { async: true } : {}) }
  }
  const overrides = isRecord(existing.request_templates) ? existing.request_templates : {}
  const base = request(existing.request_template)
  return { ...retained, image_api_profile: 'images_reference', image_reference_transport: 'json', image_size_mode: 'ratio',
    request_timeout_seconds: existing.request_timeout_seconds ?? defaultImageRequestTimeoutSeconds,
    request_path: existing.request_path || 'images/generations',
    request_template: base,
    request_templates: { ...Object.fromEntries(Object.entries(overrides).map(([mode, template]) => [mode, request(template)])),
      text: request(overrides.text ?? existing.request_template), reference: request(overrides.reference ?? existing.request_template) },
    image_base64_path: existing.image_base64_path ?? 'data.0.b64_json',
    image_url_path: existing.image_url_path ?? 'data.0.url' }
}
