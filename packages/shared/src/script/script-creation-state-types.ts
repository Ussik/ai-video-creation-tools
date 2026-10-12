// Serializable application state, shared with the dialogue UI.
export type CreationStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'
export type CreationNextStep = {
  id: string; stage: CreationStage; episode_number: number; purpose: 'generate' | 'revise';
  summary: string; basis: string; document_ids: string[]; source: 'model' | 'progress'
}
export type ScriptCreationState = {
  version: string; status: 'direction' | 'ready' | 'review' | 'complete';
  stage_context: { stage: CreationStage | null; episode_number: number | null; mode: 'default' | 'explicit' | 'review' | 'complete'; progress_key: string };
  next_step: CreationNextStep | null; saved_episodes: number[]
}
