export const videoRatios = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
export const videoResolutions = ['480p', '720p', '1080p', '4k']
export const seedance25VideoResolutions = ['480p', '720p', '1080p']

function parameterOptions(standard: string[], configured: unknown): string[] {
  const configuredValues = Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => value.trim()) : []
  const byValue = new Map<string, string>()
  for (const value of configuredValues) if (!byValue.has(value.toLowerCase())) byValue.set(value.toLowerCase(), value)
  const options = standard.map(value => byValue.get(value.toLowerCase()) || value)
  const seen = new Set(options.map(value => value.toLowerCase()))
  for (const value of configuredValues) if (!seen.has(value.toLowerCase())) {
    seen.add(value.toLowerCase())
    options.push(value)
  }
  return options
}

/** Local option lists are editable presets, rather than provider capability metadata. */
export function videoResolutionOptions(settings?: Record<string, unknown>): string[] {
  if (settings?.video_reference_profile === 'seedance_2_5') {
    const configured = parameterOptions([], settings.resolutions)
      .filter(value => seedance25VideoResolutions.includes(value.toLowerCase()))
    return configured.length ? configured : [...seedance25VideoResolutions]
  }
  return parameterOptions(videoResolutions, settings?.resolutions)
}

export function videoRatioOptions(settings?: Record<string, unknown>): string[] {
  if (settings?.video_reference_profile === 'seedance_2_5') {
    const configured = parameterOptions([], settings.ratios).filter(value => videoRatios.includes(value.toLowerCase()))
    return configured.length ? configured : [...videoRatios]
  }
  return parameterOptions(videoRatios, settings?.ratios)
}
