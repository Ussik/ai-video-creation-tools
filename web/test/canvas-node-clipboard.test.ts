import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { createCanvasNodeClipboard, parseCanvasNodeClipboard, pasteCanvasNodeClipboard, serializeCanvasNodeClipboard } from '../src/features/canvas/canvas-node-clipboard'

const graph = (nodes: CanvasNode[] = [], edges: CanvasGraph['edges'] = []): CanvasGraph => ({ nodes, edges, revision: 'a'.repeat(64) })
function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type: 'generation', x: 420, y: 100, width: 440, height: 420, title: '人物设定', text: '',
    prompt: '原始正文', asset_id: null, shot_id: null, model_id: 'image-model', job_id: null,
    settings: { modality: 'image', ratio: '16:9', resolution: '2K' }, ...patch }
}
const image = (id: string): Asset => ({ id, project_id: 'project', kind: 'image', filename: `${id}.png` } as Asset)
const detail = { assets: [image('input'), image('alternate'), image('generated')], visual_profiles: [] as VisualProfile[] }
const snapshot = (g: CanvasGraph, nodeIds = ['main']) => createCanvasNodeClipboard({ projectId: 'project', canvasId: 'A', graph: g, nodeIds, detail })

test('A to B copy preserves structured creation and parameters while isolating profile and task ownership', () => {
  const prompt = '【设定图固定要求】\n侧面、正面，保留 @参考图(input) 的衣着\n【设定图固定要求结束】\n补充文字'
  const sections = parsePromptSectionDocument(prompt)
  const main = node('main', { text: prompt, asset_id: 'generated', job_id: 'running-job', shot_id: 'old-shot',
    settings: { modality: 'image', ratio: '4:3', resolution: '4K', quality: 'high', candidate_count: 4,
      visual_profile_id: 'profile', visual_profile_revision: 6, visual_completed_job_id: 'done', generation_completed_job_id: 'done',
      group_id: 'old-group', group_title: '旧分组', storyboard_revision: 3, visual_dependencies: true,
      image_video_handoff: { source_node_id: 'source', source_asset_id: 'input', source_signature: 'old', applied_signature: 'old' },
      prompt_document: true, prompt_is_final: true, prompt_sections: sections, prompt_body: '正文', prompt_template: '来源',
    } })
  const input = node('source', { asset_id: 'input', job_id: 'source-job', x: 0 })
  const source = graph([main, input], [{ id: 'line', source: input.id, target: main.id, reference_asset_id: 'input' }])
  const before = structuredClone(source)
  const payload = createCanvasNodeClipboard({ projectId: 'project', canvasId: 'A', graph: source, nodeIds: [main.id],
    detail: { ...detail, visual_profiles: [{ id: 'profile', kind: 'character' } as VisualProfile] } })
  const serialized = serializeCanvasNodeClipboard(payload)
  assert.deepEqual(parseCanvasNodeClipboard(serialized), payload)
  const target = graph([node('existing', { x: 200, y: 100 })])
  const pasted = pasteCanvasNodeClipboard({ projectId: 'project', graph: target, payload, position: { x: 200, y: 100 }, detail })
  const copy = pasted.graph.nodes.find(item => item.id === pasted.nodeIds[0])!
  assert.equal(copy.type, 'generation')
  assert.equal(copy.title, main.title)
  assert.equal(copy.text, prompt)
  assert.deepEqual(copy.settings.prompt_sections, sections)
  assert.equal(copy.model_id, main.model_id)
  assert.equal(copy.settings.ratio, '4:3')
  assert.equal(copy.settings.resolution, '4K')
  assert.equal(copy.settings.quality, 'high')
  assert.equal(copy.settings.candidate_count, 4, 'number of future candidates is a parameter')
  assert.equal(copy.settings.visual_template_kind, 'character')
  assert.equal(copy.settings.visual_template_reference_required, false, 'a standalone profile snapshot can still generate from its complete prose')
  assert.equal(copy.asset_id, null)
  assert.equal(copy.job_id, null)
  assert.equal(copy.shot_id, null)
  for (const key of ['visual_profile_id', 'visual_profile_revision', 'generation_completed_job_id', 'visual_completed_job_id', 'storyboard_revision', 'group_id', 'group_title', 'image_video_handoff', 'visual_dependencies']) assert.equal(copy.settings[key as keyof CanvasNode['settings']], undefined)
  const edge = pasted.graph.edges.find(item => item.target === copy.id)!
  const frozen = pasted.graph.nodes.find(item => item.id === edge.source)!
  assert.equal(frozen.type, 'image')
  assert.equal(frozen.asset_id, 'input')
  assert.equal(frozen.job_id, null)
  assert.equal(edge.reference_asset_id, 'input')
  assert.ok(!source.nodes.some(item => item.id === copy.id))
  assert.deepEqual(source, before, 'copying never changes original generated assets or prompt sources')
  assert.deepEqual(target.nodes.map(item => item.id), ['existing'])
  for (const added of pasted.graph.nodes.filter(item => item.id !== 'existing')) {
    assert.ok(added.x + added.width <= 200 || added.x >= 640 || added.y + added.height <= 100 || added.y >= 520, 'paste finds free space for the whole group')
  }
  copy.settings.prompt_sections!.blocks[0].text = '独立修改'
  assert.deepEqual(payload.nodes.find(item => item.id === 'main')!.settings.prompt_sections, sections)
})

test('resolved references stay ordered and overrides do not revive replaced or removed inputs', () => {
  const main = node('main', { settings: { modality: 'video', mode: 'first_frame', ratio: '16:9',
    prompt_reference_overrides: { input: 'alternate', generated: null },
    video_reference_usages: [{ asset_id: 'alternate', usage: 'identity' }], storyboard_reference_asset_id: 'alternate' } })
  const g = graph([main, node('input-source', { asset_id: 'input' }), node('old-source', { asset_id: 'generated' })], [
    { id: 'one', source: 'input-source', target: 'main' }, { id: 'two', source: 'old-source', target: 'main' },
  ])
  const payload = createCanvasNodeClipboard({ projectId: 'project', canvasId: 'A', graph: g, nodeIds: ['main'], detail,
    referenceAssetIds: { main: ['alternate'] } })
  assert.deepEqual(payload.edges.map(edge => edge.reference_asset_id), ['alternate'])
  const copied = pasteCanvasNodeClipboard({ projectId: 'project', graph: graph(), payload }).graph.nodes.find(item => item.type === 'generation')!
  assert.deepEqual(copied.settings.video_reference_usages, main.settings.video_reference_usages)
  assert.equal(copied.settings.storyboard_reference_asset_id, 'alternate')
})

test('copy includes explicit dependencies and inactive inputs with independent text snapshots', () => {
  const main = node('main'), sourceText = node('instructions', { type: 'text', text: '保留这一段描述', model_id: null,
    settings: { text_document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留这一段描述', marks: [{ type: 'bold' }] }] }] } } })
  const source = graph([main, sourceText, node('source', { asset_id: 'input' })], [
    { id: 'text', source: 'instructions', target: 'main' }, { id: 'image', source: 'source', target: 'main' },
  ])
  const payload = createCanvasNodeClipboard({ projectId: 'project', canvasId: 'A', graph: source, nodeIds: ['main'], detail,
    referenceAssetIds: { main: ['alternate'] } })
  assert.deepEqual(payload.edges.filter(edge => edge.reference_asset_id).map(edge => edge.reference_asset_id), ['alternate', 'input'])
  assert.equal(payload.nodes.find(item => item.type === 'text')!.text, sourceText.text)
  assert.deepEqual(payload.nodes.find(item => item.type === 'text')!.settings.text_document, sourceText.settings.text_document)
  assert.ok(parseCanvasNodeClipboard(serializeCanvasNodeClipboard(payload)))
  const video = { ...image('video-input'), kind: 'video' } as Asset
  const videoPayload = createCanvasNodeClipboard({ projectId: 'project', canvasId: 'A', graph: graph([main,
    node('video-source', { type: 'video', asset_id: video.id })], [{ id: 'video-edge', source: 'video-source', target: main.id }]),
    nodeIds: [main.id], detail: { ...detail, assets: [...detail.assets, video] } })
  const videoInput = videoPayload.nodes.find(item => item.type === 'video')!
  assert.equal(videoInput.asset_id, video.id)
  const videoEdge = videoPayload.edges.find(edge => edge.source === videoInput.id)!
  assert.equal(videoEdge.reference_asset_id, undefined, 'video inputs are fixed on their media node; image pins must stay image-only')
  assert.ok(parseCanvasNodeClipboard(serializeCanvasNodeClipboard(videoPayload)))
})

test('analysis cards retain inputs and instructions and clear outputs; analysis and screenplay dependencies become ordinary text', () => {
  const analysis = node('main', { type: 'video_analysis', asset_id: 'input', job_id: 'analysis-job', text: '旧理解结果',
    settings: { video_analysis_instructions: '逐镜分析', video_analysis_start_ms: 100, video_analysis_fps: 2,
      video_analysis_result: { fake: true } as never } })
  const source = graph([analysis, node('script', { type: 'project_script_ref', text: '剧本原文', settings: { role: 'script' } })],
    [{ id: 'script-edge', source: 'script', target: 'main' }])
  const payload = snapshot(source)
  const copy = payload.nodes.find(item => item.id === 'main')!
  assert.equal(copy.asset_id, 'input')
  assert.equal(copy.job_id, null)
  assert.equal(copy.text, '')
  assert.equal(copy.settings.video_analysis_result, undefined)
  assert.equal(copy.settings.video_analysis_instructions, '逐镜分析')
  assert.equal(copy.settings.video_analysis_fps, 2)
  assert.ok(!payload.nodes.some(item => item.type === 'project_script_ref'))
  assert.equal(payload.nodes.find(item => item.type === 'text')!.text, '剧本原文')
  const other = node('other')
  const selectedTogether = snapshot(graph([analysis, other], [{ id: 'analysis-text', source: 'main', target: 'other' }]), ['main', 'other'])
  assert.ok(parseCanvasNodeClipboard(serializeCanvasNodeClipboard(selectedTogether)), 'supporting analysis prose has a separate ID from the fresh selected analysis')
  assert.equal(selectedTogether.nodes.find(item => item.type === 'text')!.text, '旧理解结果')
})

test('text nodes retain their writing and rich formatting while dropping the old generated asset and task', () => {
  const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留创作文字', marks: [{ type: 'bold' }] }] }] }
  const source = node('main', { type: 'text', text: '保留创作文字', asset_id: 'generated-text', job_id: 'old-text-job',
    settings: { text_mode: 'write', text_document: document } })
  const payload = snapshot(graph([source]))
  const pasted = pasteCanvasNodeClipboard({ projectId: 'project', graph: graph(), payload }).graph.nodes[0]
  assert.equal(pasted.type, 'text')
  assert.equal(pasted.text, source.text)
  assert.deepEqual(pasted.settings.text_document, document)
  assert.equal(pasted.asset_id, null)
  assert.equal(pasted.job_id, null)
  assert.equal(source.asset_id, 'generated-text')
})

test('repeated paste creates new identities and capacity/project/removed-reference failures are atomic', () => {
  const payload = snapshot(graph([node('main'), node('source', { asset_id: 'input' })], [{ id: 'edge', source: 'source', target: 'main' }]))
  const first = pasteCanvasNodeClipboard({ projectId: 'project', graph: graph(), payload })
  const second = pasteCanvasNodeClipboard({ projectId: 'project', graph: first.graph, payload })
  assert.notEqual(first.nodeIds[0], second.nodeIds[0])
  assert.equal(new Set(second.graph.nodes.map(item => item.id)).size, 4)
  assert.throws(() => pasteCanvasNodeClipboard({ projectId: 'another-project', graph: graph(), payload }), /同一项目/)
  assert.throws(() => pasteCanvasNodeClipboard({ projectId: 'project', graph: graph(), payload, detail: { assets: [], visual_profiles: [] } }), /引用素材已失效/)
  const full = graph(Array.from({ length: 500 }, (_, index) => node(`existing-${index}`)))
  assert.throws(() => pasteCanvasNodeClipboard({ projectId: 'project', graph: full, payload }), /上限/)
  assert.equal(full.nodes.length, 500)
  assert.equal(payload.nodes.length, 2)
})

test('clipboard parser ignores ordinary prose and rejects malformed graphs and nested editor structures', () => {
  const good = snapshot(graph([node('main')]))
  assert.equal(parseCanvasNodeClipboard('随便一段提示词'), null)
  assert.equal(parseCanvasNodeClipboard('VIDEO_STUDIO_CANVAS_NODES_V1\n{'), null)
  const corruptions: Array<(value: typeof good) => void> = [
    value => { value.version = 2 as 1 },
    value => { value.nodes.push(structuredClone(value.nodes[0])) },
    value => { value.nodeIds = ['missing'] },
    value => { value.edges = [{ id: 'dangling', source: 'main', target: 'missing' }] },
    value => { value.nodes[0].settings.prompt_sections = { version: 1, blocks: [{ id: 'x', kind: 'managed', name: '设定图固定要求', text: 'broken section' }] } },
    value => { value.nodes[0].settings.video_reference_usages = [{ asset_id: 'input', usage: 'unknown' as never }] },
    value => { value.nodes[0].settings.text_document = { type: 'doc', content: [{ type: 'unknownDangerousNode' }] } },
    value => { value.nodes[0].settings.ratio = 123 as never },
    value => { value.nodes[0].width = Infinity },
    value => { value.nodes[0].settings.image_video_handoff = { source_node_id: 'old', source_asset_id: 'input', source_signature: 'old', applied_signature: 'old' } },
  ]
  for (const corrupt of corruptions) {
    const copy = structuredClone(good); corrupt(copy)
    assert.equal(parseCanvasNodeClipboard(serializeCanvasNodeClipboard(copy)), null)
  }
})
