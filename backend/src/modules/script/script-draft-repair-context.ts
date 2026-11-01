import { createHash } from 'node:crypto'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'
import { draftCompletenessSources } from './script-draft-completeness.js'
import { applyResolvedEdits, resolvePassageEdits, revisionProblem } from './script-revision.js'
import type { DraftRepairOutput } from './script-draft-repair-generation.js'
import type { WorkflowDraft } from './script-workflow.js'

type RepairDocument = { source_key: string; title: string; version: string; length: number; content: string; source_scene_id?: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A read-only snapshot of a pending candidate, never a formal document draft.
 * Search results are evidence, not read authorization. Only complete documents
 * placed in the initial context or returned by read() may be patched. */
export function createScriptDraftRepairContext(input: {
  candidateId: string; candidateVersion: string; sourceVersion: string; draft: WorkflowDraft;
  findings: ScriptDraftFinding[]; currentSource?: string; assertCurrent?: () => void
}) {
  const documents: RepairDocument[] = draftCompletenessSources(input.draft).map(source => ({
    source_key: source.key, title: source.title, content: source.content, length: source.content.length,
    version: hash([input.candidateVersion, source.key, source.content]),
    ...(source.key.startsWith('scene:') && input.draft.scenes[Number(source.key.split(':')[1])]?.source_scene_id
      ? { source_scene_id: input.draft.scenes[Number(source.key.split(':')[1])]!.source_scene_id } : {}),
  }))
  const byKey = new Map(documents.map(document => [document.source_key, document]))
  const requested = new Set<string>()
  let fallback = !input.findings.length
  for (const finding of input.findings) {
    // Unknown/global locations must expand context rather than silently omit
    // relevant text. Related findings without a key inherit their parent key.
    for (const key of [finding.source_key, ...(finding.related_findings || []).map(item => item.source_key || finding.source_key)]) {
      if (!key || !byKey.has(key)) fallback = true
      else requested.add(key)
    }
  }
  const initialDocuments = documents.filter(document => fallback || requested.has(document.source_key))
  const loaded = new Set(initialDocuments.map(document => document.source_key))
  const descriptor = ({ content: _content, ...document }: RepairDocument) => document
  const directory = documents.map(descriptor)
  const assertVersion = (candidateVersion: string, sourceVersion?: string) => {
    input.assertCurrent?.()
    if (candidateVersion !== input.candidateVersion || sourceVersion !== undefined && sourceVersion !== input.sourceVersion) {
      revisionProblem('repair_version_stale', '候选稿或文稿版本已变化，修补尚未提交', '使用当前任务版本重新读取资料；不得沿用旧版本补丁。', { retryable: false })
    }
  }
  const select = (keys: readonly string[]) => {
    if (!keys.length || keys.length > documents.length || new Set(keys).size !== keys.length) {
      revisionProblem('invalid_repair_sources', '读取来源不能为空、重复或超出当前目录', '从候选目录选择实际 source_key，合并后批量读取。')
    }
    return keys.map(key => {
      const document = byKey.get(key)
      if (!document) revisionProblem('unknown_repair_source', '读取位置不属于当前候选草稿', '使用候选目录中真实的 source_key。')
      return document!
    })
  }
  return {
    identity: hash([input.candidateId, input.candidateVersion, input.sourceVersion, documents, input.currentSource]),
    candidateId: input.candidateId, candidateVersion: input.candidateVersion, sourceVersion: input.sourceVersion,
    initial: {
      candidate_id: input.candidateId, candidate_version: input.candidateVersion, source_version: input.sourceVersion,
      context_mode: fallback ? 'full' as const : 'targeted' as const,
      ...(fallback ? { context_reason: '问题位置缺失或超出当前目录，已提供全部候选正文以保留完整关联背景。' } : {}),
      directory: structuredClone(directory), documents: structuredClone(initialDocuments),
    },
    assertVersion,
    resetReads() {
      loaded.clear()
      initialDocuments.forEach(document => loaded.add(document.source_key))
    },
    stats: () => ({ loaded_documents: loaded.size, total_documents: documents.length,
      loaded_chars: documents.filter(document => loaded.has(document.source_key)).reduce((sum, document) => sum + document.length, 0),
      total_chars: documents.reduce((sum, document) => sum + document.length, 0) }),
    /** Private session evidence identity; counts and display summaries cannot
     * establish that another tool turn actually loaded new source material. */
    loadedSources: () => documents.filter(document => loaded.has(document.source_key))
      .map(({ source_key, version }) => ({ source_key, version })).sort((left, right) => left.source_key.localeCompare(right.source_key)),
    read(candidateVersion: string, keys: readonly string[]) {
      assertVersion(candidateVersion)
      return { candidate_version: input.candidateVersion, documents: select(keys).map(document => {
        if (loaded.has(document.source_key)) return { ...descriptor(document), already_loaded: true as const }
        loaded.add(document.source_key)
        return { ...document, already_loaded: false as const }
      }) }
    },
    search(candidateVersion: string, query: string, keys?: readonly string[]) {
      assertVersion(candidateVersion)
      if (!query.trim() || query.length > 160) revisionProblem('invalid_repair_query', '搜索词须为 1 至 160 字的非空原文', '使用具体人物、事件或规则的字面原文；需要更多正文时批量读取文档。')
      const matches: Array<{ source_key: string; title: string; version: string; offset: number; quote: string }> = []
      let total = 0
      for (const document of keys ? select(keys) : documents) {
        let offset = document.content.indexOf(query)
        while (offset >= 0) {
          total++
          if (matches.length < 20) matches.push({ source_key: document.source_key, title: document.title, version: document.version,
            offset, quote: document.content.slice(Math.max(0, offset - 60), Math.min(document.content.length, offset + query.length + 100)) })
          offset = document.content.indexOf(query, offset + Math.max(1, query.length))
        }
      }
      return { candidate_version: input.candidateVersion, query, matches, total_matches: total, truncated: total > matches.length,
        instruction: '搜索仅提供定位证据；修改前用 get_repair_context 读取对应完整文档。' }
    },
    /** Validate against this immutable snapshot and apply only to throwaway
     * strings. The caller still owns semantic validation and persistence. */
    assertPatch(value: DraftRepairOutput, candidateVersion = input.candidateVersion, sourceVersion = input.sourceVersion) {
      assertVersion(candidateVersion, sourceVersion)
      let changed = false
      for (const key of new Set(value.edits.map(edit => edit.source_key))) {
        const document = byKey.get(key)
        if (!document) revisionProblem('unknown_repair_source', '补齐位置不属于当前候选草稿', '只能修改当前候选目录中的真实来源。')
        if (!loaded.has(key)) revisionProblem('unread_repair_source', `「${document!.title}」尚未完整读取`, '先调用 get_repair_context 读取该文档，再提交精确补丁。')
        const changes = resolvePassageEdits(document!.content, document!.version, value.edits.filter(edit => edit.source_key === key),
          [[0, document!.content.length]], { id: key, title: document!.title })
        changed = applyResolvedEdits(document!.content, changes) !== document!.content || changed
      }
      if (value.source_edits.length) {
        if (input.currentSource === undefined) revisionProblem('missing_repair_source', '当前项目没有可修改的有效稿', 'source_edits 返回空数组。')
        const content = input.currentSource!
        const changes = resolvePassageEdits(content, input.sourceVersion, value.source_edits, [[0, content.length]],
          { id: 'script-source', title: '当前有效稿' })
        changed = applyResolvedEdits(content, changes) !== content || changed
      }
      if (!changed) revisionProblem('repair_without_changes', '本次补丁没有产生有效正文修改', '根据现有决定修改真实问题；不要提交 find 与 replace 完全相同的补丁。', { retryable: false })
    },
    allDocuments: () => structuredClone(documents),
  }
}

export type ScriptDraftRepairContext = ReturnType<typeof createScriptDraftRepairContext>
