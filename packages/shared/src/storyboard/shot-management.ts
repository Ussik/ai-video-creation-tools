import type { Shot } from '../api/contracts.js'

export interface ShotManagementCanvasRef { id: string; name: string }
export interface ShotManagementEntry {
  shot: Shot
  design_name: string
  canvas_refs: ShotManagementCanvasRef[]
  asset_count: number
  deleted_at: string | null
  delete_blockers: string[]
}
export interface ShotManagementSnapshot {
  revision: string
  shots: ShotManagementEntry[]
  designs: Array<{ id: string; name: string; canvas_id: string | null }>
  canvases: ShotManagementCanvasRef[]
  scenes: Array<{ id: string; heading: string; episode_number: number; position: number }>
  trashed_assets: Array<{ id: string; filename: string; kind: string; deleted_at: string }>
}
export interface ShotManagementPatch {
  title?: string
  prompt?: string
  image_prompt?: string
  video_prompt?: string
  duration?: number
  start_state?: string
  end_state?: string
  cut_note?: string
}
export interface ShotManagementActionInput {
  revision: string
  action: 'update' | 'move' | 'duplicate' | 'trash' | 'restore' | 'restore_asset'
  shot_id?: string
  asset_id?: string
  patch?: ShotManagementPatch
  direction?: 'up' | 'down'
}
export interface CanvasDeletionPreview {
  revision: string
  cleanup_revision: string
  node_count: number
  edge_count: number
  exclusive_shots: Array<{ id: string; title: string }>
  exclusive_assets: Array<{ id: string; filename: string }>
  protected_asset_count: number
  running_job_count: number
}
export interface CanvasDeletionInput {
  revision: string
  cleanup_revision?: string
  cleanup_shots?: boolean
  cleanup_assets?: boolean
}
