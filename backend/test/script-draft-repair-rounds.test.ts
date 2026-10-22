import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PendingScriptDraft } from '../src/modules/script/script-draft-resolution.js'
import { canContinueScriptDraftRepair, completeScriptDraftRepairRound, completedScriptDraftRepairRounds,
  scriptDraftRepairRoundLimit, startScriptDraftRepairRounds } from '../src/modules/script/script-draft-repair-rounds.js'

const directory = await mkdtemp(join(tmpdir(), 'draft-repair-rounds-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { claimScriptDraft, pendingScriptDraft, publicDraftResolution, retainScriptDraft, updateScriptDraftRun } = await import('../src/modules/script/script-draft-resolution.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture(rounds?: number) {
  const projectId = newId(), timestamp = now()
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', projectId, '修订轮次保护', timestamp, timestamp)
  const pending = retainScriptDraft(projectId, {
    draft: { stage: 'outline', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'outline', title: '大纲', content: '需要解决的问题。' }], scenes: [] },
    findings: [{ source_key: 'outline', kind: 'contradiction', quote: '需要解决的问题。', explanation: '人物身份前后不一致。', suggestion: '统一人物身份。' }],
    request: {}, source_version: 'unchanged-source',
    run: { strategy: 'manual', answers: ['沿用已确认的人物身份。'], status: 'interrupted', completed: 0, total: 1,
      ...(rounds === undefined ? {} : { completed_rounds: rounds }) },
  })
  return { projectId, pending }
}

test('transport interruption and continuation preserve allowance; only unsuccessful semantic reviews consume rounds', () => {
  let state: { completed_rounds?: number } = {}
  assert.equal(completedScriptDraftRepairRounds(state), 0, 'legacy runs have no completed review rounds')
  for (let round = 0; round < scriptDraftRepairRoundLimit; round++) {
    assert.equal(canContinueScriptDraftRepair(state), true)
    const resumed = startScriptDraftRepairRounds('continue', state)
    assert.equal(resumed, round, 'transport resume must not consume a round')
    assert.equal(startScriptDraftRepairRounds('continue', { completed_rounds: resumed }), round, 'repeated transport resumes have the same allowance')
    state = { completed_rounds: completeScriptDraftRepairRound(state) }
  }
  assert.equal(completedScriptDraftRepairRounds(state), 4)
  assert.equal(canContinueScriptDraftRepair(state), false)
  assert.equal(startScriptDraftRepairRounds('manual', state), 0, 'new manual answers authorize a new allowance')
  assert.equal(startScriptDraftRepairRounds('ai', state), 0, 'explicit AI delegation authorizes a new allowance')
})

test('persisted candidate counters cover missing or stale runs and invalid counters fail closed', () => {
  assert.equal(completedScriptDraftRepairRounds({ completed_rounds: 3, run: { completed_rounds: 1 } }), 3)
  assert.equal(completedScriptDraftRepairRounds({ run: { completed_rounds: 3 } }), 3)
  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(canContinueScriptDraftRepair({ completed_rounds: value }), false)
  }
})

test('changing candidate version preserves the completed rounds even when new findings remove the old answers', () => {
  const { projectId, pending } = fixture(3)
  const { id: _id, version: _version, ...value } = pending
  const next = retainScriptDraft(projectId, { ...value, completed_rounds: undefined, run: undefined }, pending)
  assert.notEqual(next.version, pending.version)
  assert.equal(next.id, pending.id)
  assert.equal(next.run, undefined, 'a new finding must not inherit invalid prior answers')
  assert.equal(next.completed_rounds, 3)
  assert.equal(pendingScriptDraft(projectId)!.completed_rounds, 3)
  assert.equal(publicDraftResolution(pendingScriptDraft(projectId))!.completed_rounds, 3)
})

test('four unsuccessful reviews block continue without changing the candidate, while a fresh delegation remains possible', () => {
  const { projectId, pending } = fixture(4)
  assert.throws(() => claimScriptDraft(projectId, { id: pending.id, version: pending.version, strategy: 'continue' }, pending.source_version),
    (error: unknown) => error instanceof Error && (error as Error & { statusCode: number }).statusCode === 409 && error.message.includes('4 轮'))
  assert.deepEqual(pendingScriptDraft(projectId), pending, 'rejection retains exact current draft and answers')
  for (const strategy of ['manual', 'ai'] as const) {
    const claim = claimScriptDraft(projectId, { id: pending.id, version: pending.version, strategy, ...(strategy === 'manual' ? { answers: ['新的明确处理方案。'] } : {}) }, pending.source_version)
    assert.equal(startScriptDraftRepairRounds(strategy, claim.pending), 0)
    claim.release()
  }
})

test('the four-round guard still applies after the pending version changes and the resumable run disappears', () => {
  const { projectId, pending } = fixture(4)
  const { id: _id, version: _version, ...value } = pending
  const next = retainScriptDraft(projectId, { ...value, completed_rounds: undefined, run: undefined }, pending)
  assert.throws(() => claimScriptDraft(projectId, { id: next.id, version: next.version, strategy: 'continue' }, next.source_version), /4 轮/)
})

test('publishing an explicitly reauthorized run resets persisted rounds, while subsequent failed review survives a new version', () => {
  for (const strategy of ['manual', 'ai'] as const) {
    const { projectId, pending } = fixture(4)
    const claim = claimScriptDraft(projectId, { id: pending.id, version: pending.version, strategy,
      ...(strategy === 'manual' ? { answers: ['重新明确的处理方案。'] } : {}) }, pending.source_version)
    const freshRun: NonNullable<PendingScriptDraft['run']> = { strategy, answers: ['重新明确的处理方案。'], status: 'running', completed: 0, total: 1 }
    assert.equal(startScriptDraftRepairRounds(strategy, claim.pending), 0)
    updateScriptDraftRun(projectId, pending, freshRun)
    assert.equal(pendingScriptDraft(projectId)!.completed_rounds, undefined, 'zero rounds remain absent from legacy metadata')
    assert.equal(canContinueScriptDraftRepair(pendingScriptDraft(projectId)!), true)
    const nextRounds = completeScriptDraftRepairRound(freshRun)
    const { id: _id, version: _version, completed_rounds: _rounds, ...value } = pending
    const next = retainScriptDraft(projectId, { ...value, completed_rounds: nextRounds, run: { ...freshRun, completed_rounds: nextRounds, status: 'interrupted' } }, pending)
    assert.equal(next.completed_rounds, 1)
    assert.equal(publicDraftResolution(next)!.run!.completed_rounds, 1)
    claim.release()
  }
})
