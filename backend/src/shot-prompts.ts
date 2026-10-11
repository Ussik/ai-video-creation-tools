type ShotPromptSource = { prompt: string; image_prompt?: string; video_prompt?: string; start_state?: string; end_state?: string; cut_note?: string }

export function shotImagePrompt(shot: ShotPromptSource): string {
  if (shot.image_prompt?.trim()) return shot.image_prompt.trim()
  return [
    '生成当前镜头的单幅首帧画面。固定一个瞬间，明确主体、场景、景别、构图、光线与材质；动作过程只用于理解情境，不表现多个时间点或分格。',
    shot.prompt.trim(), shot.start_state?.trim() && `首帧状态：${shot.start_state.trim()}`,
    '对白与旁白仅作为情绪背景，不绘制文字、字幕、水印或设定板。',
  ].filter(Boolean).join('\n\n')
}

export function shotVideoPrompt(shot: ShotPromptSource): string {
  if (shot.video_prompt?.trim()) return shot.video_prompt.trim()
  return [
    '生成当前分镜的一个连续视频镜头。描述动作先后、表情变化、镜头运动与节奏，保持人物、服装、道具、场景和光线连续；不要拼接无关镜头。',
    shot.prompt.trim(), shot.start_state?.trim() && `开镜状态：${shot.start_state.trim()}`,
    shot.end_state?.trim() && `收镜状态：${shot.end_state.trim()}`,
    shot.cut_note?.trim() && `接镜要求：${shot.cut_note.trim()}`,
    '仅在首帧或首尾帧生成模式下，从指定首帧的构图、人物位置、姿态和物体状态开始延续动作；多图参考的开场状态按正文设计。不添加画面文字、字幕或水印。',
  ].filter(Boolean).join('\n\n')
}
