import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasNodeProposalFingerprint, type CanvasNodeProposal, type CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import { serializePromptSectionDocument, reconcilePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { addCanvasNodeProposalDraft, assertCanvasNodeProposalCurrent } from '../src/features/canvas/canvas-node-proposal'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { Model, ProjectDetail, Provider } from '../src/shared/api/api'

const model: Model = { id: 'model', provider_id: 'provider', name: '视频', remote_id: 'video', protocol: 'async_video', modality: 'video', enabled: true,
  settings: { supported_modes: ['text', 'reference', 'first_frame', 'first_last_frame', 'edit', 'extend'], ratios: ['9:16'], resolutions: ['720p'],
    request_template: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}', resolution: '{{resolution}}', duration: '{{duration}}', audio: '{{generate_audio}}' } } }
const providers = [{ id: 'provider', enabled: true, adapter: 'http' } as Provider]
const sourceNode: CanvasNode = { id: 'source', type: 'generation', title: '原镜头', x: 0, y: 0, width: 440, height: 420,
  text: '', prompt: '人物回头。', asset_id: 'result', job_id: 'finished-job', shot_id: null, model_id: model.id,
  settings: { modality: 'video', mode: 'reference', duration: 8, resolution: '720p', ratio: '9:16', candidate_count: 3 } }
const graph: CanvasGraph = { revision: 'r1', nodes: [sourceNode,
  { ...sourceNode, id: 'known-image', type: 'image', asset_id: 'front', job_id: null, model_id: null, settings: {} }], edges: [] }
const detail = { id: 'project', updated_at: 'updated-1', shots: [], historical_shots: [], visual_profiles: [], shot_visual_bindings: [],
  assets: ['front', 'side', 'video'].map(id => ({ id, project_id: 'project', kind: id === 'video' ? 'video' : 'image', filename: `${id}.png` })) } as unknown as ProjectDetail
async function fixture(mode: CanvasNodeProposalSource['mode'] = 'reference'): Promise<CanvasNodeProposal> {
  const source: CanvasNodeProposalSource = { project_id: detail.id, project_updated_at: detail.updated_at, project_style_version: null,
    canvas_id: 'canvas', canvas_revision: graph.revision, source_node_id: sourceNode.id, source_fingerprint: await canvasNodeProposalFingerprint(graph, sourceNode.id),
    model_id: model.id, modality: 'video', mode, prompt: '人物回头，图片1保持身份，图片2补充侧面。',
    parameters: { ratio: '9:16', resolution: '720p', duration: 8, generate_audio: true, draft: true, clarity: null, quality: null, background: null, candidate_count: 3 },
    reference_assets: (mode === 'text' ? [] : mode === 'first_frame' ? ['front'] : ['front', 'side']).map(asset_id => ({ asset_id, usage: mode === 'reference' ? 'identity' : null })),
    reference_video_asset_id: ['edit', 'extend'].includes(mode) ? 'video' : null, shot_id: null, storyboard_revision: null, storyboard_reference_asset_id: null }
  return { id: 'proposal', created_node_id: 'new-draft', source, validation_fingerprint: 'server-state',
    before: { prompt: source.prompt, parameters: { ...source.parameters } },
    after: { prompt: mode === 'text' || mode === 'first_frame' ? '人物停步回望。' : '人物停步回望，图片1保持身份，图片2补充侧面。', parameters: { ...source.parameters } }, changes: ['动作调整'] }
}

for (const mode of ['text', 'reference', 'first_frame', 'first_last_frame', 'edit', 'extend'] as const) test(`proposal draft preserves ${mode}, fixed inputs and all parameters without editing its source`, async () => {
  const proposal = await fixture(mode)
  const original = structuredClone(graph)
  const added = addCanvasNodeProposalDraft(graph, proposal, detail, model)
  assert.deepEqual(graph, original)
  assert.equal(added.graph.nodes.filter(node => node.type === 'generation').length, graph.nodes.filter(node => node.type === 'generation').length + 1)
  assert.equal(added.node.model_id, model.id)
  assert.equal(added.node.settings.mode, mode)
  assert.equal(added.node.settings.duration, 8)
  assert.equal(added.node.settings.draft, true)
  assert.equal(added.node.settings.generate_audio, true)
  assert.equal(added.node.settings.candidate_count, 3)
  assert.equal(added.node.job_id, null); assert.equal(added.node.asset_id, null)
  assert.equal(added.node.settings.reference_video_url, ['edit', 'extend'].includes(mode) ? 'asset://video' : null)
  assert.deepEqual(added.graph.edges.filter(edge => edge.target === added.node.id).map(edge => edge.reference_asset_id), proposal.source.reference_assets.map(reference => reference.asset_id))
  assert.equal(added.referenceNodeCount, proposal.source.reference_assets.some(reference => reference.asset_id === 'side') ? 1 : 0)
  assert.equal(addCanvasNodeProposalDraft(added.graph, proposal, detail, model).alreadyApplied, true)
})

test('proposal drafts preserve reviewed managed text against their initial generated template', async () => {
  const proposal = await fixture()
  proposal.after.prompt += '\n\n【视频生成要求】\n用户确认的完整运镜与声音。\n【视频生成要求结束】'
  const added = addCanvasNodeProposalDraft(graph, proposal, detail, model)
  const document = added.node.settings.prompt_sections!
  const reconciled = reconcilePromptSectionDocument(document, added.node.settings.prompt_template!)
  assert.equal(serializePromptSectionDocument(reconciled), added.node.text)
  assert.ok(!reconciled.blocks.some(block => block.pendingSourceText !== undefined))
})

test('proposal validation rejects unsaved edits, missing assets, model availability and locked changes', async () => {
  const proposal = await fixture()
  await assertCanvasNodeProposalCurrent(graph, proposal, detail, [model], providers)
  await assert.rejects(assertCanvasNodeProposalCurrent({ ...graph, nodes: graph.nodes.map(node => node.id === 'source' ? { ...node, text: '用户后续编辑' } : node) }, proposal, detail, [model], providers), /来源节点或项目配置已变化/)
  await assert.rejects(assertCanvasNodeProposalCurrent(graph, proposal, { ...detail, updated_at: 'updated-2' }, [model], providers), /来源节点或项目配置已变化/)
  await assert.rejects(assertCanvasNodeProposalCurrent(graph, proposal, { ...detail, assets: [] }, [model], providers), /固定参考图片已不可用/)
  await assert.rejects(assertCanvasNodeProposalCurrent(graph, proposal, detail, [{ ...model, enabled: false }], providers), /模型或服务商已不可用/)
  await assert.rejects(assertCanvasNodeProposalCurrent(graph, { ...proposal, after: { ...proposal.after, parameters: { ...proposal.after.parameters, draft: false } } }, detail, [model], providers), /锁定的生成参数/)
  await assert.rejects(assertCanvasNodeProposalCurrent(graph, { ...proposal, after: { ...proposal.after, prompt: '使用[[ref:unapproved]]。' } }, detail, [model], providers), /不能添加或替换参考图片/)
})

test('proposal titles fit canvas limits without clipping an emoji or any prompt text', async () => {
  const proposal = await fixture()
  const current = { ...graph, nodes: graph.nodes.map(node => node.id === 'source' ? { ...node, title: '🎬'.repeat(80) } : node) }
  const project = { ...detail, assets: detail.assets.map(asset => asset.id === 'side' ? { ...asset, filename: '🎥'.repeat(110) + '.png' } : asset) }
  const added = addCanvasNodeProposalDraft(current, proposal, project, model)
  assert.ok(added.node.title.length <= 160)
  assert.match(added.node.title, / · 导演调整草稿$/)
  assert.ok(added.graph.nodes.filter(node => !graph.nodes.some(original => original.id === node.id)).every(node => node.title.length <= 160 && !/[\uD800-\uDBFF]$/.test(node.title)))
  assert.equal(added.node.text, proposal.after.prompt.replace('图片1', '[[ref:front]]').replace('图片2', '[[ref:side]]'))
})
