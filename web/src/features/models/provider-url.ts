export function normalizeProviderBaseUrl(value: string): string {
  const trimmed = value.trim()
  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }

  if ((url.protocol === 'http:' || url.protocol === 'https:') &&
    url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) {
    return `${url.origin}/v1`
  }

  return trimmed
}
