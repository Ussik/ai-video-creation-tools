import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareTextRequest, textRequestTrace } from '../src/infrastructure/providers/text-request-plan.js'
import { withTextInputScope } from '../src/infrastructure/providers/text-input-scope.js'
import { safeModelResult } from '../src/infrastructure/observability/model-results.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { visualAnalysisFacts, visualScopeBlock } from '../src/modules/visuals/visual-profile-analysis-context.js'
import { visualProfileObjectFacts, visualProfileContentRules } from '../src/modules/visuals/visual-profile-content-context.js'
import { normalizeVisualContentAliases } from '../src/modules/visuals/visual-profile-content-alias.js'

const evidence = '【本次范围数据，只读】\n{"scenes":[{"id":"scene-test","action":"private-story-value"}],"planned_shots":[{"shot_id":"shot-test"}]}'
const diagnostics = { input_scope_stage: 'catalog' as const, input_scene_count: 1, input_shot_count: 1,
  input_rules_chars: 24, input_facts_chars: 80, input_profiles_chars: 12, input_original_chars: 250000 }
const options = { url: 'https://scope.invalid/v1/responses', headers: {} }

test('scope diagnostics distinguish assembly absence from template loss and expose only bounded metadata', async () => {
  const events: any[] = []
  withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: value => events.push(value) }, () => {
    assert.throws(() => withTextInputScope({ evidence, diagnostics }, 'missing', () => 'unreachable'), { code: 'visual_input_assembly_missing' })
  })
  await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: value => events.push(value) }, async () => {
    await assert.rejects(withTextInputScope({ evidence, diagnostics }, evidence, () =>
      prepareTextRequest({}, { model: 'fixture', input: 'scope discarded' }, 'responses', options)), { code: 'visual_input_transport_missing' })
  })
  assert.deepEqual(events.map(event => event.input_boundary), ['assembly', 'transport'])
  assert.ok(!JSON.stringify(events).includes('private-story-value'))
  const safe = safeModelResult({ ...events[1], input_rules_chars: -1, input_scope_hash: 'not-a-hash', input_scope_stage: 'raw-story', evidence, api_key: 'private-key' })!
  assert.ok(!('input_rules_chars' in safe) && !('input_scope_hash' in safe) && !('input_scope_stage' in safe))
  assert.ok(!JSON.stringify(safe).includes('private'))
})

test('final planned input preserves exact scope through responses, chat and Anthropic message layouts', async () => {
  for (const [protocol, body] of [['responses', { model: 'fixture', input: evidence }],
    ['chat_completions', { model: 'fixture', messages: [{ role: 'user', content: evidence }] }],
    ['anthropic_messages', { model: 'fixture', max_tokens: 1000, messages: [{ role: 'user', content: [{ type: 'text', text: evidence }] }] }]] as const) {
    await withTextInputScope({ evidence, diagnostics }, evidence, async () => {
      const planned = await prepareTextRequest({}, body, protocol, options)
      assert.ok(JSON.stringify(planned.body).includes('scene-test'))
      const trace = textRequestTrace()
      assert.equal(trace.input_scene_count, 1); assert.equal(trace.input_shot_count, 1)
      assert.equal(trace.input_scope_present, true); assert.equal(trace.input_boundary, 'transport')
      assert.match(trace.input_scope_hash!, /^[a-f0-9]{64}$/)
      assert.ok(trace.input_transport_chars! > 0 && trace.input_transport_estimated_tokens! > 0)
      assert.ok(!JSON.stringify(trace).includes('private-story-value'))
    })
  }
  assert.equal(textRequestTrace().input_scope_hash, undefined, 'async scope does not leak into unrelated requests')
})

test('object facts keep the full named record and global prohibitions without a whole world or episode-outline subtree', () => {
  const relevant = '既定袋口材质、颜色和尺寸约束。'.repeat(100)
  const input = { scenes: [{ id: 's', episode_number: 1, heading: 'EP001-SC001', action: '本镜使用炒粉袋' }] as any[], shots: [], profiles: [], outline: '', characters: '', objectName: '炒粉袋', artifacts: [
    { id: 'world', artifact_type: 'world', content: '## 其他地区\nUNRELATED_WORLD'.repeat(1000) },
    { id: 'episodes', artifact_type: 'episode_outline', content: '## 本季\nEP001-SC001 无关全季梗概'.repeat(1000) },
    { id: 'prop', artifact_type: 'props', content: '## 炒粉袋\n\n### 固定外观\n' + relevant + '\n\n## 其他道具\n不应因为提及炒粉袋而加载整个其他对象。' },
    { id: 'rules', artifact_type: 'constraints', content: '所有画面不得出现已明确禁止的现代标志。' },
  ] as any[] }
  const selected = JSON.stringify(visualProfileObjectFacts(input))
  assert.ok(selected.includes(relevant)); assert.ok(selected.includes('不得出现'))
  assert.ok(!selected.includes('UNRELATED_WORLD') && !selected.includes('全季梗概'))
  assert.ok(!selected.includes('不应因为提及'))
  const rules = visualProfileContentRules('必须保持已确认道具材质。\n\n```json\n{"usage_type":"both"}\n```\n\nview_requirements使用对象格式。', 'prop')
  assert.match(rules, /保持已确认/); assert.ok(!rules.includes('usage_type') && !rules.includes('view_requirements'))
})

test('fresh character content keeps standalone character facts without a duplicate artifact', () => {
  const facts = visualProfileObjectFacts({ outline: '', characters: '## 林晚\n蓝衣设定\n\n### 服装\n立领细节\n\n## 其他人物\n其他外貌',
    objectName: '林晚', scenes: [], shots: [], profiles: [], artifacts: [] })
  const selected = JSON.stringify(facts)
  assert.ok(selected.includes('蓝衣设定') && selected.includes('立领细节'))
  assert.ok(!selected.includes('其他外貌'))
})

test('only an absent canonical usage and an already legal alias can normalize; views, notes and contradictory aliases stay intact', () => {
  const value = { view_requirements: { image: '原说明' }, shot_usage: [
    { shot_id: 's1', usage_type: 'both', reference_view: 'hand_held', note: '保留事实', visual_priority: 'high' },
    { shot_id: 's2', usage: 'image', usage_type: 'video', reference_view: null },
    { shot_id: 's3', usage_type: 'custom', reference_view: 'pocket_storage' },
  ] }
  const before = structuredClone(value), normalized = normalizeVisualContentAliases(value)
  assert.equal(normalized.changes.length, 1); assert.deepEqual(value, before)
  const result = normalized.value as typeof value
  assert.equal((result.shot_usage[0] as any).usage, 'both'); assert.equal(result.shot_usage[0]!.reference_view, 'hand_held')
  assert.equal(result.shot_usage[0]!.note, '保留事实'); assert.equal(result.shot_usage[0]!.visual_priority, 'high')
  assert.deepEqual(result.shot_usage.slice(1), value.shot_usage.slice(1)); assert.deepEqual(result.view_requirements, value.view_requirements)
})

test('reference facts retain full named subtrees and global rules, deduplicate copies and exclude unrelated object mentions', () => {
  const scene = { id: 's', episode_number: 1, heading: 'EP001-SC001 房间', location: '房间', characters: '林晚', action: '林晚走入房间', dialogue: '', narration: '' } as any
  const detail = '此段没有重复姓名的外貌细节。'.repeat(3000)
  const characters = `### 林晚\n固定蓝衣\n\n#### 服装细节\n${detail}\n\n### 其他人物\n不应因为此处提及林晚就加载整份其他人物档案。`
  const global = '所有画面都不能出现现代电子屏幕。'.repeat(100)
  const input = { scenes: [scene], shots: [], profiles: [], outline: '', characters, artifacts: [
    { id: 'copy', title: '人物', artifact_type: 'characters', content: characters, episode_number: 0 },
    { id: 'rules', title: '创作禁区', artifact_type: 'constraints', content: global, episode_number: 0 },
    { id: 'future', title: '未来集数', artifact_type: 'episode_script', content: 'FUTURE_EPISODE', episode_number: 2 },
  ] as any[] }
  const facts = JSON.stringify(visualAnalysisFacts(input))
  assert.ok(facts.includes(detail), 'no truncation even when a relevant section is very long')
  assert.ok(facts.includes(global))
  assert.ok(!facts.includes('不应因为此处提及'))
  assert.ok(!facts.includes('FUTURE_EPISODE'))
  assert.equal((facts.match(/固定蓝衣/g) || []).length, 1)
  assert.ok(visualScopeBlock([scene], []).includes(scene.action))
})
