import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'
import { all, db, newId, now, one, required, run, type Asset, type CanvasNode, type Job, type Project, type Shot, type StoryboardDesign, type StoryboardClipPlan } from '../../infrastructure/database/db.js'
import { invalidateStoryboardShot } from './storyboard-invalidation.js'
import { markChangedShotAdjacency, markShotContinuityEdited } from './storyboard-continuity-state.js'

const id = z.string().trim().min(1).max(120)
const patchSchema = z.object({ title: z.string().trim().min(1).max(120).optional(), prompt: z.string().max(10000).optional(),
  image_prompt: z.string().max(20000).optional(), video_prompt: z.string().max(20000).optional(), duration: z.number().int().min(1).max(30).optional(),
  start_state: z.string().max(2000).optional(), end_state: z.string().max(2000).optional(), cut_note: z.string().max(2000).optional() }).strict()
export function managementFail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
export const resourceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function projectNodes(projectId: string): CanvasNode[] { return all<CanvasNode>('SELECT * FROM canvas_nodes WHERE project_id=? ORDER BY position,id', projectId) }
export function normalizedCanvasId(projectId: string, canvasId?: string | null): string | null {
  return canvasId || one<{ id: string }>('SELECT id FROM project_canvases WHERE project_id=? AND is_default=1', projectId)?.id || null
}
/** Literal ID matching is deliberately conservative for references embedded in JSON documents. */
export function containsResource(value: unknown, resourceId: string): boolean { return JSON.stringify(value).includes(resourceId) }
export function assetProtection(projectId: string, asset: Asset, excludedCanvasId?: string, deletingShotIds: ReadonlySet<string> = new Set()): string[] {
  const reasons: string[] = []
  if (asset.source !== 'generated') reasons.push('上传或导出素材')
  if (one('SELECT 1 FROM saved_assets WHERE asset_id=?', asset.id)) reasons.push('已保存素材')
  for (const node of projectNodes(projectId)) {
    if (excludedCanvasId && normalizedCanvasId(projectId, node.canvas_id) === excludedCanvasId) continue
    if (containsResource(node, asset.id) || asset.remote_url && containsResource(node,asset.remote_url)) { reasons.push('其他画布引用'); break }
    if (node.job_id && one<Job>('SELECT * FROM jobs WHERE id=?', node.job_id)?.result_asset_id === asset.id) { reasons.push('其他画布引用'); break }
  }
  const edges = all<{ canvas_id: string | null; reference_asset_id: string | null }>('SELECT canvas_id,reference_asset_id FROM canvas_edges WHERE project_id=?', projectId)
  if (edges.some(edge => edge.reference_asset_id === asset.id && (!excludedCanvasId || normalizedCanvasId(projectId, edge.canvas_id) !== excludedCanvasId))) reasons.push('其他画布参考')
  // Tables with direct or snapshot references must protect candidates even when
  // the selection belongs to a historical plan or a completed export job.
  const referenceTables = ['projects', 'shots', 'timeline_clips', 'editing_cuts', 'speech_lines', 'speech_takes', 'speech_placements',
    'visual_profiles', 'shot_visual_bindings', 'visual_profile_candidates', 'visual_profile_reference_assets', 'asset_tasks', 'asset_reviews']
  for (const table of referenceTables) {
    if (!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)) continue
    const columns = all<{ name: string }>(`PRAGMA table_info(${table})`)
    const rows = table === 'projects' ? all(`SELECT * FROM projects WHERE id=?`, projectId)
      : columns.some(column => column.name === 'project_id') ? all(`SELECT * FROM ${table} WHERE project_id=?`, projectId) : all(`SELECT * FROM ${table}`)
    if (rows.some(row => {
      // These two child records are removed by deleting their owning shot.
      // Independent profile references and other shots must still protect media.
      if ((table === 'shot_visual_bindings' || table === 'asset_reviews')
        && deletingShotIds.has((row as { shot_id: string }).shot_id)) return false
      return containsResource(row, asset.id)
    })) { reasons.push('项目设定、配音或成片引用'); break }
  }
  if (all<Job>('SELECT * FROM jobs WHERE project_id=?', projectId).some(job => containsResource(job.request, asset.id) || asset.remote_url && containsResource(job.request,asset.remote_url))) reasons.push('任务输入引用')
  return [...new Set(reasons)]
}
export function shotCanvasRefs(projectId: string, shotId: string) {
  const ids = new Set(projectNodes(projectId).filter(node => containsResource(node,shotId)).map(node => normalizedCanvasId(projectId, node.canvas_id)))
  return all<{ id: string; name: string }>('SELECT id,name FROM project_canvases WHERE project_id=? ORDER BY position,id', projectId).filter(canvas => ids.has(canvas.id))
}
export function shotDeleteBlockers(shot: Shot, excludedCanvasId?: string): string[] {
  const reasons: string[] = []
  if (excludedCanvasId) {
    const owner = one<{ canvas_id: string | null }>('SELECT d.canvas_id FROM storyboard_designs d JOIN shots s ON s.design_id=d.id WHERE s.id=? AND s.project_id=?',shot.id,shot.project_id)
    if (owner?.canvas_id && owner.canvas_id !== excludedCanvasId) reasons.push('属于其他画布的分镜方案')
  }
  if (shotCanvasRefs(shot.project_id, shot.id).some(canvas => canvas.id !== excludedCanvasId)) reasons.push('仍在画布中使用，请先移除对应节点')
  if (shot.selected_asset_id || one('SELECT 1 FROM timeline_clips WHERE shot_id=?', shot.id)) reasons.push('已选入成片，请先取消选片')
  if (one('SELECT 1 FROM production_ranges WHERE project_id=? AND (start_shot_id=? OR end_shot_id=?)', shot.project_id, shot.id, shot.id)
    || all<{ canvas_id: string }>('SELECT canvas_id FROM canvas_production_ranges WHERE project_id=? AND (start_shot_id=? OR end_shot_id=?)', shot.project_id, shot.id, shot.id).some(row => row.canvas_id !== excludedCanvasId)) reasons.push('制作范围边界，请先调整制作范围')
  if (one("SELECT 1 FROM jobs WHERE shot_id=? AND status IN ('queued','running')", shot.id)) reasons.push('仍有进行中的生成任务')
  const cuts = all<{ document: string }>('SELECT document FROM editing_cuts WHERE project_id=?', shot.project_id)
  // Cuts reference media independently. Recycling or purging a shot keeps its
  // assets available; assetProtection still guards those media references.
  if (cuts.some(cut => containsResource(cut.document,shot.id))) reasons.push('镜头已用于剪辑稿')
  if (one('SELECT 1 FROM speech_placements WHERE shot_id=?',shot.id)) reasons.push('已绑定配音时间线，请先解除配音位置')
  if (all<Job>("SELECT * FROM jobs WHERE project_id=? AND job_type='export'",shot.project_id).some(job => containsResource(job.request,shot.id))) reasons.push('已被成片导出记录引用')
  return reasons
}
function assertShotsRecyclable(shots: Shot[]): void {
  const blocked = shots.flatMap(shot => {
    const reasons = shotDeleteBlockers(shot)
    return reasons.length ? [`${shot.title}：${reasons.join('、')}`] : []
  })
  if (blocked.length) managementFail(`以下镜头仍被引用，未执行任何回收：${blocked.join('；')}`)
}
function historyRows(table: string, projectId: string): Record<string, unknown>[] {
  return one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
    ? all(`SELECT * FROM ${table} WHERE project_id=? ORDER BY rowid`, projectId) : []
}
function purgeHistoryBlockers(projectId: string, resourceId: string): string[] {
  const references = [['video_comparisons', '已被视频对照记录引用'], ['video_reviews', '已被视频复核记录引用'],
    ['cut_reviews', '已被接镜复核记录引用']] as const
  return references.flatMap(([table, reason]) =>
    historyRows(table, projectId).some(row => containsResource(row, resourceId)) ? [reason] : [])
}
function shotPurgeBlockers(shot: Shot): string[] {
  return [...new Set([...shotDeleteBlockers(shot), ...purgeHistoryBlockers(shot.project_id, shot.id)])]
}
function assetPurgeBlockers(asset: Asset, deletingShotIds: ReadonlySet<string> = new Set()): string[] {
  // Explicit deletion of an already recycled upload is allowed. References are
  // protected independently of how the media originally entered the project.
  const reasons = assetProtection(asset.project_id, asset, undefined, deletingShotIds).filter(reason => reason !== '上传或导出素材')
  reasons.push(...purgeHistoryBlockers(asset.project_id, asset.id))
  if (one("SELECT 1 FROM jobs WHERE result_asset_id=? AND status IN ('queued','running')", asset.id)) reasons.push('仍有进行中的生成任务')
  if (one('SELECT 1 FROM jobs WHERE result_asset_id=? AND project_id<>?', asset.id, asset.project_id)) reasons.push('已被其他项目的任务输出引用')
  const comparisons = historyRows('video_comparisons', asset.project_id)
  if (comparisons.some(row => [row.baseline_job_id, row.candidate_job_id].some(jobId => typeof jobId === 'string'
    && one<Job>('SELECT * FROM jobs WHERE id=?', jobId)?.result_asset_id === asset.id))) reasons.push('已被视频对照结果引用')
  return [...new Set(reasons)]
}
function resourcePurgeBlockers(shots: Shot[], assets: Asset[]): string[] {
  const deletingShotIds = new Set(shots.map(shot => shot.id))
  return [
    ...shots.flatMap(shot => { const reasons = shotPurgeBlockers(shot); return reasons.length ? [`${shot.title}：${reasons.join('、')}`] : [] }),
    ...assets.flatMap(asset => { const reasons = assetPurgeBlockers(asset, deletingShotIds); return reasons.length ? [`${asset.filename}：${reasons.join('、')}`] : [] }),
  ]
}
function purgeRecycledResources(projectId: string, shots: Shot[], assets: Asset[]): void {
  if (shots.some(shot => !shot.deleted_at) || assets.some(asset => !asset.deleted_at)) managementFail('只能彻底删除回收站中的记录', 409)
  const blocked = resourcePurgeBlockers(shots, assets)
  if (blocked.length) managementFail(`以下记录仍被引用，未执行任何彻底删除：${blocked.join('；')}`)
  // Keep media files, related assets, plans and job history. SQLite detaches
  // asset/job shot references; job output IDs have no foreign key to assets.
  for (const shot of shots) run('DELETE FROM shots WHERE id=? AND project_id=?', shot.id, projectId)
  for (const asset of assets) {
    run('UPDATE jobs SET result_asset_id=NULL WHERE result_asset_id=? AND project_id=?', asset.id, projectId)
    run('DELETE FROM assets WHERE id=? AND project_id=?', asset.id, projectId)
  }
}
function restoreShot(shot: Shot): void {
  if (one('SELECT 1 FROM shots WHERE project_id=? AND design_id IS ? AND deleted_at IS NULL AND position=?',
    shot.project_id, shot.design_id || null, shot.position)) {
    run('UPDATE shots SET position=position+1 WHERE project_id=? AND design_id IS ? AND deleted_at IS NULL AND position>=?',
      shot.project_id, shot.design_id || null, shot.position)
  }
  run('UPDATE shots SET deleted_at=NULL WHERE id=?', shot.id)
}
export function managementResourceState(projectId: string): unknown {
  const tables = ['shots','assets','script_scenes','project_canvases','canvas_nodes','canvas_edges','storyboard_designs','storyboard_clip_plans','saved_assets','timeline_clips','editing_cuts','jobs','production_ranges','canvas_production_ranges','visual_profiles','asset_tasks','speech_lines','speech_takes','speech_placements','project_audio_settings','video_comparisons','video_reviews','cut_reviews']
  const owned = tables.flatMap(table => one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table)
    ? [[table, all(`SELECT ${table === 'project_canvases' ? 'id,project_id,name,position,is_default' : '*'} FROM ${table} WHERE project_id=? ORDER BY rowid`,projectId)]] : [])
  const references = ['visual_profile_candidates','visual_profile_reference_assets','shot_visual_bindings','asset_reviews'].flatMap(table => [[table,all(`SELECT * FROM ${table} ORDER BY rowid`)]])
  const foreignOutputs = all(`SELECT * FROM jobs WHERE project_id<>? AND result_asset_id IN (SELECT id FROM assets WHERE project_id=?) ORDER BY rowid`, projectId, projectId)
  return [one('SELECT * FROM projects WHERE id=?',projectId),owned,references,foreignOutputs]
}
export function shotManagementSnapshot(projectId: string): ShotManagementSnapshot {
  required<Project>('projects', projectId)
  const designs = all<StoryboardDesign>('SELECT * FROM storyboard_designs WHERE project_id=? ORDER BY created_at,id', projectId)
  const clips = new Map(all<StoryboardClipPlan>('SELECT * FROM storyboard_clip_plans WHERE project_id=?', projectId).map(clip => [clip.design_id, clip]))
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position,created_at,id', projectId)
  const assets = all<Asset>('SELECT * FROM assets WHERE project_id=? ORDER BY created_at,id', projectId)
  return { revision: resourceHash(managementResourceState(projectId)),
    shots: shots.map(shot => ({ shot, design_name: designs.find(design => design.id === shot.design_id)?.name || '默认方案',
      canvas_refs: shotCanvasRefs(projectId, shot.id), asset_count: assets.filter(asset => asset.shot_id === shot.id && !asset.deleted_at).length,
      deleted_at: shot.deleted_at || null, delete_blockers: shot.deleted_at ? [] : shotDeleteBlockers(shot),
      ...(shot.deleted_at ? { purge_blockers: shotPurgeBlockers(shot) } : {}) })),
    designs: designs.map(({ id, name, canvas_id, canvas_pending }) => ({ id,name,canvas_id,canvas_pending: !!canvas_pending,
      ...(clips.has(id) ? { source_type: 'clip' as const, source_text: clips.get(id)!.source_text, total_duration: clips.get(id)!.total_duration } : {}) })),
    canvases: all('SELECT id,name FROM project_canvases WHERE project_id=? ORDER BY position,id', projectId),
    scenes: all('SELECT id,heading,episode_number,position FROM script_scenes WHERE project_id=? ORDER BY position,id', projectId),
    trashed_assets: assets.filter(asset => asset.deleted_at).map(asset => ({ id: asset.id, filename: asset.filename, kind: asset.kind,
      deleted_at: asset.deleted_at!, purge_blockers: assetPurgeBlockers(asset) })),
    empty_trash_blockers: resourcePurgeBlockers(shots.filter(shot => !!shot.deleted_at), assets.filter(asset => !!asset.deleted_at)) }
}
function assertRanges(projectId: string): void {
  const ranges = [...all<{ start_shot_id: string | null; end_shot_id: string | null }>('SELECT * FROM production_ranges WHERE project_id=?', projectId),
    ...all<{ start_shot_id: string | null; end_shot_id: string | null }>('SELECT * FROM canvas_production_ranges WHERE project_id=?', projectId)]
  for (const range of ranges) {
    if (!range.start_shot_id || !range.end_shot_id) continue
    const first = one<Shot>('SELECT * FROM shots WHERE id=?', range.start_shot_id), last = one<Shot>('SELECT * FROM shots WHERE id=?', range.end_shot_id)
    if (first && last && first.position > last.position) managementFail('排序会颠倒已有制作范围，请先调整制作范围')
  }
}
export function registerShotManagementRoutes(app: FastifyInstance): void {
  const base = '/api/projects/:id/shot-management'
  app.get(base, async request => {
    const projectId = z.object({ id }).parse(request.params).id
    return db.transaction(() => shotManagementSnapshot(projectId))()
  })
  app.post(`${base}/actions`, async request => {
    const projectId = z.object({ id }).parse(request.params).id
    const input = z.object({ revision: z.string().length(64), action: z.enum(['update','move','duplicate','trash','restore','restore_asset','trash_many','trash_design','restore_design','purge','purge_many','purge_asset','empty_trash']),
      shot_id: id.optional(), shot_ids: z.array(id).min(1).max(500).refine(values => new Set(values).size === values.length, '镜头不能重复').optional(),
      design_id: id.nullable().optional(), asset_id: id.optional(), patch: patchSchema.optional(), direction: z.enum(['up','down']).optional() }).strict().parse(request.body)
    return db.transaction(() => {
      const snapshot = shotManagementSnapshot(projectId)
      if (snapshot.revision !== input.revision) managementFail('分镜或引用已更新，请刷新后重试', 409)
      if (input.action === 'empty_trash') {
        purgeRecycledResources(projectId,
          all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NOT NULL ORDER BY position,created_at,id', projectId),
          all<Asset>('SELECT * FROM assets WHERE project_id=? AND deleted_at IS NOT NULL ORDER BY created_at,id', projectId))
      } else if (input.action === 'purge' || input.action === 'purge_many') {
        const ids = input.action === 'purge' ? input.shot_id ? [input.shot_id] : undefined : input.shot_ids
        if (!ids?.length) managementFail('请选择要彻底删除的镜头')
        const shots = all<Shot>(`SELECT * FROM shots WHERE project_id=? AND id IN (${ids.map(() => '?').join(',')})`, projectId, ...ids)
        if (shots.length !== ids.length) managementFail('部分镜头不存在或不属于当前项目', 404)
        purgeRecycledResources(projectId, shots, [])
      } else if (input.action === 'purge_asset') {
        const asset = one<Asset>('SELECT * FROM assets WHERE id=? AND project_id=?', input.asset_id || '', projectId)
        if (!asset) managementFail('素材不存在或不属于当前项目', 404)
        purgeRecycledResources(projectId, [], [asset])
      } else if (input.action === 'restore_asset') {
        const asset = one<Asset>('SELECT * FROM assets WHERE id=? AND project_id=?', input.asset_id || '', projectId)
        if (!asset?.deleted_at) managementFail('回收站素材不存在',404)
        run('UPDATE assets SET deleted_at=NULL WHERE id=?',asset.id)
      } else if (input.action === 'trash_many') {
        if (!input.shot_ids) managementFail('请选择要回收的镜头')
        const shots = all<Shot>(`SELECT * FROM shots WHERE project_id=? AND id IN (${input.shot_ids.map(() => '?').join(',')})`, projectId, ...input.shot_ids)
        if (shots.length !== input.shot_ids.length) managementFail('部分镜头不存在或不属于当前项目', 404)
        if (shots.some(shot => shot.deleted_at)) managementFail('部分镜头已在回收站，请刷新后重试', 409)
        assertShotsRecyclable(shots)
        const deletedAt = now()
        for (const shot of shots) run('UPDATE shots SET deleted_at=? WHERE id=?', deletedAt, shot.id)
      } else if (input.action === 'trash_design' || input.action === 'restore_design') {
        if (input.design_id === undefined) managementFail('请选择分镜方案')
        if (input.design_id && !one('SELECT 1 FROM storyboard_designs WHERE id=? AND project_id=?', input.design_id, projectId)) {
          managementFail('分镜方案不存在或不属于当前项目', 404)
        }
        const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND design_id IS ? ORDER BY position,created_at,id',
          projectId, input.design_id)
        if (input.action === 'trash_design') {
          const active = shots.filter(shot => !shot.deleted_at)
          if (!active.length) managementFail('该方案没有可回收的活动镜头')
          assertShotsRecyclable(active)
          const deletedAt = now()
          for (const shot of active) run('UPDATE shots SET deleted_at=? WHERE id=?', deletedAt, shot.id)
        } else {
          const recycled = shots.filter(shot => !!shot.deleted_at)
          if (!recycled.length) managementFail('回收站中没有该方案的镜头')
          for (const shot of recycled) restoreShot(shot)
        }
      } else {
        const shot = one<Shot>('SELECT * FROM shots WHERE id=? AND project_id=?', input.shot_id || '', projectId)
        if (!shot) managementFail('分镜不存在',404)
        if (input.action === 'restore') {
          if (!shot.deleted_at) managementFail('分镜不在回收站')
          // Creation can reuse the last position while a shot is in the trash.
          // Reopen its original slot within this design without moving another
          // design's independent order or any other recycled shot.
          restoreShot(shot)
        } else {
          if (shot.deleted_at) managementFail('分镜已在回收站，请先恢复',409)
          if (input.action === 'trash') {
            const blockers = shotDeleteBlockers(shot)
            if (blockers.length) managementFail(blockers.join('；'))
            run('UPDATE shots SET deleted_at=? WHERE id=?',now(),shot.id)
          } else if (input.action === 'update') {
            if (!input.patch || !Object.keys(input.patch).length) managementFail('请填写要修改的分镜内容')
            const changed = Object.entries(input.patch).filter(([key,value]) => shot[key as keyof Shot] !== value)
            for (const [key,value] of changed) run(`UPDATE shots SET ${key}=? WHERE id=?`,value,shot.id)
            markShotContinuityEdited(shot, changed.map(([key]) => key))
            // Keep accepted sound as the review baseline when editing visuals.
            const generationFields = new Set(['prompt','image_prompt','video_prompt','duration','start_state','end_state'])
            if (changed.some(([key]) => generationFields.has(key))) invalidateStoryboardShot(required<Shot>('shots',shot.id),(shot.storyboard_revision || 0)+1)
            else if (changed.some(([key]) => key === 'title')) {
              run('UPDATE canvas_nodes SET title=? WHERE project_id=? AND shot_id=? AND title=?',input.patch.title!,projectId,shot.id,shot.title)
            }
          } else {
            const peers = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL AND design_id IS ? AND source_scene_id IS ? ORDER BY position,created_at,id',projectId,shot.design_id || null,shot.source_scene_id)
            const index = peers.findIndex(peer => peer.id === shot.id)
            if (input.action === 'move') {
              if (!input.direction) managementFail('请选择移动方向')
              const neighbor = peers[index+(input.direction === 'up' ? -1 : 1)]
              if (neighbor) {
                const beforeOrder = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL', projectId)
                run('UPDATE shots SET position=? WHERE id=?',neighbor.position,shot.id)
                run('UPDATE shots SET position=? WHERE id=?',shot.position,neighbor.id)
                assertRanges(projectId)
                markChangedShotAdjacency(beforeOrder, all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL', projectId))
              }
            } else {
              const beforeOrder = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL', projectId)
              const copyId = newId()
              run('UPDATE shots SET position=position+1 WHERE project_id=? AND position>?',projectId,shot.position)
              run(`INSERT INTO shots (id,project_id,position,title,prompt,duration,selected_asset_id,created_at,source_scene_id,start_state,end_state,cut_note,image_prompt,video_prompt,design_id,superseded_by,storyboard_revision,audio_plan)
                VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,0,?)`,copyId,projectId,shot.position+1,`${shot.title.slice(0,116)}（副本）`,shot.prompt,shot.duration,now(),shot.source_scene_id,shot.start_state,shot.end_state,shot.cut_note,shot.image_prompt,shot.video_prompt,shot.design_id || null,shot.superseded_by || null,shot.audio_plan ? JSON.stringify(shot.audio_plan) : null)
              const bindingColumns = all<{ name: string }>('PRAGMA table_info(shot_visual_bindings)').map(column => column.name)
              run(`INSERT INTO shot_visual_bindings (${bindingColumns.join(',')}) SELECT ${bindingColumns.map(column => column === 'shot_id' ? '?' : column).join(',')} FROM shot_visual_bindings WHERE shot_id=?`,copyId,shot.id)
              markChangedShotAdjacency(beforeOrder, all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL', projectId))
            }
          }
        }
      }
      run('UPDATE projects SET updated_at=? WHERE id=?',now(),projectId)
      return shotManagementSnapshot(projectId)
    }).immediate()
  })
}
