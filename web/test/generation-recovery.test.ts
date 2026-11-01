import assert from 'node:assert/strict'
import test from 'node:test'
import { generationRecoveryAction, generationRecoveryModality, type GenerationRecoveryJob } from '@video-studio/shared/jobs/generation-recovery'
import { canOptimizeImagePrompt } from '@video-studio/shared/jobs/prompt-optimization'

const failed: GenerationRecoveryJob = { job_type: 'generation', status: 'failed', request: '{"prompt":"原提示词"}', error: '服务重启' }

test('public recovery action is authoritative and null does not fall back to legacy availability flags', () => {
  for (const action of ['verify', 'query', 'download', null] as const) assert.equal(generationRecoveryAction({ ...failed,
    recovery_action: action, recovery_available: true, task_resume_available: true }, 'video'), action)
})

test('legacy image and video failures recover checkpoints first, resume known tasks next and otherwise require verification', () => {
  for (const modality of ['image', 'video']) {
    assert.equal(generationRecoveryAction({ ...failed, recovery_available: true, task_resume_available: true }, modality), 'download')
    assert.equal(generationRecoveryAction({ ...failed, task_resume_available: true }, modality), 'query')
    assert.equal(generationRecoveryAction(failed, modality), 'verify')
    assert.equal(generationRecoveryAction({ ...failed, error: 'content_policy_violation', task_resume_available: true }, modality), 'verify')
  }
  assert.equal(generationRecoveryAction(failed), 'verify', 'missing model never turns an uncertain generation into a retry')
  assert.equal(generationRecoveryAction({ ...failed, request: 'invalid json' }), 'verify')
})

test('recovery metadata cannot make successful, queued, speech or export jobs resumable', () => {
  for (const patch of [{ status: 'succeeded' }, { status: 'queued' }, { status: 'running' }, { job_type: 'export' }, { request: '{"tts":{"speaker":"voice"}}' }]) {
    assert.equal(generationRecoveryAction({ ...failed, ...patch, recovery_action: 'query', recovery_available: true }, 'video'), null)
  }
  assert.equal(generationRecoveryAction(failed, 'text'), null, 'ordinary text task retry behavior is preserved')
  assert.equal(generationRecoveryAction({ ...failed, error: 'content_policy_violation' }, 'text'), null)
})

test('recovery modality follows the persisted task when its model is changed or removed', () => {
  assert.equal(generationRecoveryModality({ ...failed, recovery_modality: 'video' }, 'image'), 'video')
  assert.equal(generationRecoveryModality({ ...failed, recovery_modality: 'video' }), 'video')
  assert.equal(generationRecoveryModality({ ...failed, recovery_modality: 'image' }, 'video'), 'image')
  assert.equal(generationRecoveryModality(failed, 'video'), 'video')
  assert.equal(generationRecoveryModality(failed, 'text'), null)
})

test('existing result download and task query never offer prompt optimization', () => {
  const policy = { ...failed, error: 'content_policy_violation', request: '{"prompt":"场景"}' } as const
  for (const recovery_action of ['query', 'download'] as const) assert.equal(canOptimizeImagePrompt({ ...policy, recovery_action }, 'image'), false)
  assert.equal(canOptimizeImagePrompt({ ...policy, recovery_action: 'verify' }, 'image'), true, 'a known refusal may still create an unsubmitted new prompt draft')
})
