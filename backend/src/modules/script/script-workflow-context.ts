import type { ScriptArtifact } from '../../infrastructure/database/db.js'
import type { GenerationCheckpoint } from './script-generation-steps.js'

type ContextArtifact = Pick<ScriptArtifact, 'artifact_type' | 'episode_number' | 'title' | 'content' | 'status'>

/** Keep saved-state metadata outside the document shape shown to a generator.
 * The legacy projection exists only to identify an exact pre-fix checkpoint. */
export function workflowDocumentContext(artifacts: readonly ContextArtifact[], legacy = false) {
  if (legacy) return { artifacts: artifacts.map(artifact => ({
    type: artifact.artifact_type, episode_number: artifact.episode_number,
    title: artifact.title, content: artifact.content, status: artifact.status,
  })) }
  return {
    artifacts: artifacts.map(({ artifact_type, title, content }) => ({ artifact_type, title, content })),
    saved_document_metadata: artifacts.map(({ artifact_type, episode_number, status }, artifact_index) => ({
      artifact_index, artifact_type, episode_number, status,
    })),
  }
}

/** An empty pre-fix attempt may use the current prompt immediately. Any saved
 * work keeps its original prompt and hashes so no accepted prose is lost. */
export function hasRetainedGenerationWork(checkpoint: GenerationCheckpoint): boolean {
  return Object.entries(checkpoint.steps).some(([id, step]) => {
    if (id !== 'draft:stream:state') return true
    if (!step.value || typeof step.value !== 'object') return true
    const state = step.value as Record<string, unknown>
    if (Array.isArray(state.pendingArtifacts) && state.pendingArtifacts.length > 0) return true
    if (Array.isArray(state.blockedArtifacts) && state.blockedArtifacts.length > 0) return true
    if (Array.isArray(state.blockedScenes) && state.blockedScenes.length > 0) return true
    return ['artifacts', 'scenes', 'blocks'].some(key => !Array.isArray(state[key]) || state[key].length > 0)
  })
}
