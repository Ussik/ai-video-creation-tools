import { createHash } from 'node:crypto'
import { all, one } from './db.js'
import type { ProjectVisualStyle, VisualStyleDetails } from './visual-style.js'
import { withProjectStyle, styleReferenceWarning } from './visual-style.js'

export function projectVisualStyle(projectId: string): ProjectVisualStyle {
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
  const decisions = !label ? all<{ topic: string; content: string }>('SELECT topic, content FROM script_story_decisions WHERE project_id=? ORDER BY updated_at DESC, id LIMIT 30', projectId) : []
  const genre = typeof settings.genre === 'string' ? settings.genre.trim() : ''
  const context = !label && (genre || decisions.length) ? JSON.stringify({ genre,
    decisions: decisions.map(item => ({ topic: item.topic, content: item.content.slice(0, 600) })) }) : ''
  const source = label ? 'settings' as const : context ? 'confirmed_context' as const : 'unspecified' as const
  const version = createHash('sha256').update(JSON.stringify([source, label, details, context])).digest('hex')
  return { version, label: label || (context ? '沿用已确认的画风描述' : '未指定画风'), source, details,
    ...(context ? { confirmed_context: context } : {}) }
}
export function assertStyleVersion(style: ProjectVisualStyle, expected?: string) {
  if (expected && expected !== style.version) throw Object.assign(new Error('项目画风已更新，请重新检查生成信息后再生成'), { statusCode: 409 })
}
export function compileProjectStyle<T extends { prompt: string; project_style_version?: string }>(projectId: string, input: T, preview = false) {
  const style = projectVisualStyle(projectId)
  if (!preview) assertStyleVersion(style, input.project_style_version)
  return { ...input, prompt: withProjectStyle(input.prompt, style), project_style_version: style.version, project_visual_style: style }
}

/** Known old generation snapshots need review; uploads/legacy media remain explicitly unknown. */
export function referenceStyleWarnings(projectId: string, ids: string[], style: ProjectVisualStyle): string[] {
  if (style.source === 'unspecified') return []
  const warnings: string[] = []
  for (const id of ids) {
    const approved = one<{ board_style_version: string | null }>('SELECT board_style_version FROM visual_profiles WHERE project_id=? AND board_asset_id=? AND board_style_version=? LIMIT 1', projectId, id, style.version)
    if (approved) continue
    const confirmedReference = one(`SELECT 1 FROM visual_profile_reference_assets r JOIN visual_profiles p ON p.id=r.profile_id
      WHERE p.project_id=? AND r.asset_id=? AND r.status='confirmed' AND r.style_version=? LIMIT 1`, projectId, id, style.version)
    if (confirmedReference) continue
    const job = one<{ request: string }>("SELECT request FROM jobs WHERE project_id=? AND result_asset_id=? AND status='succeeded' ORDER BY created_at DESC LIMIT 1", projectId, id)
    let version: string | undefined
    try { version = job && JSON.parse(job.request).project_style_version } catch { /* Legacy requests have no snapshot. */ }
    const warning = styleReferenceWarning(style, version, ids.indexOf(id))
    if (warning) warnings.push(warning)
  }
  return warnings
}
