import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'
import { all, db, newId, now, one, required, run, type Asset, type CanvasNode, type Job, type Project, type Shot, type StoryboardDesign } from '../../infrastructure/database/db.js'
import { invalidateStoryboardShot } from './storyboard-invalidation.js'

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
export function assetProtection(projectId: string, asset: Asset, excludedCanvasId?: string): string[] {
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
    if (rows.some(row => containsResource(row, asset.id))) { reasons.push('项目设定、配音或成片引用'); break }
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
  const assets = all<Asset>('SELECT * FROM assets WHERE shot_id=?', shot.id)
  const cuts = all<{ document: string }>('SELECT document FROM editing_cuts WHERE project_id=?', shot.project_id)
  if (cuts.some(cut => containsResource(cut.document,shot.id) || assets.some(asset => containsResource(cut.document, asset.id)))) reasons.push('素材已用于剪辑稿')
  if (one('SELECT 1 FROM speech_placements WHERE shot_id=?',shot.id)) reasons.push('已绑定配音时间线，请先解除配音位置')
  if (all<Job>("SELECT * FROM jobs WHERE project_id=? AND job_type='export'",shot.project_id).some(job => containsResource(job.request,shot.id))) reasons.push('已被成片导出记录引用')
  return reasons
}
export function managementResourceState(projectId: string): unknown {
  const tables = ['shots','assets','script_scenes','project_canvases','canvas_nodes','canvas_edges','storyboard_designs','saved_assets','timeline_clips','editing_cuts','jobs','production_ranges','canvas_production_ranges','visual_profiles','asset_tasks','speech_lines','speech_takes','speech_placements','project_audio_settings']
  const owned = tables.flatMap(table => one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table)
    ? [[table, all(`SELECT ${table === 'project_canvases' ? 'id,project_id,name,position,is_default' : '*'} FROM ${table} WHERE project_id=? ORDER BY rowid`,projectId)]] : [])
  const references = ['visual_profile_candidates','visual_profile_reference_assets','shot_visual_bindings','asset_reviews'].flatMap(table => [[table,all(`SELECT * FROM ${table} ORDER BY rowid`)]])
  return [one('SELECT * FROM projects WHERE id=?',projectId),owned,references]
}
export function shotManagementSnapshot(projectId: string): ShotManagementSnapshot {
  required<Project>('projects', projectId)
  const designs = all<StoryboardDesign>('SELECT * FROM storyboard_designs WHERE project_id=? ORDER BY created_at,id', projectId)
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position,created_at,id', projectId)
  const assets = all<Asset>('SELECT * FROM assets WHERE project_id=? ORDER BY created_at,id', projectId)
  return { revision: resourceHash(managementResourceState(projectId)),
    shots: shots.map(shot => ({ shot, design_name: designs.find(design => design.id === shot.design_id)?.name || '默认方案',
      canvas_refs: shotCanvasRefs(projectId, shot.id), asset_count: assets.filter(asset => asset.shot_id === shot.id && !asset.deleted_at).length,
      deleted_at: shot.deleted_at || null, delete_blockers: shot.deleted_at ? [] : shotDeleteBlockers(shot) })),
    designs: designs.map(({ id, name, canvas_id }) => ({ id,name,canvas_id })),
    canvases: all('SELECT id,name FROM project_canvases WHERE project_id=? ORDER BY position,id', projectId),
    scenes: all('SELECT id,heading,episode_number,position FROM script_scenes WHERE project_id=? ORDER BY position,id', projectId),
    trashed_assets: assets.filter(asset => asset.deleted_at).map(asset => ({ id: asset.id, filename: asset.filename, kind: asset.kind, deleted_at: asset.deleted_at! })) }
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
    const input = z.object({ revision: z.string().length(64), action: z.enum(['update','move','duplicate','trash','restore','restore_asset']),
      shot_id: id.optional(), asset_id: id.optional(), patch: patchSchema.optional(), direction: z.enum(['up','down']).optional() }).strict().parse(request.body)
    return db.transaction(() => {
      const snapshot = shotManagementSnapshot(projectId)
      if (snapshot.revision !== input.revision) managementFail('分镜或引用已更新，请刷新后重试', 409)
      if (input.action === 'restore_asset') {
        const asset = one<Asset>('SELECT * FROM assets WHERE id=? AND project_id=?', input.asset_id || '', projectId)
        if (!asset?.deleted_at) managementFail('回收站素材不存在',404)
        run('UPDATE assets SET deleted_at=NULL WHERE id=?',asset.id)
      } else {
        const shot = one<Shot>('SELECT * FROM shots WHERE id=? AND project_id=?', input.shot_id || '', projectId)
        if (!shot) managementFail('分镜不存在',404)
        if (input.action === 'restore') {
          if (!shot.deleted_at) managementFail('分镜不在回收站')
          // Creation can reuse the last position while a shot is in the trash.
          // Reopen its original slot within this design without moving another
          // design's independent order or any other recycled shot.
          if (one('SELECT 1 FROM shots WHERE project_id=? AND design_id IS ? AND deleted_at IS NULL AND position=?',projectId,shot.design_id || null,shot.position)) {
            run('UPDATE shots SET position=position+1 WHERE project_id=? AND design_id IS ? AND deleted_at IS NULL AND position>=?',projectId,shot.design_id || null,shot.position)
          }
          run('UPDATE shots SET deleted_at=NULL WHERE id=?',shot.id)
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
                run('UPDATE shots SET position=? WHERE id=?',neighbor.position,shot.id)
                run('UPDATE shots SET position=? WHERE id=?',shot.position,neighbor.id)
                assertRanges(projectId)
              }
            } else {
              const copyId = newId()
              run('UPDATE shots SET position=position+1 WHERE project_id=? AND position>?',projectId,shot.position)
              run(`INSERT INTO shots (id,project_id,position,title,prompt,duration,selected_asset_id,created_at,source_scene_id,start_state,end_state,cut_note,image_prompt,video_prompt,design_id,superseded_by,storyboard_revision)
                VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,0)`,copyId,projectId,shot.position+1,`${shot.title.slice(0,116)}（副本）`,shot.prompt,shot.duration,now(),shot.source_scene_id,shot.start_state,shot.end_state,shot.cut_note,shot.image_prompt,shot.video_prompt,shot.design_id || null,shot.superseded_by || null)
              const bindingColumns = all<{ name: string }>('PRAGMA table_info(shot_visual_bindings)').map(column => column.name)
              run(`INSERT INTO shot_visual_bindings (${bindingColumns.join(',')}) SELECT ${bindingColumns.map(column => column === 'shot_id' ? '?' : column).join(',')} FROM shot_visual_bindings WHERE shot_id=?`,copyId,shot.id)
            }
          }
        }
      }
      run('UPDATE projects SET updated_at=? WHERE id=?',now(),projectId)
      return shotManagementSnapshot(projectId)
    }).immediate()
  })
}
