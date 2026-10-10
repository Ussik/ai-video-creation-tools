type Edit = { start: number; end: number; lines: string[]; user: boolean }

function changes(base: string[], next: string[], user: boolean): Edit[] {
  // Bound the line diff for very large pasted prompts.
  if (base.length * next.length > 2_000_000) return [{ start: 0, end: base.length, lines: next, user }]
  const width = next.length + 1
  const lcs = new Uint32Array((base.length + 1) * width)
  for (let i = base.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
    lcs[i * width + j] = base[i] === next[j] ? 1 + lcs[(i + 1) * width + j + 1]
      : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
  }
  const edits: Edit[] = []
  let i = 0, j = 0, pending: Edit | undefined
  const commit = () => { if (pending) edits.push(pending); pending = undefined }
  while (i < base.length || j < next.length) {
    if (i < base.length && j < next.length && base[i] === next[j]) { commit(); i++; j++; continue }
    pending ||= { start: i, end: i, lines: [], user }
    if (j < next.length && (i === base.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) pending.lines.push(next[j++])
    else pending.end = ++i
  }
  commit()
  return edits
}

/** Carry manual edits forward while regenerating independent parameter/reference text. */
export function rebasePromptDraft(previous: string, draft: string, next: string): string {
  if (!previous || previous === next) return draft
  if (draft === previous) return next
  const base = previous.split('\n')
  const edits = [...changes(base, draft.split('\n'), true), ...changes(base, next.split('\n'), false)]
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const result: string[] = []
  let position = 0
  for (let index = 0; index < edits.length;) {
    const group = [edits[index++]]
    let end = group[0].end
    while (index < edits.length && (edits[index].start < end || edits[index].start === group[0].start)) {
      end = Math.max(end, edits[index].end); group.push(edits[index++])
    }
    result.push(...base.slice(position, group[0].start))
    const automatic = group.filter(edit => !edit.user)
    const user = group.filter(edit => edit.user)
    // Two independent additions at the same boundary must both survive (for
    // example a manual instruction and a newly bound visual profile).
    const insertions = group.every(edit => edit.start === edit.end)
    const chosen = insertions && user.length && automatic.length
      ? [...user, ...automatic.filter(edit => !user.some(item => item.lines.join('\n') === edit.lines.join('\n')))]
      : user.length ? user : automatic
    let cursor = group[0].start
    for (const edit of chosen) { result.push(...base.slice(cursor, edit.start), ...edit.lines); cursor = edit.end }
    result.push(...base.slice(cursor, end))
    position = end
  }
  const merged = [...result, ...base.slice(position)]
  // A broad manual rewrite can overlap a parameter edit. Preserve its prose
  // and update only the parameter whose control actually changed.
  const parameterKey = (line: string) => /^(画面比例|清晰度要求|画质要求|背景要求|视频时长|首帧要求)：/.exec(line)?.[1]
  const oldParameters = new Map(base.flatMap(line => { const key = parameterKey(line); return key ? [[key, line] as const] : [] }))
  const nextParameters = new Map(next.split('\n').flatMap(line => { const key = parameterKey(line); return key ? [[key, line] as const] : [] }))
  for (const key of new Set([...oldParameters.keys(), ...nextParameters.keys()])) {
    const value = nextParameters.get(key)
    if (oldParameters.get(key) === value) continue
    const indices = merged.flatMap((line, index) => parameterKey(line) === key ? [index] : [])
    if (indices.length) {
      for (const index of indices.reverse()) merged.splice(index, 1, ...(value ? [value] : []))
    } else if (value) merged.push(value)
  }
  return merged.join('\n')
}

export function videoPreferencePrompt(prompt: string, mode: string, duration: number, selection: { ratio?: string; resolution?: string } = {}): string {
  const fixedRatio = selection.ratio && selection.ratio !== 'adaptive'
  const frame = ['first_frame', 'first_last_frame'].includes(mode)
    ? `\n首帧要求：以提交的第一张参考图作为开镜画面，保持人物、服装、场景${fixedRatio ? '与动作起始状态，在所选画幅下安排构图' : '、构图与动作起始状态'}，再连续展开动作。` : ''
  const ratio = selection.ratio ? `\n画面比例：${fixedRatio ? `${selection.ratio}（宽:高），整段视频保持此画幅。` : '自适应，依据输入素材与内容确定画幅。'}` : ''
  const resolution = selection.resolution ? `\n清晰度要求：${/^4k$/i.test(selection.resolution) ? '4K' : selection.resolution}。` : ''
  return `${prompt}\n\n【视频生成要求】\n视频时长：${duration} 秒。动作与运镜安排在此时长内，保持镜头连续。${ratio}${resolution}${frame}`
}
