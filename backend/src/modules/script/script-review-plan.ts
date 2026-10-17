export type ReviewFact = { source_key: string; quote: string; meaning: string }

/** Compatibility for older callers: all original passages and every distinct
 * candidate claim belong to a single whole-work review, never a Cartesian plan. */
export function planSourceReviews(facts: ReviewFact[], batches: unknown[][]) {
  if (!facts.length || !batches.length) return []
  const unique = new Map<string, { fact: ReviewFact; meanings: Set<string> }>()
  for (const fact of facts) {
    const key = JSON.stringify([fact.source_key, fact.quote]), existing = unique.get(key)
    if (existing) existing.meanings.add(fact.meaning)
    else unique.set(key, { fact, meanings: new Set([fact.meaning]) })
  }
  const group = [...unique.values()].map(({ fact, meanings }) => ({ ...fact, meaning: [...meanings].join('；') }))
  return [{ original: batches.flat(), group, sourceIndex: 0, factIndex: 0 }]
}
