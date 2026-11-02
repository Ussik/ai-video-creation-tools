import { z } from 'zod'
import { all, db, one, required, run, type Project, type Shot, type TimelineClip } from '../../infrastructure/database/db.js'
import { invalid } from '../../infrastructure/http/request.js'
import { canvasRecord } from '../canvas/project-canvases.js'

export interface ProductionRange { start_shot_id: string | null; end_shot_id: string | null }
export interface FinalCutScope {
  canvasId?: string
  designId?: string | null
  shots: Shot[]
  clips: TimelineClip[]
  range: ProductionRange
}
const fullRange = (): ProductionRange => ({ start_shot_id: null, end_shot_id: null })

export function finalCutCanvasId(query: unknown): string | undefined {
  return z.object({ canvas_id: z.string().trim().min(1).max(100).optional() }).parse(query ?? {}).canvas_id
}

export function selectFinalCutShots(shots: Shot[], range: ProductionRange): Shot[] {
  if (!shots.length && range.start_shot_id === null && range.end_shot_id === null) return []
  const start = range.start_shot_id === null ? 0 : shots.findIndex(shot => shot.id === range.start_shot_id)
  const end = range.end_shot_id === null ? shots.length - 1 : shots.findIndex(shot => shot.id === range.end_shot_id)
  if (start < 0 || end < 0) invalid('制作范围引用的镜头不属于当前方案，请重新选择范围')
  if (start > end) invalid('制作范围的起始镜头不能晚于结束镜头')
  return shots.slice(start, end + 1)
}

export function resolveFinalCutScope(projectId: string, canvasId?: string): FinalCutScope {
  required<Project>('projects', projectId)
  let designId: string | null | undefined
  let shots: Shot[]
  if (canvasId === undefined) {
    shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY position, created_at, id', projectId)
  } else {
    canvasRecord(projectId, canvasId)
    designId = one<{ id: string }>('SELECT id FROM storyboard_designs WHERE project_id=? AND canvas_id=? ORDER BY created_at DESC, id DESC LIMIT 1', projectId, canvasId)?.id ?? null
    shots = designId ? all<Shot>('SELECT * FROM shots WHERE project_id=? AND design_id=? AND deleted_at IS NULL ORDER BY position, created_at, id', projectId, designId)
      : all<Shot>('SELECT * FROM shots WHERE project_id=? AND design_id IS NULL AND deleted_at IS NULL ORDER BY position, created_at, id', projectId)
  }
  const shotIds = new Set(shots.map(shot => shot.id))
  const clipsByShot = new Map(all<TimelineClip>('SELECT * FROM timeline_clips WHERE project_id=?', projectId)
    .filter(clip => shotIds.has(clip.shot_id)).map(clip => [clip.shot_id, clip]))
  const clips = shots.flatMap(shot => clipsByShot.has(shot.id) ? [clipsByShot.get(shot.id)!] : [])
  const legacyRange = one<ProductionRange>('SELECT start_shot_id, end_shot_id FROM production_ranges WHERE project_id=?', projectId) ?? fullRange()
  const storedRange = canvasId === undefined ? undefined : one<ProductionRange>(
    'SELECT start_shot_id, end_shot_id FROM canvas_production_ranges WHERE project_id=? AND canvas_id=?', projectId, canvasId)
  // Existing projects may reuse their old range only when both boundaries
  // belong to this exact plan. An explicit reset is stored as two nulls.
  const belongs = (id: string | null) => id === null || shotIds.has(id)
  const range = canvasId === undefined ? legacyRange : storedRange ??
    (belongs(legacyRange.start_shot_id) && belongs(legacyRange.end_shot_id) ? legacyRange : fullRange())
  return { ...(canvasId === undefined ? {} : { canvasId, designId }), shots, clips, range }
}

export function saveFinalCutRange(projectId: string, canvasId: string | undefined, range: ProductionRange): ProductionRange {
  const scope = resolveFinalCutScope(projectId, canvasId)
  selectFinalCutShots(scope.shots, range)
  db.transaction(() => {
    if (canvasId !== undefined) {
      run(`INSERT INTO canvas_production_ranges (canvas_id, project_id, start_shot_id, end_shot_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(canvas_id) DO UPDATE SET start_shot_id=excluded.start_shot_id, end_shot_id=excluded.end_shot_id`,
      canvasId, projectId, range.start_shot_id, range.end_shot_id)
    } else if (range.start_shot_id === null && range.end_shot_id === null) run('DELETE FROM production_ranges WHERE project_id=?', projectId)
    else run(`INSERT INTO production_ranges (project_id, start_shot_id, end_shot_id) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET start_shot_id=excluded.start_shot_id, end_shot_id=excluded.end_shot_id`,
    projectId, range.start_shot_id, range.end_shot_id)
  })()
  return range
}

export function requireFinalCutShot(projectId: string, canvasId: string | undefined, shotId: string): FinalCutScope {
  const scope = resolveFinalCutScope(projectId, canvasId)
  if (!scope.shots.some(shot => shot.id === shotId)) invalid('镜头不属于当前成片方案')
  return scope
}
