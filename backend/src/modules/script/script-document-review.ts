import { z } from 'zod'
import { all, db, newId, now, one, run, type Shot, type ScriptScene } from '../../infrastructure/database/db.js'
import type { ToolDocument, ToolDraftDocument } from './script-document-tools.js'
import type { DocumentReview, DocumentHealth, DraftImpact, ProjectReference } from '@video-studio/shared/script/script-review-types'
import { documentFindingCategories } from '@video-studio/shared/script/script-quality'
import { scriptStageForArtifact, scriptStageOrder } from '@video-studio/shared/script/script-stage-content'

const reference = z.object({ kind: z.enum(['document', 'scene', 'shot', 'visual_profile']), id: z.string().min(1), title: z.string().max(160) }).strict()
export const documentReviewInput = z.object({ summary: z.string().trim().min(1).max(3000),
  documents: z.array(z.object({ id: z.string().min(1), version: z.string().min(1) }).strict()).min(1).max(8),
  findings: z.array(z.object({ document_id: z.string().min(1), document_version: z.string().min(1), category: z.enum(documentFindingCategories),
    severity: z.enum(['info', 'warning', 'error']), quote: z.string().trim().min(1).max(4000), explanation: z.string().trim().min(1).max(3000),
    suggestion: z.string().trim().min(1).max(3000), related: z.array(reference).max(20).default([]),
  }).strict()).max(80),
}).strict()
export const documentReviewSchema = documentReviewInput.extend({ id: z.string().min(1), created_at: z.string().min(1) }).strict()

export function projectReferences(projectId: string, documents: ToolDocument[]): ProjectReference[] {
  return [
    ...documents.map(doc => ({ kind: 'document' as const, id: doc.id, title: doc.title })),
    ...all<{ id: string; heading: string }>('SELECT id, heading FROM script_scenes WHERE project_id=?', projectId).map(item => ({ kind: 'scene' as const, id: item.id, title: item.heading })),
    ...all<{ id: string; title: string }>('SELECT id, title FROM shots WHERE project_id=? AND deleted_at IS NULL AND superseded_by IS NULL', projectId).map(item => ({ kind: 'shot' as const, id: item.id, title: item.title })),
    ...all<{ id: string; name: string }>('SELECT id, name FROM visual_profiles WHERE project_id=?', projectId).map(item => ({ kind: 'visual_profile' as const, id: item.id, title: item.name })),
  ]
}
export function documentHealth(projectId: string, documents: ToolDocument[]): DocumentHealth[] {
  return documents.map(doc => {
    // These are textual markers for review, never a professional verdict or
    // an automatic reason to regenerate a completed stage.
    const pending_markers = [...doc.content.matchAll(/待定|待补充|尚未确定|\bTODO\b/g)].slice(0, 30)
      .map(match => ({ offset: match.index, excerpt: doc.content.slice(Math.max(0, match.index - 60), match.index + 100) }))
    const row = one<{ document_version: string; payload: string }>('SELECT document_version, payload FROM script_document_reviews WHERE project_id=? AND document_id=?', projectId, doc.id)
    const review = row ? JSON.parse(row.payload) as DocumentReview : undefined
    const stale = !!review && review.documents.some(source => documents.find(item => item.id === source.id)?.version !== source.version)
    const findings = row?.document_version === doc.version && !stale ? review!.findings.filter(item => item.document_id === doc.id) : []
    return { document_id: doc.id, version: doc.version, pending_markers, findings,
      status: stale || row && row.document_version !== doc.version ? 'stale' : row ? findings.length ? 'needs_attention' : 'reviewed' : 'unreviewed' }
  })
}
export function saveDocumentReview(projectId: string, documents: ToolDocument[], input: z.infer<typeof documentReviewInput>) {
  const targets = input.documents.map(target => {
    const doc = documents.find(item => item.id === target.id)
    if (!doc || doc.version !== target.version) throw new Error('评审目标版本已变化，请重新读取')
    return doc
  })
  if (new Set(input.documents.map(item => item.id)).size !== targets.length) throw new Error('评审文档不可重复')
  const refs = projectReferences(projectId, documents)
  for (const finding of input.findings) {
    const doc = targets.find(item => item.id === finding.document_id)
    if (!doc || doc.version !== finding.document_version || !doc.content.includes(finding.quote)) throw new Error('评审证据必须逐字来自目标文档当前原文')
    for (const related of finding.related) if (!refs.some(ref => ref.kind === related.kind && ref.id === related.id)) throw new Error('评审关联对象不存在或不属于当前项目')
    finding.related = finding.related.map(related => refs.find(ref => ref.kind === related.kind && ref.id === related.id)!)
  }
  const review: DocumentReview = { ...input, id: newId(), created_at: now() }
  db.transaction(() => {
    for (const doc of targets) run(`INSERT INTO script_document_reviews (project_id, document_id, document_version, payload, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, document_id) DO UPDATE SET document_version=excluded.document_version, payload=excluded.payload, updated_at=excluded.updated_at`, projectId, doc.id, doc.version, JSON.stringify(review), review.created_at)
  })()
  return review
}

export function documentDraftImpacts(projectId: string, documents: ToolDocument[], changes: ToolDraftDocument[], sceneIds: string[], limit = 100): DraftImpact[] {
  const impacts: DraftImpact[] = [], touched = new Set(changes.map(doc => doc.id))
  const order = (type: string) => scriptStageOrder.indexOf(scriptStageForArtifact(type) || 'episode')
  const changed = changes.filter(doc => doc.content !== doc.original_content)
  const earliest = changed.length ? Math.min(...changed.map(doc => order(doc.artifact_type))) : 5
  for (const doc of documents) if (!touched.has(doc.id) && order(doc.artifact_type) > earliest) impacts.push({ kind: 'document', id: doc.id, title: doc.title,
    basis: 'stage_dependency', explanation: '依赖本次修订的上游资料，建议核对；尚未自动修改' })
  const scenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', projectId)
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL AND superseded_by IS NULL', projectId)
  for (const shot of shots) if (shot.source_scene_id && sceneIds.includes(shot.source_scene_id)) impacts.push({ kind: 'shot', id: shot.id, title: shot.title,
    basis: 'scene_link', explanation: '源场次在本次修订范围内，需核对镜头和提示词' })
  const profiles = all<{ id: string; name: string; definition: string }>('SELECT id, name, definition FROM visual_profiles WHERE project_id=?', projectId)
  for (const profile of profiles) if (changed.some(doc => doc.replacements.some(edit => edit.find.includes(profile.name) || edit.replace.includes(profile.name)))) {
    impacts.push({ kind: 'visual_profile', id: profile.id, title: profile.name, basis: 'text_match', explanation: '修改片段提及此视觉对象，属于文本匹配线索，需判断是否同步设定' })
    for (const scene of scenes) if ([scene.characters, scene.location, scene.action, scene.dialogue].some(value => value.includes(profile.name))) impacts.push({ kind: 'scene', id: scene.id, title: scene.heading, basis: 'text_match', explanation: '场次提及本次修改的视觉对象，建议核对其剧情与状态' })
    for (const item of all<{ shot_id: string }>('SELECT shot_id FROM shot_visual_bindings WHERE profile_id=?', profile.id)) {
      const shot = shots.find(shot => shot.id === item.shot_id)
      if (shot) impacts.push({ kind: 'shot', id: shot.id, title: shot.title, basis: 'visual_binding', explanation: '镜头已绑定相关视觉设定，需核对使用版本' })
    }
  }
  return [...new Map(impacts.map(item => [`${item.kind}:${item.id}`, item])).values()].slice(0, limit)
}
