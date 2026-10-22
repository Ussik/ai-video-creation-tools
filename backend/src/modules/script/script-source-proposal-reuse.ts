import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { now, one, run } from '../../infrastructure/database/db.js'
import { scriptDocumentVersion, scriptSourceVersion } from './script-source-identity.js'
import { originalScriptSource, effectiveScriptSource } from './script-source-versions.js'
import { planScriptSourceMapReuse, type ScriptSourceMapReusePlan } from './script-source-map-reuse.js'
import { hasPassedSourceQuality } from './script-source-quality.js'
import { sourceAnalysisPipelineVersion, validateSourceCoverage } from './script-source-map.js'
import { validateSourceStory } from './script-source-story.js'

type Source = Omit<ScriptSourceDocument, 'analysis'>
type ProposalBase = { version: 1; project_id: string; upload_version: string; effective_version: string; source: Source;
  source_version: string; document_version: string; model_id: string; configuration_hash: string; analysis: ScriptSourceAnalysis }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sourceProposalBaseNamespace = 'source-proposal-base'
const sourceFields = (source: Source): Source => ({ project_id: source.project_id, filename: source.filename, content: source.content,
  updated_at: source.updated_at, ...(source.revision === undefined ? {} : { revision: source.revision }) })
const belongsTo = (document: Source, current: Source) => document.project_id === current.project_id && document.filename === current.filename &&
  document.updated_at === current.updated_at && (document.revision || 0) === (current.revision || 0)

function validateBase(document: Source, analysis: ScriptSourceAnalysis, modelId: string, configurationHash: string) {
  if (process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS === '0' || analysis.status !== 'ready' || analysis.phase !== 'ready' ||
    analysis.model_id !== modelId || analysis.configuration_hash !== configurationHash ||
    analysis.source_version !== scriptSourceVersion(document) || analysis.pipeline_version !== sourceAnalysisPipelineVersion ||
    !Number.isSafeInteger(analysis.total_chunks) || analysis.total_chunks < 1 || analysis.completed_chunks !== analysis.total_chunks ||
    analysis.completed_characters !== document.content.length || !hasPassedSourceQuality(analysis)) return false
  try {
    validateSourceCoverage(document.content, analysis.sections)
    validateSourceStory(analysis, analysis.story)
    return true
  } catch { return false }
}

function readStoredBase(projectId: string, modelId: string, configurationHash: string, uploadVersion: string, expected?: Source) {
  const row = one<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?',
    projectId, sourceProposalBaseNamespace)
  if (!row) return null
  try {
    const base = JSON.parse(row.payload) as ProposalBase
    if (base.version !== 1 || fingerprint(base) !== row.cache_key || base.project_id !== projectId ||
      base.upload_version !== uploadVersion || base.model_id !== modelId || base.configuration_hash !== configurationHash ||
      base.source.project_id !== projectId || base.source_version !== scriptSourceVersion(base.source) ||
      base.document_version !== scriptDocumentVersion(base.source) || !validateBase(base.source, base.analysis, modelId, configurationHash) ||
      expected && (scriptSourceVersion(expected) !== base.source_version || scriptDocumentVersion(expected) !== base.document_version)) return null
    const original = originalScriptSource(projectId), current = effectiveScriptSource(projectId)
    if (!original || !current || scriptDocumentVersion(original) !== uploadVersion ||
      base.effective_version !== scriptDocumentVersion(current) || !belongsTo(base.source, current)) return null
    return { source: base.source, analysis: base.analysis }
  } catch { return null }
}

export function planScriptSourceProposalReuse(document: Source, modelId: string, configurationHash: string,
  baseDocument?: ScriptSourceDocument | null): ScriptSourceMapReusePlan | null {
  if (process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS === '0') return null
  const original = originalScriptSource(document.project_id), current = effectiveScriptSource(document.project_id)
  if (!original || !current || !belongsTo(document, current)) return null
  const uploadVersion = scriptDocumentVersion(original)
  let baseSource: Source | null = null, baseAnalysis: ScriptSourceAnalysis | null = null
  const requested = baseDocument && belongsTo(baseDocument, current) ? sourceFields(baseDocument) : null
  if (requested) {
    const effective = effectiveScriptSource(document.project_id)
    const authoritative = effective && scriptSourceVersion(effective) === scriptSourceVersion(requested)
      ? one<{ snapshot: string; id: string; source_version: string; status: string }>('SELECT snapshot,id,source_version,status FROM script_source_analyses WHERE project_id=?', document.project_id)
      : null
    if (authoritative && scriptSourceVersion(requested) === scriptSourceVersion(effective!)) {
      try {
        const saved = JSON.parse(authoritative.snapshot) as ScriptSourceAnalysis
        if (authoritative.status === 'ready' && saved.id === authoritative.id && authoritative.source_version === scriptSourceVersion(requested) &&
          scriptDocumentVersion(effective!) === scriptDocumentVersion(requested) && validateBase(requested, saved, modelId, configurationHash)) {
          baseSource = requested; baseAnalysis = saved
        }
      } catch { /* Invalid persisted source maps are not reusable. */ }
    } else {
      const saved = readStoredBase(document.project_id, modelId, configurationHash, uploadVersion, requested)
      if (saved) { baseSource = requested; baseAnalysis = saved.analysis }
    }
  }
  if (!baseSource) {
    const saved = readStoredBase(document.project_id, modelId, configurationHash, uploadVersion)
    if (saved) { baseSource = saved.source; baseAnalysis = saved.analysis }
  }
  if (!baseSource) {
    const effective = effectiveScriptSource(document.project_id)
    const row = one<{ snapshot: string; id: string; source_version: string; status: string }>('SELECT snapshot,id,source_version,status FROM script_source_analyses WHERE project_id=?', document.project_id)
    if (effective && row?.status === 'ready' && row.source_version === scriptSourceVersion(effective)) {
      try {
        const analysis = JSON.parse(row.snapshot) as ScriptSourceAnalysis
        if (analysis.id === row.id && validateBase(effective, analysis, modelId, configurationHash)) {
          baseSource = effective; baseAnalysis = analysis
        }
      } catch { /* Invalid persisted source maps are not reusable. */ }
    }
  }
  if (!baseSource || !baseAnalysis || baseSource.filename !== document.filename || baseSource.content === document.content ||
    baseSource.project_id !== document.project_id || !validateBase(baseSource, baseAnalysis, modelId, configurationHash)) return null
  return planScriptSourceMapReuse(baseSource, baseAnalysis, document)
}

export function persistScriptSourceProposalBase(document: Source, analysis: ScriptSourceAnalysis, configurationHash: string) {
  const original = originalScriptSource(document.project_id)
  if (!original || !validateBase(document, analysis, analysis.model_id, configurationHash)) return
  const current = effectiveScriptSource(document.project_id)
  if (!current || !belongsTo(document, current)) return
  const payload: ProposalBase = { version: 1, project_id: document.project_id, upload_version: scriptDocumentVersion(original),
    effective_version: scriptDocumentVersion(current),
    source: sourceFields(document), document_version: scriptDocumentVersion(document), source_version: scriptSourceVersion(document), model_id: analysis.model_id,
    configuration_hash: configurationHash, analysis }
  run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at',
    document.project_id, sourceProposalBaseNamespace, fingerprint(payload), JSON.stringify(payload), now())
}
