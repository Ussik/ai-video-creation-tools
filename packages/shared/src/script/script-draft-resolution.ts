import type { ScriptStage } from './script-stage-content.js'

export type ScriptDraftFinding = {
  source_key: string; kind: 'unresolved_setting' | 'missing_core_setting' | 'contradiction';
  quote: string; explanation: string; suggestion: string;
  id?: string; topic?: string;
  issue_id?: string;
  related_findings?: Array<{ source_key?: string; quote: string; explanation: string; suggestion: string }>;
  previous_answer?: string; delegated?: boolean; repair_attempts?: number;
}

export type ScriptDraftResolution = {
  id: string; version: string; stage: ScriptStage; episode_number: number;
  findings: ScriptDraftFinding[]; document_count: number;
  /** Survives new findings that invalidate the previous resumable answers. */
  completed_rounds?: number;
  run?: ScriptDraftRepairRun;
}

export type ScriptDraftRepairRun = {
  strategy: 'manual' | 'ai';
  status: 'running' | 'interrupted'; completed: number; total: number;
  /** Completed repair + unsuccessful semantic review rounds, excluding transport resumes. */
  completed_rounds?: number;
  message?: string;
}

export type ScriptDraftResolutionInput = {
  id: string; version: string; strategy: 'manual' | 'ai' | 'continue'; answers?: string[];
}
