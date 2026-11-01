export interface VideoPromptAnalysisShot {
  title: string
  start_ms: number
  end_ms: number
  start_state: string
  action: string
  end_state: string
  camera: string
  vfx: string
  image_prompt: string
  video_prompt: string
  uncertainties: string[]
}

export interface VideoPromptAnalysisResult {
  asset_id: string
  model_id: string
  duration_ms: number
  start_ms: number
  end_ms: number
  fps: number
  global_style: string
  shots: VideoPromptAnalysisShot[]
  uncertainties: string[]
}

export const VIDEO_ANALYSIS_MAX_DURATION_MS = 180_000

export function videoAnalysisShotPrompt(shot: VideoPromptAnalysisShot, globalStyle: string): string {
  return [globalStyle.trim() ? `画风与视觉：${globalStyle.trim()}` : '', shot.video_prompt.trim()].filter(Boolean).join('\n\n')
}

export function videoAnalysisText(result: VideoPromptAnalysisResult): string {
  return [`整体画风：${result.global_style}`, ...result.shots.map((shot, index) =>
    `镜头 ${index + 1}｜${shot.title}｜${(shot.start_ms / 1000).toFixed(2)}–${(shot.end_ms / 1000).toFixed(2)} 秒\n${shot.video_prompt}`)].join('\n\n')
}
