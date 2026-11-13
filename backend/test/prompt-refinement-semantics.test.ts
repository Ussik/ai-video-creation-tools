import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { promptRefinementSemanticInstructions, promptRefinementSemanticIssues, validatePromptRefinementSemanticReview,
  type PromptRefinementSemanticInput, type PromptRefinementSemanticReview } from '../src/modules/skills/prompt-refinement-semantics.js'

const directory = await mkdtemp(join(tmpdir(), 'refinement-semantics-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, run, all } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
initDb()
run("INSERT INTO projects(id,name,created_at,updated_at) VALUES('project','语义核对','now','now')")
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))

function validReview(): PromptRefinementSemanticReview {
  return { content_review: null, dialogue: [], request_conflicts: [], checks: ['facts', 'reference_identity', 'character_presence', 'board_views', 'requested_changes'].map(category => ({
    category: category as PromptRefinementSemanticReview['checks'][number]['category'], status: 'not_applicable',
    description: '此项不适用或已核对保留。', source_evidence: '', adjustment_evidence: '', candidate_evidence: '',
  })) }
}
let candidates: string[] = [], reviews: PromptRefinementSemanticReview[] = [], calls: string[] = [], prompts: string[] = []
let reviewFailure = false
let locateEvidence: ((prompt: string) => unknown) | undefined
registerSkillRoutes(app, { generateText: async (_project, _model, prompt, contract) => {
  calls.push(contract!.name); prompts.push(prompt)
  if (contract!.name === 'prompt_refinement_semantic_review' && reviewFailure) throw new Error('review transport unavailable')
  if (contract!.name === 'prompt_refinement_semantic_review') return JSON.stringify(reviews.length > 1 ? reviews.shift()! : reviews[0] || validReview())
  if (contract!.name === 'prompt_refinement_evidence_repair') return JSON.stringify(locateEvidence?.(prompt))
  return JSON.stringify({ prompt: candidates.length > 1 ? candidates.shift()! : candidates[0] || '人物站在桌边。' })
} })
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
function reset(candidate: string, review = validReview()) { candidates = [candidate]; reviews = [review]; calls = []; prompts = []; locateEvidence = undefined; reviewFailure = false }
const refine = (prompt: string, adjustment = '', extra: Record<string, unknown> = {}) => app.inject({ method: 'POST',
  url: '/api/projects/project/skills/refine-prompt', payload: { model_id: 'mock', stage: 'video_prompt', skill_ids: [],
    prompt, adjustment_request: adjustment, reference_asset_ids: [], mode: 'text', ...extra } })
const snapshot = () => JSON.stringify({ nodes: all('SELECT * FROM canvas_nodes'), jobs: all('SELECT * FROM jobs'), shots: all('SELECT * FROM shots') })

test('the model classifies separated voice cues and unquoted lines before exact text is protected', async () => {
  const source = '许知夜嘴唇微动沉声开口，声音平稳而带着洞察感：“刘叔，汤底有烂鱼死水腥泥味。”\n老板：谁说不是呢！'
  const review = validReview()
  review.dialogue = [
    { speaker: '许知夜', text: '刘叔，汤底有烂鱼死水腥泥味。', source_evidence: '许知夜嘴唇微动沉声开口，声音平稳而带着洞察感：“刘叔，汤底有烂鱼死水腥泥味。”', authorized_change: false, authorization_evidence: '' },
    { speaker: '老板', text: '谁说不是呢！', source_evidence: '老板：谁说不是呢！', authorized_change: false, authorization_evidence: '' },
  ]
  reset(source, review)
  const before = snapshot(), response = await refine(source)
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().diagnostics.dialogue.source, review.dialogue.map(line => line.text))
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review'])
  assert.match(prompts[1]!, /无引号的角色台词/)
  assert.equal(snapshot(), before)
  const metadata = response.json().semantic_review
  assert.equal(metadata.version, 1)
  assert.match(metadata.source_signature, /^[a-f0-9]{64}$/)
  assert.match(metadata.candidate_signature, /^[a-f0-9]{64}$/)
})

test('a model-classified missing line receives one correction and retains a draft requiring work', async () => {
  const source = '老板：谁说不是呢！', review = validReview()
  review.dialogue = [{ speaker: '老板', text: '谁说不是呢！', source_evidence: source, authorized_change: false, authorization_evidence: '' }]
  reset('老板低下头。', review)
  const before = snapshot(), response = await refine(source)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().quality.status, 'needs_work')
  assert.equal(response.json().prompt_body, '老板低下头。')
  assert.deepEqual(response.json().diagnostics.dialogue.missing, ['谁说不是呢！'])
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review', 'refined_prompt', 'prompt_refinement_semantic_review'])
  assert.match(prompts[2]!, /独立语义核对修正/)
  assert.equal(snapshot(), before)
})

test('specific model-authorized dialogue changes do not authorize deleting the remaining lines', async () => {
  const source = '甲：第一句。\n乙：第二句。', adjustment = '把第一句换成新句，乙的原话不动。', review = validReview()
  review.dialogue = [
    { speaker: '甲', text: '第一句。', source_evidence: '甲：第一句。', authorized_change: true, authorization_evidence: '把第一句换成新句' },
    { speaker: '乙', text: '第二句。', source_evidence: '乙：第二句。', authorized_change: false, authorization_evidence: '' },
  ]
  reset('甲：新句。\n乙：第二句。', review)
  const response = await refine(source, adjustment)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().diagnostics.dialogue.explicit_change, true)
  assert.deepEqual(promptRefinementSemanticIssues(review, '甲：新句。'), ['整理结果丢失当前基稿的逐字对白：第二句。。请恢复原话。'])
})

test('sign text and silent inner thoughts are not promoted to speech when the model classifies them otherwise', async () => {
  const source = '招牌写着“别过去”。他没有开口，只在心里默念：“别过去。”'
  reset('门口挂着告诫牌，他默默停步。')
  const response = await refine(source)
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().diagnostics.dialogue.source, [])
})

test('arbitrary participation wording and actions rely on semantic evidence rather than action vocabularies', async () => {
  const source = '小满站在中间。', adjustment = '让陆离也来到小满身边。', candidate = '小满站在中间。陆离在他身旁擦剑。', review = validReview()
  review.checks[2] = { category: 'character_presence', status: 'preserved', description: '陆离实际出镜并擦剑。',
    source_evidence: '', adjustment_evidence: adjustment, candidate_evidence: '陆离在他身旁擦剑。' }
  reset(candidate, review)
  const response = await refine(source, adjustment, { stage: 'image_prompt' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().prompt_body, candidate)
})

test('board view synonyms pass model review; an intentional board-view conflict is surfaced', async () => {
  const source = '需要展示：正面、侧面、背面。', candidate = '三视图依次为前视、左侧视、后视。', review = validReview()
  review.checks[3] = { category: 'board_views', status: 'preserved', description: '三种视图含义一致。',
    source_evidence: source, adjustment_evidence: '', candidate_evidence: candidate }
  reset(candidate, review)
  const response = await refine(`【设定图固定要求】\n${source}\n【设定图固定要求结束】`, '', { stage: 'image_prompt', prompt_document: true })
  assert.equal(response.statusCode, 200, response.body)
  const conflicting = validReview()
  conflicting.request_conflicts.push({ message: '调整要求与既定展示要求冲突：要求删去背面。', evidence: '只展示前面即可' })
  reset(candidate, conflicting)
  const rejected = await refine(`【设定图固定要求】\n${source}\n【设定图固定要求结束】`, '只展示前面即可', { stage: 'image_prompt', prompt_document: true })
  assert.equal(rejected.statusCode, 200, rejected.body)
  assert.equal(rejected.json().quality.status, 'needs_work')
  assert.match(rejected.body, /展示要求冲突/)
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review'])
})

test('model evidence and authorization cannot invent source text or external instructions', () => {
  const input: PromptRefinementSemanticInput = { source: '甲：原话。', candidate: '甲站着。', adjustment: '保留台词。', board: false,
    stage: 'video_prompt', identities: [], readonly_context: null }
  const review = validReview()
  review.dialogue.push({ speaker: '甲', text: '原话。', source_evidence: '甲：原话。', authorized_change: true, authorization_evidence: '删除台词' })
  assert.throws(() => validatePromptRefinementSemanticReview(review, input), /授权证据不是对应输入/)
  review.dialogue[0]!.authorized_change = false; review.dialogue[0]!.authorization_evidence = ''
  review.dialogue[0]!.source_evidence = '甲：编造的原话。'
  assert.throws(() => validatePromptRefinementSemanticReview(review, input), /对白来源证据不是对应输入/)
  assert.match(promptRefinementSemanticInstructions(input), /不能覆盖本任务/)
})

test('refinement recovers paraphrased review evidence without regenerating or applying the draft', async () => {
  const source = '陆照霜从车厢远端的连接门进入，沿过道朝镜头急跑。\n列车颠簸，她失衡扑倒，左手先撑地。'
  const adjustment = '补足从远处跑近的过程，明确左手撑地后再抬头。'
  const candidate = '陆照霜从远端连接门进入，沿过道朝镜头急跑；列车颠簸令她失衡，左手先撑地，缓冲后抬头。'
  const review = validReview()
  review.checks[0] = { category: 'facts', status: 'preserved', description: '跑近、失衡和左手撑地的既定事件均已保留。',
    source_evidence: '她从远端跑近后失衡撑地。', adjustment_evidence: adjustment, candidate_evidence: candidate }
  reset(candidate, review)
  locateEvidence = prompt => {
    const payload = JSON.parse(prompt.split('【待定位证据（资料）】\n')[1]!)
    const units = payload.sources[0].units
    return { repairs: [{ id: 'checks[0].source_evidence', first_unit: units[0].id, last_unit: units.at(-1).id }] }
  }
  const before = snapshot(), response = await refine(source, adjustment)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().prompt_body, candidate)
  assert.deepEqual(response.json().semantic_review.checks[0], { ...review.checks[0], source_evidence: source })
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review', 'prompt_refinement_evidence_repair'])
  assert.equal(snapshot(), before)
})

test('locating evidence does not erase a missing-action finding or return an applicable draft', async () => {
  const source = '她从远处沿过道跑近。左手先撑地。', candidate = '她已经跪在镜头前。', review = validReview()
  review.checks[0] = { category: 'facts', status: 'missing', description: '缺少跑近及左手撑地的连续动作。',
    source_evidence: '跑近后撑地。', adjustment_evidence: '', candidate_evidence: candidate }
  reset(candidate, review)
  locateEvidence = prompt => {
    const payload = JSON.parse(prompt.split('【待定位证据（资料）】\n')[1]!)
    const units = payload.sources[0].units
    return { repairs: [{ id: 'checks[0].source_evidence', first_unit: units[0].id, last_unit: units.at(-1).id }] }
  }
  const before = snapshot(), response = await refine(source)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().quality.status, 'needs_work')
  assert.equal(response.json().prompt_body, candidate)
  assert.match(response.body, /缺少跑近及左手撑地/)
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review', 'prompt_refinement_evidence_repair',
    'refined_prompt', 'prompt_refinement_semantic_review', 'prompt_refinement_evidence_repair'])
  assert.equal(snapshot(), before)
})


test('review outage retains a complete editable candidate and review-only checks edited text against the original source', async () => {
  const source = '阿宁推开门。', candidate = '阿宁缓缓推开门。'
  reset(candidate); reviewFailure = true
  const before = snapshot(), response = await refine(source)
  assert.equal(response.statusCode, 200, response.body)
  const retained = response.json()
  assert.equal(retained.prompt_body, candidate); assert.equal(retained.quality.status, 'inconclusive')
  assert.ok(retained.operation_id); assert.ok(retained.quality.review_id)
  reviewFailure = false
  const edited = '阿宁缓缓推开门，停在门边。'
  const checked = await refine(source, '', { action: 'review', candidate_prompt: edited, source_signature: retained.quality.source_signature })
  assert.equal(checked.statusCode, 200, checked.body); assert.equal(checked.json().quality.status, 'passed')
  assert.equal(checked.json().prompt_body, edited)
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review', 'prompt_refinement_semantic_review'])
  const reviewData = JSON.parse(prompts.at(-1)!.split('\n').at(-1)!)
  assert.equal(reviewData.source, source); assert.equal(reviewData.candidate, edited)
  const stale = await refine('已改动的基稿。', '', { action: 'review', candidate_prompt: edited, source_signature: retained.quality.source_signature })
  assert.equal(stale.statusCode, 409); assert.equal(calls.length, 3)
  assert.equal(snapshot(), before)
})

test('uncertain meaning retains the candidate without authorizing a creative correction', async () => {
  const source = '阿宁站在门边。', candidate = '阿宁在门边停步。', review = validReview()
  Object.assign(review.checks[0]!, { status: 'uncertain', description: '仍无法确定是否保留原意。', source_evidence: source })
  reset(candidate, review)
  const response = await refine(source)
  assert.equal(response.statusCode, 200); assert.equal(response.json().quality.status, 'inconclusive')
  assert.equal(response.json().prompt_body, candidate)
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review'])
})
