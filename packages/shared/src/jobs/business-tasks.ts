export type BusinessTaskKind = 'storyboard' | 'reference' | 'script' | 'analysis' | 'prompt' | 'speech' | 'image' | 'video' | 'export'
export type BusinessTaskStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'
export type BusinessTaskScope = { shot_ids: string[]; profile_ids?: string[]; asset_ids?: string[]; scene_ids: string[]; episode_numbers: number[]; label: string }
export interface BusinessTaskRecord {
  id: string; project_id: string; kind: BusinessTaskKind; title: string; scope: BusinessTaskScope
  status: BusinessTaskStatus; summary: string; entry: 'storyboard' | 'canvas' | 'script' | 'speech' | 'assets'
  created_at: string; updated_at: string; operation_ids: string[]; model_task_ids: string[]; job_ids: string[]
  domain_task_id?: string
  /** Explicit ID links only. Missing legacy parents are never inferred from time or text. */
  details?: { operations: Array<{ id: string; state: string; route: string; message?: string }>; models: Array<{ id: string; state: string; label: string; requests: number; uncertain_requests: number; phases: string[] }> }
}
