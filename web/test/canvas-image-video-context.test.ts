import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { ProjectDetail, ShotVisualBinding } from '../src/shared/api/api'
import { applyImageVideoContext, imageVideoContentSignature, imageVideoSourceContext } from '../src/features/canvas/canvas-image-video-context'
import { parsePromptSectionDocument, reconcilePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { extractPromptReferenceIds } from '@video-studio/shared/visuals/prompt-references'
import { extractPromptBody } from '@video-studio/shared/visuals/prompt-document'

function fixture() {
  const source = { id: 'image', type: 'generation', title: '新画面', prompt: '旧人物独自站在门前', text: '',
    asset_id: 'frame', shot_id: 'shot', model_id: null, job_id: null, x: 0, y: 0, width: 300, height: 250,
    settings: { modality: 'image', visual_reference_mode: 'profiles' } } as CanvasNode
  const input = { ...source, id: 'peiyan', title: '裴砚 · 执卷官常态', asset_id: 'peiyan-board', shot_id: null,
    settings: { visual_profile_id: 'peiyan-profile' } } as CanvasNode
  const binding = { shot_id: 'shot', profile_id: 'peiyan-profile', kind: 'character', name: '裴砚', variant: '执卷官常态',
    revision: 1, definition: '手持卷宗的执卷官', view_requirements: '', board_asset_id: 'peiyan-board', required: false, usage: 'none' } as ShotVisualBinding
  const detail = { id: 'project', shots: [{ id: 'shot', prompt: '旧人物独自站在门前', image_prompt: '旧人物静止',
    video_prompt: '旧人物独自在门前推镜头', duration: 5, end_state: '停在门边', cut_note: '保持视线连续' }],
    assets: ['frame', 'peiyan-board', 'replacement', 'video-only', 'removed'].map(id => ({ id, project_id: 'project', kind: 'image', filename: `${id}.png` })),
    shot_visual_bindings: [binding], visual_profiles: [], jobs: [], script: { scenes: [], artifacts: [] },
    project_visual_style: { version: 'v1', source: 'settings', label: '水墨', details: {} } } as unknown as ProjectDetail
  const graph = { nodes: [source, input], edges: [], revision: 'one' } as CanvasGraph
  const video = { ...source, id: 'video', title: '视频', prompt: '旧视频正文', text: '', asset_id: null,
    settings: { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe',
      storyboard_reference_asset_id: 'frame', duration: 6, ratio: 'adaptive', resolution: '720p' } } as CanvasNode
  return { source, input, detail, graph, video, binding }
}

test('content signatures are stable across property order and distinct for meaningful values', () => {
  assert.equal(imageVideoContentSignature({ a: 1, z: { b: 3, a: 2 } }), imageVideoContentSignature({ z: { a: 2, b: 3 }, a: 1 }))
  assert.notEqual(imageVideoContentSignature({ ids: ['a', 'b'] }), imageVideoContentSignature({ ids: ['b', 'a'] }))
})

test('unchanged automatic sources retain the original video node without introducing new settings', () => {
  const f = fixture()
  const context = imageVideoSourceContext(f.graph, f.source, f.detail, [])
  assert.equal(context.customized, false)
  assert.equal(applyImageVideoContext(f.video, context, f.detail, []), f.video)
})

test('unavailable fixed source images block handoff instead of silently dropping a selected reference', () => {
  const f = fixture()
  const graph = { ...f.graph, edges: [{ id: 'missing', source: f.input.id, target: f.source.id, reference_asset_id: 'missing-image' }] }
  assert.throws(() => imageVideoSourceContext(graph, f.source, f.detail, []), /参考已失效/)
})

test('identity label changes refresh the source signature while unrelated asset labels do not', () => {
  const f = fixture(), source = { ...f.source, settings: { ...f.source.settings, prompt_body: '[[ref:peiyan-board]]站在左侧。' } }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'reference', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' }] }
  const initial = imageVideoSourceContext(graph, source, f.detail, [])
  const renamed = { ...f.detail, shot_visual_bindings: [{ ...f.binding, name: '裴大人', variant: '朝服' }] }
  assert.notEqual(imageVideoSourceContext(graph, source, renamed, []).signature, initial.signature)
  const unrelated = { ...f.detail, assets: f.detail.assets.map(asset => asset.id === 'removed' ? { ...asset, filename: '无关更名.png' } : asset) }
  assert.equal(imageVideoSourceContext(graph, source, unrelated, []).signature, initial.signature)
})

test('an explicit prop definition updates the handoff signature while unrelated library definitions stay independent', () => {
  const f = fixture()
  const prop = { id: 'ruler-profile', kind: 'prop', name: '巡天尺', variant: '黑铁', revision: 1,
    definition: '黑铁直尺，尺身有三道刻纹。', view_requirements: '结构与握柄', board_asset_id: 'replacement', reference_assets: [] } as unknown as NonNullable<ProjectDetail['visual_profiles']>[number]
  const unrelated = { ...prop, id: 'other-profile', name: '无关道具', board_asset_id: 'removed' }
  const detail = { ...f.detail, visual_profiles: [prop, unrelated] }
  const source = { ...f.source, settings: { ...f.source.settings, prompt_body: '手持[[ref:replacement]]，保持右手握姿。' } }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'ruler', source: f.input.id, target: source.id, reference_asset_id: 'replacement' }] }
  const initial = imageVideoSourceContext(graph, source, detail, [])
  const updated = { ...detail, visual_profiles: [{ ...prop, definition: '黑铁直尺，尺身有五道刻纹。' }, unrelated] }
  assert.notEqual(imageVideoSourceContext(graph, source, updated, []).signature, initial.signature)
  const irrelevantUpdate = { ...detail, visual_profiles: [prop, { ...unrelated, definition: '无关的新定义。' }] }
  assert.equal(imageVideoSourceContext(graph, source, irrelevantUpdate, []).signature, initial.signature)
  assert.match(applyImageVideoContext({ ...f.video, settings: { ...f.video.settings, mode: 'reference', visual_reference_mode: 'profiles' } },
    initial, detail, []).text, /道具：巡天尺（黑铁，版本 1）；\[\[ref:replacement\]\]/)
})

test('only the chosen view semantics affect handoff reuse, independent of profile timestamps and sibling view edits', () => {
  const f = fixture()
  const view = { id: 'detail-ref', asset_id: 'replacement', view: 'detail', purpose: 'detail', label: '握柄细节', revision: 1,
    style_version: null, status: 'confirmed', profile_id: 'ruler', created_at: 'old', updated_at: 'old' }
  const sibling = { ...view, id: 'side-ref', asset_id: 'removed', view: 'side', purpose: 'structure', label: '侧面' }
  const prop = { id: 'ruler', kind: 'prop', name: '巡天尺', variant: '黑铁', revision: 1, definition: '黑铁直尺。',
    view_requirements: '结构与握柄', board_asset_id: null, reference_assets: [view, sibling] } as unknown as NonNullable<ProjectDetail['visual_profiles']>[number]
  const source = { ...f.source, settings: { ...f.source.settings, prompt_body: '手握[[ref:replacement]]。' } }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'ruler-view', source: f.input.id, target: source.id, reference_asset_id: 'replacement' }] }
  const detail = { ...f.detail, visual_profiles: [prop] }
  const initial = imageVideoSourceContext(graph, source, detail, []).signature
  const profileWithViews = (references: typeof view[]) => ({ ...prop, reference_assets: references } as unknown as typeof prop)
  assert.notEqual(imageVideoSourceContext(graph, source, { ...detail, visual_profiles: [profileWithViews([{ ...view, label: '新的握柄细节' }, sibling])] }, []).signature, initial)
  assert.equal(imageVideoSourceContext(graph, source, { ...detail, visual_profiles: [profileWithViews([
    { ...view, updated_at: 'new' }, { ...sibling, label: '无关的背面视图' },
  ])] }, []).signature, initial)
})

test('fixed inactive references, replacements and exclusions match effective image inputs without changing shot usage', () => {
  const f = fixture()
  const source = { ...f.source, settings: { ...f.source.settings, prompt_reference_overrides: { 'peiyan-board': 'replacement', removed: null },
    excluded_visual_profile_ids: ['excluded'] } }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'manual', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' }] }
  const context = imageVideoSourceContext(graph, source, f.detail, [])
  assert.equal(context.customized, true)
  assert.deepEqual(context.referenceAssetIds, ['replacement'])
  assert.deepEqual(context.promptReferenceOverrides, { 'peiyan-board': 'replacement', removed: null })
  assert.deepEqual(context.excludedVisualProfileIds, ['excluded'])
  assert.equal(context.referenceLabels.replacement, '裴砚（执卷官常态）')
  assert.match(applyImageVideoContext(f.video, { ...context, body: '[[ref:peiyan-board]]作为裴砚的人物参考。' }, f.detail, []).text,
    /首帧中的裴砚（执卷官常态）/)
  assert.equal(f.detail.shot_visual_bindings![0].usage, 'none')
  assert.equal(context.signature, imageVideoSourceContext({ ...graph, revision: 'later' }, { ...source, x: 800 }, f.detail, []).signature)
  assert.notEqual(context.signature, imageVideoSourceContext(graph, { ...source, settings: { ...source.settings,
    prompt_reference_overrides: { 'peiyan-board': null } } }, f.detail, []).signature)
})

test('source section prose is authoritative, image boilerplate is removed, and first-frame tokens become identities', () => {
  const f = fixture()
  const body = '生成当前镜头的单幅首帧画面。固定一个瞬间，明确主体、场景、景别、构图、光线与材质；动作过程只用于理解情境，不表现多个时间点或分格。\n\n裴砚站在陆照左后方，怀抱卷宗。[[ref:peiyan-board]]只用于裴砚外貌。固定机位，保持画面安静。'
  const document = `${body}\n\n【图片生成要求】\n画面比例：9:16\n【图片生成要求结束】`
  const source = { ...f.source, text: '过时的text缓存', settings: { ...f.source.settings, prompt_is_final: true,
    prompt_body: '过时的body缓存', prompt_sections: parsePromptSectionDocument(document, { sourceText: document }) } }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'manual', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' }] }
  const context = imageVideoSourceContext(graph, source, f.detail, [])
  assert.match(context.body, /裴砚站在陆照左后方/)
  assert.doesNotMatch(context.body, /过时|图片生成要求/)
  const result = applyImageVideoContext(f.video, context, f.detail, [])
  assert.match(result.text, /裴砚站在陆照左后方，怀抱卷宗/)
  assert.match(result.text, /首帧中的裴砚（执卷官常态）/)
  assert.match(result.text, /固定机位，保持画面安静/)
  assert.match(result.text, /连续视频镜头/)
  assert.doesNotMatch(result.text, /旧人物|单幅首帧|固定一个瞬间|图片生成要求/)
  assert.deepEqual(extractPromptReferenceIds(result.text), [])
  assert.match(result.text, /视频时长：6 秒/)
  assert.match(result.text, /清晰度要求：720p/)
  assert.equal(result.settings.prompt_body, extractPromptBody({ prompt: result.text }))
  assert.equal(result.settings.prompt_sections?.blocks.some(block => block.pendingSourceText !== undefined), false)
})

test('multi-reference video preserves canonical tokens and adds active video identities after the current frame', () => {
  const f = fixture()
  const source = { ...f.source, settings: { ...f.source.settings, prompt_body: '裴砚入镜，[[ref:peiyan-board]]用于裴砚。',
    prompt_reference_overrides: { 'peiyan-board': 'replacement' } } }
  const detail = { ...f.detail, shot_visual_bindings: [f.binding, { ...f.binding, profile_id: 'second-profile',
    name: '巡夜人', usage: 'video' as const, board_asset_id: 'video-only' }] }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'manual', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' }] }
  const context = imageVideoSourceContext(graph, source, detail, [])
  const video = { ...f.video, settings: { ...f.video.settings, mode: 'reference' as const, visual_reference_mode: 'profiles' as const } }
  const result = applyImageVideoContext(video, context, detail, [])
  assert.match(result.settings.prompt_body!, /\[\[ref:replacement\]\]/)
  assert.deepEqual(extractPromptReferenceIds(result.settings.prompt_template!).sort(), ['frame', 'replacement', 'video-only'].sort())
  assert.match(result.settings.prompt_template!, /\[\[ref:frame\]\]：分镜构图/)
  assert.match(result.settings.prompt_template!, /\[\[ref:replacement\]\]：裴砚（执卷官常态）.*人物身份、面部/)
  assert.doesNotMatch(result.text, /旧人物/)
  assert.match(result.text, /裴砚/)
  assert.match(result.text, /巡夜人/)
  assert.deepEqual(result.settings.prompt_reference_overrides, { 'peiyan-board': 'replacement' })
})

test('custom visual sections and deleted style survive with the video template as their baseline', () => {
  const f = fixture()
  const original = '陆照站在门边。\n\n【镜头视觉设定】\n旧设定\n【镜头视觉设定结束】\n\n【项目画风约束】\n画风：水墨\n【项目画风约束结束】'
  const sections = parsePromptSectionDocument(original, { sourceText: original })
  const visual = sections.blocks.find(block => block.name === '镜头视觉设定')!
  visual.text = '【镜头视觉设定】\n裴砚站在陆照左后方，服装参考[[ref:peiyan-board]]。\n【镜头视觉设定结束】'
  const style = sections.blocks.find(block => block.name === '项目画风约束')!
  style.text = ''; style.deleted = true
  const source = { ...f.source, settings: { ...f.source.settings, prompt_sections: sections } }
  const graph = { ...f.graph, nodes: [source, f.input], edges: [{ id: 'manual', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' }] }
  const context = imageVideoSourceContext(graph, source, f.detail, [])
  const result = applyImageVideoContext(f.video, context, f.detail, [])
  assert.match(result.text, /裴砚站在陆照左后方，服装参考首帧中的裴砚/)
  assert.doesNotMatch(result.text, /旧设定|项目画风约束/)
  const inheritedStyle = result.settings.prompt_sections!.blocks.find(block => block.name === '项目画风约束')!
  assert.equal(inheritedStyle.deleted, true)
  assert.match(inheritedStyle.sourceText!, /水墨/)
  const reopened = reconcilePromptSectionDocument(result.settings.prompt_sections!, result.settings.prompt_template!, { body: result.settings.prompt_body })
  assert.equal(reopened.blocks.some(block => block.pendingSourceText !== undefined), false)
  assert.equal(reopened.blocks.find(block => block.name === '项目画风约束')?.deleted, true)
  const changed = structuredClone(sections)
  changed.blocks.find(block => block.name === '镜头视觉设定')!.text += '新要求'
  assert.notEqual(context.signature, imageVideoSourceContext(graph, { ...source,
    settings: { ...source.settings, prompt_sections: changed } }, f.detail, []).signature)
})

test('connected text is included once when no final body has already incorporated it', () => {
  const f = fixture()
  const input = { ...f.input, id: 'text', type: 'text' as const, text: '新增裴砚站在门边。', asset_id: null, settings: {} }
  const graph = { ...f.graph, nodes: [f.source, input], edges: [{ id: 'text-input', source: input.id, target: f.source.id }] }
  const context = imageVideoSourceContext(graph, f.source, f.detail, [])
  assert.equal(context.customized, true)
  assert.equal(context.body.match(/新增裴砚/g)?.length, 1)
  const source = { ...f.source, settings: { ...f.source.settings, prompt_body: context.body, prompt_is_final: true } }
  const saved = imageVideoSourceContext(graph, source, f.detail, [])
  assert.equal(saved.body.match(/新增裴砚/g)?.length, 1)
})

test('new connected instructions rebase into an already saved body without losing its authored additions', () => {
  const f = fixture()
  const source = { ...f.source, text: '旧人物独自站在门前，身披蓝袍。', settings: { ...f.source.settings,
    prompt_is_final: true, prompt_body: '旧人物独自站在门前，身披蓝袍。', prompt_base: f.source.prompt,
    prompt_template: f.source.prompt } }
  const input = { ...f.input, id: 'text', type: 'text' as const, text: '新增裴砚站在门边。', asset_id: null, settings: {} }
  const graph = { ...f.graph, nodes: [source, input], edges: [{ id: 'text-input', source: input.id, target: source.id }] }
  const context = imageVideoSourceContext(graph, source, f.detail, [])
  assert.match(context.body, /新增裴砚站在门边/)
  assert.match(context.body, /身披蓝袍/)
})

test('legacy numbered references follow the active image list after removal shifts image one', () => {
  const f = fixture()
  const body = '参考图1用于新角色。'
  const source = { ...f.source, text: body, settings: { ...f.source.settings, prompt_is_final: true,
    prompt_body: body, prompt_base: body, prompt_template: body, prompt_reference_overrides: { 'peiyan-board': null } } }
  const input = { ...f.input, id: 'new-character', title: '新角色', asset_id: 'video-only', settings: {} }
  const graph = { ...f.graph, nodes: [source, f.input, input], edges: [
    { id: 'old', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' },
    { id: 'new', source: input.id, target: source.id, reference_asset_id: 'video-only' },
  ] }
  const context = imageVideoSourceContext(graph, source, f.detail, [])
  assert.deepEqual(context.referenceAssetIds, ['video-only'])
  assert.equal(context.body, '[[ref:video-only]]用于新角色。')
  const result = applyImageVideoContext(f.video, context, f.detail, [])
  assert.match(result.settings.prompt_body!, /首帧中的新角色用于新角色/)
  assert.doesNotMatch(result.settings.prompt_body!, /裴砚/)
})

test('replacement deduplication renumbers legacy references while existing stable identities remain unchanged', () => {
  const f = fixture()
  const body = '参考图1用于新角色，参考图2用于场景。[[ref:peiyan-board]]保持原来的身份。'
  const original = `${body}\n\n【镜头视觉设定】\n参考图1用于角色\n【镜头视觉设定结束】`
  const sections = parsePromptSectionDocument(original, { sourceText: original })
  sections.blocks.find(block => block.name === '镜头视觉设定')!.text = '【镜头视觉设定】\n参考图1用于新角色\n【镜头视觉设定结束】'
  const source = { ...f.source, text: original, settings: { ...f.source.settings, prompt_is_final: true,
    prompt_body: body, prompt_base: body, prompt_template: original, prompt_sections: sections,
    prompt_reference_overrides: { 'peiyan-board': 'replacement' } } }
  const second = { ...f.input, id: 'second', asset_id: 'video-only', settings: {} }
  const third = { ...f.input, id: 'third', asset_id: 'replacement', settings: {} }
  const graph = { ...f.graph, nodes: [source, f.input, second, third], edges: [
    { id: 'old', source: f.input.id, target: source.id, reference_asset_id: 'peiyan-board' },
    { id: 'second', source: second.id, target: source.id, reference_asset_id: 'video-only' },
    { id: 'third', source: third.id, target: source.id, reference_asset_id: 'replacement' },
  ] }
  const context = imageVideoSourceContext(graph, source, f.detail, [])
  assert.deepEqual(context.referenceAssetIds, ['replacement', 'video-only'])
  assert.equal(context.body, '[[ref:replacement]]用于新角色，[[ref:video-only]]用于场景。[[ref:peiyan-board]]保持原来的身份。')
  assert.match(context.customizedSections[0].text, /\[\[ref:replacement\]\]用于新角色/)
  const video = { ...f.video, settings: { ...f.video.settings, mode: 'reference' as const, visual_reference_mode: 'profiles' as const } }
  const result = applyImageVideoContext(video, context, f.detail, [])
  assert.match(result.settings.prompt_body!, /\[\[ref:replacement\]\]保持原来的身份/)
  assert.doesNotMatch(result.settings.prompt_body!, /\[\[ref:peiyan-board\]\]/)
})

for (const sync_mode of ['locked', 'follow'] as const) test(`${sync_mode} dynamic profile connections use the shot board snapshot and preserve explicit pins`, () => {
  const f = fixture()
  const binding = { ...f.binding, board_asset_id: 'peiyan-board', reference_assets: [], usage: 'image' as const,
    sync_mode, reference_selection: 'manual' as const }
  const detail = { ...f.detail, shot_visual_bindings: [binding], visual_profiles: [{ ...binding, id: binding.profile_id, board_asset_id: 'replacement' }] } as ProjectDetail
  const input = { ...f.input, asset_id: 'replacement', settings: { ...f.input.settings, visual_profile_id: binding.profile_id } }
  const source = { ...f.source, settings: { ...f.source.settings, visual_reference_mode: 'profiles' as const } }
  const graph = { ...f.graph, nodes: [source, input], edges: [{ id: 'dynamic', source: input.id, target: source.id }] }
  assert.deepEqual(imageVideoSourceContext(graph, source, detail, []).referenceAssetIds, ['peiyan-board'])
  assert.deepEqual(imageVideoSourceContext({ ...graph, edges: [{ ...graph.edges[0], reference_asset_id: 'replacement' }] }, source, detail, []).referenceAssetIds,
    ['replacement', 'peiyan-board'], 'a manually pinned newer image remains an explicit extra input')
  const missing = { ...detail, shot_visual_bindings: [{ ...binding, board_asset_id: null }] }
  assert.deepEqual(imageVideoSourceContext(graph, source, missing, []).referenceAssetIds, [], 'an empty snapshot cannot use the profile latest board')
})
