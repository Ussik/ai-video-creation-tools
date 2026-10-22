import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeEditedPromptDocument, extractPromptBody, getManagedPromptBlocks, restoreManagedPromptBlocks, stripManagedPromptBlocks, validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'

const ending = '保持上述对象的外观、比例、服装、材质与空间关系。只生成当前镜头的一幅完整画面或连续视频；不要复制设定板的多视角拼版、文字、标签或色板。'
const legacyBlock = `【镜头视觉设定】\n人物：姜望（渡口，版本 1）；参考图 1\n灰衣\n${ending}`

test('bounded system blocks are removed independently while all surrounding user characters survive', () => {
  const body = '\n  姜望补网。🎣\t\n\n'
  let full = body
  for (const name of ['镜头视觉设定', '图片参考图用途', '视频参考图用途', '项目画风约束', '图片生成要求', '视频生成要求',
    '基础身份参考', '设定图固定要求', '生成参数约束', '基础版本与本次状态变化', '生成参考图']) {
    full += `\n\n【${name}】\n固定资料\n【${name}结束】`
  }
  const suffix = '\n\t人工尾部段落。  \n'
  assert.equal(stripManagedPromptBlocks(full + suffix), body + suffix)
  assert.equal(stripManagedPromptBlocks(stripManagedPromptBlocks(full)), body)
})

test('a bare old visual heading never consumes the creator tail without exact template evidence', () => {
  const value = `姜望补网。\n\n${legacyBlock}\n\n人工调整：固定机位。`
  assert.equal(stripManagedPromptBlocks(value), value)
  assert.equal(stripManagedPromptBlocks('正文\n\n【镜头视觉设定】手写说明'), '正文\n\n【镜头视觉设定】手写说明')
})

test('old visual blocks require a full generated ending and exact matching content; creator suffix survives', () => {
  const template = `原正文\n\n${legacyBlock}\n\n模板尾部不属于固定区`
  const value = `新的动作。\n\n${legacyBlock}\n\n创作者新尾部。\t\n`
  assert.equal(stripManagedPromptBlocks(value, { legacyVisualTemplates: [template] }), '新的动作。\n\n创作者新尾部。\t\n')
  const edited = value.replace('灰衣', '创作者手改的蓝衣')
  assert.equal(stripManagedPromptBlocks(edited, { legacyVisualTemplates: [template] }), edited)
  assert.equal(stripManagedPromptBlocks(value, { legacyVisualTemplates: ['【镜头视觉设定】\n人物：姜望'] }), value)
})

test('an explicit body wins over a stale complete prompt, including its intentional whitespace', () => {
  const prompt = `原正文\n\n${legacyBlock}`
  assert.equal(extractPromptBody({ prompt, prompt_body: '  新正文。\n\t', prompt_template: prompt }), '  新正文。\n\t')
  assert.equal(extractPromptBody({ prompt, prompt_body: '' }), '')
  assert.equal(extractPromptBody({ prompt, prompt_template: prompt }), '原正文')
  assert.equal(extractPromptBody({ prompt }), prompt)
})

test('incomplete markers and unrecognized blocks remain user prose', () => {
  const prompt = '【自定义说明】保留【自定义说明结束】\n\n【项目画风约束】尚未写完\n\n【图片参考图用途】人工草稿'
  assert.equal(stripManagedPromptBlocks(prompt), prompt)
})

test('only exact legacy parameter fields are removed, preserving every following creator paragraph', () => {
  const image = '图片生成要求：\n画面比例：16:9。\n清晰度要求：4K\n背景要求：保留背景'
  const video = '【视频生成要求】\n视频时长：5 秒。动作连续。\n画面比例：16:9。\n清晰度要求：4K。\n首帧要求：承接输入图。'
  const template = `原正文\n\n${image}\n\n${video}\n\n${legacyBlock}`
  const userTail = '\n\n我的镜头调整：固定机位。  \n'
  const prompt = `新正文\n\n${image}\n\n${video}${userTail}`
  assert.equal(extractPromptBody({ prompt, prompt_template: template }), '新正文' + userTail)
  assert.equal(extractPromptBody({ prompt: prompt.replace('清晰度要求：4K\n', '清晰度要求：2K\n'), prompt_template: template }),
    `新正文\n\n${image.replace('4K', '2K')}${userTail}`)
})

test('selective stripping preserves parameter and style layers; extraction follows source order', () => {
  const style = '【项目画风约束】\n水墨\n【项目画风约束结束】'
  const parameters = '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】'
  const visual = '【镜头视觉设定】\n人物：姜望\n【镜头视觉设定结束】'
  const prompt = `正文\n\n${style}\n\n${parameters}\n\n${visual}`
  assert.deepEqual(getManagedPromptBlocks(prompt, ['图片生成要求', '项目画风约束']), [style, parameters])
  assert.equal(stripManagedPromptBlocks(prompt, { blockNames: ['镜头视觉设定'] }), `正文\n\n${style}\n\n${parameters}`)
})

test('complete document updates only untouched template sections and preserves authored changes and deletions', () => {
  const block = (name: string, content: string) => `【${name}】\n${content}\n【${name}结束】`
  const oldVisual = block('镜头视觉设定', '旧设定'), newVisual = block('镜头视觉设定', '新设定')
  const oldParameters = block('图片生成要求', '16:9'), newParameters = block('图片生成要求', '9:16')
  const oldStyle = block('项目画风约束', '旧画风'), newStyle = block('项目画风约束', '新画风')
  const previousTemplate = [oldVisual, oldParameters, oldStyle].join('\n\n')
  const nextTemplate = [newVisual, newParameters, newStyle].join('\n\n')
  const document = `  人工正文\n\n${oldVisual.replace('旧设定', '人工改设定 [[ref:hero]]')}\n\n段落二\t\n\n${oldParameters}\n尾部  `
  const result = composeEditedPromptDocument({ document, previousTemplate, nextTemplate })
  assert.equal(result, document.replace(oldParameters, newParameters))
  assert.doesNotMatch(result, /新设定|新画风|旧画风/)
  assert.equal(composeEditedPromptDocument({ document, previousTemplate, nextTemplate: previousTemplate }), document)
  assert.equal(composeEditedPromptDocument({ document: '用户删光全部区块。', previousTemplate, nextTemplate }), '用户删光全部区块。')
  assert.equal(composeEditedPromptDocument({ document: `正文\n\n${oldParameters}`, previousTemplate: oldParameters,
    nextTemplate: '' }), '正文')
  assert.equal(composeEditedPromptDocument({ document: '正文', previousTemplate: '', nextTemplate: oldParameters }), `正文\n\n${oldParameters}`)
})

test('body rewriting preserves exact authored sections and incomplete markers are never auto-composed', () => {
  const section = '【图片参考图用途】\n人工身份[[ref:hero]]。\n【图片参考图用途结束】'
  const original = `  原正文\n\n${section}\n尾部。  `
  assert.equal(restoreManagedPromptBlocks(stripManagedPromptBlocks(original), original), original)
  assert.equal(restoreManagedPromptBlocks('新正文\n\n【图片参考图用途】\n模型伪造\n【图片参考图用途结束】', original), `新正文\n\n${section}`)
  assert.equal(composeEditedPromptDocument({ document: original, previousTemplate: original, nextTemplate: original,
    body: '改后的正文' }), `改后的正文\n\n${section}`)
  const unfinished = '正文\n\n【图片参考图用途】\n用户正在编辑'
  assert.equal(composeEditedPromptDocument({ document: unfinished, previousTemplate: '', nextTemplate: section, body: '新正文' }), unfinished)
})

test('known section markers must pair without nesting while unknown headings remain prose', () => {
  for (const document of ['【镜头视觉设定】未结束', '【镜头视觉设定结束】',
    '【镜头视觉设定】x【图片参考图用途】y【图片参考图用途结束】【镜头视觉设定结束】',
    '【镜头视觉设定】x【项目画风约束结束】']) assert.throws(() => validateManagedPromptDocument(document), /系统区/)
  assert.doesNotThrow(() => validateManagedPromptDocument('【自定义章节】未配对也保留\n【镜头视觉设定】x【镜头视觉设定结束】'))
})
