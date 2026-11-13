import type { VideoContinuityReview } from '@video-studio/shared/media/video-continuity-review'
import type { GenerationRequest, CanvasGraph, CanvasNode } from '../../src/features/canvas/ProjectCanvas'
import type { Model, Provider } from '../../src/shared/api/api'
import { fixture } from './final-cut'

export function continuityFixture() {
  const { detail } = fixture()
  for (const shot of detail.shots) {
    shot.source_scene_id = 'train-scene'
    shot.image_prompt = '右手持纸，尚未睁眼。'
    shot.video_prompt = '保持右手持纸，随后睁眼。'
    shot.audio_plan = { version: 1, speech: [], sound_effects: ['纸张摩擦'], music: '', silent: false,
      scene_sound: { ambience: ['列车运行声'], acoustics: '同一节封闭车厢', music_policy: 'timeline' } }
  }
  detail.assets.push({ ...detail.assets[0], id: 'other-take', filename: 'other-take.mp4' })
  const request: GenerationRequest = { shot_id: 's2', model_id: 'seedance', prompt: '右手持纸，从暗处睁眼。', mode: 'reference',
    reference_asset_ids: ['still'], storyboard_reference_asset_id: 'still', reference_video_url: null,
    resolution: '720p', duration: 5, ratio: '16:9', generate_audio: true, draft: false }
  const source: CanvasNode = { id: 'source-image', type: 'generation', x: 0, y: 0, width: 300, height: 300,
    title: '本镜首帧', text: '', prompt: '右手持纸，尚未睁眼。', asset_id: 'still', shot_id: 's2', model_id: null, job_id: null,
    settings: { modality: 'image', visual_reference_mode: 'profiles', prompt_body: '右手持纸，尚未睁眼。' } }
  const graph: CanvasGraph = { nodes: [source], edges: [], revision: 'r1' }
  const provider: Provider = { id: 'remote', name: '测试服务', adapter: 'http', base_url: 'http://invalid.test', auth_header: 'Authorization', auth_prefix: 'Bearer ',
    model_catalog: { path: '', list_path: '', id_path: '' }, has_key: true, enabled: true }
  const text: Model = { id: 'text', name: '文字模型', provider_id: provider.id, modality: 'text', protocol: 'chat_completions', remote_id: 'text',
    settings: { supports_vision: false }, enabled: true, is_default: true }
  const vision: Model = { ...text, id: 'vision', name: '图片模型', settings: { supports_vision: true }, is_default: false }
  return { detail, request, source, graph, provider, models: [text, vision] }
}

export function continuityReport(signature: string): VideoContinuityReview {
  return { source_signature: signature, context_signature: 'context', summary: '首帧与动作起点存在冲突，需创作者判断。',
    findings: [{ category: 'opening_state', severity: 'error', basis: 'text', observation: '首帧已经睁眼，动作仍要求随后睁眼。',
      quotes: ['首帧已睁眼', '随后睁眼'], image_index: null, suggestion: '统一本镜起点。' }],
    uncertainties: ['声音未试听，本报告不证明实际成片的声音连续性。'], images: [] }
}
