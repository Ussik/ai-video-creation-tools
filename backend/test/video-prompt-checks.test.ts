import { candidateQualityAccepted } from '@video-studio/shared/api/ai-candidate-quality'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import sharp from 'sharp'
import { semanticReviewFixture } from './helpers/prompt-refinement-semantics.js'

const directory = await mkdtemp(join(tmpdir(), 'video-prompt-checks-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, run, all, mediaDir } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const { installSkillBundle, configureSkill, skillContext } = await import('../src/modules/skills/skills.js')
initDb()
run("INSERT INTO projects(id,name,created_at,updated_at) VALUES('project','动作核对','now','now')")
run("INSERT INTO shots(id,project_id,position,title,prompt,video_prompt,duration,start_state,end_state,cut_note,created_at) VALUES('shot','project',0,'笑意僵住','','旧提示词中说：“旧台词。”',2,'带笑','抬手停住','保持背景静止','now')")
run("INSERT INTO providers(id,name,adapter,base_url,created_at) VALUES('provider','测试','http','https://example.invalid','now')")
run("INSERT INTO models(id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES('vision','provider','看图','vision','text','responses',?,1)", JSON.stringify({ supports_vision: true }))
const path = join(mediaDir, 'image.png')
await writeFile(path, await sharp({ create: { width: 32, height: 32, channels: 3, background: '#445566' } }).png().toBuffer())
run("INSERT INTO assets(id,project_id,kind,filename,path,source,created_at) VALUES('image','project','image','参考.png',?,'upload','now')", path)
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
const source = '陆照笑着喊：“老陈，面要凉了。”他把册夹在右腋，左手提剑，居民保持静止。'
let candidate = source, calls: string[] = [], seenPixels = 0, badFinding = false, allowDialogueChange = false, wantsContentReview = false
const semantics = () => ({ ...semanticReviewFixture(), content_review: wantsContentReview ? review() : null, dialogue: [{ speaker: '陆照', text: '老陈，面要凉了。', source_evidence: '陆照笑着喊：“老陈，面要凉了。”', authorized_change: allowDialogueChange, authorization_evidence: allowDialogueChange ? '删除本镜对白' : '' }] })
const review = () => ({ primary_action: '跑至桌边站稳', secondary_actions: ['收册'], start_state: '正在跑来', end_state: '站稳', visible_result: '清楚落脚并停住',
  facts: [{ fact: '背景居民静止', status: 'preserved', evidence: '居民保持静止' }],
  issues: [{ code: 'action_load', severity: 'warning', message: '四秒内同时跑入和收册需要复验', suggestion: '优先保证跑入完成，再判断是否延长。' }],
  reference_findings: badFinding ? [{ image_number: 2, observation: '伪造未查看图片', suggestion: '' }] : seenPixels ? [{ image_number: 1, observation: '单幅色块测试像素', suggestion: '根据实际构图诊断' }] : [] })
registerSkillRoutes(app, {
  generateText: async (_project, _model, prompt, contract) => {
    calls.push(contract!.name)
    assert.doesNotMatch(prompt, /旧提示词中说/)
    return JSON.stringify(contract?.name === 'video_prompt_content_review' ? review() : contract?.name === 'prompt_refinement_semantic_review' ? semantics() : { prompt: candidate })
  },
  generateWithImages: async (_project, _model, _prompt, images, contract, signal) => {
    signal!.throwIfAborted(); calls.push(contract!.name); seenPixels = images.length
    assert.match(images[0]!.data_url, /^data:image\/jpeg;base64,/)
    return JSON.stringify(contract?.name === 'video_prompt_content_review' ? review() : contract?.name === 'prompt_refinement_semantic_review' ? semantics() : { prompt: candidate })
  },
})
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const snapshot = () => JSON.stringify({ shots: all('SELECT * FROM shots'), assets: all('SELECT * FROM assets'), jobs: all('SELECT * FROM jobs') })
const refine = (extra: Record<string, unknown> = {}) => { wantsContentReview = extra.check_video_content === true; return app.inject({ method: 'POST', url: '/api/projects/project/skills/refine-prompt', payload: {
  model_id: 'vision', stage: 'video_prompt', shot_id: 'shot', skill_ids: [], prompt: source, duration: 4,
  mode: 'reference', reference_asset_ids: ['image'], explicit_reference_asset_ids: ['image'], ...extra,
} }) }

test('all action dependencies load for video stage without unrelated model dialects or image-stage expansion', () => {
  const names = ['motion-recipe.md', 'generability.md', 'production-prompt-grammar.md', 'rubric-visual-motion.md', 'production-quality-gates.md', 'qa-rubric.md']
  const skill = installSkillBundle({ repo: 'fixture/motion', path: 'skills/motion', name: 'motion', description: '动作', revision: 'a'.repeat(40), license: null,
    suggested_stages: ['video_prompt'], tool_requirements: [], url: 'https://example.invalid', files: [
      { path: 'skills/motion/SKILL.md', content: '---\nname: motion\ndescription: 动作\n---\n保留原意。' },
      ...names.map(name => ({ path: `skills/motion/references/${name}`, content: `规则 ${name}` })),
      { path: 'skills/motion/references/seedance-2.5.md', content: '不适用方言' },
    ] })
  configureSkill(skill.id, true, ['video_prompt', 'image_prompt'])
  const loaded = skillContext('video_prompt', '人物跑入', [skill.id])
  for (const name of names) assert.ok(loaded.files.some(path => path.endsWith(name)), name)
  assert.ok(!loaded.text.includes('不适用方言'))
  assert.ok(!skillContext('image_prompt', '人物', [skill.id]).text.includes('规则 motion-recipe'))
})

test('independent content review sees real pixels and returns separate generation/edit duration without business changes', async () => {
  const before = snapshot(); calls = []; seenPixels = 0; candidate = source
  const response = await refine({ check_video_content: true, analyze_reference_images: true })
  assert.equal(response.statusCode, 200, response.body)
  const report = response.json().diagnostics
  assert.deepEqual(calls, ['refined_prompt', 'prompt_refinement_semantic_review'])
  assert.equal(seenPixels, 1); assert.equal(report.references.mode, 'pixels')
  assert.equal(report.content_review.primary_action, '跑至桌边站稳')
  assert.equal(report.generation_duration, 4); assert.equal(report.edit_duration, 2)
  assert.ok(report.issues.some((issue: { code: string }) => issue.code === 'edit_duration'))
  assert.equal(snapshot(), before)
})

test('dropping dialogue remains unapplied after one correction while explicit changes and existing text-only callers remain supported', async () => {
  const before = snapshot()
  calls = []; seenPixels = 0; candidate = '本镜无对白，陆照站在桌边。'
  const failed = await refine()
  assert.equal(failed.statusCode, 200)
  assert.equal(failed.json().quality.status, 'needs_work')
  assert.equal(candidateQualityAccepted(failed.json().quality), false)
  assert.deepEqual(failed.json().diagnostics.dialogue.missing, ['老陈，面要凉了。'])
  assert.equal(failed.json().prompt_body, candidate); assert.equal(calls.length, 4)
  assert.equal(snapshot(), before, 'the incomplete dialogue candidate cannot change formal content')
  allowDialogueChange = true
  const changed = await refine({ adjustment_request: '删除本镜对白，其他动作和背景静止保持不变。' })
  assert.equal(changed.statusCode, 200)
  assert.equal(candidateQualityAccepted(changed.json().quality), true)
  assert.equal(changed.json().diagnostics.dialogue.explicit_change, true)
  assert.equal(changed.json().diagnostics.references.mode, 'text_only')
  candidate = source; allowDialogueChange = false
})

test('visual findings may not claim unprovided image pixels', async () => {
  const before = snapshot(); badFinding = true
  const response = await refine({ check_video_content: true, analyze_reference_images: true })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().quality.status, 'inconclusive')
  assert.equal(candidateQualityAccepted(response.json().quality), false)
  assert.match(response.json().quality.error.message, /没有提供实际像素/)
  assert.equal(response.json().diagnostics, undefined, 'unverified pixel claims never become accepted diagnostics')
  assert.equal(snapshot(), before)
  badFinding = false
})
