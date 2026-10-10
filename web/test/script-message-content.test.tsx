import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const { default: ScriptMessageContent } = await import('../src/ScriptMessageContent')

function render(text: string) {
  return new JSDOM(renderToStaticMarkup(<ScriptMessageContent text={text} />)).window.document
}

test('revision summaries render accessible GFM tables with inline formatting and aligned columns', () => {
  const doc = render('###各文档修订摘要\n| 文档 | 状态 | 本次修订 |\n| :--- | :---: | ---: |\n| 全剧故事大纲 | **已修订** | 名称与地点已统一 |\n| 第1集 | 无需修改 | 已与设定一致 |\n###说明\n正文。')
  assert.equal(doc.querySelector('h3')?.textContent, '各文档修订摘要')
  assert.equal(doc.querySelectorAll('table').length, 1)
  assert.equal(doc.querySelectorAll('thead th[scope="col"]').length, 3)
  assert.equal(doc.querySelectorAll('tbody tr').length, 2)
  assert.equal(doc.querySelectorAll('tbody td').length, 6)
  assert.equal(doc.querySelector('tbody strong')?.textContent, '已修订')
  assert.match(doc.querySelector('thead th:nth-child(2)')?.getAttribute('style') || '', /text-align:center/)
  assert.match(doc.querySelector('tbody td:last-child')?.getAttribute('style') || '', /text-align:right/)
  assert.equal(doc.querySelector('.script-message-table-scroll')?.getAttribute('tabindex'), '0')
  assert.equal(doc.querySelectorAll('h3').length, 2)
})

test('escaped pipes and explicit cell breaks stay inside their cells', () => {
  const doc = render('| 文档 | 修订 |\n| --- | --- |\n| 人物\\|关系 | 第一行<br/>第二行<br>第三行 |')
  assert.equal(doc.querySelectorAll('tbody td').length, 2)
  assert.equal(doc.querySelector('tbody td')?.textContent, '人物|关系')
  assert.equal(doc.querySelectorAll('tbody td:last-child br').length, 2)
})

test('pipe prose, malformed separators and fenced Markdown examples never become tables', () => {
  const doc = render('甲 | 乙，仍是正文。\n\n| 名称 | 状态 |\n| -- | 待定 |\n\n```md\n###保留源码\n| 文档 | 状态 |\n| --- | --- |\n| 人物 | 已修订 |\n```')
  assert.equal(doc.querySelectorAll('table').length, 0)
  assert.match(doc.querySelector('pre code')?.textContent || '', /###保留源码/)
  assert.match(doc.querySelector('pre code')?.textContent || '', /\| --- \| --- \|/)
  assert.match(doc.body.textContent || '', /甲 \| 乙，仍是正文/)
})

test('raw HTML and unsafe links remain disabled while readable message content survives', () => {
  const doc = render('| 文档 | 修订 |\n| --- | --- |\n| <script>alert(1)</script> | <img src=x onerror=alert(1)>说明 |\n\n[危险链接](javascript:alert%281%29)\n\n[安全链接](https://example.com)')
  assert.equal(doc.querySelectorAll('script,img').length, 0)
  assert.match(doc.querySelector('tbody td:last-child')?.textContent || '', /说明/)
  assert.equal(doc.querySelector('a')?.getAttribute('href'), '')
  assert.equal(doc.querySelector('a:last-child')?.getAttribute('rel'), 'noopener noreferrer')
  assert.match(doc.body.textContent || '', /危险链接/)
})

test('ordinary Chinese headings, multiline prose, lists and emphasis remain formatted', () => {
  const doc = render('##1.林晚与奶奶\n第一行\n第二行\n\n1. **人物设定**\n2. 场景设定\n\n> 统一风格\n\n~~~md\n##保持源码\n~~~')
  assert.equal(doc.querySelector('h2')?.textContent, '1.林晚与奶奶')
  assert.equal(doc.querySelector('p')?.textContent, '第一行\n第二行')
  assert.equal(doc.querySelectorAll('ol li').length, 2)
  assert.equal(doc.querySelector('strong')?.textContent, '人物设定')
  assert.match(doc.querySelector('blockquote')?.textContent || '', /统一风格/)
  assert.match(doc.querySelector('pre code')?.textContent || '', /##保持源码/)
})
