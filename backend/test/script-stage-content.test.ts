import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels, scriptStageForArtifact, type ScriptStage } from '@video-studio/shared/script/script-stage-content'
import { scriptDesignStageInstructions } from '@video-studio/shared/script/script-design-content'
import { scriptStageQualityGuidance } from '@video-studio/shared/script/script-quality'
import { workflowDraftSchema, workflowGenerationDraftSchema, workflowInstructions, workflowContentInstructions, workflowRequest, parseWorkflowDraft } from '../src/modules/script/script-workflow.js'

function draft(stage: ScriptStage) {
  return { stage, artifacts: scriptStageArtifacts[stage].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: `具体的${scriptArtifactLabels[artifact_type]}正文` })),
    scenes: stage === 'episode' ? [{ heading: '修车铺', action: '林照收起报纸', duration: 10 }] : [] }
}

test('outline and episode templates allow genre-appropriate endings and finale resolution', () => {
  for (const stage of ['outline', 'episode'] as const) {
    const prompt = workflowContentInstructions(workflowRequest.parse({ stage, episode_number: 8 }))
    assert.match(prompt, /是否设置悬念由题材、叙事阶段与创作者明确要求决定/)
    assert.match(prompt, /当集结果与情感落点/)
    assert.match(prompt, /终集完成主线、人物弧光和关键伏笔的兑现/)
    assert.doesNotMatch(prompt, /各集结尾悬念|结尾悬念与下一集承接|结尾钩子以及留给下一集的状态/)
  }
})

test('new drafts require every deliverable and report the specific missing document', () => {
  assert.equal(scriptStageArtifacts.outline.length, 9)
  assert.equal(scriptStageArtifacts.characters.length, 2)
  assert.equal(scriptStageArtifacts.locations.length, 4)
  assert.equal(scriptStageArtifacts.props.length, 4)
  for (const stage of Object.keys(scriptStageArtifacts) as ScriptStage[]) {
    const complete = draft(stage)
    assert.ok(workflowGenerationDraftSchema.safeParse(complete).success, stage)
    for (const missing of scriptStageArtifacts[stage]) {
      const result = workflowGenerationDraftSchema.safeParse({ ...complete, artifacts: complete.artifacts.filter(doc => doc.artifact_type !== missing) })
      assert.equal(result.success, false, `${stage}/${missing}`)
      if (!result.success) assert.match(result.error.message, new RegExp(scriptArtifactLabels[missing]))
    }
  }
})

test('complete drafts reject empty bodies, duplicate types, other stages and incorrect scopes', () => {
  const outline = draft('outline')
  const invalid = [
    { ...outline, artifacts: outline.artifacts.map((doc, i) => i === 0 ? { ...doc, content: '  ' } : doc) },
    { ...outline, artifacts: [...outline.artifacts.slice(0, 8), outline.artifacts[0]] },
    { ...outline, artifacts: [...outline.artifacts.slice(0, 8), draft('props').artifacts[0]] },
    { ...outline, scope: 'episode' },
    { ...outline, scenes: [{ heading: '越界分场', duration: 10 }] },
    { ...draft('episode'), episode_number: 0 },
    { ...draft('episode'), scope: 'project' },
    { ...draft('episode'), scenes: [] },
  ]
  for (const value of invalid) assert.equal(workflowGenerationDraftSchema.safeParse(value).success, false)
})

test('missing episode scenes and extra project scenes report distinct actionable errors', () => {
  const episode = workflowGenerationDraftSchema.safeParse({ ...draft('episode'), scenes: [] })
  assert.equal(episode.success, false)
  if (!episode.success) assert.deepEqual(episode.error.issues.map(issue => ({ path: issue.path, message: issue.message })), [
    { path: ['scenes'], message: '分集正文缺少对应分场，请保留正文并补齐 scenes' },
  ])
  const project = workflowGenerationDraftSchema.safeParse({ ...draft('outline'), scenes: [{ heading: '越界分场', duration: 10 }] })
  assert.equal(project.success, false)
  if (!project.success) assert.deepEqual(project.error.issues.map(issue => ({ path: issue.path, message: issue.message })), [
    { path: ['scenes'], message: '当前项目资料阶段不应包含分场剧本，scenes 必须为空数组' },
  ])
})

test('generated documents require explicit nonblank titles and accept bodies without repeated headings', () => {
  const complete = draft('outline')
  const request = workflowRequest.parse({ stage: 'outline' })
  for (const title of [undefined, null, '', ' \n\t ']) {
    const artifacts = complete.artifacts.map((doc, index) => index === 0 ? { ...doc, title } : doc)
    const result = workflowGenerationDraftSchema.safeParse({ ...complete, artifacts })
    assert.equal(result.success, false)
    if (!result.success) {
      assert.deepEqual(result.error.issues[0].path, ['artifacts', 0, 'title'])
      assert.match(result.error.issues[0].message, /标题.*补全 title/)
    }
    assert.equal(parseWorkflowDraft(JSON.stringify({ artifacts, scenes: [] }), request), null)
  }
  const artifacts = complete.artifacts.map(doc => ({ ...doc, title: `城市救援 · ${doc.title}` }))
  const result = parseWorkflowDraft(JSON.stringify({ artifacts, scenes: [] }), request)!
  assert.deepEqual(result.artifacts, artifacts, 'preserves model titles and complete bodies without title headings')
})

test('saved legacy drafts remain editable while JSON generation rejects incomplete results', () => {
  const legacy = { ...draft('outline'), artifacts: draft('outline').artifacts.slice(0, 1) }
  assert.ok(workflowDraftSchema.safeParse(legacy).success)
  assert.equal(workflowGenerationDraftSchema.safeParse(legacy).success, false)
  const request = workflowRequest.parse({ stage: 'outline', episode_number: 5 })
  assert.equal(parseWorkflowDraft(JSON.stringify({ artifacts: legacy.artifacts, scenes: [] }), request), null)
  assert.equal(parseWorkflowDraft(JSON.stringify({ artifacts: draft('outline').artifacts, scenes: [] }), request)?.episode_number, 0)
  const episode = draft('episode')
  episode.artifacts[0].title = '第 3 集 · 地下救援'
  const result = parseWorkflowDraft(JSON.stringify({ artifacts: episode.artifacts, scenes: episode.scenes }), workflowRequest.parse({ stage: 'episode', episode_number: 3 }))!
  assert.equal(result.episode_number, 3)
  assert.equal(result.artifacts[0].title, '第 3 集 · 地下救援')
})

test('explicit JSON and tool generation share detailed content standards with discussion', () => {
  for (const stage of Object.keys(scriptStageArtifacts) as ScriptStage[]) {
    const request = workflowRequest.parse({ stage, episode_number: 2 })
    const standards = workflowContentInstructions(request)
    assert.ok(standards.includes(scriptStageQualityGuidance(stage)))
    for (const type of scriptStageArtifacts[stage]) assert.ok(standards.includes(scriptArtifactLabels[type]), type)
    assert.ok(workflowInstructions(request, 'tools').includes(standards))
    assert.ok(workflowInstructions(request, 'json').includes(standards))
    assert.match(standards, /title 是必填的唯一文档标题/)
    assert.match(standards, /正文无需再写文档总标题/)
    assert.doesNotMatch(standards, /本轮为|不提问|本轮.*文档生成/)
  }
  assert.match(workflowContentInstructions(workflowRequest.parse({ stage: 'episode', episode_number: 2, target_duration: 60 })), /只写第 2 集[\s\S]*约 60 秒/)
})

test('artifact classification keeps relationships in characters and episode outlines in the story stage', () => {
  assert.equal(scriptStageForArtifact('relationships'), 'characters')
  assert.equal(scriptStageForArtifact('episode_outline'), 'outline')
  assert.equal(scriptStageForArtifact('episode_script'), 'episode')
  assert.equal(scriptStageForArtifact('unknown'), undefined)
  for (const stage of ['locations', 'props'] as const) {
    for (const type of scriptStageArtifacts[stage]) assert.equal(scriptStageForArtifact(type), stage)
  }
})

test('design JSON generation rejects malformed stages but retains historical single-document edits', () => {
  for (const stage of ['locations', 'props'] as const) {
    const complete = draft(stage), request = workflowRequest.parse({ stage, episode_number: 8 })
    const invalid = [
      complete.artifacts.slice(0, 1),
      [...complete.artifacts, complete.artifacts[0]],
      [...complete.artifacts, draft(stage === 'locations' ? 'props' : 'locations').artifacts[1]],
      complete.artifacts.map((doc, i) => i === 2 ? { ...doc, title: '' } : doc),
      complete.artifacts.map((doc, i) => i === 2 ? { ...doc, content: ' \n ' } : doc),
    ]
    for (const artifacts of invalid) {
      assert.equal(workflowGenerationDraftSchema.safeParse({ ...complete, artifacts }).success, false)
      assert.equal(parseWorkflowDraft(JSON.stringify({ artifacts, scenes: [] }), request), null)
    }
    const parsed = parseWorkflowDraft(JSON.stringify({ artifacts: complete.artifacts, scenes: complete.scenes }), request)!
    assert.deepEqual(parsed.artifacts, complete.artifacts)
    assert.equal(parsed.episode_number, 0)
    assert.deepEqual(parsed.scenes, [])
    const legacy = { ...complete, artifacts: [{ ...complete.artifacts[0], title: stage === 'locations' ? '场景设计' : '道具设计', content: '# 已有模型标题\n完整原文不可丢失' }] }
    assert.deepEqual(workflowDraftSchema.parse(legacy).artifacts, legacy.artifacts)
    assert.equal(workflowGenerationDraftSchema.safeParse(legacy).success, false)
    assert.ok(workflowContentInstructions(request).includes(scriptDesignStageInstructions(stage)))
  }
})
