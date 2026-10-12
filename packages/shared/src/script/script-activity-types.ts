/** Public execution records shared by API and UI, without server dependencies. */
export type ScriptActivity = {
  id: string; kind: 'skill' | 'tool' | 'model' | 'context';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  label: string; summary: string; started_at: number; ended_at?: number; duration_ms?: number;
  round?: number; name?: string; skill_id?: string; revision?: string; files?: string[];
  input?: string; output?: string; input_truncated?: boolean; output_truncated?: boolean;
  targets?: ScriptActivityTarget[];
}

export type ScriptActivityTarget = { kind: 'document' | 'scene' | 'shot' | 'visual_profile'; id: string; title: string }
export type ScriptExecution = {
  title: string; request: string; started_at: number; targets?: string[];
  focus_artifact?: 'all' | 'character' | 'location' | 'prop';
  mode?: 'all' | 'script' | 'director';
  document_action?: { operation: 'review' | 'revise'; document_ids: string[] };
  workflow?: { operation?: import('./script-stage-access.js').StageOperation; stage: 'outline' | 'characters' | 'locations' | 'props' | 'episode'; scope?: 'project' | 'episode'; episode_number: number; target_duration?: number };
  outcome?: { kind: 'reply' | 'question' | 'draft' | 'partial' | 'saved' | 'discarded' | 'review' | 'next_step' | 'failed' | 'cancelled'; summary: string; draft_id?: string; draft_version?: string };
}
