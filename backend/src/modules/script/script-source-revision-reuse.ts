import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { now, one, run } from '../../infrastructure/database/db.js'
import { scriptDocumentVersion, scriptSourceVersion } from './script-source-identity.js'
import { planScriptSourceMapReuse } from './script-source-map-reuse.js'
import { hasPassedSourceQuality } from './script-source-quality.js'
import { validateSourceCoverage, sourceAnalysisPipelineVersion } from './script-source-map.js'
import { validateSourceStory } from './script-source-story.js'

type Source = Omit<ScriptSourceDocument, 'analysis'>
type RevisionBase = { version: 1; project_id: string; upload_version: string; revision_id: string;
  base_document_version: string; base_source_version: string; source_version: string; document_version: string;
  configuration_hash: string; analysis: ScriptSourceAnalysis }
type Revision = { id: string; project_id: string; source_base_version: string; original_content: string; content: string; created_at: string }
const fingerprint = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
export const sourceAnalysisConfigurationHash = (configuration?: unknown) => fingerprint(['source-analysis-configuration-v1', configuration ?? null])
export const sourceRevisionReuseNamespace = 'source-revision-base'

/** Called only inside the confirmed revision transaction. The historical
 * original_content already lives in its revision row; do not duplicate it. */
export function captureSourceRevisionBase(current: Source, original: Source, revised: Source, revisionId: string) {
  const projectId = current.project_id
  const discard = () => run('DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, sourceRevisionReuseNamespace)
  if (process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS === '0') { discard(); return }
  try {
    const row = one<{ id: string; source_version: string; status: string; snapshot: string }>('SELECT id,source_version,status,snapshot FROM script_source_analyses WHERE project_id=?', projectId)
    if (!row || row.status !== 'ready' || row.source_version !== scriptSourceVersion(current)) { discard(); return }
    const analysis = JSON.parse(row.snapshot) as ScriptSourceAnalysis
    if (analysis.id !== row.id || analysis.status !== 'ready' || analysis.phase !== 'ready' ||
      analysis.source_version !== row.source_version || typeof analysis.model_id !== 'string' || !analysis.model_id.trim() ||
      typeof analysis.configuration_hash !== 'string' || !analysis.configuration_hash.trim() ||
      ![5, sourceAnalysisPipelineVersion].includes(analysis.pipeline_version!) ||
      analysis.completed_chunks !== analysis.total_chunks || !analysis.total_chunks ||
      analysis.completed_characters !== current.content.length || !hasPassedSourceQuality(analysis)) { discard(); return }
    validateSourceCoverage(current.content, analysis.sections)
    validateSourceStory(analysis, analysis.story)
    const payload: RevisionBase = { version: 1, project_id: projectId, upload_version: scriptDocumentVersion(original), revision_id: revisionId,
      base_document_version: scriptDocumentVersion(current), base_source_version: row.source_version,
      source_version: scriptSourceVersion(revised), document_version: scriptDocumentVersion(revised),
      configuration_hash: analysis.configuration_hash, analysis }
    run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at',
      projectId, sourceRevisionReuseNamespace, fingerprint(payload), JSON.stringify(payload), now())
  } catch { discard() }
}

/** Reconstruct candidates from the committed revision and its verified base.
 * Hash, upload, configuration and target guards also apply after restart. */
export function sourceRevisionMapReuse(document: Source, modelId: string, configurationHash?: string) {
  if (process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS === '0' || !configurationHash) return null
  try {
    const row = one<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', document.project_id, sourceRevisionReuseNamespace)
    if (!row) return null
    const base = JSON.parse(row.payload) as RevisionBase
    if (base.version !== 1 || fingerprint(base) !== row.cache_key || base.project_id !== document.project_id ||
      base.source_version !== scriptSourceVersion(document) || base.document_version !== scriptDocumentVersion(document) ||
      base.configuration_hash !== configurationHash || base.analysis?.configuration_hash !== configurationHash || base.analysis.model_id !== modelId) return null
    const original = one<Source>('SELECT * FROM script_source_documents WHERE project_id=?', document.project_id)
    const revision = one<Revision>('SELECT * FROM script_source_revisions WHERE id=? AND project_id=?', base.revision_id, document.project_id)
    if (!original || !revision || scriptDocumentVersion(original) !== base.upload_version || revision.source_base_version !== base.upload_version ||
      revision.content !== document.content || revision.created_at !== document.updated_at ||
      scriptSourceVersion({ filename: original.filename, content: revision.original_content }) !== base.base_source_version) return null
    const plan = planScriptSourceMapReuse({ filename: original.filename, content: revision.original_content }, base.analysis, document)
    return plan.mode === 'incremental' ? plan : null
  } catch { return null }
}
