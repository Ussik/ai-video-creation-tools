/** Read receipts contain locations and versions only, never manuscript text.
 * They survive a tool-session restart without granting a review or save. */
export type RevisionRead = { version: string; ranges: Array<[number, number]> }
export type RevisionReads = {
  saved: Record<string, RevisionRead>
  draft: Record<string, RevisionRead>
  scenes: Record<string, string>
  draft_scenes: Record<string, string>
  scene_fragments: Record<string, RevisionRead>
  draft_scene_fragments: Record<string, RevisionRead>
  references: Record<string, string>
}

export function mergeReadRanges(ranges: Array<[number, number]>, length = Number.MAX_SAFE_INTEGER): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const [start, end] of ranges.filter(([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start <= length)
    .map(([start, end]) => [start, Math.min(end, length)] as [number, number]).sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else merged.push([start, end])
  }
  return merged
}

export function mergeRevisionRead(previous: RevisionRead | undefined, version: string, ranges: Array<[number, number]>, length?: number): RevisionRead {
  return { version, ranges: mergeReadRanges([...(previous?.version === version ? previous.ranges : []), ...ranges], length) }
}

export function emptyRevisionReads(): RevisionReads {
  return { saved: {}, draft: {}, scenes: {}, draft_scenes: {}, scene_fragments: {}, draft_scene_fragments: {}, references: {} }
}

export function nextUnreadOffset(read: RevisionRead | undefined, version: string, length: number) {
  if (read?.version !== version) return 0
  return Math.min(read.ranges.find(([start]) => start === 0)?.[1] ?? 0, length)
}
