import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-proposal-budget-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now, run } = await import('../src/infrastructure/database/db.js')
const { sourceProposalBudget } = await import('../src/modules/script/script-proposal-budget.js')
const { beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

function source(id: string) {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, id, now(), now())
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, 'story.txt', '完整原文', now())
}

function withLimits(requests: string | undefined, tokens: string | undefined, work: () => void) {
  const names = ['VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS', 'VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS'] as const
  const previous = names.map(name => process.env[name])
  try {
    for (const [index, name] of names.entries()) {
      const value = [requests, tokens][index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    work()
  } finally {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    }
  }
}

test('unset and blank limits allow continuations beyond the former defaults while preserving durable uncertain usage', () => {
  for (const [index, value] of [undefined, '', ' \t '].entries()) {
    const id = `unlimited-${index}`
    source(id)
    withLimits(value, value, () => {
      let updates = 0
      const first = sourceProposalBudget(id, 'outline', () => { updates++ })
      assert.equal(first.limits.max_requests, undefined)
      assert.equal(first.limits.max_tokens, undefined)
      first.run(() => {
        for (let request = 0; request < 121; request++) {
          const pending = beginTextRequest({ request_bytes: 50000, estimated_input_tokens: 25000, reserved_output_tokens: 1 })
          if (request === 120) assert.equal(pending.identify('unsettled-response'), true)
        }
      })
      assert.equal(first.usage.requests, 121)
      assert.equal(first.usage.uncertain_requests, 121)
      assert.ok(first.usage.estimated_input_tokens + first.usage.estimated_output_tokens > 3_000_000)
      assert.equal(first.usage.pending_requests.length, 1)
      assert.ok(updates >= 121, 'dispatch still persists usage before the upstream outcome is known')

      const resumed = sourceProposalBudget(id, 'outline')
      assert.deepEqual(resumed.usage, first.usage, 'loading an over-default ledger must retain its complete counters and pending response')
      resumed.run(() => beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 }))
      const persisted = sourceProposalBudget(id, 'outline').usage
      assert.equal(persisted.requests, 122, 'continuation dispatches instead of inheriting the former 120-request cutoff')
      assert.equal(persisted.uncertain_requests, 122)
      assert.deepEqual(persisted.pending_requests, first.usage.pending_requests)
      assert.equal(persisted.estimated_input_tokens, first.usage.estimated_input_tokens + 1)
      assert.equal(persisted.estimated_output_tokens, first.usage.estimated_output_tokens + 1)
    })
  }
})

test('an obsolete environment request cap cannot stop a stage with large cumulative usage', () => {
  source('request-only')
  withLimits('1', undefined, () => {
    const budget = sourceProposalBudget('request-only', 'outline')
    assert.equal(budget.limits.max_requests, undefined)
    assert.equal(budget.limits.max_tokens, undefined)
    budget.run(() => beginTextRequest({ request_bytes: 6000002, estimated_input_tokens: 3_000_001, reserved_output_tokens: 1 }))
    const before = structuredClone(budget.usage)
    const resumed = sourceProposalBudget('request-only', 'outline')
    resumed.run(() => beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 }))
    assert.equal(resumed.usage.requests, 2)
    assert.equal(resumed.usage.estimated_input_tokens, before.estimated_input_tokens + 1)
    assert.deepEqual(sourceProposalBudget('request-only', 'outline').usage, resumed.usage)
  })
})

test('an obsolete environment token cap cannot stop a resumed stage and all reservations remain counted', () => {
  source('token-only')
  withLimits(undefined, '100', () => {
    const budget = sourceProposalBudget('token-only', 'outline')
    assert.equal(budget.limits.max_requests, undefined)
    assert.equal(budget.limits.max_tokens, undefined)
    budget.run(() => {
      for (let request = 0; request < 120; request++) {
        beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 })
          .complete({ input_tokens: 0, output_tokens: 0 })
      }
      beginTextRequest({ request_bytes: 180, estimated_input_tokens: 90, reserved_output_tokens: 10 })
    })
    assert.equal(budget.usage.requests, 121, 'a token-only setting must not introduce a request-count limit')
    const before = structuredClone(budget.usage)
    const resumed = sourceProposalBudget('token-only', 'outline')
    resumed.run(() => beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 }))
    assert.equal(resumed.usage.requests, before.requests + 1)
    assert.equal(resumed.usage.estimated_input_tokens, before.estimated_input_tokens + 1)
    assert.equal(resumed.usage.estimated_output_tokens, before.estimated_output_tokens + 1)
    assert.deepEqual(sourceProposalBudget('token-only', 'outline').usage, resumed.usage)
  })
})

test('malformed obsolete environment caps are ignored instead of blocking stage creation', () => {
  source('invalid-limits')
  for (const invalid of ['0', '-1', '1.5', 'no-limit', 'Infinity', '9007199254740992']) {
    withLimits(invalid, undefined, () => {
      assert.deepEqual(sourceProposalBudget('invalid-limits', 'outline').limits, { unknown_output_tokens: 4096 })
    })
    withLimits(undefined, invalid, () => {
      assert.deepEqual(sourceProposalBudget('invalid-limits', 'outline').limits, { unknown_output_tokens: 4096 })
    })
  }
})

test('candidate and transport continuations retain usage without blocking; other stages keep independent ledgers', () => {
  source('p')
  const previous = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
  process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = '1'
  try {
    const first = sourceProposalBudget('p', 'outline')
    first.run(() => beginTextRequest({ request_bytes: 100, estimated_input_tokens: 50, reserved_output_tokens: 30 }))
    const resumed = sourceProposalBudget('p', 'outline')
    assert.equal(resumed.usage.requests, 1)
    assert.equal(resumed.usage.uncertain_requests, 1)
    resumed.run(() => beginTextRequest({ request_bytes: 100, estimated_input_tokens: 50 }))
    assert.equal(resumed.usage.requests, 2)
    const nextStage = sourceProposalBudget('p', 'characters')
    nextStage.run(() => beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 }).complete({ input_tokens: 9, output_tokens: 5 }))
    assert.equal(sourceProposalBudget('p', 'outline').usage.uncertain_requests, 2)
    assert.equal(sourceProposalBudget('p', 'characters').usage.input_tokens, 9)
  } finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
    else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = previous
  }
})

test('old scopes cannot dispatch against a replacement upload; new upload receives a fresh ledger', () => {
  source('replace')
  const old = sourceProposalBudget('replace', 'outline')
  run('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?', '另一份完整原文', 'changed', 'replace')
  assert.throws(() => old.run(() => beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 })), /原始剧本来源已变化/)
  assert.equal(sourceProposalBudget('replace', 'outline').usage.requests, 0)
})

test('a long project preserves all stage ledgers without a cumulative scope-count cutoff', () => {
  source('many-scopes')
  const first = sourceProposalBudget('many-scopes', 'initial')
  first.run(() => beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 })
    .complete({ input_tokens: 1, output_tokens: 1 }))
  const row = db.prepare("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal-usage'").get('many-scopes') as { payload: string }
  const ledger = JSON.parse(row.payload)
  for (let index = 0; index < 1001; index++) ledger.scopes[`episode-${index}`] = structuredClone(first.usage)
  run("UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace='source-proposal-usage'", JSON.stringify(ledger), 'many-scopes')
  const resumed = sourceProposalBudget('many-scopes', 'episode-1000')
  resumed.run(() => beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 })
    .complete({ input_tokens: 1, output_tokens: 1 }))
  assert.equal(resumed.usage.requests, 2)
  assert.equal(sourceProposalBudget('many-scopes', 'episode-0').usage.requests, 1)
  assert.equal(sourceProposalBudget('many-scopes', 'initial').usage.requests, 1)
})

test('malformed durable counters still stop before generation without losing historical usage', () => {
  source('corrupt')
  const budget = sourceProposalBudget('corrupt', 'outline')
  budget.run(() => beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 }))
  const row = db.prepare("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal-usage'").get('corrupt') as { payload: string }
  const ledger = JSON.parse(row.payload)
  ledger.scopes.outline.requests = -1
  run("UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace='source-proposal-usage'", JSON.stringify(ledger), 'corrupt')
  assert.throws(() => sourceProposalBudget('corrupt', 'outline'), /用量检查点无效/)
  const previous = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS
  process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS = 'no-limit'
  try { assert.throws(() => sourceProposalBudget('corrupt', 'outline'), /用量检查点无效/) }
  finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS
    else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS = previous
  }
})
