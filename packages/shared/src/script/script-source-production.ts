/** Offsets are UTF-16 positions in the unchanged, stored source. No semantic
 * judgement is made here: unknown endings and unresolved plots are valid. */
export type SourceProductionScene = { offset: number; length: number; heading: string; text: string; action: string; dialogue: string; characters: string }
export type SourceProductionEpisode = { episode_number: number; title: string; offset: number; length: number; scenes: SourceProductionScene[]; ambiguous: boolean }
export type SourceProductionState = {
  source_version: string; filename: string;
  episodes: Array<SourceProductionEpisode & { status: 'ready' | 'available' | 'needs_adaptation' | 'needs_selection'; saved_scene_ids: string[]; imported_offsets: number[]; changed_scene_ids: string[]; blocked_scene_offsets?: number[] }>
}
const numberValue = (value: string): number => {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let total = 0, digit = 0
  for (const char of value) {
    if (char === '百' || char === '十') { total += (digit || 1) * (char === '百' ? 100 : 10); digit = 0 }
    else if (digits[char] !== undefined) digit = digits[char]
    else return 0
  }
  return total + digit
}
const cleanHeading = (text: string) => text.trim().replace(/^#{1,6}\s*/, '').replace(/^(?:[-+*]|\d+[.)])\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1')
const episodePattern = /^第\s*([零〇一二两三四五六七八九十百\d]+)\s*[集话章]/u
const scenePattern = /^(?:第[零〇一二两三四五六七八九十百\d]+[场幕]|场[景次]?\s*[零〇一二两三四五六七八九十百\d]+|\d{1,3}[-－—]\d{1,3}(?:[\s、.：:｜|]|$)|(?:INT|EXT|INT\/EXT)\s*[.．\s])/i
const metadataSpeaker = /^(?:人物|角色|地点|场景|时间|对白|动作|旁白|画外音|梗概|内容|说明|注|时长|集数)$/
function scene(content: string, offset: number, end: number, heading: string): SourceProductionScene {
  const text = content.slice(offset, end)
  const dialogue: string[] = [], action: string[] = [], characters = new Set<string>()
  for (const line of text.split('\n').slice(1)) {
    const speech = /^\s*([^：:\n]{1,24})[：:]\s*\S/.exec(line)
    if (speech && !metadataSpeaker.test(speech[1].trim())) { dialogue.push(line); characters.add(speech[1].trim()) }
    else action.push(line)
  }
  return { offset, length: end - offset, heading: heading.slice(0, 120), text, action: action.join('\n'), dialogue: dialogue.join('\n'), characters: [...characters].join('、') }
}
export function sourceProductionDirectory(content: string): SourceProductionEpisode[] {
  const lines = [...content.matchAll(/[^\n]+(?:\n|$)|\n/g)].map(match => ({ offset: match.index, text: cleanHeading(match[0]) }))
  const headings = lines.flatMap(line => {
    const match = episodePattern.exec(line.text), number = match ? numberValue(match[1]) : 0
    return number >= 1 && number <= 200 ? [{ ...line, number }] : []
  })
  const ranges = headings.length ? headings : [{ offset: 0, text: '第 1 集（未标注集数）', number: 1 }]
  const episodes = ranges.map((entry, i) => {
    const end = ranges[i + 1]?.offset ?? content.length
    const starts = lines.filter(line => line.offset >= entry.offset && line.offset < end && scenePattern.test(line.text))
    const scenes = starts.map((line, n) => scene(content, line.offset, starts[n + 1]?.offset ?? end, line.text))
      .filter(item => item.text.slice(item.text.indexOf('\n') + 1).trim() && item.text.includes('\n'))
    // A prologue between episode and first scene is material too. Never drop
    // it silently: retain the precise text with the first scene's action.
    if (scenes.length) {
      const bodyStart = headings.length ? content.indexOf('\n', entry.offset) + 1 : entry.offset
      if (bodyStart >= entry.offset && bodyStart < scenes[0].offset && content.slice(bodyStart, scenes[0].offset).trim()) {
        const first = scenes[0], prefix = content.slice(bodyStart, first.offset)
        scenes[0] = { ...first, offset: bodyStart, length: first.offset + first.length - bodyStart,
          text: content.slice(bodyStart, first.offset + first.length), action: prefix + first.action }
      }
    }
    return { episode_number: entry.number, title: entry.text, offset: entry.offset, length: end - entry.offset, scenes,
      ambiguous: ranges.filter(other => other.number === entry.number).length > 1 }
  })
  return episodes
}
