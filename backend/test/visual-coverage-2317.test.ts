import assert from 'node:assert/strict'
import { evidenceWireValue } from './helpers/appearance-evidence.js'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { z } from 'zod'
import { visualCoverageDifferences, validateVisualReferenceCoverage } from '../src/modules/visuals/visual-reference-coverage.js'
import { appearanceArbitration, applyAppearanceDecisions } from '../src/modules/visuals/visual-appearance-arbitration.js'
import { prepareVisualCoverage } from '../src/modules/visuals/visual-coverage-workflow.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
const fixture = JSON.parse(await readFile(new URL('./fixtures/visual-coverage-2317.json', import.meta.url), 'utf8'))
const parse = (raw: string) => JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/gu, ''))
const correction = parse(fixture.coverage_checkpoint.correction.raw).visual_coverage
const base = 'PROP-CHAOFENDAI', derived = base + '-VARIANT'
function proof(shot: any, field: string, word: string) {
  const source = shot[field] as string
  const position = source.indexOf(word)
  assert.ok(position >= 0, field + ':' + word)
  return { field, quote: source.slice(Math.max(0, position - 15), position + word.length + 25) }
}
function answer(shot: any) {
  const n = Number(shot.id.split('-')[1])
  const ev = (mode: 'image' | 'video') => n === 3 ? proof(shot, mode === 'image' ? 'image_prompt' : 'video_prompt', '台阶')
    : n === 5 ? proof(shot, mode === 'image' ? 'start_state' : 'video_prompt', '双手')
      : proof(shot, mode === 'image' ? 'image_prompt' : 'video_prompt', n === 2 && mode === 'video' ? '点心袋' : '塑料袋')
  return { decisions: {
    [base]: { relation_to_base: 'independent', image: { visible: [1, 2, 4].includes(n), evidence: ev('image') },
      video: { visible: [1, 2, 4].includes(n), phase: n === 4 ? 'before_change' : [1, 2].includes(n) ? 'throughout' : 'not_visible', evidence: ev('video') }, reason: '按本镜手持阶段与画面证据，不能沿用到口袋状态。' },
    [derived]: { relation_to_base: 'replacement', image: { visible: false, evidence: ev('image') },
      video: { visible: n === 4, phase: n === 4 ? 'after_change' : 'not_visible', evidence: n === 4 ? proof(shot, 'video_prompt', '塞进风衣右侧口袋') : ev('video') }, reason: n === 4 ? '本镜塞入动作后袋口露出，只有视频后段可见口袋状态。' : '首帧或动作没有该口袋状态可见证据，不能提前或凭携带推断出镜。' },
  } }
}
test('2317 complete candidate exposes every identity and image/video mismatch rather than only the first name', () => {
  const differences = visualCoverageDifferences(correction, fixture.scenes, fixture.shots, fixture.profiles)
  assert.ok(differences.some(item => item.object_key === derived && item.shot_id === 'shot-1' && item.missing_modes.includes('video')))
  assert.ok(differences.some(item => item.object_key === derived && item.shot_id === 'shot-2'))
  assert.ok(differences.some(item => item.object_key === base && item.shot_id === 'shot-5'))
  assert.throws(() => validateVisualReferenceCoverage(correction, fixture.scenes, fixture.shots, fixture.profiles), (error: any) => error.differences.length === differences.length)
})
test('2317 arbitration distinguishes initial state and transition; every fixed description and original candidate stays unchanged', () => {
  const before = structuredClone(fixture.profiles), original = structuredClone(correction)
  let profiles = structuredClone(fixture.profiles), coverage = structuredClone(correction)
  for (const shot of fixture.shots) {
    const family = profiles.filter((item: any) => [base, derived].includes(item.draft_key))
    const plan = appearanceArbitration(shot, fixture.scenes[0], family)
    const value = plan.validate(answer(shot))
    const merged = applyAppearanceDecisions(profiles, coverage, shot, value.decisions)
    profiles = merged.profiles; coverage = merged.visual_coverage
  }
  assert.deepEqual(profiles.find((p: any) => p.draft_key === derived).shot_usage.map((row: any) => row.usage), ['none', 'none', 'none', 'video', 'none'])
  assert.deepEqual(profiles.find((p: any) => p.draft_key === base).shot_usage.map((row: any) => row.usage), ['both', 'both', 'none', 'both', 'none'])
  for (const profile of profiles) {
    const old = before.find((p: any) => p.draft_key === profile.draft_key)
    assert.equal(profile.definition, old.definition); assert.equal(profile.view_requirements, old.view_requirements)
  }
  assert.deepEqual(fixture.profiles, before); assert.deepEqual(correction, original)
  // Other captured families may independently conflict; never erase their differences.
  const remaining = visualCoverageDifferences(coverage, fixture.scenes, fixture.shots, profiles)
  assert.ok(!remaining.some(item => [base, derived].includes(item.object_key)))
})
test('future state cannot claim a first frame or use end_state as image evidence; local patch locks all other objects', () => {
  const shot = fixture.shots[3], profiles = fixture.profiles.filter((item: any) => [base, derived].includes(item.draft_key))
  const plan = appearanceArbitration(shot, fixture.scenes[0], profiles), raw = answer(shot)
  raw.decisions[derived].image.visible = true
  assert.throws(() => plan.validate(raw), /首帧/)
  raw.decisions[derived].image.evidence = { field: 'end_state', quote: shot.end_state.slice(0, 20) }
  let failure: any
  try { plan.validate(raw) } catch (error) { failure = error }
  const patch = plan.planLocalRepair(raw, { issues: [], error: failure })!
  assert.ok(patch)
  assert.ok(!JSON.stringify(z.toJSONSchema(patch.schema)).includes('"' + base + '"'))
  const repaired = patch.apply({ repairs: { [derived + '__image']: evidenceWireValue(shot, answer(shot).decisions[derived].image) } })
  plan.validate(repaired)
  assert.deepEqual((repaired as any).decisions[base], raw.decisions[base])
})


test('2317 saved complete coverage replays without full model calls; settled arbitration failure returns all profiles and resumes only that shot', async () => {
  let state: any = { steps: {} }, fail = true
  const calls: string[] = []
  const execute = async (retries = new Map<string, string>()) => {
    const steps = createGenerationSteps({ checkpoint: state, save: value => { state = structuredClone(value) } })
    return prepareVisualCoverage({ scenes: fixture.scenes, shots: fixture.shots, profiles: fixture.profiles, steps,
      hasHistorical: true, historical: () => structuredClone(fixture.coverage_checkpoint), retries,
      generate: async (prompt, contract) => {
        assert.ok(!prompt.includes('已确认对象的外观'), 'coverage never sends legal definitions for rewriting')
        assert.ok(!prompt.includes('剧本资料：'), 'no project-scale source assembly')
        const match = prompt.match(/本次镜头证据：(.*?)(?:\n仅需仲裁|$)/)
        assert.ok(match, 'only one exact shot evidence per arbitration request')
        const evidence = JSON.parse(match[1]!), shot = fixture.shots.find((s: any) => s.id === evidence.shot_id)!
        calls.push(shot.id)
        if (shot.id === 'shot-4' && fail) return JSON.stringify({ decisions: {} })
        if (contract?.name.endsWith('_local_repair')) {
          const keys = Object.keys((contract.schema as any).properties.repairs.properties)
          return JSON.stringify(evidenceWireValue(shot, { repairs: Object.fromEntries(keys.map(key => [key, answer(shot).decisions[key as keyof ReturnType<typeof answer>['decisions']]])) }))
        }
        return JSON.stringify(evidenceWireValue(shot, answer(shot)))
      } })
  }
  const partial = await execute()
  assert.equal(partial.profiles.length, 9)
  assert.equal(partial.failed_units?.length, 1)
  assert.equal(partial.failed_units?.[0]?.stage, 'coverage')
  assert.equal(partial.failed_units?.[0]?.recovery?.action, 'retry', JSON.stringify(partial.failed_units))
  const old = structuredClone(state), count = calls.length
  const duplicate = await execute()
  assert.equal(duplicate.failed_units?.length, 1)
  assert.equal(calls.length, count, 'reopening settled failure cannot purchase another patch')
  fail = false
  const unit = partial.failed_units![0]!
  const complete = await execute(new Map([[unit.unit_key, unit.recovery!.token!]]))
  assert.ok(!complete.failed_units?.length)
  validateVisualReferenceCoverage(complete.visual_coverage!, fixture.scenes, fixture.shots, complete.profiles)
  assert.deepEqual(calls.slice(count), ['shot-4'], 'only failed shot is repaired; no successful profile or shot is repurchased')
  for (const [key, value] of Object.entries(old.steps)) if (key.startsWith('response:')) assert.deepEqual(state.steps[key], value)
  const after = calls.length
  await execute(new Map([[unit.unit_key, unit.recovery!.token!]]))
  assert.equal(calls.length, after, 'duplicate explicit retry reuses its retained successful result')
})

test('unresolved coverage retains later validated shots while fencing new requests', async () => {
  let state: any = { steps: {} }
  const calls: string[] = []
  const run = (selectedKeys?: readonly string[]) => prepareVisualCoverage({ scenes: fixture.scenes, shots: fixture.shots, profiles: fixture.profiles, selectedKeys,
    steps: createGenerationSteps({ checkpoint: state, save: value => { state = structuredClone(value) } }), hasHistorical: true,
    historical: () => structuredClone(fixture.coverage_checkpoint), retries: new Map(), generate: async (prompt, contract) => {
      const shotId = JSON.parse(prompt.match(/本次镜头证据：(.*?)(?:\n仅需仲裁|$)/)![1]!).shot_id
      calls.push(shotId)
      if (selectedKeys) {
        const shot = fixture.shots.find((item: { id: string }) => item.id === shotId)
        return JSON.stringify(evidenceWireValue(shot, answer(shot)))
      }
      assert.equal(shotId, 'shot-1')
      if (contract?.name.endsWith('_local_repair')) throw new TypeError('isolated connection interrupted after dispatch')
      return JSON.stringify({ decisions: {} })
    } })
  await run(['@appearance:shot-4'])
  const partial = await run()
  assert.equal(partial.profiles.length, 9)
  const unknown = partial.failed_units?.find(unit => unit.unit_key === '@appearance:shot-1')
  assert.equal(unknown?.recovery?.action, 'inspect')
  assert.equal(unknown?.recovery?.token, undefined)
  assert.ok(partial.failed_units?.some(unit => unit.unit_key === '@appearance:shot-2' && unit.recovery?.action === 'continue'))
  assert.ok(!partial.failed_units?.some(unit => unit.unit_key === '@appearance:shot-4'))
  const later = partial.profiles.find(profile => profile.draft_key === derived)?.shot_usage?.find(row => row.shot_id === 'shot-4')
  assert.equal(later?.usage, 'video')
  assert.deepEqual(calls, ['shot-4', 'shot-1', 'shot-1'])
  const reopened = await run()
  assert.deepEqual(reopened.profiles, partial.profiles)
  assert.deepEqual(calls, ['shot-4', 'shot-1', 'shot-1'])
})
