import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProjectDetail, VisualProfile } from '../src/shared/api/api'
import { resolveCanvasProfileDisplayText } from '../src/features/canvas/canvas-profile-display-text'

const fixture = () => {
  const base = { id: 'base-id', project_id: 'p', design_id: 'design-6', kind: 'character', name: '姜望', variant: '渡口补网装·落泥前',
    source_draft_key: 'P6-CHAR-JIANGWANG-BASE::1234abcd' } as VisualProfile
  const state = { ...base, id: 'state-id', variant: '左手背少量泥点', source_draft_key: 'P6-CHAR-JIANGWANG-MUD::1234abcd', base_profile_id: base.id }
  const detail = { visual_profiles: [base, state], shots: [{ id: 'shot-id', project_id: 'p', title: '泥水落在补网的手上' }] } as ProjectDetail
  return { base, state, detail }
}

test('existing override prose resolves real profile and shot IDs without changing source data', () => {
  const { state, detail } = fixture(), source = '基础为base-id，在shot-id视频中左手背溅泥。'
  const before = JSON.stringify(detail)
  assert.equal(resolveCanvasProfileDisplayText(source, state, detail), '基础为姜望（渡口补网装·落泥前），在镜头「泥水落在补网的手上」视频中左手背溅泥。')
  assert.equal(source, '基础为base-id，在shot-id视频中左手背溅泥。')
  assert.equal(JSON.stringify(detail), before)
})

test('same-design draft keys and scoped aliases resolve while another design cannot supply their labels', () => {
  const { base, state, detail } = fixture()
  detail.visual_profiles!.push({ ...base, id: 'old-id', design_id: 'design-5', name: '旧方案姜望', source_draft_key: 'P6-CHAR-JIANGWANG-BASE::ffffffff' })
  assert.equal(resolveCanvasProfileDisplayText('沿用P6-CHAR-JIANGWANG-BASE::1234abcd和P6-CHAR-JIANGWANG-BASE。', state, detail),
    '沿用姜望（渡口补网装·落泥前）和姜望（渡口补网装·落泥前）。')
  assert.equal(resolveCanvasProfileDisplayText('旧记录为old-id。', state, detail), '旧记录为旧方案姜望（渡口补网装·落泥前）。')
  assert.equal(resolveCanvasProfileDisplayText('不明草稿P6-CHAR-JIANGWANG-BASE::ffffffff。', state, detail), '不明草稿P6-CHAR-JIANGWANG-BASE::ffffffff。')
})

test('historical base wording uses only the explicit same-design relation', () => {
  const { base, state, detail } = fixture()
  base.source_draft_key = null
  assert.equal(resolveCanvasProfileDisplayText('基础为本批P6-CHAR-JIANGWANG-BASE，其余保持。', state, detail),
    '基础为本批姜望（渡口补网装·落泥前），其余保持。')
  base.design_id = 'design-5'
  assert.equal(resolveCanvasProfileDisplayText('基础为本批P6-CHAR-JIANGWANG-BASE，其余保持。', state, detail),
    '基础为本批关联设定待核对，其余保持。')
})

test('stable image tokens, URLs and embedded machine-key fragments remain byte-for-byte', () => {
  const { state, detail } = fixture()
  const source = '[[ref:base-id]] https://host/base-id/shot-id?q=P6-CHAR-JIANGWANG-BASE ' +
    'data:image/png;base64,base-id blob:base-id file:/base-id prefix-base-id base-id-suffix；可读base-id。'
  assert.equal(resolveCanvasProfileDisplayText(source, state, detail),
    source.replace('可读base-id。', '可读姜望（渡口补网装·落泥前）。'))
})

test('ambiguous same-design draft aliases and foreign-project records never guess a profile label', () => {
  const { base, state, detail } = fixture()
  detail.visual_profiles!.push({ ...base, id: 'ambiguous-id', name: '同键另一人物' }, { ...base, id: 'foreign-id', project_id: 'foreign', name: '其他项目人物' })
  detail.shots.push({ id: 'foreign-shot', project_id: 'foreign', title: '其他项目镜头' } as ProjectDetail['shots'][number])
  assert.equal(resolveCanvasProfileDisplayText('沿用P6-CHAR-JIANGWANG-BASE。', state, detail), '沿用关联设定待核对。')
  assert.equal(resolveCanvasProfileDisplayText('保留foreign-id和foreign-shot。', state, detail), '保留foreign-id和foreign-shot。')
})
