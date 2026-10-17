import type { Asset, Model, ProjectDetail, ScriptCanvasResult } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from '../canvas/ProjectCanvas'
import { missingVisualReferences, syncVisualProfileNode } from '../canvas/canvas-visual-profiles'
import { imageGenerationDefaults } from '../canvas/canvas-model-parameters'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { placeNewCanvasNodes } from '../canvas/canvas-node-placement'

type Request = { id: string; project_id: string; ratio: string; result: ScriptCanvasResult }
export const scriptCanvasRequestKey = (projectId: string) => `script-canvas-open:${projectId}`

export function requestScriptCanvas(projectId: string, ratio: string, result: ScriptCanvasResult) {
  const request: Request = { id: crypto.randomUUID(), project_id: projectId, ratio, result }
  window.sessionStorage.setItem(scriptCanvasRequestKey(projectId), JSON.stringify(request))
  window.dispatchEvent(new Event('script-canvas-open'))
}

export function readScriptCanvasRequest(projectId: string): Request | null {
  const saved = window.sessionStorage.getItem(scriptCanvasRequestKey(projectId))
  if (!saved) return null
  const request = JSON.parse(saved) as Request
  if (request.project_id !== projectId || !request.id || !request.result ||
    !Array.isArray(request.result.shots) || !Array.isArray(request.result.visual_profiles) || !Array.isArray(request.result.shot_visual_bindings)) {
    throw new Error('加入画布的数据不完整，请从剧本对话重新操作')
  }
  return request
}

export function addScriptCanvasNodes(graph: CanvasGraph, result: ScriptCanvasResult, ratio: string, imageModel?: Model,
  models: Pick<Model, 'id' | 'modality'>[] = [], assets: Pick<Asset, 'id' | 'kind'>[] = []) {
  const nodes = [...graph.nodes]
  const imageAssetIds = new Set(assets.filter(asset => asset.kind === 'image').map(asset => asset.id))
  const profileNodeIds: string[] = [], shotNodeIds: string[] = []
  let addedProfiles = 0, addedShots = 0, addedReferences = 0
  const modality = (node: CanvasNode) => models.find(model => model.id === node.model_id)?.modality || node.settings.modality
  for (const [index, node] of nodes.entries()) {
    if (node.type !== 'generation' || node.settings.visual_profile_id || !result.updated_shot_ids?.includes(node.shot_id || '')) continue
    const shot = result.shots.find(shot => shot.id === node.shot_id)
    const nodeModality = modality(node) || (!node.model_id ? 'image' : undefined)
    if (!shot || !['image', 'video'].includes(String(nodeModality))) continue
    const { prompt_is_final, prompt_base, prompt_template, prompt_override, ...settings } = node.settings
    nodes[index] = { ...node, title: shot.title, prompt: nodeModality === 'video' ? shotVideoPrompt(shot) : shotImagePrompt(shot),
      settings: { ...settings, modality: nodeModality === 'video' ? 'video' : 'image', duration: shot.duration } }
  }
  const baseY = nodes.length ? Math.max(...nodes.map(node => node.y + node.height)) + 100 : 80
  function blank(x: number, y: number): CanvasNode {
    return { id: crypto.randomUUID(), type: 'generation', x, y, width: 440, height: 420, title: '', text: '',
      asset_id: null, shot_id: null, model_id: imageModel?.id || null, job_id: null, prompt: '',
      settings: blankSettings(imageModel, ratio) }
  }
  for (const [index, profile] of result.visual_profiles.entries()) {
    if (result.shot_visual_bindings.some(binding => binding.profile_id === profile.id)
      && !result.shot_visual_bindings.some(binding => binding.profile_id === profile.id && binding.usage !== 'none')) continue
    let node = nodes.find(item => item.settings.visual_profile_id === profile.id)
    if (!node) {
      node = { ...blank(80, baseY + index * 490), title: `${profile.name} · ${profile.variant}`, asset_id: profile.board_asset_id,
        settings: { modality: 'image', ...imageGenerationDefaults(imageModel), visual_profile_id: profile.id, visual_profile_revision: profile.revision } }
      nodes.push(node); addedProfiles++
    } else if (node.settings.visual_profile_revision !== profile.revision) {
      node = syncVisualProfileNode(node, profile, { asset_tasks: [] })
      nodes[nodes.findIndex(item => item.id === node!.id)] = node
    }
    profileNodeIds.push(node.id)
  }
  // A completed shot may use an older approved board than today's profile.
  // Keep its exact image snapshot visible instead of substituting a newer board.
  for (const binding of result.shot_visual_bindings) {
    if (binding.usage === 'none') continue
    // Independent views are managed by their profile and resolved from the
    // shot snapshot; importing them must not add an unused old board node.
    if (binding.reference_assets?.length) continue
    const assetId = binding.board_asset_id
    if (!assetId || result.visual_profiles.some(profile => profile.id === binding.profile_id && profile.board_asset_id === assetId)) continue
    let node = nodes.find(item => item.asset_id === assetId && !item.settings.visual_profile_id
      && (item.type === 'image' || item.type === 'generation' && modality(item) === 'image'))
    if (!node) {
      node = { ...blank(80, baseY + (result.visual_profiles.length + addedReferences) * 490), type: 'image',
        title: `${binding.name} · ${binding.variant}（分镜引用）`, asset_id: assetId, model_id: null, settings: {} }
      nodes.push(node); addedReferences++
    }
    profileNodeIds.push(node.id)
  }
  for (const [index, shot] of result.shots.entries()) {
    let node = nodes.find(item => item.type === 'generation' && item.shot_id === shot.id && !item.settings.visual_profile_id
      && (modality(item) === 'image' || !modality(item) && (!item.model_id || item.model_id === imageModel?.id)))
    if (!node) {
      node = { ...blank(740, baseY + index * 490), title: shot.title, shot_id: shot.id, prompt: shotImagePrompt(shot),
        asset_id: shot.selected_asset_id && imageAssetIds.has(shot.selected_asset_id) ? shot.selected_asset_id : null,
        settings: { ...blankSettings(imageModel, ratio), duration: shot.duration, visual_dependencies: true,
          group_id: shot.id, group_title: `镜头 ${String(shot.position + 1).padStart(2, '0')} · ${shot.title}` } }
      nodes.push(node); addedShots++
    } else if (!node.settings.visual_dependencies) {
      node = { ...node, settings: { ...node.settings, visual_dependencies: true } }
      nodes[nodes.findIndex(item => item.id === node!.id)] = node
    }
    shotNodeIds.push(node.id)
  }
  if (nodes.length > 500) throw new Error('画布节点将超过 500 个。设定与分镜已准备好，请清理节点后点击重试加入画布')
  return { graph: { ...graph, nodes: placeNewCanvasNodes(graph.nodes, nodes) }, addedProfiles, addedShots, addedReferences, profileNodeIds: [...new Set(profileNodeIds)], shotNodeIds }
}

/** Guide an imported storyboard to its required references before its first frame.
 * Read each shot's own approved snapshot; today's profile or an unconfirmed
 * candidate must not make an empty or outdated shot binding appear ready.
 */
export function scriptCanvasInitialFocus(imported: ReturnType<typeof addScriptCanvasNodes>, result: ScriptCanvasResult,
  detail: ProjectDetail, models: Pick<Model, 'id' | 'modality'>[] = []) {
  const profileIds = new Set(result.visual_profiles.map(profile => profile.id))
  const shotIds = new Set(result.shots.map(shot => shot.id))
  const currentDetail: ProjectDetail = { ...detail,
    visual_profiles: [...(detail.visual_profiles || []).filter(profile => !profileIds.has(profile.id)), ...result.visual_profiles],
    shot_visual_bindings: [...(detail.shot_visual_bindings || []).filter(binding => !shotIds.has(binding.shot_id)), ...result.shot_visual_bindings],
  }
  const missing = new Map<string, ReturnType<typeof missingVisualReferences>[number]>()
  for (const nodeId of imported.shotNodeIds) {
    for (const reference of missingVisualReferences(imported.graph, nodeId, currentDetail, models)) {
      if (!missing.has(reference.profileId) || reference.action === 'bindings') missing.set(reference.profileId, reference)
    }
  }
  const references = [...missing.values()]
  return {
    targetNodeId: references.find(reference => reference.nodeId)?.nodeId || imported.shotNodeIds[0] || imported.profileNodeIds[0] || null,
    missingReferenceCount: references.length,
    bindingUpdateCount: references.filter(reference => reference.action === 'bindings').length,
  }
}

function blankSettings(model: Model | undefined, ratio: string): CanvasNode['settings'] {
  return { modality: 'image', ...imageGenerationDefaults(model), ratio }
}
