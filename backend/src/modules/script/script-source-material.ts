import { scriptSourceCharacterLimit, type ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import type { StructuredGenerator } from '../generation/model-output.js'
import type { GenerationSteps } from './script-generation-steps.js'

export const completeSourceEvidenceCharacters = scriptSourceCharacterLimit

/** Every accepted manuscript is sent in full. Coordinates remain available
 * without turning indexed passages into separate model requests. */
export function completeSourceEvidence(source: ScriptSourceDocument) {
  if (source.content.length > scriptSourceCharacterLimit) {
    throw Object.assign(new Error('剧本文字超过 10 万字符，无法处理'), { statusCode: 422 })
  }
  return [{ offset: 0, content: source.content }]
}

export function sourceMaterialIndex(source: ScriptSourceDocument, includeDirectory = true) {
  return { filename: source.filename, revision: source.revision || 0, source_version: source.analysis?.source_version,
    story: source.analysis?.story, sections: includeDirectory ? source.analysis?.sections.map((section, id) => ({ id, unit_id: section.unit_id ?? id,
      title: section.title, episode_number: section.episode_number, offset: section.offset, length: section.length, summary: section.summary.slice(0, 180),
      characters: section.characters.slice(0, 24).map(item => item.name), character_count: section.characters.length,
      events: section.events.slice(0, 8).map(item => ({ summary: item.summary, offset: item.evidence.offset })), event_count: section.events.length,
      open_threads: section.open_threads?.slice(0, 8), continues_previous: section.continues_previous })) || [] : undefined }
}

/** Compatibility entry point for callers that formerly selected excerpts.
 * No locator, ranking or supplementary-read model request is needed. */
export async function selectSourceMaterial(source: ScriptSourceDocument, _task: string, _generate: StructuredGenerator, signal?: AbortSignal,
  _options: { steps?: GenerationSteps; key?: string; parentId?: string; purpose?: 'source_constraints' } = {}) {
  signal?.throwIfAborted()
  return completeSourceEvidence(source)
}

/** Legacy callers receive a single complete source, never transport batches. */
export function sourceEvidenceBatches(source: ScriptSourceDocument) {
  return [completeSourceEvidence(source)]
}
