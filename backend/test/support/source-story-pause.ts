import assert from 'node:assert/strict'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

type StoryTask = NonNullable<ScriptSourceAnalysis['story_work']>['tasks'][number]

/** Stop a fixture at candidate creation, before the output layer records a
 * dispatch intent or invokes its generator. This is a storage interruption,
 * never a transport error relabelled as not_sent. */
export function pauseBeforeStoryRequest(state: ScriptSourceAnalysis,
  match: string | ((task: StoryTask) => boolean), error: Error, controller?: AbortController) {
  let paused = false
  return () => {
    if (paused) return
    const task = state.story_work?.tasks.find(task => typeof match === 'string' ? task.key === match : match(task))
    const checkpoint = task?.output_candidate?.checkpoint
    if (!checkpoint || checkpoint.input_hash !== undefined) return
    assert.equal(checkpoint.initial_started, undefined)
    assert.equal(checkpoint.correction_started, undefined)
    assert.equal(checkpoint.raw, undefined)
    paused = true
    controller?.abort(error)
    throw error
  }
}
