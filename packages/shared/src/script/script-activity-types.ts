import type { ScriptRequestUsage, ScriptRequestUsageLimits } from './script-request-usage.js'
import type { ScriptStage, StageArtifactType } from './script-stage-content.js'

export type ScriptActivityArtifactPreview = {
  stage: ScriptStage; scope?: 'project' | 'episode'; episode_number: number;
  artifacts: Array<{ artifact_type: StageArtifactType; title: string; content: string }>;
  scenes: Array<{ source_scene_id?: string; heading: string; location: string; time_of_day: string; characters: string;
    action: string; dialogue: string; narration: string; duration: number }>;
}

/** Public execution records shared by API and UI, without server dependencies. */
export type ScriptActivity = {
  task_id?: string; step_id?: string;
  /** One-based claimed request attempt; absent when the counter is unknown. */
  attempt?: number; sequence?: number;
  id: string; kind: 'skill' | 'tool' | 'model' | 'context';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  label: string; summary: string; started_at: number; ended_at?: number; duration_ms?: number;
  round?: number; name?: string; skill_id?: string; revision?: string; files?: string[];
  scope?: 'task' | 'step' | 'notice'; parent_id?: string; reused?: boolean;
  input?: string; output?: string; input_truncated?: boolean; output_truncated?: boolean;
  request_bytes?: number; response_chars?: number; first_event_ms?: number;
  input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; output_limit?: number;
  output_limit_reason?: 'max_output_tokens' | 'length'; output_limit_kind?: 'text' | 'reasoning' | 'tool_arguments';
  cache_read_tokens?: number; cache_write_tokens?: number; cache_miss_tokens?: number; request_purpose?: string;
  estimated_input_tokens?: number; context_window_tokens?: number; reserved_output_tokens?: number;
  input_limit_tokens?: number; output_limit_tokens?: number;
  budget_mode?: 'shared' | 'separate' | 'unknown';
  input_count_method?: 'estimate' | 'provider' | 'estimated_fallback';
  capacity_status?: 'validated' | 'estimated' | 'partial' | 'unknown';
  output_source?: 'auto' | 'fixed' | 'upstream' | 'template' | 'reserve';
  capability_source?: 'override' | 'provider' | 'legacy' | 'unknown';
  upstream_request_id?: string; http_status?: number;
  usage?: { current: ScriptRequestUsage; cumulative?: ScriptRequestUsage; limits?: ScriptRequestUsageLimits };
  targets?: ScriptActivityTarget[];
  /** Complete candidate output of this task, never a write to formal documents. */
  artifact_preview?: ScriptActivityArtifactPreview;
}

export type ScriptActivityTarget = { kind: 'document' | 'scene' | 'shot' | 'visual_profile'; id: string; title: string }
export type ScriptExecution = {
  title: string; request: string; started_at: number; targets?: string[];
  focus_artifact?: 'all' | 'character' | 'location' | 'prop';
  mode?: 'all' | 'script' | 'director';
  document_action?: { operation: 'review' | 'revise'; document_ids: string[]; revision_kind?: 'dialogue' };
  workflow?: { operation?: import('./script-stage-access.js').StageOperation; stage: 'outline' | 'characters' | 'locations' | 'props' | 'episode'; scope?: 'project' | 'episode'; episode_number: number; target_duration?: number;
    intent?: import('./script-task-contract.js').ScriptTaskIntent; artifact_types?: StageArtifactType[] };
  outcome?: { kind: 'reply' | 'question' | 'draft' | 'partial' | 'saved' | 'discarded' | 'review' | 'next_step' | 'failed' | 'cancelled'; summary: string; draft_id?: string; draft_version?: string };
}
