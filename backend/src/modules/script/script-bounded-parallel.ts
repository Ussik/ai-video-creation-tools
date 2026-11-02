/** Runs independent work with a fixed concurrency ceiling and returns results in
 * input order. Once any item fails or the signal aborts, no further item is
 * started; items already running finish so their validated results can be
 * checkpointed. Undispatched items report a rejection and are simply redone on
 * resume, which keeps total dispatch bounded. */
export async function settleBounded<T, R>(items: readonly T[], limit: number, signal: AbortSignal | undefined,
  work: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  const skipped = new Error('前序检查未完成，本组尚未开始；恢复时只会重做未完成的组。')
  let next = 0, stopped = false
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      if (stopped || signal?.aborted) { results[index] = { status: 'rejected', reason: signal?.aborted ? signal.reason : skipped }; continue }
      try { results[index] = { status: 'fulfilled', value: await work(items[index]!, index) } }
      catch (reason) { stopped = true; results[index] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

export function reviewConcurrency(): number {
  const requested = Number(process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY || 3)
  return Number.isFinite(requested) ? Math.max(1, Math.min(4, Math.trunc(requested))) : 3
}
