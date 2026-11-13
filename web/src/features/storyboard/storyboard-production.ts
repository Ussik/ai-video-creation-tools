import type { ProjectDetail } from '../../shared/api/api'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'

type ProductionDesignSnapshot = Pick<ShotManagementSnapshot, 'designs' | 'shots' | 'canvases'>

/** Current shots are accepted directly. A previous saved plan can start
 * or continue production only after fresh metadata verifies its pending design
 * or its canvas still exists in this project's management snapshot. */
export function assertStoryboardProductionScope(detail: ProjectDetail, projectId: string, sceneIds: string[], shotIds: string[], designId: string | null, productionSnapshot?: ProductionDesignSnapshot): void {
  if (detail.id !== projectId || !sceneIds.length || !shotIds.length || new Set(sceneIds).size !== sceneIds.length || new Set(shotIds).size !== shotIds.length) {
    throw new Error('分镜选择已更新，请返回分镜管理重新选择。')
  }
  if (sceneIds.some(sceneId => !detail.script.scenes.some(scene => scene.id === sceneId))) {
    throw new Error('所选场次已更新，请返回分镜管理重新选择。')
  }
  const containsHistorical = shotIds.some(shotId => !detail.shots.some(shot => shot.id === shotId && !shot.superseded_by))
  const selected = shotIds.map(shotId => detail.shots.find(shot => shot.id === shotId)
    || detail.historical_shots?.find(shot => shot.id === shotId))
  let verifiedHistoricalDesign = false
  if (containsHistorical && designId && productionSnapshot) {
    const design = productionSnapshot.designs.find(item => item.id === designId)
    const hasCanvas = !!design?.canvas_id && productionSnapshot.canvases.some(canvas => canvas.id === design.canvas_id)
    verifiedHistoricalDesign = !!design && (design.canvas_pending === true || hasCanvas) && shotIds.every((shotId, index) => {
      const entry = productionSnapshot.shots.find(item => item.shot.id === shotId), shot = selected[index]
      return !!entry && !entry.deleted_at && !entry.shot.deleted_at && entry.shot.project_id === projectId
        && entry.shot.design_id === designId && sceneIds.includes(entry.shot.source_scene_id || '')
        && !!shot && shot.project_id === projectId && shot.design_id === entry.shot.design_id && shot.source_scene_id === entry.shot.source_scene_id
    })
  }
  if (containsHistorical && !verifiedHistoricalDesign) {
    throw new Error('所选历史方案尚未通过制作校验，请刷新分镜管理后重新选择；仅未加入画布或仍有关联画布的已保存方案可在此准备制作。')
  }
  if (selected.some(shot => !shot || shot.deleted_at || shot.superseded_by && !verifiedHistoricalDesign || (shot.design_id || null) !== designId || !sceneIds.includes(shot.source_scene_id || ''))
    || sceneIds.some(sceneId => !selected.some(shot => shot?.source_scene_id === sceneId))) {
    throw new Error('所选镜头已不属于当前有效方案，请刷新分镜管理后重新选择；历史方案可在原画布继续制作。')
  }
}
