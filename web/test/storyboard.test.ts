import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storyboardContext, storyboardItems, storyboardPrompt, storyboardStatus } from '../src/features/storyboard/storyboard'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { Asset, Job, Model, ProjectDetail, ScriptArtifact, Shot } from '../src/shared/api/api'

const project = (patch: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: 'project', name: '借光的人', brief: '', assets: [], shots: [], jobs: [],
  script: { outline: '', characters: '', generation_options: {}, scenes: [], artifacts: [] }, ...patch,
} as ProjectDetail)
const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: 'generation', title: id, text: '', prompt: '', settings: {}, x: 0, y: 0, width: 300, height: 300,
  asset_id: null, shot_id: null, job_id: null, model_id: null, ...patch,
})
const graph = (...nodes: CanvasNode[]): CanvasGraph => ({ nodes, edges: [], revision: 'v1' })

test('saved documents and episode scripts stay discoverable without canvas reference nodes', () => {
  const detail = project({ script: { outline: '主线', characters: '', generation_options: {}, scenes: [], artifacts: [
    { id: 'ep2', artifact_type: 'episode_script', title: '第二集', content: '第二集独立正文', episode_number: 2, position: 2 },
    { id: 'ep1', artifact_type: 'episode_script', title: '第一集', content: '第一集独立正文', episode_number: 1, position: 1 },
    { id: 'empty', artifact_type: 'props', title: '空道具', content: '  ', position: 0 },
  ] as ScriptArtifact[] } })
  const items = storyboardItems(detail, graph(), [])
  assert.deepEqual(items.map(item => item.id), ['script:project', 'artifact:ep1', 'artifact:ep2'])
  assert.match(storyboardContext(items[2], detail), /第 2 集.*第二集独立正文/s)
  assert.doesNotMatch(storyboardContext(items[2], detail), /第一集独立正文/)
})

test('visual profile boards remain production references rather than storyboard shots', () => {
  const detail = project({ assets: [{ id: 'board', kind: 'image' }] as Asset[] })
  const items = storyboardItems(detail, graph(
    node('profile', { asset_id: 'board', settings: { visual_profile_id: 'linwan', modality: 'image' } }),
    node('frame', { asset_id: 'board', shot_id: 'shot' }),
  ), [])
  assert.deepEqual(items.map(item => item.id), ['frame'])
})

test('image/video generators use completed job output, pinned assets and model modality correctly', () => {
  const image = { id: 'image', kind: 'image', filename: 'image.png' } as Asset
  const video = { id: 'video', kind: 'video', filename: 'video.mp4' } as Asset
  const job = { id: 'completed', status: 'succeeded', result_asset_id: 'video' } as Job
  const detail = project({ assets: [image, video], jobs: [job] })
  const items = storyboardItems(detail, graph(
    node('latest', { job_id: job.id, settings: { modality: 'video' } }),
    node('pinned', { asset_id: image.id, job_id: job.id }),
    node('waiting', { model_id: 'video-model' }),
    node('plain', { type: 'text', text: '人物设定' }),
  ), [{ id: 'video-model', modality: 'video' } as Model])
  assert.deepEqual(items.map(item => item.kind), ['video', 'image', 'video', 'text'])
  assert.equal(items[0].asset?.id, video.id)
  assert.equal(items[1].asset?.id, image.id)
  assert.equal(storyboardStatus(items[2]), '尚未生成')
})

test('shot ordering and duplicate pinned media remain stable without mutating the canvas', () => {
  const detail = project({ shots: [{ id: 's2', position: 1 }, { id: 's1', position: 0 }] as Shot[], assets: [{ id: 'a', kind: 'image' }] as Asset[] })
  const original = graph(node('second', { shot_id: 's2', asset_id: 'a' }), node('note', { type: 'text' }), node('first', { shot_id: 's1', asset_id: 'a' }))
  const before = JSON.stringify(original)
  assert.deepEqual(storyboardItems(detail, original, []).map(item => item.id), ['first', 'second', 'note'])
  assert.equal(JSON.stringify(original), before)
})

test('failed and running nodes expose their actual status and text output is separate from input prompts', () => {
  const detail = project({ assets: [{ id: 'answer', kind: 'text', text: '生成结果正文' }] as Asset[], jobs: [
    { id: 'failed', status: 'failed' }, { id: 'running', status: 'running' },
  ] as Job[] })
  const items = storyboardItems(detail, graph(
    node('error', { job_id: 'failed', settings: { modality: 'image' } }),
    node('progress', { job_id: 'running', settings: { modality: 'video' } }),
    node('text', { asset_id: 'answer', text: '用户输入的提示词' }),
  ), [])
  assert.equal(storyboardStatus(items[0]), '生成失败')
  assert.equal(storyboardStatus(items[1]), '生成中')
  assert.equal(items[2].content, '生成结果正文')
  assert.equal(items[2].kind, 'text')
})

test('board hides the linked current result but keeps an older candidate and an independent reuse', () => {
  const detail = project({ assets: [{ id: 'current', kind: 'image' }, { id: 'old', kind: 'image' }] as Asset[] })
  const original = graph(node('generator', { asset_id: 'current' }),
    node('result', { type: 'image', asset_id: 'current' }),
    node('older', { type: 'image', asset_id: 'old' }),
    node('reused', { type: 'image', asset_id: 'current' }))
  original.edges = [
    { id: 'current-edge', source: 'generator', target: 'result' },
    { id: 'old-edge', source: 'generator', target: 'older' },
  ]
  assert.deepEqual(storyboardItems(detail, original, []).map(item => item.id), ['generator', 'older', 'reused'])
  assert.equal(original.nodes.length, 4)
})

test('media inspection and director context use the submitted prompt rather than an outdated shot prompt', () => {
  const detail = project({ shots: [{ id: 'shot', prompt: '旧分镜描述' }] as Shot[], jobs: [
    { id: 'job', request: JSON.stringify({ prompt: '实际提交运镜与对白' }), status: 'running' },
  ] as Job[] })
  const item = storyboardItems(detail, graph(node('video', {
    shot_id: 'shot', job_id: 'job', text: '待下次生成的草稿', settings: { modality: 'video', prompt_override: true },
  })), [])[0]
  assert.equal(storyboardPrompt(item), '实际提交运镜与对白')
  assert.match(storyboardContext(item, detail), /实际提交运镜与对白/)
  assert.doesNotMatch(storyboardContext(item, detail), /旧分镜描述|待下次生成的草稿/)
})

test('image analysis projects its editable text and stays visible beside the source generator without exposing the source image as output', () => {
  const detail = project({ assets: [{ id: 'source', kind: 'image', prompt: '来源图片的历史提示词', filename: '来源.png' }] as Asset[] })
  const original = graph(node('generator', { asset_id: 'source', settings: { modality: 'image' } }),
    node('result', { type: 'image', asset_id: 'source' }),
    node('analysis', { type: 'image_analysis', asset_id: 'source', model_id: 'vision', text: '手改专业提示词：低机位中景，冷色轮廓光。' }))
  original.edges = [{ id: 'result-edge', source: 'generator', target: 'result' },
    { id: 'analysis-source', source: 'generator', target: 'analysis', reference_asset_id: 'source' }]
  const before = JSON.stringify(original)
  const items = storyboardItems(detail, original, [{ id: 'vision', modality: 'text' } as Model])
  assert.deepEqual(items.map(item => item.id), ['generator', 'analysis'], 'ordinary duplicate result is hidden while image analysis remains discoverable')
  const item = items[1]
  assert.equal(item.kind, 'text')
  assert.equal(item.asset, undefined)
  assert.equal(item.content, '手改专业提示词：低机位中景，冷色轮廓光。')
  assert.equal(storyboardStatus(item), '创作文本')
  assert.match(storyboardContext(item, detail), /手改专业提示词：低机位中景，冷色轮廓光。/)
  assert.doesNotMatch(storyboardContext(item, detail), /来源图片的历史提示词/)
  assert.equal(JSON.stringify(original), before)
  const empty = storyboardItems(detail, graph(node('empty', { type: 'image_analysis', asset_id: 'source' })), [])[0]
  assert.equal(empty.kind, 'text')
  assert.equal(empty.asset, undefined)
  assert.equal(storyboardStatus(empty), '空白文本')
})
