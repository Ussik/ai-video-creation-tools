import assert from 'node:assert/strict'
import { test } from 'node:test'
import { managedPromptBlockNames } from '@video-studio/shared/visuals/prompt-document'
import { promptPreviewText } from '../src/features/canvas/canvas-prompt-preview'

test('full preview labels prose while retaining all requirement types, references and generation order', () => {
  const requirements = managedPromptBlockNames.map(name => `【${name}】\n保留要求与[[ref:asset-1]]\n【${name}结束】`)
  const prose = '正文第一行\n正文第二行[[ref:asset-1]]'
  const prompt = `  ${prose}\n\n${requirements.join('\n\n')}\n`
  const preview = promptPreviewText(prompt)
  assert.equal(preview, `  【主要创作内容】\n${prose}\n【主要创作内容结束】\n\n${requirements.join('\n\n')}\n`)
  assert.equal(promptPreviewText(preview), preview, 'reopening an already labelled display must not duplicate its labels')
})

test('board primary keeps its existing boundaries and only authored supplements gain prose boundaries', () => {
  const primary = '【设定图固定要求】\n对象：祠堂；保留四视图。\n【设定图固定要求结束】'
  assert.equal(promptPreviewText(primary), primary)
  const prompt = `${primary}\n\n补充：夜间侧光。\n\n【图片生成要求】\n4K\n【图片生成要求结束】`
  assert.equal(promptPreviewText(prompt), `${primary}\n\n【主要创作内容】\n补充：夜间侧光。\n【主要创作内容结束】\n\n【图片生成要求】\n4K\n【图片生成要求结束】`)
})

test('empty content and whitespace separators never become empty prose sections', () => {
  assert.equal(promptPreviewText(''), '')
  assert.equal(promptPreviewText(' \n\t'), ' \n\t')
  const prompt = '\n\n【图片生成要求】\n4K\n【图片生成要求结束】\n\n'
  assert.equal(promptPreviewText(prompt), prompt)
})
