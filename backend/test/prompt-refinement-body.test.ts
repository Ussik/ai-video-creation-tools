import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { getManagedPromptBlocks, stripManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { visualBoardPromptParts } from '@video-studio/shared/visuals/visual-board-document'
import { semanticIssueFixture, semanticReviewFixture } from './helpers/prompt-refinement-semantics.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-refine-body-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, all } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const app = buildApp(), refineApp = Fastify()
let captured = '', modelBody = '整理后的单幅画面：姜望低头补网，陆沉舟准备登船。', duringModel: (() => void) | undefined
let calls = 0, modelResults: string[] = []
let semanticResults = [semanticReviewFixture()]
refineApp.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
registerSkillRoutes(refineApp, { generateText: async (_project, _model, prompt, contract) => {
  if (contract?.name === 'prompt_refinement_semantic_review') return JSON.stringify(semanticResults.length > 1 ? semanticResults.shift()! : semanticResults[0])
  captured = prompt
  calls++
  duringModel?.()
  return JSON.stringify({ prompt: modelResults.shift() ?? modelBody })
} })
after(async () => { await refineApp.close(); await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function create(url: string, payload: unknown, method: 'POST' | 'PUT' | 'PATCH' = 'POST') {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  duringModel = undefined
  modelResults = []
  semanticResults = [semanticReviewFixture()]
  modelBody = '整理后的单幅画面：姜望低头补网，陆沉舟准备登船。'
  const project = await create('/api/projects', { name: '正文和固定设定分离' })
  run("INSERT INTO scripts (project_id, generation_options, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET generation_options=excluded.generation_options",
    project.id, JSON.stringify({ visual_style: '厚涂仙侠动画', visual_style_details: { medium: '动画' } }), '2026-10-19')
  const assets = ['jiang', 'lu', 'extra'].map(name => `${project.id}-${name}`)
  for (const asset of assets) run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,'/tmp/fixture.png','upload','2026-10-19')", asset, project.id, `${asset}.png`)
  const { visual_profiles: profiles } = await create(`/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'character', name: '姜望', variant: '补网装', definition: '短发、灰褐短褂、左手背少量泥点', view_requirements: '正侧背与面部细节' },
    { kind: 'character', name: '陆沉舟', variant: '登船装', definition: '青衣、腰间佩剑', view_requirements: '正侧背与佩剑细节' },
  ] })
  const jiang = profiles.find((profile: any) => profile.name === '姜望'), lu = profiles.find((profile: any) => profile.name === '陆沉舟')
  await create(`/api/visual-profiles/${jiang.id}`, { expected_revision: 1, board_asset_id: assets[0] }, 'PATCH')
  await create(`/api/visual-profiles/${lu.id}`, { expected_revision: 1, board_asset_id: assets[1] }, 'PATCH')
  const shot = await create(`/api/projects/${project.id}/shots`, { title: '渡船补网', image_prompt: '源镜头旧图片描述', video_prompt: '源镜头旧视频描述', start_state: '姜望坐在旧渡船边', end_state: '陆沉舟登船' })
  await create(`/api/shots/${shot.id}/visual-bindings`, { bindings: [
    { profile_id: jiang.id, required: true, usage: 'both' }, { profile_id: lu.id, required: false, usage: 'both' },
  ] }, 'PUT')
  return { project, assets, shot, jiang, lu, input: { model_id: 'text-fixture', skill_ids: [], stage: 'image_prompt', shot_id: shot.id,
    prompt: '近景，姜望低头补网，陆沉舟位于画面右侧。', reference_asset_ids: assets.slice(0, 2), visual_reference_mode: 'profiles', ratio: '16:9',
    resolution: '3840x2160', clarity: '4K', quality: 'high', background: 'auto', mode: 'reference' } }
}
async function refine(projectId: string, input: unknown) {
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${projectId}/skills/refine-prompt`, payload: input })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as { prompt: string; prompt_body: string; prompt_document?: boolean; reference_asset_ids: string[] }
}

async function explicitProp(state: Awaited<ReturnType<typeof fixture>>) {
  const sibling = `${state.project.id}-ruler-sibling`
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','sibling.png','/tmp/fixture.png','upload','2026-10-19')", sibling, state.project.id)
  const result = await create(`/api/projects/${state.project.id}/visual-profiles`, { profiles: [
    { kind: 'prop', name: '巡天尺', variant: '青铜常态', definition: '巡天尺为青铜长尺，尺端嵌一枚朱红晶石。', view_requirements: '正面结构与握柄细节' },
  ] })
  const prop = result.visual_profiles.find((profile: any) => profile.name === '巡天尺')
  const references: string[] = []
  for (const [asset_id, label] of [[state.assets[2], '握柄红晶'], [sibling, '未选尺身']]) {
    const registered = await create(`/api/visual-profiles/${prop.id}/reference-assets`, { expected_revision: 1,
      expected_style_version: result.project_visual_style.version, asset_id, view: 'detail', purpose: 'detail', label, status: 'confirmed' })
    references.push(registered.reference_assets.find((reference: any) => reference.asset_id === asset_id).id)
  }
  await create(`/api/shots/${state.shot.id}/visual-bindings`, { bindings: [
    { profile_id: state.jiang.id, required: true, usage: 'both' }, { profile_id: state.lu.id, required: false, usage: 'both' },
    { profile_id: prop.id, required: false, usage: 'none', reference_asset_ids: references },
  ] }, 'PUT')
  return { prop, sibling }
}

test('non-document refinement annotates an explicitly selected inactive prop with identity, definition and view purpose', async () => {
  const state = await fixture(), { prop, sibling } = await explicitProp(state)
  modelBody = '姜望双手握住参考图 1所示巡天尺，尺端朝上。'
  const result = await refine(state.project.id, { ...state.input, reference_asset_ids: [state.assets[2], state.assets[0]],
    explicit_reference_asset_ids: [state.assets[2]], prompt: '姜望手握巡天尺。' })
  assert.deepEqual(result.reference_asset_ids, [state.assets[2], state.assets[0]])
  assert.match(result.prompt, /道具：巡天尺（青铜常态/)
  assert.match(result.prompt, /青铜长尺，尺端嵌一枚朱红晶石/)
  assert.match(result.prompt, /参考图 1：巡天尺.*握柄红晶.*局部纹理/)
  assert.match(captured, /实际参考图（按输入顺序）：.*握柄红晶/)
  assert.match(captured, /视觉设定：.*青铜长尺/)
  assert.doesNotMatch(captured, /未选尺身/)
  assert.ok(!result.reference_asset_ids.includes(sibling))
  assert.equal(all<{ usage: string }>('SELECT usage FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', state.shot.id, prop.id)[0]!.usage, 'none')

  modelBody = '姜望低头补网。'
  const disconnected = await refine(state.project.id, { ...state.input, reference_asset_ids: [state.assets[0]], prompt: '姜望低头补网。' })
  assert.deepEqual(disconnected.reference_asset_ids, [state.assets[0]])
  assert.doesNotMatch(disconnected.prompt, /巡天尺|握柄红晶/)
})

test('explicit prop full-document refinement preserves creator sections and does not inject saved definitions into model context', async () => {
  const state = await fixture()
  await explicitProp(state)
  const blocks = ['【镜头视觉设定】\n道具按创作者要求改为木质短尺。\n【镜头视觉设定结束】',
    '【图片参考图用途】\n参考图 1仅用于握持方式。\n【图片参考图用途结束】']
  modelBody = '姜望举起木质短尺。'
  const result = await refine(state.project.id, { ...state.input, prompt_document: true,
    reference_asset_ids: [state.assets[2]], explicit_reference_asset_ids: [state.assets[2]],
    prompt: `姜望握住木质短尺。\n\n${blocks.join('\n\n')}` })
  assert.deepEqual(getManagedPromptBlocks(result.prompt), blocks)
  assert.match(captured, /已选图片身份标签.*巡天尺/)
  assert.doesNotMatch(captured, /青铜长尺|握柄红晶|未选尺身/)
  const absent = await refine(state.project.id, { ...state.input, prompt_document: true,
    reference_asset_ids: [state.assets[2]], explicit_reference_asset_ids: [state.assets[2]], prompt: '只保留创作者正文。' })
  assert.deepEqual(getManagedPromptBlocks(absent.prompt), [])
})

test('refinement rejects changes to explicitly inherited inactive definitions while the model is working', async () => {
  const state = await fixture(), { prop } = await explicitProp(state)
  const before = calls
  duringModel = () => run('UPDATE shot_visual_bindings SET definition=? WHERE shot_id=? AND profile_id=?',
    '已修改的黑铁巡天尺设定', state.shot.id, prop.id)
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${state.project.id}/skills/refine-prompt`, payload: {
    ...state.input, reference_asset_ids: [state.assets[2]], explicit_reference_asset_ids: [state.assets[2]], prompt: '姜望手持巡天尺。',
  } })
  assert.equal(response.statusCode, 409, response.body)
  assert.equal(calls, before + 1)
  duringModel = undefined
})

test('complete documents use current edited blocks as readonly context without replacing them from saved settings', async () => {
  const { project, input } = await fixture()
  const blocks = [
    '【项目画风约束】\n画风：创作者手动指定的水墨木刻。\n保留此处独特的纸张颗粒。\n【项目画风约束结束】',
    '【镜头视觉设定】\n姜望：创作者手动添加的赭红披肩，袖口保留三处补丁。\n【镜头视觉设定结束】',
    '【生成参数约束】\n创作者在本块补充的非标准说明。\n【生成参数约束结束】',
  ]
  modelBody = '姜望坐在船边，低头认真补网。\n\n【项目画风约束】\n模型伪造的画风\n【项目画风约束结束】\n\n【图片参考图用途】\n模型伪造的引用\n【图片参考图用途结束】'
  const result = await refine(project.id, { ...input, prompt_document: true,
    prompt: `创作者当前正文，姜望坐在船边补网。\n\n${blocks.join('\n\n')}`,
    prompt_body: '应忽略的过时正文缓存。' })
  assert.equal(result.prompt_document, true)
  assert.equal(result.prompt_body, '姜望坐在船边，低头认真补网。')
  assert.match(captured, /原提示词：\n创作者当前正文，姜望坐在船边补网。/)
  assert.match(captured, /当前文档只读结构上下文：.*"read_only":true/)
  assert.match(captured, /水墨木刻|纸张颗粒/)
  assert.match(captured, /赭红披肩|三处补丁/)
  assert.match(captured, /非标准说明/)
  assert.doesNotMatch(captured, /过时正文缓存|厚涂仙侠动画|灰褐短褂|正侧背与面部细节/)
  const rewriteInput = captured.split('原提示词：\n')[1]!.split('\n本次调整要求：')[0]!
  assert.equal(rewriteInput, '创作者当前正文，姜望坐在船边补网。')
  assert.deepEqual(getManagedPromptBlocks(result.prompt), blocks)
  assert.doesNotMatch(result.prompt, /厚涂仙侠动画|灰褐短褂|模型伪造|【图片参考图用途】/)
})

test('an explicit document with removed blocks stays a single editable prompt without regenerating absent blocks', async () => {
  const { project, input } = await fixture()
  modelBody = '自定义章节中整理后的动作正文。'
  const result = await refine(project.id, { ...input, prompt_document: true, prompt: '【自定义章节】\n只整理这一段创作描述。', prompt_body: '旧缓存。' })
  assert.equal(result.prompt, modelBody)
  assert.equal(result.prompt_body, modelBody)
  assert.equal(result.prompt_document, true)
  assert.match(captured, /原提示词：\n【自定义章节】\n只整理这一段创作描述。/)
  assert.match(captured, /"sections":\[\]/)
  assert.doesNotMatch(captured, /厚涂仙侠动画|灰褐短褂|正侧背与面部细节|青衣、腰间佩剑/)
  assert.deepEqual(getManagedPromptBlocks(result.prompt), [])
})

test('an unchanged refined body retains the original complete document and section positions exactly', async () => {
  const { project, input } = await fixture()
  const prompt = '开头正文。\n\n【镜头视觉设定】\n创作者手调的中间区块。\n【镜头视觉设定结束】\n\n结尾正文。'
  modelBody = stripManagedPromptBlocks(prompt)
  const result = await refine(project.id, { ...input, prompt, prompt_document: true })
  assert.equal(result.prompt, prompt)
})

test('legacy complete previews with bounded blocks are preserved when no explicit body or document flag is supplied', async () => {
  const { project, input } = await fixture()
  const block = '【镜头视觉设定】\n创作者修改过的旧节点：补丁短褂。\n【镜头视觉设定结束】'
  const result = await refine(project.id, { ...input, prompt: `旧节点中的当前正文。\n\n${block}` })
  assert.equal(result.prompt_document, true)
  assert.deepEqual(getManagedPromptBlocks(result.prompt), [block])
  assert.match(captured, /"content":"创作者修改过的旧节点：补丁短褂。"/)
  assert.doesNotMatch(captured.split('原提示词：\n')[1]!, /补丁短褂/)
  assert.doesNotMatch(result.prompt, /灰褐短褂|【项目画风约束】/)
})

test('setting-board refinement incorporates main content and supplements once while preserving other sections', async () => {
  const { project, input, jiang } = await fixture()
  const blocks = [
    '【设定图固定要求】\n保留创作者定制的四视图与额外的旧木网针细节。\n【设定图固定要求结束】',
    '【基础身份参考】\n保留创作者手调的眼角疤痕和眉形。\n【基础身份参考结束】',
    '【项目画风约束】\n画风：创作者指定的木刻。\n【项目画风约束结束】',
  ]
  const tables = ['visual_profiles', 'shot_visual_bindings', 'canvas_nodes', 'jobs']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  modelBody = '创作者定制的四视图排列清楚，包含旧木网针细节。'
  const result = await refine(project.id, { ...input, shot_id: undefined, profile_id: jiang.id, prompt_document: true,
    prompt: `把视图排列清楚。\n\n${blocks.join('\n\n')}`, prompt_body: '过期的正文缓存。' })
  const parts = visualBoardPromptParts(result.prompt)
  assert.deepEqual(parts.primary, [modelBody])
  assert.equal(parts.supplement, '')
  assert.deepEqual(parts.context, blocks.slice(1))
  assert.equal(result.prompt_body, modelBody)
  assert.equal(result.prompt.split(modelBody).length - 1, 1)
  assert.match(captured, /原提示词：\n保留创作者定制的四视图与额外的旧木网针细节。\n\n把视图排列清楚。/)
  const readonlyContext = captured.split('当前文档只读结构上下文：')[1]!.split('\n实际参考图')[0]!
  assert.doesNotMatch(readonlyContext, /四视图|旧木网针/)
  assert.match(captured, /四视图与额外的旧木网针细节/)
  assert.match(captured, /眼角疤痕和眉形/)
  assert.doesNotMatch(captured, /短发、灰褐短褂|正侧背与面部细节|厚涂仙侠动画|过期的正文缓存/)
  assert.doesNotMatch(result.prompt, /【镜头视觉设定】|正侧背与面部细节/)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before, 'refinement only returns a reviewable draft')
})

test('primary-only setting documents can refine without profile context or supplemental prose', async () => {
  const { project, input } = await fixture()
  const block = '【设定图固定要求】\n木质网针正侧背三视图，保留打磨痕迹。\n【设定图固定要求结束】'
  const context = '【图片生成要求】\n画面比例：16:9\n清晰度要求：4K\n【图片生成要求结束】'
  modelBody = '木质网针按正侧背三视图整齐排列，打磨痕迹清晰可见。'
  const result = await refine(project.id, { ...input, shot_id: undefined, reference_asset_ids: [], prompt_document: true,
    prompt: `${block}\n\n${context}` })
  assert.deepEqual(visualBoardPromptParts(result.prompt), { primary: [modelBody], supplement: '', context: [context] })
  assert.match(captured, /原提示词：\n木质网针正侧背三视图，保留打磨痕迹。/)
  assert.doesNotMatch(captured, /灰褐短褂|正侧背与面部细节|厚涂仙侠动画/)
})

test('setting refinement protects current facts and display requirements even from adjustment or skill preferences', async () => {
  const { project, input } = await fixture()
  const context = '【项目画风约束】\n画风：木刻，保留纸张纹理。\n【项目画风约束结束】'
  const primary = '对象：旧木网针；版本：修补态。\n视觉设定：\n旧木材质，针孔边缘有一道裂痕。\n需要展示：\n正侧背三视图和俯视，针孔细节。'
  modelBody = '旧木网针（修补态），旧木材质，针孔边缘保留一道裂痕。正视图、侧视图、后视图和顶视图排列有序，针孔细节清晰。'
  const result = await refine(project.id, { ...input, shot_id: undefined, reference_asset_ids: [], prompt_document: true,
    prompt: `【设定图固定要求】\n${primary}\n【设定图固定要求结束】\n\n${context}`, adjustment_request: '精简重复描述，排列清楚。' })
  assert.match(captured, /只整理语言表达、句子顺序和重复描述/)
  assert.match(captured, /不能改变既定事实、身份、版本、状态、结构、材质、配色和展示要求/)
  assert.match(captured, /调整要求及技能建议也不能授权突破此边界/)
  assert.doesNotMatch(captured, /定义、视图和版式允许按本次要求整理|允许相应更新本镜头的人物参与/)
  assert.deepEqual(visualBoardPromptParts(result.prompt), { primary: [modelBody], supplement: '', context: [context] })
})

test('setting drafts that lose explicit current views are corrected once and never returned as applicable', async () => {
  const { project, input } = await fixture(), before = calls
  const primary = '【设定图固定要求】\n对象：旧木网针；版本：修补态。\n需要展示：正侧背三视图与俯视。\n【设定图固定要求结束】'
  const invalid = '旧木网针（修补态）展示正侧背三视图。'
  modelResults = [invalid, invalid]
  semanticResults = [semanticIssueFixture('board_views', '未保留设定图展示要求：俯视。', { source: '俯视' })]
  const tables = ['visual_profiles', 'shot_visual_bindings', 'canvas_nodes', 'jobs']
  const saved = tables.map(table => all(`SELECT * FROM ${table}`))
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, shot_id: undefined, reference_asset_ids: [], prompt_document: true, prompt: primary,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().quality.status, 'needs_work')
  assert.equal(response.json().prompt_body, invalid)
  assert.match(response.body, /未保留设定图展示要求.*俯视/)
  assert.equal(calls, before + 2)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), saved)
})

test('fixed parameter conflicts fail before generation while natural-language board conflicts use model review', async () => {
  const { project, input } = await fixture(), before = calls
  for (const adjustment_request of ['画面比例：9:16', '删除背面视图。', '将三视图改为四视图。']) {
    const review = semanticReviewFixture()
    review.request_conflicts = [{ message: '调整要求与既定展示要求冲突。', evidence: adjustment_request }]
    semanticResults = [review]
    const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
      ...input, shot_id: undefined, reference_asset_ids: [], prompt_document: true,
      prompt: '【设定图固定要求】\n需要展示：正侧背三视图。\n【设定图固定要求结束】', adjustment_request,
    } })
    assert.equal(response.statusCode, adjustment_request.startsWith('画面比例') ? 422 : 200, response.body)
    if (!adjustment_request.startsWith('画面比例')) assert.equal(response.json().quality.status, 'needs_work')
    assert.match(response.body, /调整要求.*冲突/)
  }
  assert.equal(calls, before + 2)
})

test('a setting profile with a removed primary refines its remaining body without restoring saved facts', async () => {
  const { project, input, jiang } = await fixture()
  const context = '【项目画风约束】\n画风：保留创作者木刻。\n【项目画风约束结束】'
  modelBody = '只画一把带缺口的蓝色短尺。'
  const result = await refine(project.id, { ...input, shot_id: undefined, profile_id: jiang.id, prompt_document: true,
    prompt: `只画蓝色短尺。\n\n${context}` })
  assert.equal(result.prompt, `${modelBody}\n\n${context}`)
  assert.deepEqual(visualBoardPromptParts(result.prompt).primary, [])
  assert.doesNotMatch(captured, /灰褐短褂|正侧背与面部细节|厚涂仙侠动画/)
})

test('ambiguous primary sections and setting documents without creative content fail before a model call', async () => {
  const { project, input, jiang } = await fixture()
  const before = calls
  const primary = '【设定图固定要求】\n一张蓝色短尺三视图。\n【设定图固定要求结束】'
  for (const [prompt, error] of [
    [`${primary}\n\n${primary}`, /多个设定图内容/],
    ['【项目画风约束】\n画风：木刻。\n【项目画风约束结束】', /请输入/],
    ['【设定图固定要求】\n\n【设定图固定要求结束】', /请输入/],
  ] as const) {
    const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
      ...input, shot_id: undefined, profile_id: jiang.id, prompt_document: true, prompt,
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, error)
  }
  assert.equal(calls, before)
})

test('reference tokens inside preserved blocks are validated and resolved without rewriting the remaining block text', async () => {
  const { project, input, assets } = await fixture()
  const block = `【镜头视觉设定】\n姜望身份以[[ref:${assets[0]}]]为准；保留赭红披肩和两道折痕。\n陆沉舟维持参考图1的佩剑。\n【镜头视觉设定结束】`
  const result = await refine(project.id, { ...input, prompt_document: true, prompt: `整理姜望补网的动作。\n\n${block}`,
    reference_asset_ids: [assets[1], assets[2]], prompt_reference_overrides: { [assets[0]!]: assets[2] } })
  assert.deepEqual(getManagedPromptBlocks(result.prompt), [block.replace(`[[ref:${assets[0]}]]`, '参考图 2')])
  assert.match(captured, /赭红披肩和两道折痕/)
  assert.match(captured, /维持参考图1/)
  assert.doesNotMatch(captured.split('原提示词：\n')[1]!, /赭红披肩|两道折痕|维持参考图1/)
  assert.match(result.prompt, /陆沉舟维持参考图1的佩剑/)
})

test('malformed known blocks and disconnected references inside protected blocks fail before refinement', async () => {
  const { project, input, assets, lu } = await fixture(), before = calls
  const documents = [
    { prompt: '正文。\n【镜头视觉设定】\n缺少结束的固定要求。' },
    { prompt: '正文。\n【镜头视觉设定】\n【项目画风约束】\n嵌套。\n【项目画风约束结束】\n【镜头视觉设定结束】' },
    { prompt: '正文。\n【镜头视觉设定】\n错误结束。\n【项目画风约束结束】' },
    { prompt: '正文。\n【镜头视觉设定结束】' },
    { prompt: `正文。\n【镜头视觉设定】\n陆沉舟[[ref:${assets[1]}]]。\n【镜头视觉设定结束】`, excluded_visual_profile_ids: [lu.id] },
  ]
  for (const document of documents) {
    const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, ...document, prompt_document: true } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /系统区|参考已断开/)
  }
  assert.equal(calls, before)
})

test('image refinement rewrites only the body and restores bindings, mappings, parameters and style from saved data', async () => {
  const { project, input, shot } = await fixture()
  const tables = ['shots', 'visual_profiles', 'shot_visual_bindings', 'canvas_nodes', 'jobs']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  modelBody = '姜望坐在船边，微微低头补网。\n\n【镜头视觉设定】\n模型篡改的红衣和错误身份\n【镜头视觉设定结束】\n\n【图片参考图用途】\n参考图 1：错误人物\n【图片参考图用途结束】\n\n【生成参数约束】\n画面比例：1:1\n【生成参数约束结束】'
  const result = await refine(project.id, { ...input, prompt: withProjectStyle('应被结构正文替代的旧整稿', { version: 'old', source: 'settings', label: '照片写实', details: {} }),
    prompt_body: '姜望坐在船边，低头补网。', adjustment_request: '只强化低头动作。' })
  assert.equal(result.prompt_body, '姜望坐在船边，微微低头补网。')
  assert.match(captured, /原提示词：\n姜望坐在船边，低头补网。\n本次调整要求：\n只强化低头动作。/)
  assert.doesNotMatch(captured, /应被结构正文替代|源镜头旧图片描述|源镜头旧视频描述|画风：照片写实/)
  assert.match(captured, /只读上下文/)
  assert.match(result.prompt, /【镜头视觉设定】/)
  assert.match(result.prompt, /短发、灰褐短褂、左手背少量泥点/)
  assert.match(result.prompt, /【图片参考图用途】/)
  assert.match(result.prompt, /参考图\s*1[：:].*姜望/)
  assert.match(result.prompt, /参考图\s*2[：:].*陆沉舟/)
  assert.match(result.prompt, /画面比例：16:9/)
  assert.match(result.prompt, /输出分辨率：3840x2160/)
  assert.match(result.prompt, /厚涂仙侠动画/)
  assert.doesNotMatch(result.prompt, /篡改|错误人物|画风：照片写实|画面比例：1:1/)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before)
  assert.ok(all('SELECT * FROM shots WHERE id=?', shot.id).length)
})

test('continuing from a complete preview never includes system blocks in the new body or duplicates them', async () => {
  const { project, input } = await fixture()
  const first = await refine(project.id, input)
  modelBody = '继续整理后的近景正文。'
  const next = await refine(project.id, { ...input, prompt: first.prompt })
  const editableInput = captured.split('原提示词：\n')[1]?.split('\n本次调整要求：')[0]
  assert.equal(editableInput, first.prompt_body)
  assert.equal(next.prompt_body, modelBody)
  for (const name of ['镜头视觉设定', '图片参考图用途', '生成参数约束', '项目画风约束']) {
    assert.equal(next.prompt.split(`【${name}】`).length - 1, 1, name)
  }
})

test('image exclusions retain frozen definitions without image ownership while text mode does not add bound images', async () => {
  const { project, input, assets, lu } = await fixture()
  const excluded = await refine(project.id, { ...input, excluded_visual_profile_ids: [lu.id] })
  assert.match(captured, /青衣、腰间佩剑/)
  assert.match(excluded.prompt, /青衣、腰间佩剑/)
  assert.match(excluded.prompt, /人物：陆沉舟（登船装，版本 1）\n青衣、腰间佩剑/)
  const imageMapping = excluded.prompt.split('【图片参考图用途】')[1]!.split('【图片参考图用途结束】')[0]!
  assert.doesNotMatch(imageMapping, /陆沉舟/)
  const referenceLine = captured.split('\n').find(line => line.startsWith('实际参考图'))!
  assert.ok(referenceLine.includes(assets[0]!)); assert.ok(!referenceLine.includes(assets[1]!))
  const textOnly = await refine(project.id, { ...input, reference_asset_ids: [], visual_reference_mode: 'text_only' })
  assert.match(textOnly.prompt, /短发、灰褐短褂/)
  assert.doesNotMatch(textOnly.prompt, /【图片参考图用途】/)
})

test('an excluded reference changing its retained frozen definition invalidates the result', async () => {
  const { project, input, shot, lu } = await fixture()
  duringModel = () => run('UPDATE shot_visual_bindings SET definition=? WHERE shot_id=? AND profile_id=?', '陆沉舟的固定青衣设定发生更新', shot.id, lu.id)
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, excluded_visual_profile_ids: [lu.id],
  } })
  duringModel = undefined
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /已更新/)
})

test('video body refinement restores actual image purposes and the selected duration', async () => {
  const { project, input, assets } = await fixture()
  modelBody = '姜望先低头补网，然后抬头看向陆沉舟。固定机位。'
  const result = await refine(project.id, { ...input, stage: 'video_prompt', duration: 8,
    reference_asset_ids: [assets[1], assets[0]], video_reference_usages: [{ asset_id: assets[1], usage: 'identity' }, { asset_id: assets[0], usage: 'scale' }] })
  assert.equal(result.prompt_body, modelBody)
  assert.match(result.prompt, /【视频参考图用途】/)
  assert.match(result.prompt, /图片1：陆沉舟/)
  assert.match(result.prompt, /图片2：姜望/)
  assert.match(result.prompt, /视频时长：8 秒/)
  assert.doesNotMatch(result.prompt, /【图片参考图用途】/)
})

test('setting-board refinement restores profile requirements and base identity without applying shot layout prohibitions', async () => {
  const { project, jiang, assets } = await fixture()
  const { visual_profiles: [derived] } = await create(`/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'character', name: '姜望', variant: '手背溅泥', definition: '灰褐短褂，左手背溅少量泥点', view_requirements: '正侧背与左手背特写',
      base_profile_id: jiang.id, state_delta: '仅左手背少量泥点，其余保持基础版本' },
  ] })
  modelBody = '将正侧背视图排列整齐，突出左手背状态。'
  const result = await refine(project.id, { model_id: 'text-fixture', skill_ids: [], stage: 'image_prompt', profile_id: derived.id,
    prompt: '排列三视图与手部细节。', reference_asset_ids: [assets[2], assets[0]], ratio: '16:9' })
  assert.equal(result.prompt_body, modelBody)
  assert.match(result.prompt, /【设定图固定要求】/)
  assert.match(result.prompt, /正侧背与左手背特写/)
  assert.match(result.prompt, /基础图为参考图 2/)
  assert.match(result.prompt, /【基础身份参考】\n参考图 2/)
  assert.match(result.prompt, /仅左手背少量泥点/)
  assert.match(result.prompt, /设定板版式/)
  assert.doesNotMatch(result.prompt, /【镜头视觉设定】|【图片参考图用途】|不要复制设定板的多视角拼版/)
})

test('a setting change during refinement rejects the stale result without saving its draft', async () => {
  const { project, input, shot } = await fixture()
  duringModel = () => run('UPDATE shot_visual_bindings SET definition=? WHERE shot_id=?', '模型运行期间更新的固定设定', shot.id)
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: input })
  duringModel = undefined
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /已更新/)
  assert.equal(all('SELECT * FROM jobs').length, 0)
  assert.equal(all('SELECT * FROM canvas_nodes').length, 0)
})

test('an unrelated profile edit does not invalidate the current refinement', async () => {
  const { project, input } = await fixture()
  const { visual_profiles: updatedProfiles } = await create(`/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'prop', name: '其他场次的铜灯', definition: '黄铜灯罩', view_requirements: '正侧面' },
  ] })
  const unrelated = updatedProfiles.find((profile: any) => profile.name === '其他场次的铜灯')
  duringModel = () => run('UPDATE visual_profiles SET definition=? WHERE id=?', '另一场次改为旧铜灯', unrelated.id)
  const result = await refine(project.id, input)
  duringModel = undefined
  assert.equal(result.prompt_body, modelBody)
  assert.doesNotMatch(result.prompt, /另一场次改为旧铜灯/)
})

test('an unclosed model-generated system section uses the existing bounded correction and is never appended as prose', async () => {
  const { project, input } = await fixture(), before = calls
  modelResults = ['整理正文。\n\n【镜头视觉设定】\n错误而且没有结束标记', '修正后仅保留正文。']
  const result = await refine(project.id, input)
  assert.equal(calls, before + 2)
  assert.equal(result.prompt_body, '修正后仅保留正文。')
  assert.match(captured, /未闭合的系统固定区块/)
  assert.equal(result.prompt.split('【镜头视觉设定】').length - 1, 1)
  assert.doesNotMatch(result.prompt, /错误而且没有结束标记/)
})

function actualReferences() {
  const line = captured.split('\n').find(line => line.startsWith('实际参考图（按输入顺序）：'))!
  return JSON.parse(line.slice(line.indexOf('：') + 1)) as Array<Record<string, any>>
}

test('image-only bindings keep identity and independent-view purposes in the actual reference context', async () => {
  const { project, input, assets, shot, jiang, lu } = await fixture()
  const snapshot = { id: 'frozen-face', asset_id: assets[0], view: 'face', purpose: 'identity', label: '面部定型', revision: 1, style_version: null }
  run('UPDATE shot_visual_bindings SET usage=?, reference_assets=? WHERE shot_id=? AND profile_id=?', 'image', JSON.stringify([snapshot]), shot.id, jiang.id)
  run('UPDATE shot_visual_bindings SET usage=? WHERE shot_id=? AND profile_id=?', 'video', shot.id, lu.id)
  const result = await refine(project.id, input)
  const references = actualReferences()
  assert.equal(references.length, 1)
  assert.equal(references[0]!.id, assets[0])
  assert.equal(references[0]!.purpose, 'character')
  assert.equal(references[0]!.objects, '姜望')
  assert.equal(references[0]!.view, 'face')
  assert.equal(references[0]!.reference_purpose, 'identity')
  assert.equal(references[0]!.reference_label, '面部定型')
  assert.equal(references[0]!.reference_details[0].profile_id, jiang.id)
  assert.match(result.prompt, /参考图 1：姜望/)
  assert.match(result.prompt, /面部特写（面部定型）/)
  assert.doesNotMatch(result.prompt, /青衣、腰间佩剑/)
})

test('already-prepared chained replacements retain binding ownership and resolve body references against final order', async () => {
  const { project, input, assets } = await fixture()
  const result = await refine(project.id, { ...input,
    reference_asset_ids: [assets[1], assets[2]],
    prompt_body: `保持[[ref:${assets[0]}]]中的姜望身份，与参考图 1中的陆沉舟相望。`,
    prompt_reference_overrides: { [assets[0]!]: 'intermediate-reference', 'intermediate-reference': assets[2] },
  })
  assert.match(captured, /原提示词：\n保持参考图 2中的姜望身份，与参考图 1中的陆沉舟相望。/)
  assert.deepEqual(actualReferences().map(reference => [reference.id, reference.objects]), [[assets[1], '陆沉舟'], [assets[2], '姜望']])
  assert.match(result.prompt, /参考图 1：陆沉舟/)
  assert.match(result.prompt, /参考图 2：姜望/)
  assert.doesNotMatch(result.prompt, /\[\[ref:|intermediate-reference/)
})

test('mapped inactive and excluded references stay outside scope while shared active replacements remain', async () => {
  const { project, input, assets, shot, lu } = await fixture()
  run('UPDATE shot_visual_bindings SET usage=? WHERE shot_id=? AND profile_id=?', 'video', shot.id, lu.id)
  await refine(project.id, { ...input, reference_asset_ids: [assets[0], assets[2]], prompt_reference_overrides: { [assets[1]!]: assets[2] } })
  assert.deepEqual(actualReferences().map(reference => reference.id), [assets[0]])
  run('UPDATE shot_visual_bindings SET usage=? WHERE shot_id=? AND profile_id=?', 'both', shot.id, lu.id)
  await refine(project.id, { ...input, reference_asset_ids: [assets[0], assets[2]], excluded_visual_profile_ids: [lu.id],
    prompt_reference_overrides: { [assets[1]!]: assets[2] } })
  assert.deepEqual(actualReferences().map(reference => reference.id), [assets[0]])
  await refine(project.id, { ...input, reference_asset_ids: [assets[2]], excluded_visual_profile_ids: [lu.id],
    prompt_reference_overrides: { [assets[0]!]: assets[2], [assets[1]!]: assets[2] } })
  const references = actualReferences()
  assert.equal(references[0]!.objects, '姜望')
  assert.equal(references.length, 1)
})

test('video replacements remap storyboard and per-image purposes and reject merged conflicting uses', async () => {
  const { project, input, assets } = await fixture()
  const options = { ...input, stage: 'video_prompt', reference_asset_ids: [assets[2]],
    storyboard_reference_asset_id: assets[0], prompt_reference_overrides: { [assets[0]!]: assets[2], [assets[1]!]: assets[2] },
    video_reference_usages: [{ asset_id: assets[0], usage: 'identity' }, { asset_id: assets[1], usage: 'identity' }] }
  const result = await refine(project.id, options)
  const references = actualReferences()
  assert.equal(references.length, 1)
  assert.equal(references[0]!.id, assets[2])
  assert.equal(references[0]!.purpose, 'storyboard')
  assert.equal(references[0]!.usage, 'identity')
  assert.match(references[0]!.objects, /姜望/)
  assert.match(references[0]!.objects, /陆沉舟/)
  assert.match(result.prompt, /图片1：分镜构图/)
  const before = calls
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...options, video_reference_usages: [{ asset_id: assets[0], usage: 'identity' }, { asset_id: assets[1], usage: 'scale' }],
  } })
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /冲突用途/)
  assert.equal(calls, before)
})

test('invalid replacement graphs, foreign final images and disconnected body references fail before the model', async () => {
  const { project, input, assets, lu } = await fixture()
  const foreign = await fixture()
  const invalid = [
    { prompt_reference_overrides: { [assets[0]!]: assets[2], [assets[2]!]: assets[0] } },
    { prompt_reference_overrides: { [assets[0]!]: foreign.assets[0] }, reference_asset_ids: [foreign.assets[0]] },
    { prompt_body: `保留[[ref:${assets[1]}]]身份。`, excluded_visual_profile_ids: [lu.id] },
  ]
  const before = calls
  for (const options of invalid) {
    const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, ...options } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /循环|当前项目|参考已断开/)
  }
  assert.equal(calls, before)
})

test('a replaced final asset changing in flight invalidates the refinement snapshot', async () => {
  const { project, input, assets } = await fixture()
  duringModel = () => run('UPDATE assets SET filename=? WHERE id=?', '已经更新的替换图.png', assets[2]!)
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, reference_asset_ids: [assets[2], assets[1]], prompt_reference_overrides: { [assets[0]!]: assets[2] },
  } })
  duringModel = undefined
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /已更新/)
})

test('document parameter conflicts fail before the model and do not mutate any generation state', async () => {
  const { project, input } = await fixture(), beforeCalls = calls
  const tables = ['shots', 'visual_profiles', 'shot_visual_bindings', 'canvas_nodes', 'asset_tasks', 'jobs']
  const before = tables.map(table => all(`SELECT * FROM ${table}`))
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, prompt_document: true, prompt: '补网动作。\n\n【图片生成要求】\n画面比例：9:16\n清晰度要求：2K\n【图片生成要求结束】',
  } })
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /画面比例.*16:9/)
  assert.match(response.body, /清晰度要求.*4K/)
  assert.equal(calls, beforeCalls)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), before)
})

test('model-introduced explicit parameter conflicts use bounded correction before returning a valid body', async () => {
  const { project, input } = await fixture(), before = calls
  modelResults = ['补网动作。\n画面比例：9:16', '补网动作。']
  const result = await refine(project.id, { ...input, prompt_document: true, prompt: '补网动作。' })
  assert.equal(calls, before + 2)
  assert.equal(result.prompt, '补网动作。')
})

test('current document reference purposes are readonly model context and saved default uses are absent', async () => {
  const { project, input, assets } = await fixture()
  const block = '【视频参考图用途】\n图片1仅参考旧木材质，不约束人物身份；图片2仅参考光线。\n【视频参考图用途结束】'
  const result = await refine(project.id, { ...input, stage: 'video_prompt', prompt_document: true,
    prompt: `姜望补网动作保持连贯。\n\n${block}`, reference_asset_ids: assets.slice(0, 2),
    video_reference_usages: [{ asset_id: assets[0], usage: 'identity' }],
  })
  const context = JSON.parse(captured.split('当前文档只读结构上下文：')[1]!.split('\n')[0]!)
  assert.deepEqual(context.sections, [{ name: '视频参考图用途', content: '图片1仅参考旧木材质，不约束人物身份；图片2仅参考光线。' }])
  const references = JSON.parse(captured.split('实际参考图（按输入顺序）：')[1]!.split('\n')[0]!)
  assert.deepEqual(Object.keys(references[0]).sort(), ['id', 'image_number', 'name'])
  assert.doesNotMatch(captured, /usage_instruction|短发、灰褐短褂|青衣、腰间佩剑|厚涂仙侠动画/)
  assert.deepEqual(getManagedPromptBlocks(result.prompt), [block])
})

test('an explicitly connected inactive character is retained without restoring removed settings or changing protected sections', async () => {
  const { project, input, assets, shot, lu } = await fixture()
  run('UPDATE shot_visual_bindings SET usage=? WHERE shot_id=? AND profile_id=?', 'none', shot.id, lu.id)
  const block = '【镜头视觉设定】\n姜望保留创作者修改的赭红披肩。\n【镜头视觉设定结束】'
  modelBody = '姜望仍坐在左侧补网。'
  const excluded = await refine(project.id, { ...input, prompt_document: true, prompt: `姜望坐在左侧补网。\n\n${block}` })
  assert.deepEqual(excluded.reference_asset_ids, [assets[0]])
  const connected = await refine(project.id, { ...input, explicit_reference_asset_ids: [assets[1]],
    prompt_document: true, prompt: `姜望坐在左侧补网。\n\n${block}` })
  assert.deepEqual(connected.reference_asset_ids, assets.slice(0, 2))
  const identities = JSON.parse(captured.split('已选图片身份标签（仅用于识别素材归属，不是恢复已删除设定或默认用途的依据）：')[1]!.split('\n')[0]!)
  assert.equal(identities[0].profiles[0].name, '陆沉舟')
  assert.equal(identities[0].asset_id, assets[1])
  assert.deepEqual(Object.keys(identities[0].profiles[0]).sort(), ['kind', 'name', 'profile_id', 'variant'])
  assert.doesNotMatch(captured, /青衣、腰间佩剑|短发、灰褐短褂/)
  assert.deepEqual(getManagedPromptBlocks(connected.prompt), [block])
  assert.doesNotMatch(connected.prompt, /【图片参考图用途】|【项目画风约束】/)
})

test('an explicit new-character request corrects purpose-only output into a visible character with the matching image', async () => {
  const { project, input, assets, shot, lu } = await fixture(), before = calls
  run('UPDATE shot_visual_bindings SET usage=? WHERE shot_id=? AND profile_id=?', 'none', shot.id, lu.id)
  const block = '【生成参数约束】\n画面比例：16:9\n【生成参数约束结束】'
  modelResults = ['姜望坐在船边补网；参考图1只用于陆沉舟的人物身份、面部和服装。', '姜望坐在船边补网。陆沉舟站在画面右侧准备登船，外观依据参考图1。']
  semanticResults = [semanticIssueFixture('character_presence', '未落实新增人物“陆沉舟”。', { adjustment: '加入这个新角色' }), semanticReviewFixture()]
  const result = await refine(project.id, { ...input, reference_asset_ids: [assets[1], assets[0]], explicit_reference_asset_ids: [assets[1]],
    prompt_document: true, prompt: `姜望坐在船边补网。\n\n${block}`,
    adjustment_request: `将[[ref:${assets[1]}]]作为陆沉舟的人物参考，加入这个新角色。` })
  assert.equal(calls, before + 2)
  assert.match(captured, /未落实新增人物“陆沉舟”/)
  assert.match(captured, /本次调整要求：\n将参考图 1作为陆沉舟的人物参考，加入这个新角色。/)
  assert.match(result.prompt_body, /陆沉舟站在画面右侧.*参考图 1/)
  assert.deepEqual(result.reference_asset_ids, [assets[1], assets[0]])
  assert.deepEqual(getManagedPromptBlocks(result.prompt), [block])
})

test('unknown adjustment tokens and invalid explicit selections fail before model calls', async () => {
  const { project, input, assets } = await fixture(), before = calls
  for (const options of [
    { adjustment_request: '加入[[ref:unconnected-image]]中的人物。' },
    { explicit_reference_asset_ids: [assets[2]] },
  ]) {
    const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: { ...input, ...options } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /参考已断开|图片身份对应错误|必须属于当前参考列表/)
  }
  assert.equal(calls, before)
})

test('continuing from a saved purpose-only draft still corrects the requested new character into the visible scene', async () => {
  const { project, input, assets, shot, lu } = await fixture(), before = calls
  run('UPDATE shot_visual_bindings SET usage=? WHERE shot_id=? AND profile_id=?', 'none', shot.id, lu.id)
  const purposeOnly = '姜望坐在船边补网；参考图1只用于陆沉舟的人物身份、面部和服装。'
  const block = '【生成参数约束】\n画面比例：16:9\n【生成参数约束结束】'
  modelResults = [purposeOnly, '姜望坐在船边补网。陆沉舟站在右侧准备登船，人物外观参考图1。']
  semanticResults = [semanticIssueFixture('character_presence', '未落实新增人物“陆沉舟”。', { adjustment: '加入这个新角色' }), semanticReviewFixture()]
  const result = await refine(project.id, { ...input, reference_asset_ids: [assets[1], assets[0]], explicit_reference_asset_ids: [assets[1]],
    prompt_document: true, prompt: `${purposeOnly}\n\n${block}`,
    adjustment_request: `将[[ref:${assets[1]}]]作为陆沉舟的人物参考，加入这个新角色，保留姜望。` })
  assert.equal(calls, before + 2)
  assert.match(captured, /未落实新增人物“陆沉舟”/)
  assert.match(captured, /加入这个新角色，保留姜望/)
  assert.match(result.prompt_body, /陆沉舟站在右侧.*参考图 1/)
  assert.deepEqual(getManagedPromptBlocks(result.prompt), [block])
})

test('wrong image identity in the model body receives bounded correction and valid bodies keep final image order', async () => {
  const { project, input, assets } = await fixture(), before = calls
  modelResults = ['姜望坐在左侧。陆沉舟站在右侧，将参考图1作为陆沉舟的人物参考。', '姜望坐在左侧。陆沉舟站在右侧，将参考图2作为陆沉舟的人物参考。']
  semanticResults = [semanticIssueFixture('reference_identity', '图片身份对应错误：陆沉舟引用了姜望的人物图。', { adjustment: '加入陆沉舟' }), semanticReviewFixture()]
  const result = await refine(project.id, { ...input, prompt_document: true, prompt: '姜望坐在左侧。',
    explicit_reference_asset_ids: [assets[1]], adjustment_request: `加入陆沉舟，人物外观使用[[ref:${assets[1]}]]。` })
  assert.equal(calls, before + 2)
  assert.match(captured, /图片身份对应错误/)
  assert.match(result.prompt_body, /参考图 2/)
  assert.deepEqual(result.reference_asset_ids, assets.slice(0, 2))
})

test('a model that repeatedly omits the explicitly added character retains a draft requiring work', async () => {
  const { project, input, assets } = await fixture(), before = calls
  const tables = ['shots', 'shot_visual_bindings', 'canvas_nodes', 'jobs']
  const saved = tables.map(table => all(`SELECT * FROM ${table}`))
  modelResults = ['姜望坐在船边；参考图2只用于陆沉舟人物外观。', '姜望坐在船边；参考图2只用于陆沉舟人物外观。']
  semanticResults = [semanticIssueFixture('character_presence', '未落实新增人物“陆沉舟”。', { adjustment: '加入陆沉舟作为新角色' })]
  const response = await refineApp.inject({ method: 'POST', url: `/api/projects/${project.id}/skills/refine-prompt`, payload: {
    ...input, prompt_document: true, prompt: '姜望坐在船边。', explicit_reference_asset_ids: [assets[1]],
    adjustment_request: `加入陆沉舟作为新角色，外观使用[[ref:${assets[1]}]]。`,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().quality.status, 'needs_work')
  assert.match(response.body, /未落实新增人物/)
  assert.equal(calls, before + 2)
  assert.deepEqual(tables.map(table => all(`SELECT * FROM ${table}`)), saved)
})
