export const canvasNodeProposalEditableParameters = ['ratio', 'resolution', 'duration', 'generate_audio'] as const
export type CanvasNodeProposalParameter = typeof canvasNodeProposalEditableParameters[number]
export type CanvasNodeProposalMode = 'text' | 'reference' | 'first_frame' | 'first_last_frame' | 'edit' | 'extend'
export type CanvasNodeProposalParameters = {
  ratio: string; resolution: string | null; duration: number; generate_audio: boolean
  draft: boolean; clarity: string | null; quality: string | null; background: string | null; candidate_count: number
}
export type CanvasNodeProposalParameterPatch = Partial<Pick<CanvasNodeProposalParameters, CanvasNodeProposalParameter>>
/** Captured from the validated generation preview, independently of editable director text. */
export type CanvasNodeProposalSource = {
  project_id: string; project_updated_at: string; project_style_version: string | null
  canvas_id: string; canvas_revision: string; source_node_id: string; source_fingerprint: string
  model_id: string; modality: 'image' | 'video'; mode: CanvasNodeProposalMode; prompt: string
  parameters: CanvasNodeProposalParameters
  reference_assets: Array<{ asset_id: string; usage: string | null }>
  reference_video_asset_id: string | null; shot_id: string | null; storyboard_revision: number | null
  storyboard_reference_asset_id: string | null
}
export type CanvasNodeProposalValue = { prompt: string; parameters: CanvasNodeProposalParameters }
export type CanvasNodeProposal = {
  id: string; created_node_id: string; source: CanvasNodeProposalSource; validation_fingerprint: string
  before: CanvasNodeProposalValue; after: CanvasNodeProposalValue; changes: string[]
}
export type CanvasNodeProposalRequest = { text_model_id: string; instructions: string; source: CanvasNodeProposalSource }
export type CanvasNodeProposalValidationRequest = Pick<CanvasNodeProposal, 'source' | 'validation_fingerprint'>
export type CanvasNodeProposalGraph = { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }>; revision: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
}
export function canvasNodeProposalSourceKey(value: unknown): string { return JSON.stringify(canonical(value)) }

/** Includes the persisted source, incoming edge order and complete incoming nodes. */
export async function canvasNodeProposalFingerprint(graph: CanvasNodeProposalGraph, nodeId: string): Promise<string> {
  const node = graph.nodes.find(value => value.id === nodeId)
  if (!node) throw new Error('来源节点已不存在，请重新读取节点')
  const edges = graph.edges.filter(edge => edge.target === nodeId)
  const incoming = edges.map(edge => graph.nodes.find(value => value.id === edge.source) || null)
  const data = new TextEncoder().encode(canvasNodeProposalSourceKey({ node, edges, incoming }))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}
