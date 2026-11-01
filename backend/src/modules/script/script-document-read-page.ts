import { documentParagraphs } from './script-revision.js'

export const documentReadPageLimit = 48_000

type DocumentSource = 'saved' | 'draft'
export type DocumentReadRequest = {
  source: DocumentSource
  offset: number
  length: number
  scene_offset: number
  scene_limit: number
  /** Character offset within JSON.stringify(scene), for a single oversized scene. */
  scene_content_offset?: number
}
type ReadableDocument = { id: string; title: string; version: string; content: string }
type ReadableScene = { id: string; version: string }
export type DocumentReadInput<D extends ReadableDocument, S extends ReadableScene> = { document: D; scenes?: S[] }
export type SceneReadFragment = {
  id: string; version: string; serialized_scene_fragment: string
  offset: number; next_offset: number; total_length: number; complete: boolean
}
export type DocumentReadPage<D extends ReadableDocument, S extends ReadableScene> = Omit<D, 'content'> & {
  source: DocumentSource; content: string; offset: number; next_offset: number; complete: boolean; total_length: number
  paragraphs: ReturnType<typeof documentParagraphs>
  scenes?: S[]; scene_fragments?: SceneReadFragment[]
  scene_offset?: number; scene_next_offset?: number; scene_content_offset?: number; scene_next_content_offset?: number
  scenes_complete?: boolean; total_scenes?: number
}
export type DocumentReadContinuation = DocumentReadRequest & { document_ids: string[] }
export type DocumentReadResult<D extends ReadableDocument, S extends ReadableScene> = {
  documents: Array<DocumentReadPage<D, S>>
  deferred_document_ids: string[]
  continuations: DocumentReadContinuation[]
  note: string
}

const pagingNote = '程序已按序列化长度自动缩页。按continuations逐项调用read_documents读完；deferred_document_ids尚未读取。complete仅表示本页到达文末，不证明此前已读。scene_fragments是同版本场次JSON的字符片段，须按offset拼接还原，不可当完整场次。'
const serializedLength = (value: unknown) => JSON.stringify(value).length

function continuation<D extends ReadableDocument, S extends ReadableScene>(input: DocumentReadInput<D, S>, request: DocumentReadRequest, page?: DocumentReadPage<D, S>): DocumentReadContinuation | undefined {
  if (page?.complete && (page.scenes_complete ?? true)) return undefined
  return {
    document_ids: [input.document.id], source: request.source, offset: page?.next_offset ?? request.offset,
    length: request.length, scene_offset: page?.scene_next_offset ?? request.scene_offset, scene_limit: request.scene_limit,
    ...((page?.scene_next_content_offset ?? request.scene_content_offset ?? 0) ? { scene_content_offset: page?.scene_next_content_offset ?? request.scene_content_offset } : {}),
  }
}

/** Find a fitting prefix using the actual JSON cost, including escaping and anchors. */
function fittingEnd(start: number, end: number, fits: (end: number) => boolean) {
  // Finishing a page can shrink its cursor/complete metadata. A completed UTF-16
  // surrogate pair also serializes more cheaply than its lone first half.
  if (fits(end)) return end
  let low = start, high = end
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  // The cost is otherwise monotone, except for those adjacent surrogate halves.
  // Check both endpoints so a fitting emoji cannot be rejected as no progress.
  for (let next = Math.min(end, low + 2); next > low; next--) if (fits(next)) return next
  return low
}

function singlePage<D extends ReadableDocument, S extends ReadableScene>(input: DocumentReadInput<D, S>, request: DocumentReadRequest, budget: number, paragraphs: ReturnType<typeof documentParagraphs>): DocumentReadPage<D, S> | undefined {
  const { content, ...metadata } = input.document
  const scenes = input.scenes
  const page: DocumentReadPage<D, S> = {
    ...metadata, source: request.source, content: '', paragraphs: [], offset: request.offset, next_offset: request.offset,
    complete: request.offset === content.length, total_length: content.length,
    ...(scenes ? { scenes: [], scene_fragments: [], scene_offset: request.scene_offset, scene_next_offset: request.scene_offset,
      scene_content_offset: request.scene_content_offset ?? 0, scene_next_content_offset: request.scene_content_offset ?? 0,
      scenes_complete: request.scene_offset === scenes.length, total_scenes: scenes.length } : {}),
  }
  const baseSize = serializedLength(page)
  if (baseSize > budget) return undefined
  const hasBody = request.offset < content.length, hasScenes = scenes && request.scene_offset < scenes.length
  // Reserve a fair share for scene progress, rather than repeatedly returning only the body.
  const bodyBudget = hasBody && hasScenes ? baseSize + Math.floor((budget - baseSize) / 2) : budget
  const fillBody = (end: number) => {
    page.content = content.slice(request.offset, end)
    page.paragraphs = paragraphs.filter(paragraph => paragraph.start >= request.offset && paragraph.end <= end)
    page.next_offset = end
    page.complete = end === content.length
  }
  const bodyEnd = fittingEnd(request.offset, Math.min(content.length, request.offset + request.length), end => {
    fillBody(end)
    return serializedLength(page) <= bodyBudget
  })
  fillBody(bodyEnd)

  if (scenes) {
    const end = Math.min(scenes.length, request.scene_offset + request.scene_limit)
    for (let index = request.scene_offset; index < end; index++) {
      const scene = scenes[index]!
      const offset = index === request.scene_offset ? request.scene_content_offset ?? 0 : 0
      // Ordinary scenes retain their exact structured fields and existing version.
      if (offset === 0) {
        page.scenes!.push(scene)
        page.scene_next_offset = index + 1
        page.scene_next_content_offset = 0
        page.scenes_complete = index + 1 === scenes.length
        if (serializedLength(page) <= budget) continue
        page.scenes!.pop()
        page.scene_next_offset = index
        page.scenes_complete = false
      }
      const serialized = JSON.stringify(scene)
      const fragment: SceneReadFragment = { id: scene.id, version: scene.version, serialized_scene_fragment: '', offset,
        next_offset: offset, total_length: serialized.length, complete: offset === serialized.length }
      page.scene_fragments!.push(fragment)
      const fillFragment = (next: number) => {
        fragment.serialized_scene_fragment = serialized.slice(offset, next)
        fragment.next_offset = next
        fragment.complete = next === serialized.length
        page.scene_next_offset = fragment.complete ? index + 1 : index
        page.scene_next_content_offset = fragment.complete ? 0 : next
        page.scenes_complete = fragment.complete && index + 1 === scenes.length
      }
      const next = fittingEnd(offset, serialized.length, next => {
        fillFragment(next)
        return serializedLength(page) <= budget
      })
      fillFragment(next)
      if (next === offset && offset !== serialized.length) {
        page.scene_fragments!.pop()
        page.scene_next_offset = index
        page.scene_next_content_offset = offset
        page.scenes_complete = false
        break
      }
      if (!fragment.complete) break
    }
  }
  const sceneProgress = (page.scene_next_offset ?? request.scene_offset) > request.scene_offset
    || (page.scene_next_content_offset ?? 0) > (request.scene_content_offset ?? 0)
  if ((hasBody || hasScenes) && page.next_offset === request.offset && !sceneProgress) return undefined
  if (serializedLength(page) > budget) return undefined
  return page
}

/**
 * Bound the entire tool result, not just source text. Every requested document is
 * either returned or explicitly deferred. Following each continuation recovers
 * all text and scenes without trusting a model to invent a smaller page size.
 */
export function buildDocumentReadPage<D extends ReadableDocument, S extends ReadableScene>(inputs: Array<DocumentReadInput<D, S>>, request: DocumentReadRequest, options: { maxSerializedCharacters?: number } = {}): DocumentReadResult<D, S> {
  const maximum = options.maxSerializedCharacters ?? documentReadPageLimit
  for (const { document, scenes } of inputs) {
    if (request.offset > document.content.length) throw new RangeError('读取位置超过文档长度')
    if (scenes && request.scene_offset > scenes.length) throw new RangeError('场次读取位置超过本集场次数')
    if (scenes && (request.scene_content_offset ?? 0) > 0) {
      const scene = scenes[request.scene_offset]
      if (!scene || request.scene_content_offset! > JSON.stringify(scene).length) throw new RangeError('场次片段读取位置超过场次长度')
    }
  }
  const result: DocumentReadResult<D, S> = { documents: [], deferred_document_ids: inputs.map(input => input.document.id),
    continuations: inputs.map(input => continuation(input, request)!), note: pagingNote }
  if (serializedLength(result) > maximum) throw new RangeError('分页元数据超过读取预算，请减少单次文档数量')
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!
    const paragraphs = documentParagraphs(input.document.content, input.document.version)
    // The unfilled continuation/deferred entries are already included in result.
    const available = maximum - serializedLength(result)
    let budget = Math.floor(available / (inputs.length - index))
    let page = singlePage(input, request, budget, paragraphs)
    if (!page && index === 0) {
      // Small custom budgets may fit only one document. Always make progress on it.
      budget = available
      page = singlePage(input, request, budget, paragraphs)
    }
    while (page) {
      const next = continuation(input, request, page)
      const candidate = { ...result, documents: [...result.documents, page],
        deferred_document_ids: result.deferred_document_ids.filter(id => id !== input.document.id),
        continuations: result.continuations.flatMap(item => item.document_ids[0] === input.document.id ? next ? [next] : [] : [item]) }
      const excess = serializedLength(candidate) - maximum
      if (excess <= 0) {
        Object.assign(result, candidate)
        break
      }
      budget -= excess + 16
      page = singlePage(input, request, budget, paragraphs)
    }
  }
  if (inputs.length && !result.documents.length) throw new RangeError('读取预算无法容纳文档定位与原文，请减少单次文档数量')
  return result
}
