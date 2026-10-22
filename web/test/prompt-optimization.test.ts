import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canOptimizeImagePrompt, isContentPolicyRejection, jobPromptRequest } from '@video-studio/shared/jobs/prompt-optimization'
import { addOptimizedPromptDraft, validateOptimizedPromptReferences } from '../src/features/canvas/canvas-optimized-prompt'
import type { CanvasGraph } from '../src/features/canvas/ProjectCanvas'
import type { Job, Model, ProjectDetail } from '../src/shared/api/api'
import { rebasePromptDraft } from '../src/features/canvas/canvas-prompt-draft'
import { serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

test('moderation refusals match without treating network, billing or ordinary task failures as policy errors', () => {
  for (const error of ['We are so sorry, but the prompt may violate our content policies.', 'content_policy_violation',
    'Your request was blocked by our safety policy.', '内容审核拒绝', '提示词违规', '内容未通过安全审核']) assert.equal(isContentPolicyRejection(error), true, error)
  for (const error of [null, '', 'HTTP 502 Bad Gateway', 'insufficient_quota', '连接超时', '任务失败，请修改提示词',
    'Failed to fetch content policy settings']) assert.equal(isContentPolicyRejection(error), false, String(error))
  const job = { status: 'failed', job_type: 'generation', error: 'content_policy_violation', request: '{"prompt":"场景"}' }
  assert.equal(canOptimizeImagePrompt(job, 'image'), true)
  for (const patch of [{ status: 'running' }, { job_type: 'export' }, { request: 'broken' }, { request: '{"prompt":42}' }, { recovery_available: true }]) {
    assert.equal(canOptimizeImagePrompt({ ...job, ...patch }, 'image'), false)
  }
  assert.equal(canOptimizeImagePrompt(job, 'video'), false)
  assert.deepEqual(jobPromptRequest('[]'), {})
})

const job = { id: 'old-job', project_id: 'project', shot_id: 'shot', model_id: 'image', status: 'failed',
  request: JSON.stringify({ prompt: '原始提示词', visual_source_prompt: '旧内容', reference_asset_ids: ['b', 'a'], ratio: '16:9', resolution: '2K', quality: 'high', background: 'opaque', clarity: '2K' }),
} as Job
const detail = { id: 'project', shots: [{ id: 'shot' }], assets: [{ id: 'a', kind: 'image', filename: 'a.png' }, { id: 'b', kind: 'image', filename: 'b.png' }] } as ProjectDetail
const models = [{ id: 'image', enabled: true, modality: 'image' }] as Model[]

test('historical optimization creates an unsubmitted draft and retains ordered references, parameters and existing content', () => {
  const graph = { nodes: [{ id: 'existing', x: 80, y: 80, width: 440, text: '后来编辑的内容' }], edges: [], revision: 'revision' } as unknown as CanvasGraph
  const before = JSON.stringify({ graph, job })
  const added = addOptimizedPromptDraft(graph, { id: 'draft', projectId: 'project', job, prompt: '克制的画面描述' }, detail, models)
  assert.equal(JSON.stringify({ graph, job }), before)
  assert.equal(added.graph.nodes[0], graph.nodes[0])
  assert.equal(added.node.job_id, null)
  assert.equal(added.node.asset_id, null)
  assert.equal(added.node.text, '克制的画面描述')
  assert.equal(added.node.settings.ratio, '16:9')
  assert.equal(added.node.settings.resolution, '2K')
  assert.equal(added.node.settings.quality, 'high')
  assert.equal(added.node.settings.visual_dependencies, false)
  assert.deepEqual(added.graph.edges.map(edge => edge.reference_asset_id), ['b', 'a'])
  assert.doesNotMatch(JSON.stringify(added.node), /原始提示词|旧内容/)
  assert.equal(added.node.settings.prompt_is_final, true)
  assert.equal(rebasePromptDraft(added.node.settings.prompt_template!, added.node.text, '由旧镜头重新拼接的拒绝内容'), '克制的画面描述')
})

test('missing references and wrong projects cannot silently create a different image request', () => {
  assert.throws(() => validateOptimizedPromptReferences(job, { ...detail, assets: detail.assets.slice(0, 1) }), /参考图已不可用/)
  assert.throws(() => addOptimizedPromptDraft({ nodes: [], edges: [], revision: 'v' }, { id: 'draft', projectId: 'other', job, prompt: 'new' }, detail, models), /不属于/)
  const added = addOptimizedPromptDraft({ nodes: [], edges: [], revision: 'v' }, { id: 'draft', projectId: 'project', job, prompt: 'new' }, detail, [])
  assert.equal(added.node.model_id, null)
})

test('historical complete optimization keeps reviewed settings and stable reference identities as an authoritative document', () => {
  const source = '【镜头视觉设定】\n参考图 1 保持蓝衣\n【镜头视觉设定结束】'
  const prompt = `克制的画面描述\n\n${source.replace('蓝衣', '深蓝衣')}`
  const historical = { ...job, request: JSON.stringify({ ...jobPromptRequest(job.request), prompt: `原始提示词\n\n${source}` }) }
  const result = addOptimizedPromptDraft({ nodes: [], edges: [], revision: 'r' }, { id: 'draft', projectId: 'project', job: historical, prompt }, detail, models)
  assert.equal(result.node.settings.prompt_document, true)
  assert.equal(result.node.settings.prompt_body, '克制的画面描述')
  assert.equal(serializePromptSectionDocument(result.node.settings.prompt_sections!), '克制的画面描述\n\n【镜头视觉设定】\n[[ref:b]] 保持深蓝衣\n【镜头视觉设定结束】')
  const section = result.node.settings.prompt_sections!.blocks.find(block => block.kind === 'managed')!
  assert.equal(section.sourceText, source.replace('参考图 1', '[[ref:b]]'))
  assert.doesNotMatch(JSON.stringify(result.node), /原始提示词/)
})
