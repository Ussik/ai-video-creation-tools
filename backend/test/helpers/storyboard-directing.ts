import assert from 'node:assert/strict'
import type { OutputContract } from '../../src/modules/generation/model-output.js'

/** Adapt the same authored production fixture to the two generation contracts. */
export function storyboardOutlineFixture(value: any) {
  return { ...value, scenes: value.scenes.map((scene: any) => ({ ...scene, shots: scene.shots.map((shot: any) => {
    const { image_prompt: _image, video_prompt: _video, directing: _directing, ...outline } = shot
    return outline
  }) })) }
}
export function storyboardBatchFixture(value: any, contract: OutputContract) {
  const properties = contract.schema.properties as any
  const sceneId = properties.scene_id.const
  const offset = properties.shots.items.properties.shot_index.minimum
  const count = properties.shots.minItems
  const scene = value.scenes.find((item: any) => item.scene_id === sceneId)
  return { scene_id: sceneId, shots: Array.from({ length: count }, (_, index) => {
    const { image_prompt, video_prompt, directing } = scene.shots[offset + index]
    return { shot_index: offset + index, expansion: { image_prompt, video_prompt, directing } }
  }) }
}

/** Rich model fixtures; accepted-plan/commit fixtures deliberately stay legacy-shaped. */
export function withStoryboardDirecting<T>(value: T): T {
  if (!value || typeof value !== 'object' || !('scenes' in value) || !Array.isArray(value.scenes)) return value
  return { ...value, scenes: value.scenes.map((scene: Record<string, unknown>) => ({
    ...scene,
    scene_direction: scene.scene_direction || {
      anchors: '保留原文空间中的入口与出口作为固定参照，不增添剧情物件。',
      blocking: '人物按原文动作从起始位置移动到结束位置，持物归属保持连续。',
      axis: '摄影机保持在动作轴线同一工作侧；换机位保留运动方向。',
      dramatic_progression: '先读清行动，再呈现行动造成的反应。',
      sound: { ambience: [], acoustics: '', music_policy: 'timeline' },
    },
    shots: Array.isArray(scene.shots) ? scene.shots.map((shot: Record<string, unknown>, index: number, shots: unknown[]) => ({
      ...shot,
      directing: shot.directing || {
        purpose: `看清${String(shot.title || '人物行动')}的叙事变化。`,
        camera: {
          movement: '跟拍', start_frame: String(shot.image_prompt || shot.start_state || '原镜头开场构图'),
          trigger: '人物开始移动时启动。', path: '沿人物既定移动方向平稳跟随，不越过动作轴线。',
          end_frame: String(shot.end_state || '保留原镜头结束构图'), motivation: '让观众读清人物从起点到终点的行动。',
        },
        cut: {
          type: index === shots.length - 1 ? 'ending' : 'action_match',
          cut_moment: '在本镜已交代的行动完成或阶段闭合时切出。',
          carry_over: String(shot.end_state || '保留已建立的人物位置和动作状态。'),
          reason: index === shots.length - 1 ? '本场行动完成后收住。' : '下一镜承接已建立的动作后果。',
        },
      },
    })) : scene.shots,
  })) } as T
}

/** Compilation may add professional direction, but must preserve source facts and IDs. */
export function assertCompiledStoryboardSources(actual: Array<Record<string, unknown>>, expected: Array<Record<string, unknown>>) {
  assert.equal(actual.length, expected.length)
  for (const [index, scene] of expected.entries()) {
    const result = actual[index]!
    for (const field of ['scene_id', 'scene_duration', 'scene_heading']) assert.deepEqual(result[field], scene[field], field)
    assert.equal('scene_direction' in result, false, 'generation-only metadata cannot leak into the legacy commit contract')
    const expectedShots = scene.shots as Array<Record<string, unknown>>, actualShots = result.shots as Array<Record<string, unknown>>
    assert.equal(actualShots.length, expectedShots.length)
    for (const [shotIndex, source] of expectedShots.entries()) {
      const shot = actualShots[shotIndex]!
      for (const [field, value] of Object.entries(source)) {
        if (['prompt', 'image_prompt', 'video_prompt', 'cut_note'].includes(field)) assert.ok(String(shot[field]).includes(String(value)), `${field} keeps the source text`)
        else if (field === 'audio_plan') {
          const { scene_sound: _sound, ...audio } = shot[field] as Record<string, unknown>
          assert.deepEqual(audio, value, field)
        } else assert.deepEqual(shot[field], value, field)
      }
      assert.equal('directing' in shot, false)
    }
  }
}

export function withClipDirecting<T extends { shots: Array<Record<string, unknown>> }>(value: T) {
  const rich = withStoryboardDirecting({ scenes: [{ shots: value.shots }] }).scenes[0] as unknown as {
    scene_direction: Record<string, unknown>; shots: Array<Record<string, unknown>>
  }
  return { groups: [{ group_id: 'clip-main', scene_direction: rich.scene_direction }],
    shots: rich.shots.map(shot => ({ ...shot, group_id: 'clip-main' })) }
}

/** Names come from wire contract metadata, or its serialized schema for prompt-only providers. */
export function storyboardWireContract(body: Record<string, any>, protocol: 'responses' | 'chat_completions') {
  const name = protocol === 'responses' ? body.text?.format?.name : body.response_format?.json_schema?.name
  if (name) return name as string
  const prompt = protocol === 'responses' ? body.input : body.messages?.[0]?.content
  if (typeof prompt !== 'string') return undefined
  const schemaLine = prompt.split('【本次结构化返回契约】')[1]?.split('\n').find(line => line.trim().startsWith('{'))
  if (!schemaLine) return undefined
  try {
    const schema = JSON.parse(schemaLine)
    return schema.properties?.issues ? 'storyboard_directing_review' : schema.properties?.scenes ? 'controlled_storyboard' : undefined
  } catch { return undefined }
}
