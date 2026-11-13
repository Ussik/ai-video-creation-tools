import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import sharp from 'sharp'
import { seedance2VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { stripManagedPromptBlocks, getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { applyExactPromptPatches, generateExactPromptEdits, promptParagraphs, promptSourceHash, type PromptExactPatch } from '../src/modules/skills/prompt-exact-edit.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { semanticReviewFixture } from './helpers/prompt-refinement-semantics.js'
import { currentModelRequestContext } from '../src/modules/generation/model-task-policy.js'

const directory = await mkdtemp(join(tmpdir(), 'prompt-exact-edit-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, all, mediaDir } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const { installSkillBundle, configureSkill } = await import('../src/modules/skills/skills.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
function patch(source: string, find: string, replace: string, id = 'edit-1', anchor?: PromptExactPatch['anchor']): PromptExactPatch {
  return { id, source_hash: promptSourceHash(source), find, replace, ...(anchor ? { anchor } : {}) }
}

test('exact edits use original offsets and preserve every untouched byte, paragraph and spoken line', () => {
  const source = '开场：alpha beta。\r\n\r\n林晚说：“这句话逐字保留。”  \n尾声：原样。'
  const result = applyExactPromptPatches(source, [patch(source, 'alpha', 'beta', 'a'), patch(source, 'beta。', 'gamma。', 'b')])
  assert.equal(result, '开场：beta gamma。\r\n\r\n林晚说：“这句话逐字保留。”  \n尾声：原样。')
  assert.equal(applyExactPromptPatches(source, []), source)
  assert.equal(promptParagraphs('首段。\r\n\r\n末段。').length, 2, 'Windows newlines retain exact paragraph anchors')
  assert.equal(applyExactPromptPatches(source, [patch(source, '尾声：原样。', '')]), source.replace('尾声：原样。', ''))
})

test('repeated fragments require one exact paragraph anchor and invalid hashes or overlap never apply', () => {
  const source = '第一段。\n\n相同短句。\n\n相同短句。', paragraphs = promptParagraphs(source)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '相同短句。', '只改这里。')]), /出现多次/)
  const anchor = { paragraph_id: paragraphs[2]!.id, paragraph_hash: paragraphs[2]!.hash }
  assert.equal(applyExactPromptPatches(source, [patch(source, '相同短句。', '只改这里。', 'x', anchor)]), '第一段。\n\n相同短句。\n\n只改这里。')
  assert.throws(() => applyExactPromptPatches(source, [{ ...patch(source, '第一段。', '新的开场。'), source_hash: '0'.repeat(64) }]), /原文哈希/)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '第一段。', '新的开场。', 'x', { ...anchor, paragraph_hash: '0'.repeat(64) })]), /段落锚点/)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '第一段。', '新的开场。', 'x'), patch(source, '一段', '一小节', 'y')]), /重叠/)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '第一段。', '新的开场。', 'x'), patch(source, '相同短句。', '变更。', 'x', anchor)]), /ID/)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '第一段。', '第一段。')]), /没有实际修改/)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '完全不存在', '不能猜位置')]), /逐字匹配原文/)
  assert.throws(() => applyExactPromptPatches(source, [patch(source, '第一段。', '扩展'.repeat(30))], 30), /长度上限/)
})

test('exhausted patch pages shrink to one, preserve complete pages, and resume only unfinished changes', async () => {
  const source = '第一项原动作。\n\n第二项原动作。', steps = createGenerationSteps()
  let calls = 0, fail = true
  const sizes: number[] = []
  const generate = async (prompt: string, contract?: any) => {
    calls++; assert.equal(contract.name, 'refined_prompt_page')
    assert.equal(currentModelRequestContext()?.policy.purpose, 'prompt')
    assert.equal(contract.schema.properties.items.items.properties.source_hash.const, promptSourceHash(source))
    sizes.push(contract.schema.properties.items.maxItems)
    if (calls === 1) return JSON.stringify({ items: [patch(source, '第一项原动作。', '第一项清楚动作。')], complete: false })
    assert.match(prompt, /第一项清楚动作/)
    if (fail) throw new TextOutputLimitError('{"items":[{"id":"未闭合', 'length')
    return JSON.stringify({ items: [patch(source, '第二项原动作。', '第二项清楚动作。', 'edit-2')], complete: true })
  }
  const options = { source, prompt: `完整上下文：${source}`, steps, generate, validate: (candidate: string) => assert.match(candidate, /第一项/) }
  await assert.rejects(generateExactPromptEdits(options), (error: any) => error.code === 'script_generation_pagination_stalled')
  assert.deepEqual(sizes, [8, 8, 4, 2, 1])
  assert.equal((steps.checkpoint.steps['candidate:exact-patches']!.value as any).items.length, 1)
  fail = false
  assert.equal((await generateExactPromptEdits(options)).prompt, '第一项清楚动作。\n\n第二项清楚动作。')
  assert.equal(calls, 6); assert.equal(sizes.at(-1), 1)
})

test('a complete but invalid patch page is corrected once and never persisted as accepted progress', async () => {
  const source = '原始正文。\n\n对白：“原话。”', steps = createGenerationSteps()
  let calls = 0
  await assert.rejects(generateExactPromptEdits({ source, prompt: source, steps,
    generate: async () => { calls++; return JSON.stringify({ items: [patch(source, '对白：“原话。”', '无对白。')], complete: true }) },
    validate: candidate => { if (!candidate.includes('原话')) throw new Error('对白不可删除') } }), /对白不可删除/)
  assert.equal(calls, 2)
  assert.deepEqual((steps.checkpoint.steps['candidate:exact-patches']!.value as any).items, [])
})

async function fixture() {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '长提示词精确编辑' } })
  assert.equal(response.statusCode, 200, response.body)
  const project = response.json(), provider = `${project.id}-provider`, model = `${project.id}-text`, target = `${project.id}-video`
  run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES(?,?,'http','https://fixture.invalid','now')", provider, '文本验证')
  run("INSERT INTO models(id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES(?,?,?,'fixture','text','responses',?,1)", model, provider, '看图文本', JSON.stringify({ supports_vision: true }))
  run("INSERT INTO models(id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES(?,?,?,'doubao-seedance-2-0-mini-260615','video','async_video',?,1)", target, provider, '视频模型', JSON.stringify(seedance2VideoSettings()))
  const asset = `${project.id}-image`, path = join(mediaDir, `${asset}.png`)
  await writeFile(path, await sharp({ create: { width: 32, height: 32, channels: 3, background: '#445566' } }).png().toBuffer())
  run("INSERT INTO assets(id,project_id,kind,filename,path,source,created_at) VALUES(?,?,'image','长提示词参考.png',?,'upload','now')", asset, project.id, path)
  const skill = installSkillBundle({ repo: 'fixture/exact-edit', path: 'skills/video', name: 'exact-edit-video', description: '精确编辑视频规则', license: null,
    revision: 'a'.repeat(40), suggested_stages: ['video_prompt'], tool_requirements: [], url: 'https://example.invalid', files: [
      { path: 'skills/video/SKILL.md', content: '---\nname: exact-edit-video\ndescription: 精确编辑视频规则\n---\n保留叙事与全部对白。' },
      { path: 'skills/video/references/seedance-2.0.md', content: '只适用2.0的专门规范：保持参考图编号与身份。' },
      { path: 'skills/video/references/seedance-2.5.md', content: '错误的2.5方言不应加载。' },
    ] })
  configureSkill(skill.id, true, ['video_prompt'])
  const source = '林晚站在门边。她缓慢抬手。她说：“我会回来的。”\n\n' +
    Array.from({ length: 600 }, (_, index) => `环境${index + 1}：窗外细雨落在旧车站屋檐上，背景乘客保持原位，站台灯光与人物身份保持一致。`).join('\n\n') + '\n\n结束状态：林晚仍站在门边。'
  assert.ok(source.length > 12000)
  return { project, model, target, asset, skill, source,
    payload: { model_id: model, target_model_id: target, stage: 'video_prompt', skill_ids: [skill.id], prompt: source, duration: 5,
      ratio: '16:9', mode: 'reference', reference_asset_ids: [asset], explicit_reference_asset_ids: [asset], analyze_reference_images: true, check_video_content: true,
      adjustment_request: '只把抬手改为清楚抬起右手，把结束动作改为望向门外，其他内容和对白保持不变。' } }
}
function isolated() {
  const instance = Fastify()
  instance.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
  return instance
}
const review = { primary_action: '清楚抬起右手', secondary_actions: [], start_state: '站立', end_state: '望向门外', visible_result: '手抬至胸前', facts: [], issues: [], reference_findings: [] }

test('long route edits resume pages with intact source, rules, ordered pixels and target dialect, then independently review the final candidate', async t => {
  const f = await fixture(), instance = isolated(); t.after(() => instance.close())
  let page = 0, failPage = true, failReview = true, reviews = 0, firstPixels = ''
  const calls: string[] = []
  registerSkillRoutes(instance, { generateText: async () => { throw new Error('all requests must retain the attached actual pixels') },
    generateWithImages: async (_project, _model, prompt, images, contract, signal) => {
      signal!.throwIfAborted(); assert.equal(images.length, 1)
      if (!firstPixels) firstPixels = images[0]!.data_url
      assert.equal(images[0]!.data_url, firstPixels)
      if (contract?.name === 'prompt_refinement_semantic_review') {
        reviews++; calls.push('review')
        assert.match(prompt, /清楚抬起右手/); assert.match(prompt, /望向门外/); assert.match(prompt, /我会回来的/)
        if (failReview) throw Object.assign(new Error('独立审读中断'), { statusCode: 422 })
        return JSON.stringify({ ...semanticReviewFixture(), content_review: review })
      }
      assert.equal(contract?.name, 'refined_prompt_page')
      calls.push('patch'); page++
      assert.ok(prompt.includes(f.source), 'every page must receive the full original body')
      assert.match(prompt, /只适用2.0的专门规范/); assert.doesNotMatch(prompt, /错误的2.5方言/)
      assert.match(prompt, /Seedance 2.0 系列提示词要求/)
      assert.match(prompt, new RegExp(f.asset)); assert.match(prompt, /image_number[^\n]*1/)
      if (page === 1) return JSON.stringify({ items: [patch(f.source, '她缓慢抬手。', '她清楚抬起右手。')], complete: false })
      assert.match(prompt, /她清楚抬起右手/)
      if (failPage) throw Object.assign(new Error('补丁页中断'), { statusCode: 422 })
      return JSON.stringify({ items: [patch(f.source, '结束状态：林晚仍站在门边。', '结束状态：林晚望向门外。', 'end')], complete: true })
    } })
  const invoke = () => instance.inject({ method: 'POST', url: `/api/projects/${f.project.id}/skills/refine-prompt`, payload: f.payload })
  assert.equal((await invoke()).statusCode, 422)
  failPage = false
  assert.equal((await invoke()).statusCode, 422, 'independent review failure cannot return a final candidate')
  const before = page
  failReview = false
  const result = await invoke(); assert.equal(result.statusCode, 200, result.body)
  assert.equal(page, before, 'review resume must reuse the fully validated candidate without new patch requests')
  assert.equal(reviews, 2)
  const expected = f.source.replace('她缓慢抬手。', '她清楚抬起右手。').replace('结束状态：林晚仍站在门边。', '结束状态：林晚望向门外。')
  assert.equal(result.json().prompt_body, expected)
  assert.deepEqual(result.json().reference_asset_ids, [f.asset])
  assert.ok(result.json().loaded_files.includes('skills/video/references/seedance-2.0.md'))
  assert.deepEqual(calls, ['patch', 'patch', 'patch', 'review', 'review'])
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT * FROM model_unit_checkpoints WHERE project_id=?', f.project.id).length, 0)
})

test('long protected documents preserve fixed sections and reject dialogue removal or conflicting parameters before accepting patches', async t => {
  const f = await fixture(), instance = isolated(); t.after(() => instance.close())
  let bad: 'dialogue' | 'parameters' | 'reference' | 'none' = 'dialogue', calls = 0
  registerSkillRoutes(instance, { generateText: async (_project, _model, _prompt, contract) => {
    if (contract?.name === 'prompt_refinement_semantic_review') {
      return JSON.stringify({ ...semanticReviewFixture(), dialogue: [{ speaker: '林晚', text: '我会回来的。',
        source_evidence: '她说：“我会回来的。”', authorized_change: false, authorization_evidence: '' }] })
    }
    assert.equal(contract?.name, 'refined_prompt_page'); calls++
    const change = bad === 'dialogue' ? patch(f.source, '她说：“我会回来的。”', '无对白。') : bad === 'parameters'
      ? patch(f.source, '结束状态：林晚仍站在门边。', '结束状态：林晚仍站在门边。\n画面比例：9:16')
      : bad === 'reference' ? patch(f.source, '她缓慢抬手。', '她参考图片2的身份抬手。')
      : patch(f.source, '她缓慢抬手。', '她清楚抬起右手。')
    return JSON.stringify({ items: [change], complete: true })
  } })
  const original = withProjectStyle(f.source, { version: 'fixture', source: 'settings', label: '水墨动画', details: {} })
  const payload = { ...f.payload, prompt: original, prompt_document: true, analyze_reference_images: false, check_video_content: false, restart: true }
  const invoke = () => instance.inject({ method: 'POST', url: `/api/projects/${f.project.id}/skills/refine-prompt`, payload })
  let result = await invoke(); assert.equal(result.statusCode, 422, result.body); assert.match(result.body, /逐字对白/)
  bad = 'parameters'; result = await invoke(); assert.equal(result.statusCode, 422, result.body); assert.match(result.body, /画面比例/)
  bad = 'reference'; result = await invoke(); assert.equal(result.statusCode, 422, result.body); assert.match(result.body, /参考图 2/)
  bad = 'none'; result = await invoke(); assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(getManagedPromptBlocks(result.json().prompt), getManagedPromptBlocks(original))
  assert.equal(stripManagedPromptBlocks(result.json().prompt).trim(), f.source.replace('她缓慢抬手。', '她清楚抬起右手。'))
  assert.equal(calls, 7, 'each invalid proposal gets one format correction without persisting invalid edits')
})
