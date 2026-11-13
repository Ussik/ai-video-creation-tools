import { createHash } from 'node:crypto'
import { all, now, one, run } from '../../infrastructure/database/db.js'
import type { EffectiveVisualStyle, ProjectVisualStyle, VisualStyleDetails } from '@video-studio/shared/visuals/visual-style'
import { effectiveVisualStyleOrigin, isEffectiveVisualStyle, withProjectStyle, styleReferenceWarning } from '@video-studio/shared/visuals/visual-style'
import { getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'

export function projectVisualStyle(projectId: string, options: { includeConfirmedContext?: boolean } = {}): ProjectVisualStyle {
  const row = one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', projectId)
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(row?.generation_options || '{}') } catch { /* Old projects may have no settings. */ }
  const label = typeof settings.visual_style === 'string' ? settings.visual_style.trim() : ''
  const rawDetails = label && settings.visual_style_details && typeof settings.visual_style_details === 'object'
    ? settings.visual_style_details as VisualStyleDetails : {}
  const details: VisualStyleDetails = Object.fromEntries(['medium', 'rendering', 'linework', 'palette'].flatMap(key => {
    const value = rawDetails[key as keyof VisualStyleDetails]
    return typeof value === 'string' && value.trim() ? [[key, value.trim()]] : []
  }))
  if (rawDetails.exclusions?.length) details.exclusions = rawDetails.exclusions
  // Compatibility is verbatim confirmed context, not a keyword guess or a global anime default.
  const includeConfirmedContext = options.includeConfirmedContext !== false
  const decisions = !label && includeConfirmedContext ? all<{ topic: string; content: string }>('SELECT topic, content FROM script_story_decisions WHERE project_id=? ORDER BY updated_at DESC, id LIMIT 30', projectId) : []
  const genre = typeof settings.genre === 'string' ? settings.genre.trim() : ''
  const context = !label && includeConfirmedContext && (genre || decisions.length) ? JSON.stringify({ genre,
    decisions: decisions.map(item => ({ topic: item.topic, content: item.content.slice(0, 600) })) }) : ''
  const source = label ? 'settings' as const : context ? 'confirmed_context' as const : 'unspecified' as const
  const version = createHash('sha256').update(JSON.stringify([source, label, details, context])).digest('hex')
  return { version, label: label || (context ? '沿用已确认的画风描述' : '未指定画风'), source, details,
    ...(context ? { confirmed_context: context } : {}) }
}
export function assertStyleVersion(style: ProjectVisualStyle, expected?: string) {
  if (expected && expected !== style.version) throw Object.assign(new Error('项目画风已更新，请重新检查生成信息后再生成'), { statusCode: 409 })
}

/** Derive provenance from the actual document, never a caller-supplied flag. */
export function effectiveVisualStyleForPrompt(prompt: string, style: ProjectVisualStyle): EffectiveVisualStyle {
  const blocks = getManagedPromptBlocks(prompt, ['项目画风约束']).map(block => block.replace(/\r\n/g, '\n').trim())
  const origin = effectiveVisualStyleOrigin(prompt, style)
  return { origin, fingerprint: createHash('sha256').update(JSON.stringify(blocks)).digest('hex') }
}

/** Older complete documents can be diagnosed using their saved project snapshot. */
export function generationEffectiveVisualStyle(request: Record<string, unknown>): EffectiveVisualStyle | undefined {
  const snapshot = request.project_visual_style as ProjectVisualStyle | undefined
  if (typeof request.prompt === 'string' && snapshot && typeof snapshot.version === 'string'
    && typeof snapshot.label === 'string' && ['settings', 'confirmed_context', 'unspecified'].includes(snapshot.source)
    && snapshot.details && typeof snapshot.details === 'object') return effectiveVisualStyleForPrompt(request.prompt, snapshot)
  if (isEffectiveVisualStyle(request.effective_visual_style)) return request.effective_visual_style
  if (request.prompt_document === true) return { origin: 'unknown',
    fingerprint: createHash('sha256').update(String(request.prompt || '')).digest('hex') }
  // Legacy generated templates without a snapshot keep their previous handling.
  return undefined
}

export function generationStyleNeedsReview(request: Record<string, unknown>): boolean {
  const origin = generationEffectiveVisualStyle(request)?.origin
  return origin === 'custom' || origin === 'removed' || origin === 'unknown'
}

function assetGeneration(projectId: string, assetId: string): { id: string; request: Record<string, unknown> } | undefined {
  const job = one<{ id: string; request: string }>("SELECT id, request FROM jobs WHERE project_id=? AND result_asset_id=? AND status='succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1", projectId, assetId)
  try { return job ? { id: job.id, request: JSON.parse(job.request) } : undefined } catch { return undefined }
}

/** A current baseline stamped by an old automatic approval is insufficient. */
export function assetStyleNeedsReview(projectId: string, assetId: string, styleVersion: string, profileId?: string): boolean {
  const generation = assetGeneration(projectId, assetId)
  if (!generation || !generationStyleNeedsReview(generation.request)) return false
  const reviews = generation.request.visual_style_reviews
  return !Array.isArray(reviews) || !reviews.some(review => review && typeof review === 'object'
    && review.style_version === styleVersion && (!profileId || review.profile_id === profileId))
}

/** Append a visual review without changing the immutable generation fields. */
export function recordAssetStyleReview(projectId: string, assetId: string, styleVersion: string, profileId: string): void {
  const generation = assetGeneration(projectId, assetId)
  if (!generation || !generationStyleNeedsReview(generation.request)) return
  const previous = Array.isArray(generation.request.visual_style_reviews) ? generation.request.visual_style_reviews : []
  const reviews = previous.filter(review => !(review && typeof review === 'object'
    && review.style_version === styleVersion && review.profile_id === profileId))
  reviews.push({ profile_id: profileId, style_version: styleVersion, reviewed_at: now() })
  run('UPDATE jobs SET request=? WHERE id=?', JSON.stringify({ ...generation.request, visual_style_reviews: reviews }), generation.id)
}

export function compileProjectStyle<T extends { prompt: string; prompt_document?: boolean; project_style_version?: string }>(projectId: string, input: T, preview = false) {
  const style = projectVisualStyle(projectId)
  if (!preview) assertStyleVersion(style, input.project_style_version)
  const prompt = input.prompt_document ? input.prompt : withProjectStyle(input.prompt, style)
  return { ...input, prompt, project_style_version: style.version, project_visual_style: style,
    effective_visual_style: effectiveVisualStyleForPrompt(prompt, style) }
}

/** Known old generation snapshots need review; uploads/legacy media remain explicitly unknown. */
export function referenceStyleWarnings(projectId: string, ids: string[], style: ProjectVisualStyle): string[] {
  const warnings: string[] = []
  for (const id of ids) {
    const approved = all<{ id: string }>('SELECT id FROM visual_profiles WHERE project_id=? AND board_asset_id=? AND board_style_version=?', projectId, id, style.version)
    if (approved.some(profile => !assetStyleNeedsReview(projectId, id, style.version, profile.id))) continue
    const confirmedReferences = all<{ profile_id: string }>(`SELECT r.profile_id FROM visual_profile_reference_assets r JOIN visual_profiles p ON p.id=r.profile_id
      WHERE p.project_id=? AND r.asset_id=? AND r.status='confirmed' AND r.style_version=?`, projectId, id, style.version)
    if (confirmedReferences.some(reference => !assetStyleNeedsReview(projectId, id, style.version, reference.profile_id))) continue
    const request = assetGeneration(projectId, id)?.request || {}
    // Replacing a board does not revoke a prior per-image review used by a
    // locked shot. Require both candidate ownership and that profile's audit.
    const previousOwners = generationStyleNeedsReview(request) ? all<{ profile_id: string }>(`SELECT c.profile_id FROM visual_profile_candidates c
      JOIN visual_profiles p ON p.id=c.profile_id WHERE p.project_id=? AND c.asset_id=?`, projectId, id) : []
    if (previousOwners.some(owner => !assetStyleNeedsReview(projectId, id, style.version, owner.profile_id))) continue
    const warning = styleReferenceWarning(style, request.project_style_version, ids.indexOf(id), generationEffectiveVisualStyle(request))
    if (warning) warnings.push(warning)
  }
  return warnings
}
