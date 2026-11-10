/** K and M use decimal token counts, matching model-provider capacity labels. */
export function parseTokenQuantity(value: string): number | null {
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?\s*([km])?$/i.exec(value.trim())
  if (!match) return null
  const places = match[3]?.toUpperCase() === 'M' ? 6 : match[3] ? 3 : 0
  if (match[2] !== undefined && !match[3]) return null
  const whole = match[1].replaceAll(',', '').replace(/^0+/, '') || '0'
  const fraction = (match[2] || '').replace(/0+$/, '')
  if (whole.length > 16 || fraction.length > places) return null
  // Decimal string arithmetic avoids rounding fractional or oversized inputs
  // into a different (but apparently valid) integer token count.
  const tokens = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0') || '0')
  if (tokens <= 0n || tokens > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(tokens)
}

export function formatTokenQuantity(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return ''
  const tokens = BigInt(value)
  const unit = value >= 1_000_000 ? { divisor: 1_000_000n, suffix: 'M', places: 6 }
    : value >= 1_000 ? { divisor: 1_000n, suffix: 'K', places: 3 } : null
  if (unit) {
    const fraction = (tokens % unit.divisor).toString().padStart(unit.places, '0').replace(/0+$/, '')
    if (fraction.length <= 3) return `${tokens / unit.divisor}${fraction ? `.${fraction}` : ''}${unit.suffix}`
  }
  return value.toLocaleString('en-US')
}
