import { isVideoAudioPlan, renderVideoAudioPlan } from '../media/video-prompt-audio.js'

type ShotPromptSource = { prompt: string; image_prompt?: string; video_prompt?: string; start_state?: string; end_state?: string; cut_note?: string; audio_plan?: unknown }
const continuousShotInstruction = '生成当前分镜的一个连续视频镜头。描述动作先后、表情变化、镜头运动与节奏，保持人物、服装、道具、场景和光线连续；不要拼接无关镜头。'
const videoFrameInstruction = '仅在首帧或首尾帧生成模式下，从指定首帧的构图、人物位置、姿态和物体状态开始延续动作；多图参考的开场状态按正文设计。不添加画面文字、字幕或水印。'

/** Only complete blocks owned by this compiler may be replaced. An incomplete
 * marker, including one before another complete block, remains author prose. */
function withoutManagedBlock(value: string, heading: string): string {
  const start = `【${heading}】\n`, end = `\n【${heading}结束】`, parts: string[] = []
  let cursor = 0
  while (cursor < value.length) {
    const begin = value.indexOf(start, cursor)
    if (begin < 0) { parts.push(value.slice(cursor)); break }
    const finish = value.indexOf(end, begin + start.length)
    const nested = value.indexOf(start, begin + start.length)
    if (nested >= 0 && (finish < 0 || nested < finish)) {
      parts.push(value.slice(cursor, nested)); cursor = nested; continue
    }
    if (finish < 0) { parts.push(value.slice(cursor)); break }
    parts.push(value.slice(cursor, begin)); cursor = finish + end.length
  }
  return parts.join('').trim()
}

export function shotImagePrompt(shot: ShotPromptSource): string {
  if (shot.image_prompt?.trim()) return shot.image_prompt.trim()
  return [
    '生成当前镜头的单幅首帧画面。固定一个瞬间，明确主体、场景、景别、构图、光线与材质；动作过程只用于理解情境，不表现多个时间点或分格。',
    shot.prompt.trim(), shot.start_state?.trim() && `首帧状态：${shot.start_state.trim()}`,
    '对白与旁白仅作为情绪背景，不绘制文字、字幕、水印或设定板。',
  ].filter(Boolean).join('\n\n')
}

export function shotVideoPrompt(shot: ShotPromptSource): string {
  return compileShotVideoPrompt(shot, true)
}

function compileShotVideoPrompt(shot: ShotPromptSource, includeAudio: boolean): string {
  // An authored motion prompt and the saved shot boundaries are independent
  // inputs. Replacing the managed block keeps repeated imports idempotent and
  // lets a changed end state replace its old value instead of contradicting it.
  const authored = withoutManagedBlock(withoutManagedBlock(shot.video_prompt || '', '镜头起止与接镜约束'), '镜头声音执行约束')
  const body = authored || [
    continuousShotInstruction, shot.prompt.trim(), videoFrameInstruction,
  ].filter(Boolean).join('\n\n')
  const boundaries = [shot.start_state?.trim() && `开镜状态：${shot.start_state.trim()}`,
    shot.end_state?.trim() && `收镜状态：${shot.end_state.trim()}`,
    shot.cut_note?.trim() && `接镜要求：${shot.cut_note.trim()}`,
  ].filter(Boolean)
  const boundaryBlock = boundaries.length && `【镜头起止与接镜约束】\n以下为当前已保存的镜头边界；正文中旧状态与此冲突时以本区块为准。\n${boundaries.join('\n')}\n切镜换角度或景别属于剪辑，不把下一镜机位误写成本镜摄影机必须完成的移动。\n【镜头起止与接镜约束结束】`
  const audioBlock = includeAudio && isVideoAudioPlan(shot.audio_plan)
    && `【镜头声音执行约束】\n${renderVideoAudioPlan(shot.audio_plan)}\n【镜头声音执行约束结束】`
  return [body, boundaryBlock, audioBlock].filter(Boolean).join('\n\n')
}

/** Exact automatic baselines only; never strip user prose when deciding whether
 * an old video node may be restored. The legacy fallback predates managed shot
 * boundaries and placed its state lines before the final frame instruction. */
export function isAutomaticShotVideoPrompt(prompt: string, shot: ShotPromptSource): boolean {
  if (prompt === shotVideoPrompt(shot)) return true
  // Automatic drafts created before the sound block was introduced are still
  // restorable. Match the whole baseline, never a keyword or a prose subset.
  if (prompt === compileShotVideoPrompt(shot, false)) return true
  const legacy = shot.video_prompt?.trim() || [continuousShotInstruction, shot.prompt.trim(),
    shot.start_state?.trim() && `开镜状态：${shot.start_state.trim()}`,
    shot.end_state?.trim() && `收镜状态：${shot.end_state.trim()}`,
    shot.cut_note?.trim() && `接镜要求：${shot.cut_note.trim()}`, videoFrameInstruction,
  ].filter(Boolean).join('\n\n')
  return prompt === legacy
}
