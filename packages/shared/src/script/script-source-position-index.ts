/** Deterministic UTF-16 positions, independent of semantic model chapters.
 * An explicit heading locates material; it does not certify plot or identity. */
export type SourcePosition = { id: string; kind: 'section' | 'episode'; heading: string; offset: number; length: number;
  parent_id: string | null; episode_number: number | null; ambiguous: boolean }
export type SourcePositionIndex = { version: 1; status: 'explicit' | 'ambiguous' | 'unmarked'; entries: SourcePosition[];
  episodes: SourcePosition[]; duplicate_episode_numbers: number[]; prefix: { offset: 0; length: number } }
function numberValue(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let sum = 0, digit = 0
  for (const char of value) {
    if (char === '百' || char === '十' || char === '千') { sum += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]!); digit = 0 }
    else if (digits[char] !== undefined) digit = digits[char]!
    else return 0
  }
  return sum + digit
}
export function sourcePositionIndex(content: string): SourcePositionIndex {
  const entries: SourcePosition[] = [], levels: number[] = []
  for (const match of content.matchAll(/[^\n]+(?:\n|$)|\n/g)) {
    const raw = match[0].trim(), markdown = /^(#{1,6})\s+/.exec(raw)
    const heading = raw.replace(/^#{1,6}\s+/, '').replace(/^(?:[-+*]|\d+[.)、])\s+/, '').replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/, '$1').trim()
    const episode = /^第\s*([零〇一二两三四五六七八九十百千\d]+)\s*[集话](?=$|[\s:：、.．｜|—-])/u.exec(heading)
    const number = episode ? numberValue(episode[1]!) : null
    const validEpisode = number !== null && number >= 1 && number <= 10000
    if (!validEpisode && !markdown) continue
    // Range headings such as 第1–15集 are parents, never episodes.
    const level = validEpisode ? 7 : markdown![1]!.length
    let parent: SourcePosition | undefined
    for (let i = entries.length - 1; i >= 0; i--) if (levels[i]! < level) { parent = entries[i]; break }
    entries.push({ id: `position:${match.index}`, kind: validEpisode ? 'episode' : 'section', heading,
      offset: match.index, length: content.length - match.index, parent_id: parent?.id || null,
      episode_number: validEpisode ? number : null, ambiguous: false })
    levels.push(level)
  }
  for (const [i, entry] of entries.entries()) {
    const next = entries.find((_, n) => n > i && levels[n]! <= levels[i]!)
    entry.length = (next?.offset ?? content.length) - entry.offset
  }
  const episodes = entries.filter(entry => entry.kind === 'episode')
  const counts = new Map<number, number>()
  for (const entry of episodes) counts.set(entry.episode_number!, (counts.get(entry.episode_number!) || 0) + 1)
  const duplicate = [...counts].filter(([, count]) => count > 1).map(([number]) => number)
  for (const entry of episodes) entry.ambiguous = duplicate.includes(entry.episode_number!)
  return { version: 1, status: duplicate.length ? 'ambiguous' : episodes.length ? 'explicit' : 'unmarked', entries, episodes,
    duplicate_episode_numbers: duplicate, prefix: { offset: 0, length: episodes[0]?.offset ?? content.length } }
}
