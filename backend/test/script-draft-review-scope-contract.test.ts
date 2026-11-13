import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts, type StageArtifactType } from '@video-studio/shared/script/script-stage-content'
import { scriptTaskAcceptance } from '@video-studio/shared/script/script-task-contract'
import { reviewScriptDraftCompleteness } from '../src/modules/script/script-draft-completeness.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

type Source = { key: string; artifact_type: StageArtifactType; title: string; content: string }
const sourcesMarker = '待核对草稿原文（资料）：'
function submitted(prompt: string): Source[] {
  return JSON.parse(prompt.slice(prompt.lastIndexOf(sourcesMarker) + sourcesMarker.length).split('\n【本轮候选正文结束】')[0]!) as Source[]
}
function fixedAcceptance(prompt: string): string[] {
  const match = /本次固定验收要求：([^\n]+)/.exec(prompt)
  assert.ok(match, 'the actual scoped acceptance remains explicit')
  return JSON.parse(match[1]!) as string[]
}
function clear(prompt: string) {
  return { facts: [], checked_artifacts: [...new Set(submitted(prompt).map(source => source.artifact_type))], findings: [] }
}
function fixture() {
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [],
    artifacts: scriptStageArtifacts.outline.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `独有候选正文${index}：林晚在第${index + 1}个地点寻找家人，最终归还铜钥匙。` })) }
  const context = { uploaded_script: { content: '完整原稿：林晚寻找家人，最终归还铜钥匙。' },
    creator_messages: [{ role: 'user', text: '完成本轮约定的全部设计，保留原稿结局。' }] }
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  return { draft, context, steps, checkpoint: () => checkpoint }
}

test('local task acceptance names only the submitted artifacts while global consistency retains the whole contract', async () => {
  const f = fixture(), overall = scriptTaskAcceptance(f.draft), seen: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    assert.equal(contract!.name, 'script_draft_completeness')
    const sources = submitted(prompt), global = prompt.includes('【独立任务：全局一致性】')
    const expected = global ? overall : scriptTaskAcceptance({ ...f.draft, artifact_types: sources.map(source => source.artifact_type) })
    assert.deepEqual(fixedAcceptance(prompt), expected,
      'the executable local contract cannot demand the entire nine-document package')
    assert.ok(prompt.includes(f.context.uploaded_script.content), 'every task still sees the original manuscript')
    if (global) assert.equal(sources.length, 9)
    else {
      seen.push(sources.map(source => source.key).join(','))
      assert.ok(sources.length < 9)
      assert.match(prompt, /整体交付要求（不扩展本任务送审范围）/)
      assert.ok(prompt.includes(JSON.stringify(overall)), 'the overall requirement is retained as context')
    }
    return JSON.stringify(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'tasks', acceptance: overall })
  assert.equal(seen.length, 3)
  assert.ok(f.checkpoint().steps['review:task:consistency:result'])
})

test('each scoped prompt identifies every candidate by key and title without including unchecked sibling text', async () => {
  const f = fixture(), overall = scriptTaskAcceptance(f.draft)
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    const sources = submitted(prompt), global = prompt.includes('【独立任务：全局一致性】')
    if (!global) {
      const prefix = prompt.slice(0, prompt.lastIndexOf(sourcesMarker))
      const marker = '【全部候选成果清单（系统已确认存在）】\n'
      const start = prefix.lastIndexOf(marker)
      assert.ok(start >= 0, 'a complete candidate inventory explains why omitted sibling bodies are not missing deliverables')
      const inventory = JSON.parse(prefix.slice(start + marker.length).split('\n')[0]!)
      assert.deepEqual(inventory, f.draft.artifacts.map(artifact => ({ key: artifact.artifact_type, title: artifact.title,
        submitted_here: sources.some(source => source.key === artifact.artifact_type) })),
      'all nine candidate identities are present, with accurate submitted-here flags and no sibling text')
      for (const artifact of f.draft.artifacts) {
        assert.ok(prefix.includes(JSON.stringify(artifact.artifact_type)), `inventory includes ${artifact.artifact_type}`)
        assert.ok(prefix.includes(JSON.stringify(artifact.title)), `inventory includes ${artifact.title}`)
        if (!sources.some(source => source.key === artifact.artifact_type)) {
          assert.ok(!prompt.includes(artifact.content), 'unsubmitted sibling body is absent from the local review')
        }
      }
      assert.match(prompt, /本任务[^\n]*(?:送审|验收)|本轮[^\n]*送审/)
      assert.match(prompt, /其他[^\n]*(?:任务|核对)|另[^\n]*(?:任务|核对)/)
    }
    return JSON.stringify(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'tasks', acceptance: overall })
})

test('custom overall acceptance remains mandatory for applicable local text and authoritative for global consistency', async () => {
  const f = fixture(), custom = ['仅交付本轮九份设计。', '作者定制要求：铜钥匙始终保留裂纹，禁止改成无瑕的新钥匙。']
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    const sources = submitted(prompt), global = prompt.includes('【独立任务：全局一致性】')
    assert.ok(prompt.includes(custom[1]!), 'scoping never erases a real creator requirement')
    if (global) assert.deepEqual(fixedAcceptance(prompt), custom)
    else {
      assert.deepEqual(fixedAcceptance(prompt), scriptTaskAcceptance({ ...f.draft, artifact_types: sources.map(source => source.artifact_type) }))
      assert.match(prompt, /整体交付要求（不扩展本任务送审范围）/)
      assert.match(prompt, /涉及本组送审正文的明确作者约束仍必须落实/,
        'local scoping must not downgrade applicable custom author constraints to optional background')
      assert.match(prompt, /仅其他成果的交付责任由对应任务核对/)
      assert.doesNotMatch(prompt, /整体交付要求[^\n]*仅作背景/)
      assert.ok(prompt.includes(JSON.stringify(custom)))
    }
    return JSON.stringify(clear(prompt))
  }, { context: f.context, review_scope: 'tasks', acceptance: custom })
})

test('scoping preserves an explicitly supplied source-outline intent and its protection for unknown source facts', async () => {
  const f = fixture(), intent = 'source_outline' as const, overall = scriptTaskAcceptance({ ...f.draft, intent })
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    const sources = submitted(prompt), global = prompt.includes('【独立任务：全局一致性】')
    const expected = global ? overall : scriptTaskAcceptance({ ...f.draft, intent, artifact_types: sources.map(source => source.artifact_type) })
    assert.deepEqual(fixedAcceptance(prompt), expected)
    assert.ok(fixedAcceptance(prompt).includes('原稿未说明的谜底、规则、结局或制作信息如实保留未知，不补造，也不因此阻断大纲交付。'))
    return JSON.stringify(clear(prompt))
  }, { context: f.context, review_scope: 'tasks', intent, acceptance: overall })
})

test('a local candidate edit reuses unaffected sibling reviews despite the full candidate inventory', async () => {
  const f = fixture(), overall = scriptTaskAcceptance(f.draft)
  const run = (calls: string[]) => reviewScriptDraftCompleteness(f.draft, async prompt => {
    const sources = submitted(prompt)
    calls.push(prompt.includes('【独立任务：全局一致性】') ? 'consistency' : sources.map(source => source.key).join(','))
    return JSON.stringify(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'tasks', acceptance: overall })
  const first: string[] = []
  await run(first)
  assert.equal(first.length, 4)
  f.draft.artifacts.find(artifact => artifact.artifact_type === 'world')!.content += '作者补充：钥匙裂纹不变。'
  const second: string[] = []
  await run(second)
  assert.deepEqual(second, ['world,constraints', 'consistency'], 'inventory metadata does not make unrelated body edits invalidate cached sibling tasks')
})
