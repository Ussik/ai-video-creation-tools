import type { Asset, ProjectDetail } from '../../shared/api/api'

/** Candidates belong to a shot, so earlier runs and other canvases share its history. */
export function shotImageCandidates(shotId: string | null | undefined, detail: Pick<ProjectDetail, 'id' | 'assets' | 'jobs'>): Asset[] {
  if (!shotId) return []
  const ids = new Set<string>()
  for (const job of detail.jobs) {
    if (job.project_id !== detail.id || job.shot_id !== shotId || job.job_type !== 'generation'
      || job.status !== 'succeeded' || !job.result_asset_id) continue
    try {
      const request: unknown = JSON.parse(job.request)
      if (!request || typeof request !== 'object' || Array.isArray(request)) continue
      const metadata = request as Record<string, unknown>
      // Setting boards and independent profile references have their own candidate manager.
      if (metadata.visual_profile_id || metadata.asset_task_id || metadata.visual_reference_generation === true
        || metadata.visual_reference_view || ['character', 'location', 'prop'].includes(String(metadata.source_artifact_type ?? ''))) continue
      ids.add(job.result_asset_id)
    } catch { /* Malformed legacy task metadata cannot establish candidate provenance. */ }
  }
  return detail.assets.filter(asset => ids.has(asset.id) && asset.project_id === detail.id && asset.shot_id === shotId
    && asset.kind === 'image' && asset.source === 'generated')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}
