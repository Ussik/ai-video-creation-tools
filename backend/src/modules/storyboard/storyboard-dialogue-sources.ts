import { createHash } from 'node:crypto'
import { z } from 'zod'
import { recoverVideoAudioPlanSourceText, videoAudioSourceMatches, type VideoAudioPlan } from '@video-studio/shared/media/video-prompt-audio'
import { videoAudioPlanSchema, videoAudioSpeechSchema, validateVideoAudioPlanSources } from '../canvas/video-audio-plan.js'
import { generateStructuredOutput, type StructuredGenerator } from '../generation/model-output.js'
import { reportModelResult, withModelOperationStage } from '../generation/model-result-observation.js'

type Scene = { id: string; heading: string; episode_number: number; action: string; dialogue: string; narration: string }
type Document = { id: string; content: string; artifact_type: string; episode_number: number; version: string | number }
export type DialogueSource = { id: string; scene_id: string; version: string; field: string; text: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const issue = (code: string, message: string, details: Record<string, unknown> = {}): never => {
  throw Object.assign(new Error(message), { code, message, statusCode: 422, retryable: false, ...details })
}
const punctuationEquivalent = (candidate: string, source: string) => {
  const matches = videoAudioSourceMatches(candidate, [source])
  return matches.length === 1 && matches[0] === source
}
const canonicalPunctuation = (value: string) => value.replace(/[，：；？！]/gu, mark => ({ '，': ',', '：': ':', '；': ';', '？': '?', '！': '!' })[mark]!)
function uniqueSourceSpan(candidate: string, source: string): { start: number; end: number; text: string } | null {
  if (!candidate.trim()) return { start: 0, end: source.length, text: source }
  const target = canonicalPunctuation(candidate), normalized = canonicalPunctuation(source), indexes: number[] = []
  for (let index = normalized.indexOf(target); index >= 0; index = normalized.indexOf(target, index + 1)) {
    indexes.push(index)
    if (indexes.length > 1) return null
  }
  const start = indexes[0]
  return start === undefined ? null : { start, end: start + target.length, text: source.slice(start, start + target.length) }
}

/** Only explicit current-scene fields or an exactly headed section of its
 * episode document can authorize speech. Global reference prose cannot. */
export function storyboardDialogueSources(scenes: readonly Scene[], documents: readonly Document[] = []): DialogueSource[] {
  const result: DialogueSource[] = []
  const add = (scene: Scene, field: string, text: string) => {
    if (text.trim()) result.push({ id: 'ds_' + hash([scene.id, field]).slice(0, 24), scene_id: scene.id,
      version: hash([scene.id, field, text]), field, text })
  }
  for (const scene of scenes) {
    for (const field of ['dialogue', 'narration', 'action'] as const) add(scene, field, scene[field])
    for (const doc of documents.filter(doc => doc.artifact_type === 'episode_script' && doc.episode_number === scene.episode_number)) {
      const lines = [...doc.content.matchAll(/[^\r\n]+/g)]
      const heading = lines.filter(line => line[0].replace(/^\s*#{1,6}\s*/, '').trim() === scene.heading.trim())
      if (heading.length !== 1) continue
      const begin = heading[0]!.index! + heading[0]![0].length
      const next = lines.find(line => line.index! >= begin &&
        (/^\s*#{1,6}\s/.test(line[0]) || /^\s*(?:#{1,6}\s*)?EP\d+-SC\d+\b/.test(line[0])))
      const passage = doc.content.slice(begin, next?.index ?? doc.content.length).trim()
      // Do not duplicate an identical field and introduce false ambiguity.
      if (passage && !result.some(source => source.scene_id === scene.id && source.text === passage)) add(scene, `document.${doc.id}.v${doc.version}`, passage)
    }
  }
  return result
}

/** Generation can select coordinates and leave copied strings empty. Stored
 * and downstream contracts still require resolved exact text/source_text. */
export const storyboardAudioInputSchema = z.object({ ...videoAudioPlanSchema.shape, speech: z.array(videoAudioSpeechSchema.extend({
  text: z.string().max(5000), source_text: z.string().max(20000),
})).max(100) }).strict()
export const storyboardDialogueCorrectionSchema = z.object({
  speaker: z.string().max(160), text: z.string().max(5000), delivery: z.string().max(4000), mode: z.enum(['dialogue', 'voiceover']), source_text: z.string().max(20000),
  source_ref: z.object({ id: z.string().min(1).max(120), scene_id: z.string().min(1).max(120), version: z.string().min(1).max(64),
    start: z.number().int().min(0).optional(), end: z.number().int().min(1).optional() }).strict().optional(),
}).strict()

export const storyboardDialogueInstructions =
  '【台词来源引用】dialogue_sources 是按当前场次划定的允许来源。优先在 speech.source_ref 返回 {id,scene_id,version,start,end}，' +
  'id、scene_id、version 逐字复制，start/end 为该条 text 内明确要发声的连续原文片段的 JavaScript UTF-16 起止偏移（end 不含）。' +
  '使用引用时 speech.text 和 source_text 均返回空字符串，程序将回填原文，不能自行重写出处。' +
  '可用不同片段拆句，但不得漏词、重复分配、跨场借用。无引用的兼容输出仍须逐字给出 text/source_text。' +
  '引用只证明定位和归属；仍须按剧情判断该片段是否真正发声、说话者及语义，不得把动作、标签、字幕当成台词。\n'

export function resolveStoryboardAudio(plan: VideoAudioPlan, sceneId: string, sources: readonly DialogueSource[], recover = true, recalculateRef = false): VideoAudioPlan {
  const allowed = sources.filter(source => source.scene_id === sceneId)
  const resolved = { ...plan, speech: plan.speech.map((line, speech_index) => {
    const ref = line.source_ref
    if (!ref) return { ...line }
    const details = { scene_id: sceneId, speech_index, ref_id: ref.id, field_path: `audio_plan.speech.${speech_index}.source_ref` }
    if (ref.scene_id !== sceneId) issue('dialogue_ref_wrong_scene', '台词引用属于其他场次，未采用。', details)
    const matches = allowed.filter(source => source.id === ref.id)
    if (matches.length > 1) issue('dialogue_ref_ambiguous', '台词引用对应多个来源，未采用。', details)
    const source = matches[0] || issue('dialogue_source_mismatch', '台词引用不存在，未采用。', details)
    if (source.version !== ref.version) issue('dialogue_source_mismatch', '台词引用不存在或原文版本已变化，未采用。', details)
    if (!recalculateRef && (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > source.text.length
      || /[\uDC00-\uDFFF]/.test(source.text[ref.start] || '') || /[\uD800-\uDBFF]/.test(source.text[ref.end - 1] || ''))) {
      issue('dialogue_source_mismatch', '台词引用片段坐标无效，未采用。', details)
    }
    const candidate = recalculateRef ? line.text || line.source_text : source.text.slice(ref.start, ref.end)
    const span = uniqueSourceSpan(candidate, source.text) || issue('dialogue_source_mismatch', '台词引用片段在当前场次原文中不存在唯一匹配，未采用。', details)
    const text = span.text
    if (!text.trim() || text.length > 5000 || source.text.length > 20000
      || line.text && line.text !== text && !punctuationEquivalent(line.text, text)) {
      issue('dialogue_source_mismatch', '台词或出处与所选原文引用不一致，未采用。', details)
    }
    return { ...line, text, source_text: source.text, source_ref: { ...ref, start: span.start, end: span.end } }
  }) }
  const recovered = recover ? recoverVideoAudioPlanSourceText(resolved, allowed.map(source => source.text)) : resolved
  if (!allowed.length && recovered.speech.length) issue('dialogue_source_mismatch', '本场没有允许的台词来源，未采用。', { scene_id: sceneId })
  validateVideoAudioPlanSources(recovered, allowed.map(source => source.text))
  videoAudioPlanSchema.parse(recovered)
  return recovered
}

type Schedule = { scenes: Array<{ scene_id: string; shots: Array<{ shot_id?: string | null; audio_plan: VideoAudioPlan }> }> }
/** Mutates only failed speech entries. Each durable unit receives at most one
 * model correction, including explicit resumes; the existing task owns usage. */
export async function repairStoryboardDialogue<T extends Schedule>(value: T, sources: readonly DialogueSource[], options: {
  key: string; steps: Record<string, unknown>; retain(key: string, value: unknown): void; generate: StructuredGenerator; signal: AbortSignal
}): Promise<T> {
  const candidate = structuredClone(value)
  options.retain(options.key + ':candidate', candidate)
  for (const [sceneIndex, scene] of candidate.scenes.entries()) for (const [shotIndex, shot] of scene.shots.entries()) {
    for (let lineIndex = 0; lineIndex < shot.audio_plan.speech.length; lineIndex++) {
      const line = shot.audio_plan.speech[lineIndex]!, field_path = `scenes.${sceneIndex}.shots.${shotIndex}.audio_plan.speech.${lineIndex}`
      let problem: unknown
      try {
        const resolved = resolveStoryboardAudio({ ...shot.audio_plan, speech: [line] }, scene.scene_id, sources, true, true)
        shot.audio_plan.speech[lineIndex] = resolved.speech[0]!
        if (JSON.stringify(line) !== JSON.stringify(resolved.speech[0])) reportModelResult({ phase: 'structure', status: 'valid',
          repair_strategy: 'local_dialogue_source_recovery', repair_applied: true, repair_count: 0, repaired_units: [field_path], evidence_validation: 'passed',
          scene_id: scene.scene_id, shot_id: shot.shot_id || undefined, field_path })
        options.retain(options.key + ':candidate', candidate)
        continue
      } catch (error) { problem = error }
      const sourceCode = (problem as { code?: string }).code
      if (!sourceCode?.startsWith('dialogue_')) throw problem
      const unit = `${options.key}:speech:${scene.scene_id}:${shotIndex}:${lineIndex}`
      if (options.steps[unit]) throw Object.assign(problem as object, { raw_output: JSON.stringify(candidate), diagnostics: '本台词项的一次局部纠正已用尽；完整候选及已完成镜头已保留。' })
      options.signal.throwIfAborted()
      options.retain(unit, { attempted: true })
      const allowed = sources.filter(source => source.scene_id === scene.scene_id)
      try {
        const repaired = await withModelOperationStage('dialogue_source_correction', () => generateStructuredOutput('storyboard_dialogue_source_correction',
          z.object({ speech: storyboardDialogueCorrectionSchema }).strict(), options.generate,
          '只纠正一个失败台词项的引用、text/source_text。保留说话者、mode、delivery和原话含义，不增删台词，不重做镜头或大纲。资料不含可用原话则不能编造。\n' +
          storyboardDialogueInstructions + '\n本次局部纠正例外：只返回稳定 source_ref.id/scene_id/version 或原文候选，不要返回 start/end；程序会依据当前版本唯一匹配并计算坐标。' +
          JSON.stringify({ diagnostic: { scene_id: scene.scene_id, field_path, error_code: sourceCode }, speech: line, dialogue_sources: allowed }) +
          '\n诊断字段仅供定位，严禁出现在返回对象；返回根对象只能包含 speech，speech 只能包含台词 Schema 字段。',
          { signal: options.signal, maxAttempts: 1, stopOnBusinessError: true, validate: patch => {
            if (patch.speech.speaker !== line.speaker || patch.speech.mode !== line.mode || patch.speech.delivery !== line.delivery) issue('dialogue_source_mismatch', '局部纠正改变了非授权表演字段')
            patch.speech = resolveStoryboardAudio({ ...shot.audio_plan, speech: [patch.speech] } as VideoAudioPlan, scene.scene_id, sources, true, true).speech[0]! as typeof patch.speech
            if (line.text && (patch.speech.text.length !== line.text.length || videoAudioSourceMatches(line.text, [patch.speech.text]).length !== 1)) issue('dialogue_source_mismatch', '局部纠正不得改字、漏词或替换成另一句台词')
          } }), { scene_id: scene.scene_id, shot_id: shot.shot_id || undefined, field_path })
        shot.audio_plan.speech[lineIndex] = repaired.speech as VideoAudioPlan['speech'][number]
        options.retain(unit, { attempted: true, completed: true })
        options.retain(options.key + ':candidate', candidate)
        reportModelResult({ phase: 'structure', status: 'valid', stage: 'dialogue_source_correction', repair_strategy: 'local_speech_item_correction',
          repair_count: 1, repair_applied: true, repaired_units: [field_path], evidence_validation: 'passed', scene_id: scene.scene_id, shot_id: shot.shot_id || undefined, field_path })
      } catch (error) {
        const originalCode = (error as { code?: string }).code
        const correctionCode = originalCode === 'model_field_contract' || originalCode === 'model_json_syntax'
          ? 'dialogue_source_correction_contract' : originalCode || sourceCode
        reportModelResult({ phase: 'structure', status: correctionCode === 'dialogue_source_correction_contract' ? 'invalid_contract' : 'invalid_business', stage: 'dialogue_source_correction', failure_code: correctionCode,
          repair_strategy: 'local_speech_item_correction', repair_count: 1, repaired_units: [field_path], evidence_validation: 'failed', scene_id: scene.scene_id,
          shot_id: shot.shot_id || undefined, field_path })
        throw Object.assign(error as object, { code: correctionCode, correction_error_code: correctionCode, scene_id: scene.scene_id, field_path,
          raw_output: JSON.stringify(candidate), diagnostics: '局部台词纠正未通过，已停止；完整候选及已完成镜头已保留。' })
      }
    }
    shot.audio_plan = resolveStoryboardAudio(shot.audio_plan, scene.scene_id, sources)
  }
  return candidate
}
