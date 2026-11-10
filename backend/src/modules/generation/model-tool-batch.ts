/** Only independent read resources before the first write can overlap.
 * A model proposing parallel calls does not authorize parallel writes. */
export async function executeModelToolBatch<T>(calls: readonly T[], options: {
  read: (call: T) => boolean
  resource?: (call: T) => string
  resources?: (call: T) => readonly string[]
  signal?: AbortSignal
  execute: (call: T) => Promise<void>
  defer: (call: T, reason: 'write_barrier' | 'read_failed') => void
  stopped: () => boolean
  /** Ordinary tool validation errors are relayed to the model rather than
   * thrown. They still prevent dispatching dependent reads or any write. */
  readFailed?: () => boolean
}) {
  const firstWrite = calls.findIndex(call => !options.read(call))
  const reads = firstWrite < 0 ? calls : calls.slice(0, firstWrite)
  const resources = (call: T) => options.resources?.(call) ?? [options.resource?.(call) ?? 'shared']
  let pending = [...reads]
  while (pending.length && !options.stopped()) {
    options.signal?.throwIfAborted()
    const keys = new Set<string>(), blocked = new Set<string>(), wave: T[] = [], rest: T[] = []
    for (const call of pending) {
      const scope = resources(call)
      if (wave.length < 3 && !scope.some(key => keys.has(key) || blocked.has(key))) {
        scope.forEach(key => keys.add(key)); wave.push(call)
      } else {
        // A deferred multi-resource read also reserves its order relative to
        // later reads. Otherwise [a], [a,b], [b] could incorrectly reorder b.
        scope.forEach(key => blocked.add(key)); rest.push(call)
      }
    }
    const settled = await Promise.allSettled(wave.map(async call => {
      options.signal?.throwIfAborted()
      if (!options.stopped()) await options.execute(call)
    }))
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    pending = rest
    if (options.readFailed?.()) {
      for (const call of pending) options.defer(call, 'read_failed')
      if (firstWrite >= 0) for (const call of calls.slice(firstWrite)) options.defer(call, 'read_failed')
      return
    }
  }
  if (firstWrite >= 0 && !options.stopped()) {
    options.signal?.throwIfAborted()
    await options.execute(calls[firstWrite]!)
    for (const call of calls.slice(firstWrite + 1)) options.defer(call, 'write_barrier')
  }
}
