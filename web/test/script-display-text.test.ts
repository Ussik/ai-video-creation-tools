import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptDiagnosticDisplayText, scriptReviewDisplayText } from '../src/features/script/script-display-text'

test('the screenshot diagnostic describes the failed analysis and character batch in Chinese', () => {
  const source = '修订稿分析未完成，尚未开始阶段设定核对：模型结果不符合 script_source_story_characters 契约（已修正一次）：人物任务「characters:2」中「杜铮」的别名「戏楼班主」没有所引章节的原文或目录证据。'
  assert.equal(scriptDiagnosticDisplayText(source),
    '修订稿分析未完成，尚未开始阶段设定核对：人物与身份整理未通过格式与内容校验（已修正一次）：人物任务「人物整理（第 3 批）」中「杜铮」的别名「戏楼班主」没有所引章节的原文或目录证据。')
  assert.ok(source.includes('script_source_story_characters'), 'rendering preserves the stored diagnostic')
})

test('every source analysis schema used by the pipeline has a readable diagnostic label', () => {
  const schemas = [
    ['script_source_map', '剧本剧情目录分析'],
    ['script_source_evidence_repair', '原文证据修补'],
    ['script_source_story', '全剧信息整理'],
    ['script_source_story_overview', '全剧主线与结局整理'],
    ['script_source_story_characters', '人物与身份整理'],
    ['script_source_story_characters_merge', '人物身份归并'],
    ['script_source_story_timeline', '事件与因果整理'],
    ['script_source_story_threads', '伏笔与线索整理'],
    ['script_source_story_uncertainties', '待确认信息整理'],
    ['script_source_quality', '剧本分析质量核对'],
    ['script_source_quality_repair', '剧本分析问题修补'],
  ] as const
  for (const [schema, label] of schemas) {
    assert.equal(scriptDiagnosticDisplayText(`模型结果不符合 ${schema} 契约：请检查。`), `${label}未通过格式与内容校验：请检查。`)
    assert.equal(scriptDiagnosticDisplayText(`处理中：${schema}。`), `处理中：${label}。`)
  }
})

test('diagnostics display numbered batches, coverage recovery and hashed character merge tasks', () => {
  assert.equal(scriptDiagnosticDisplayText('任务「characters:0/coverage:1」；timeline:2、threads:3、uncertainties:0；characters_merge:0a1b2c3d。'),
    '任务「人物整理（第 1 批，补全第 2 组）」；事件与因果整理（第 3 批）、伏笔与线索整理（第 4 批）、待确认信息整理（第 1 批）；人物身份归并。')
})

test('workflow draft validation identifies each document and field without exposing the long type enum', () => {
  const issues = [
    'artifacts.0: Unrecognized key: "status"',
    'artifacts.1.artifact_type: Invalid option: expected one of "outline"|"synopsis"|"world"|"episode_outline"',
    'artifacts.1: Unrecognized keys: "type", "status"',
  ]
  for (const separator of ['\n', '；', '; ']) {
    const source = `编写阶段草稿失败：模型结果不符合 workflow_draft 契约（已修正一次）：${issues.join(separator)}`
    assert.equal(scriptDiagnosticDisplayText(source),
      `编写阶段草稿失败：阶段草稿未通过格式与内容校验（已修正一次）：${[
        '第 1 份文档：包含不支持的字段「状态」',
        '第 2 份文档：文档类型缺失或不合法',
        '第 2 份文档：包含不支持的字段「类型别名」、「状态」',
      ].join(separator)}`)
    assert.ok(source.includes(issues[1]!), 'formatting preserves the stored diagnostic and raw model return')
  }
})

test('workflow draft diagnostics describe missing types and legacy enum validation without claiming completion', () => {
  for (const issue of ['Required', 'Invalid input: expected string, received undefined', "Invalid enum value. Expected 'outline' | 'synopsis', received 'summary'"]) {
    const source = `模型结果不符合 workflow_draft 契约：artifacts.9.artifact_type: ${issue}`
    assert.equal(scriptDiagnosticDisplayText(source), '阶段草稿未通过格式与内容校验：第 10 份文档：文档类型缺失或不合法')
  }
  assert.equal(scriptDiagnosticDisplayText('模型结果不符合 workflow_draft 契约：artifacts.0.title: Required\nartifacts.1.content: Invalid input: expected string, received number\nartifacts.2.content: Too small: expected string to have >=1 characters'),
    '阶段草稿未通过格式与内容校验：第 1 份文档：缺少文档标题\n第 2 份文档：文档正文应为文本\n第 3 份文档：文档正文不能为空')
})

test('workflow draft diagnostics translate current JSONPath errors and suppress schema details and enum values', () => {
  const issues = [
    '$.artifacts[0].artifact_type: 缺少必填字段，请按本次 Schema 补全。',
    '$.artifacts[1].type: Schema 未定义的多余字段，请删除该字段，不要原样返回。',
    '$.artifacts[1].status: Schema 未定义的多余字段，请删除该字段，不要原样返回。',
    '$.artifacts[2].artifact_type: 字段取值不合法；允许值包括 "outline"、"synopsis"、"world"、"structure"、"hooks"，其余合法值见本次 Schema。',
    '$.artifacts[3].content: 字段类型不合法，要求 string，当前为 object；请按 Schema 修正。',
    '$.result.artifacts[4].title: 缺少必填字段，请按本次 Schema 补全。',
    '$.artifacts[5]: 存在不支持的字段 "type", "status"',
  ]
  const expected = [
    '第 1 份文档：缺少文档类型',
    '第 2 份文档：包含不支持的字段「类型别名」',
    '第 2 份文档：包含不支持的字段「状态」',
    '第 3 份文档：文档类型不合法',
    '第 4 份文档：文档正文格式不正确',
    '第 5 份文档：缺少文档标题',
    '第 6 份文档：包含不支持的字段「类型别名」、「状态」',
  ]
  for (const separator of ['\n', '；', '; ']) {
    const source = `模型结果不符合 workflow_draft 契约（已修正一次）：${issues.join(separator)}`
    assert.equal(scriptDiagnosticDisplayText(source), `阶段草稿未通过格式与内容校验（已修正一次）：${expected.join(separator)}`)
    assert.ok(source.includes('$.artifacts[0].artifact_type'), 'the source diagnostic remains unchanged')
  }
})

test('workflow draft formatting is scoped to contract diagnostics and retains other validation explanations', () => {
  const prose = '原文包含 workflow_draft、artifacts.0 和 Unrecognized key: "status"。'
  assert.equal(scriptDiagnosticDisplayText(prose), prose)
  const unknown = '模型结果不符合 workflow_draft_extra 契约：artifacts.0: Unrecognized key: "status"'
  assert.equal(scriptDiagnosticDisplayText(unknown), unknown)
  assert.equal(scriptDiagnosticDisplayText('模型结果不符合 workflow_draft 契约：artifacts.0.title: 标题与原文不一致'),
    '阶段草稿未通过格式与内容校验：第 1 份文档的文档标题：标题与原文不一致')
  assert.equal(scriptDiagnosticDisplayText('模型结果不符合 workflow_draft 契约：当前阶段缺少完整文档：背景设定'),
    '阶段草稿未通过格式与内容校验：当前阶段缺少完整文档：背景设定')
})

test('legacy stage scene validation arrays explain the mismatch without exposing internal JSON', () => {
  const issue = { code: 'custom', message: '仅分集正文阶段需要分场剧本', path: ['scenes'] }
  const source = JSON.stringify([issue], null, 2)
  const expected = '生成结果中的分场内容与当前创作阶段不一致，未通过校验。请重新生成当前阶段。'
  assert.equal(scriptDiagnosticDisplayText(source), expected)
  assert.equal(scriptDiagnosticDisplayText(`模型结果不符合 workflow_draft 契约：scenes: ${issue.message}`), `阶段草稿未通过格式与内容校验：${expected}`)
  assert.equal(source, JSON.stringify([issue], null, 2), 'presentation leaves historical diagnostics intact')
})

test('stage scene diagnostics keep other failures and leave unrelated JSON and prose intact', () => {
  const source = JSON.stringify([
    { code: 'custom', message: '仅分集正文阶段需要分场剧本', path: ['scenes'] },
    { code: 'custom', message: '当前阶段缺少完整文档：故事简述', path: ['artifacts'] },
  ])
  const display = scriptDiagnosticDisplayText(source)
  assert.match(display, /分场内容与当前创作阶段不一致/)
  assert.match(display, /当前阶段缺少完整文档：故事简述/)
  assert.doesNotMatch(display, /"code"|"path"/)
  for (const unchanged of [
    '原文中的提示是“仅分集正文阶段需要分场剧本”。',
    JSON.stringify([{ code: 'custom', message: '仅分集正文阶段需要分场剧本', path: ['dialogue'] }]),
    JSON.stringify([{ message: '仅分集正文阶段需要分场剧本', path: ['scenes'] }]),
    '[{"code":"custom","message":"仅分集正文阶段需要分场剧本","path":["scenes"]}',
  ]) assert.equal(scriptDiagnosticDisplayText(unchanged), unchanged)
})

test('scene diagnostics distinguish missing episode scenes from extra project scenes', () => {
  for (const [message, expected] of [
    ['分集正文缺少对应分场，请保留正文并补齐 scenes', '分集正文缺少对应分场，需要保留正文并补齐分场后再确认。'],
    ['当前项目资料阶段不应包含分场剧本，scenes 必须为空数组', '当前正在编写全剧资料，生成结果中不应包含分集的分场内容。'],
  ]) {
    const diagnostic = JSON.stringify([{ code: 'custom', message, path: ['scenes'] }])
    assert.equal(scriptDiagnosticDisplayText(diagnostic), expected)
    assert.equal(scriptDiagnosticDisplayText(`模型结果不符合 workflow_draft 契约：scenes: ${message}`), `阶段草稿未通过格式与内容校验：${expected}`)
    assert.equal(scriptDiagnosticDisplayText(message!), message, 'ordinary model prose is not rewritten')
    const unrelated = JSON.stringify([{ code: 'custom', message, path: ['dialogue'] }])
    assert.equal(scriptDiagnosticDisplayText(unrelated), unrelated, 'the translation requires the exact validation field')
  }
})

test('review prose translates the screenshot document references and preserves adjacent Chinese text', () => {
  assert.equal(scriptReviewDisplayText('episode_outline 第31集告帖点名；world的封坛匣条目与constraints 第37条冲突，foreshadowing第22条及synopsis也须同步。'),
    '分集大纲 第31集告帖点名；背景设定的封坛匣条目与创作禁区 第37条冲突，伏笔与回收第22条及故事简述也须同步。')
  assert.equal(scriptReviewDisplayText('outline、structure、hooks、reversals、characters、relationships；locations、location_layouts、location_atmosphere、location_continuity；props、prop_visuals、prop_functions、prop_continuity；episode_script。'),
    '概要设计、全剧分段、钩子预设、反转预设、人物小传、人物关系；场景清单、空间与动线、视觉与氛围、场景连续性；道具清单、外观与辨识、剧情功能与使用规则、归属与状态流转；分集正文。')
})

test('unknown identifiers and longer identifier fragments remain unchanged', () => {
  const diagnostics = 'script_source_future、script_source_story_characters_extra、prefix_script_source_map、script_source_map2；characters:2_extra、characters:2x、prefix_characters:2、characters_merge:xyz。'
  assert.equal(scriptDiagnosticDisplayText(diagnostics), diagnostics)
  const review = 'worldbuilding、world2、my_world、world_map、episode_outlines、episode_outline_extra、constraints2、future_artifact、WORLD。'
  assert.equal(scriptReviewDisplayText(review), review)
  assert.equal(scriptDiagnosticDisplayText('模型结果不符合 script_source_future 契约：未知格式。'), '模型结果不符合 script_source_future 契约：未知格式。')
})

test('all repeated evidence occurrences remain verbatim even when the quote list contains nested duplicates', () => {
  const quote = '他说：“world 与 constraints 的关系见 episode_outline。”'
  const evidence = Object.freeze([quote, 'world 与 constraints', quote, '', 'episode_outline'])
  const source = `world需核对。原文：${quote}；另一次引用：${quote}；建议同步foreshadowing。`
  assert.equal(scriptReviewDisplayText(source, evidence), `背景设定需核对。原文：${quote}；另一次引用：${quote}；建议同步伏笔与回收。`)
  assert.deepEqual(evidence, [quote, 'world 与 constraints', quote, '', 'episode_outline'])
  assert.ok(source.startsWith('world'), 'rendering never rewrites the input text')
})

test('overlapping evidence protects the complete original spans at every occurrence regardless of quote order', () => {
  const overlap = 'world、constraints、foreshadowing'
  const source = `episode_outline：${overlap}；再次引用：${overlap}；synopsis。`
  const expected = `分集大纲：${overlap}；再次引用：${overlap}；故事简述。`
  const quotes = ['world、constraints', 'constraints、foreshadowing']
  assert.equal(scriptReviewDisplayText(source, quotes), expected)
  assert.equal(scriptReviewDisplayText(source, [...quotes].reverse()), expected)
})

test('empty inputs and evidence absent from the text do not affect ordinary display formatting', () => {
  assert.equal(scriptDiagnosticDisplayText(''), '')
  assert.equal(scriptReviewDisplayText('', ['world']), '')
  assert.equal(scriptReviewDisplayText('world 与 constraints。', ['未出现的原文', '']), '背景设定 与 创作禁区。')
})
