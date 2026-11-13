export interface VideoAudioSpeech {
  speaker: string
  text: string
  delivery: string
  mode: 'dialogue' | 'voiceover'
  /** Exact source passage containing the spoken text, for provenance checks. */
  source_text: string
}

/** Shared by shots in one accepted continuous scene; it contains no dialogue. */
export interface SceneSoundPlan {
  ambience: string[]
  /** Recording space and distance; empty means that the source leaves it unknown. */
  acoustics: string
  /** Source music is an explicit exception, such as an audible in-scene radio. */
  music_policy: 'timeline' | 'source'
}

export interface VideoAudioPlan {
  version: 1
  speech: VideoAudioSpeech[]
  sound_effects: string[]
  music: string
  /** Absent on legacy plans. The scene's common sound is not reinvented per shot. */
  scene_sound?: SceneSoundPlan
  /** Entries, exits or changes relative to scene_sound, rather than a replacement bed. */
  ambience_change?: string
  /** True means the entire shot is silent, including effects and music. */
  silent: boolean
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, required = false): value is string => typeof value === 'string'
  && value.length <= max && (!required || !!value.trim())

export function isSceneSoundPlan(value: unknown): value is SceneSoundPlan {
  return object(value) && Object.keys(value).every(key => ['ambience', 'acoustics', 'music_policy'].includes(key))
    && Array.isArray(value.ambience) && value.ambience.length <= 30 && value.ambience.every(sound => text(sound, 4000, true))
    && text(value.acoustics, 4000) && (value.music_policy === 'timeline' || value.music_policy === 'source')
}

/** Validate the explicit contract. Creative prose is never used to infer this shape. */
export function isVideoAudioPlan(value: unknown): value is VideoAudioPlan {
  if (!object(value) || Object.keys(value).some(key => !['version', 'speech', 'sound_effects', 'music', 'silent', 'scene_sound', 'ambience_change'].includes(key))
    || value.version !== 1 || typeof value.silent !== 'boolean' || !text(value.music, 4000)
    || !Array.isArray(value.speech) || value.speech.length > 100
    || !Array.isArray(value.sound_effects) || value.sound_effects.length > 100
    || !value.sound_effects.every(effect => text(effect, 4000, true))) return false
  if (value.scene_sound !== undefined && !isSceneSoundPlan(value.scene_sound)) return false
  if (value.ambience_change !== undefined && !text(value.ambience_change, 4000)) return false
  if (!value.speech.every(line => object(line)
    && Object.keys(line).every(key => ['speaker', 'text', 'delivery', 'mode', 'source_text'].includes(key))
    && text(line.speaker, 160) && text(line.text, 5000, true) && text(line.delivery, 4000)
    && (line.mode === 'dialogue' || line.mode === 'voiceover') && text(line.source_text, 20000, true))) return false
  return !value.silent || !value.speech.length && !value.sound_effects.length && !value.music.trim()
}

/** Exact excerpt checks validate provenance without classifying natural language. */
export function videoAudioPlanSourceIssue(plan: VideoAudioPlan, sources: readonly string[]): string | null {
  for (const line of plan.speech) {
    if (!line.source_text.includes(line.text)) return `台词“${line.text}”必须逐字包含在其来源摘录 source_text 中`
    if (sources.length && !sources.some(source => source.includes(line.source_text))) {
      return `台词“${line.text}”的来源摘录不在本次提供的镜头资料中，不能补写或改写原话`
    }
  }
  return null
}

const sourcePunctuation: Record<string, string> = { '，': ',', '：': ':', '；': ';', '？': '?', '！': '!' }
const canonicalPunctuation = (value: string) => value.replace(/[，：；？！]/gu, mark => sourcePunctuation[mark]!)

/** Restore only an unambiguous punctuation-width copy error from an exact,
 * supplied source. The returned plan still needs the strict provenance check. */
export function recoverVideoAudioPlanSourceText(plan: VideoAudioPlan, sources: readonly string[]): VideoAudioPlan {
  return { ...plan, speech: plan.speech.map(line => {
    if (line.source_text.includes(line.text) || !sources.some(source => source.includes(line.source_text))) return { ...line }
    const source = canonicalPunctuation(line.source_text), target = canonicalPunctuation(line.text)
    const index = source.indexOf(target)
    if (index < 0 || source.indexOf(target, index + 1) >= 0) return { ...line }
    return { ...line, text: line.source_text.slice(index, index + line.text.length) }
  }) }
}

/** Rendering consumes a reviewed plan; missing legacy data must stay unknown. */
export function renderVideoAudioPlan(plan: VideoAudioPlan): string {
  const authority = '声音执行仅依据本结构化计划；正文中的对白、音效、环境声和配乐描述保留为原始创作意图，不得据此额外生成或覆盖本计划。'
  if (plan.silent) return `${authority}\n本镜全程静音，不生成人物对白、旁白、音效或配乐。`
  const scene = plan.scene_sound
  return [
    authority,
    ...(plan.speech.length ? plan.speech.map(line => [
      line.mode === 'voiceover' ? '画外人声' : '人物对白',
      line.speaker && `说话者：${line.speaker}`, line.delivery && `表演与语气：${line.delivery}`,
      `必须逐字生成可听见的人声：“${line.text}”`,
      line.mode === 'dialogue' && '人物说话与口型自然同步，不以表情或字幕代替说话',
    ].filter(Boolean).join('；')) : ['本镜没有人物对白或旁白。']),
    ...(scene?.ambience.map(sound => `本场共同环境底声（跨镜延续）：${sound}`) || []),
    scene?.acoustics && `本场空间声学：${scene.acoustics}`,
    plan.ambience_change && `本镜环境变化（相对共同底声）：${plan.ambience_change}`,
    ...plan.sound_effects.map(effect => `${scene ? '本镜事件音效' : '音效与环境声'}：${effect}`),
    scene?.music_policy === 'timeline'
      ? '背景配乐由成片时间线统一实现。本镜不生成背景配乐，保留对白、旁白、环境底声与事件音效。'
      : plan.music && `配乐：${plan.music}`,
    scene?.music_policy === 'timeline' && '正文中的音乐进入、增强或切换只表示成片配乐意图，不在本镜独立作曲或生成音乐。',
    scene?.music_policy === 'timeline' && plan.music && `时间线配乐意图（仅供后期安排，本镜不生成）：${plan.music}`,
  ].filter(Boolean).join('\n')
}
