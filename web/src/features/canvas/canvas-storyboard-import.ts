import type { Model, ProjectDetail, ScriptCanvasResult } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { importShotGraph } from './canvas-shot-import'
import { addScriptCanvasNodes } from '../script/script-canvas-handoff'

/** Restore job snapshots before adding reference dependencies, so an existing
 * image/video job keeps its exact prompt, assets and locally edited node. */
export function importStoryboardGraph(current: CanvasGraph, result: ScriptCanvasResult, detail: ProjectDetail,
  availableModels: Model[], models: Model[], blankNode: (type: CanvasNode['type'], x: number, y: number) => CanvasNode,
  nodeSize: (node: CanvasNode) => { height: number }) {
  const restored = importShotGraph(current, result.shots, detail, availableModels, models, blankNode, nodeSize)
  if (restored.hitLimit) throw new Error('所选内容将超过画布容量，请减少分镜或先清理目标画布')
  const imported = addScriptCanvasNodes(restored.graph, result, detail.ratio,
    availableModels.find(model => model.modality === 'image'), models, detail.assets)
  const unchanged = imported.graph.nodes.length === current.nodes.length
    && imported.graph.nodes.every((node, index) => node === current.nodes[index])
    && imported.graph.edges.length === current.edges.length
    && imported.graph.edges.every((edge, index) => edge === current.edges[index])
  return { ...imported, addedShots: restored.addedShots + imported.addedShots, graph: unchanged ? current : imported.graph, restored }
}
