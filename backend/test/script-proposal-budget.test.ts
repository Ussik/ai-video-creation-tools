import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-proposal-budget-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now, run } = await import('../src/infrastructure/database/db.js')
const { sourceProposalBudget } = await import('../src/modules/script/script-proposal-budget.js')
const { beginTextRequest, TextRequestBudgetError } = await import('../src/infrastructure/providers/text-request-usage.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

function source(id: string) {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, id, now(), now())
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, 'story.txt', '完整原文', now())
}
test('candidate and transport continuations restore the same stage budget before dispatch; other stages retain independent budgets', () => {
  source('p')
  const previous = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
  process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = '1'
  try {
    const first = sourceProposalBudget('p', 'outline')
    first.run(() => beginTextRequest({ request_bytes: 100, estimated_input_tokens: 50, reserved_output_tokens: 30 }))
    const resumed = sourceProposalBudget('p', 'outline')
    assert.equal(resumed.usage.requests, 1)
    assert.equal(resumed.usage.uncertain_requests, 1)
    assert.throws(() => resumed.run(() => beginTextRequest({ request_bytes: 100, estimated_input_tokens: 50 })), TextRequestBudgetError)
    assert.equal(resumed.usage.requests, 1)
    const nextStage = sourceProposalBudget('p', 'characters')
    nextStage.run(() => beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 }).complete({ input_tokens: 9, output_tokens: 5 }))
    assert.equal(sourceProposalBudget('p', 'outline').usage.uncertain_requests, 1)
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

test('malformed durable counters and invalid limit configuration stop before generation', () => {
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
  try { assert.throws(() => sourceProposalBudget('corrupt', 'outline'), /必须是正整数/) }
  finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS
    else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS = previous
  }
})
