import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Shot } from '../src/shared/api/api'
import type { CanvasGraph } from '../src/features/canvas/ProjectCanvas'
import { recoverCanvasShotPrompts } from '../src/features/canvas/canvas-shot-prompt-recovery'
import { compileCanvasPrompt, type CanvasPromptCompilerInput } from '../src/features/canvas/canvas-prompt-compiler'
import { promptRefinementSource } from '../src/features/skills/prompt-refinement-scope'
import { validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'
import { reconcilePromptSectionDocument, serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

const source = '固定开场瞬间；[[ref:hero]]。\n\n【项目画风约束】\n画风：冷灰动画。\n\n【本镜首帧构图约束】\n保持原位。\n【本镜首帧构图约束结束】'
const style = '【项目画风约束】\n当前项目画风\n【项目画风约束结束】'
const shot = { id: 'shot', prompt: '叙事', image_prompt: source } as Shot
function fixture(): CanvasGraph {
  return { revision: 'optimistic-server-revision', edges: [{ id: 'edge', source: 'reference', target: 'node', reference_asset_id: 'hero' }], nodes: [{
    id: 'node', type: 'generation', x: 1, y: 2, width: 320, height: 240, title: '原镜头', text: source,
    prompt: source, shot_id: shot.id, asset_id: null, job_id: null, model_id: 'image', settings: {
      modality: 'image', prompt_override: true, prompt_is_final: true, prompt_document: true,
      prompt_base: source, prompt_body: source, prompt_template: `${source}\n\n${style}`,
      prompt_sections: { version: 1, blocks: [{ id: 'body-1', kind: 'body', text: source },
        { id: 'managed-1', kind: 'managed', name: '项目画风约束', text: '', sourceText: '', deleted: true, deletionSource: 'source' }] },
    },
  }] }
}
const config: CanvasPromptCompilerInput = { profileReferences: [], referenceIds: ['hero'], referenceNames: ['人物'],
  bindings: [], visualReferenceMode: 'profiles', model: { modality: 'image', settings: {} }, mode: 'reference', ratio: '16:9',
  resolution: '2K', clarity: null, quality: null, background: null, duration: 6, durationFollowsSource: false,
  style: { version: 'current', label: '水墨', source: 'settings', details: {} } }

test('real saved shape loads into a valid refinement scope and compiles without losing source prose or reference identities', () => {
  const graph = fixture(), before = structuredClone(graph), healed = recoverCanvasShotPrompts(graph, [shot])
  assert.notEqual(healed, graph)
  const node = healed.nodes[0]!, settings = node.settings
  assert.equal(node.text, source.replace('【项目画风约束】', '［项目画风约束］'))
  assert.equal(node.prompt, node.text); assert.equal(settings.prompt_base, node.text); assert.equal(settings.prompt_body, node.text)
  assert.equal(settings.prompt_template, `${node.text}\n\n${style}`)
  assert.deepEqual(settings.prompt_sections!.blocks.map(b => b.id), ['body-1', 'managed-1'])
  assert.deepEqual(settings.prompt_sections!.blocks[1], graph.nodes[0]!.settings.prompt_sections!.blocks[1])
  assert.equal(promptRefinementSource({ prompt: node.text, promptSections: settings.prompt_sections }).error, '')
  const compiled = compileCanvasPrompt(settings.prompt_body!, config)
  assert.doesNotThrow(() => validateManagedPromptDocument(compiled))
  const reconciled = reconcilePromptSectionDocument(settings.prompt_sections!, compiled, { body: settings.prompt_body })
  const final = serializePromptSectionDocument(reconciled)
  assert.doesNotThrow(() => validateManagedPromptDocument(final))
  assert.match(final, /本镜首帧构图约束结束/); assert.match(final, /\[\[ref:hero\]\]/)
  assert.equal(reconciled.blocks.find(b => b.id === 'managed-1')!.deleted, undefined)
  assert.deepEqual(healed.edges, before.edges); assert.equal(healed.revision, before.revision)
  assert.deepEqual(graph, before)
  assert.equal(recoverCanvasShotPrompts(healed, [shot]), healed)
})

test('manual malformed bodies, mismatched snapshots, duplicate bodies and unrelated nodes are never normalized', () => {
  const variants = [
    (g: CanvasGraph) => { g.nodes[0]!.text += '\n手写修改' },
    (g: CanvasGraph) => { g.nodes[0]!.settings.prompt_base = '作者基础' },
    (g: CanvasGraph) => { g.nodes[0]!.settings.prompt_template += '\n【图片参考图用途】未完' },
    (g: CanvasGraph) => { g.nodes[0]!.shot_id = 'unrelated' },
    (g: CanvasGraph) => { g.nodes[0]!.settings.prompt_body += '\n手写内容' },
    (g: CanvasGraph) => { g.nodes[0]!.settings.prompt_sections!.blocks.push({ id: 'duplicate', kind: 'body', text: source }); g.nodes[0]!.text += source },
  ]
  for (const mutate of variants) { const graph = fixture(); mutate(graph); assert.equal(recoverCanvasShotPrompts(graph, [shot]), graph) }
})

test('plain automatic shot sources recover but user overrides remain exact', () => {
  const graph = fixture(), node = graph.nodes[0]!
  node.settings = { modality: 'image' }; node.text = ''
  const healed = recoverCanvasShotPrompts(graph, [shot])
  assert.match(healed.nodes[0]!.prompt, /［项目画风约束］/)
  assert.equal(healed.nodes[0]!.text, '')
  node.settings.prompt_override = true; node.text = source + '\n作者备注'
  assert.equal(recoverCanvasShotPrompts(graph, [shot]), graph)
})
