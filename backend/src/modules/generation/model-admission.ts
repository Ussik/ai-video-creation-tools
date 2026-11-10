type Waiter = { grant: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort?: () => void }
const lanes = new Map<string, { running: boolean; waiting: Waiter[] }>()

/** Serializes one owned resource. Unrelated resources remain independent;
 * aborting a queued waiter cannot release another task's running slot. */
export async function withModelAdmission<T>(key: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  let lane = lanes.get(key)
  if (!lane) { lane = { running: false, waiting: [] }; lanes.set(key, lane) }
  const owned = lane
  if (owned.running) await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { grant: resolve, reject, signal }
    waiter.abort = () => {
      const index = owned.waiting.indexOf(waiter)
      if (index >= 0) owned.waiting.splice(index, 1)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', waiter.abort, { once: true })
    owned.waiting.push(waiter)
  })
  else owned.running = true
  try { signal?.throwIfAborted(); return await work() }
  finally {
    let next: Waiter | undefined
    while ((next = owned.waiting.shift())) {
      next.signal?.removeEventListener('abort', next.abort!)
      if (next.signal?.aborted) { next.reject(next.signal.reason); continue }
      next.grant(); break
    }
    if (!next) { owned.running = false; if (lanes.get(key) === owned) lanes.delete(key) }
  }
}
