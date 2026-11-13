import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const directory = await mkdtemp(join(tmpdir(), 'candidate-review-evidence-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, run } = await import('../src/infrastructure/database/db.js')
const { retainCandidateReview, readCandidateReview } = await import('../src/modules/generation/candidate-review-evidence.js')
initDb()
run("INSERT INTO projects(id,name,created_at,updated_at) VALUES('project','候选复核','now','now'),('foreign','其他项目','now','now')")
run("INSERT INTO providers(id,name,adapter,base_url,created_at) VALUES('provider','测试','http','https://invalid.example','now')")
run("INSERT INTO models(id,provider_id,name,remote_id,modality,settings) VALUES('reviewer','provider','审查','mock','text','{}')")
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const candidate = { scenes: [{ title: '完整候选' }] }, source = 'source-version'
const retain = (status: 'passed' | 'needs_work') => retainCandidateReview({ projectId: 'project', family: 'storyboard', candidate, source, modelId: 'reviewer', status, report: { issues: [] } })
const read = (reviewId?: string, extra: Record<string, unknown> = {}) => readCandidateReview({ projectId: 'project', family: 'storyboard', reviewId, candidate, source, accepted: true, ...extra })

test('only a persisted accepted receipt bound to project, family, exact candidate and source permits application', () => {
  const passed = retain('passed'), rejected = retain('needs_work')
  assert.equal(read(passed.review_id).status, 'passed')
  for (const [reviewId, extra] of [
    [undefined, {}], ['forged', {}], [rejected.review_id, {}],
    [passed.review_id, { candidate: { scenes: [{ title: '手工编辑后' }] } }],
    [passed.review_id, { source: 'new-source' }], [passed.review_id, { family: 'prompt_refinement' }],
    [passed.review_id, { projectId: 'foreign' }],
  ] as Array<[string | undefined, Record<string, unknown>]>) assert.throws(() => read(reviewId, extra), (error: unknown) => {
    assert.equal((error as { statusCode: number }).statusCode, 409); return true
  })
})

test('changing the effective review model or provider invalidates earlier approval', () => {
  const receipt = retain('passed')
  run("UPDATE models SET settings=? WHERE id='reviewer'", JSON.stringify({ temperature: 0.8 }))
  assert.throws(() => read(receipt.review_id), /模型配置一致/)
  const current = retain('passed')
  run("UPDATE providers SET base_url='https://changed.invalid' WHERE id='provider'")
  assert.throws(() => read(current.review_id), /模型配置一致/)
})
