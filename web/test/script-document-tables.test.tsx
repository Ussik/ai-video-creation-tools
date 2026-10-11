import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const { DirectorDocumentBody } = await import('../src/DirectorDocuments')

test('director document reader renders accessible scene tables with header, rows and formatting', () => {
  const text = '##全剧场景设计\n| 地点（暂名） | 类别 | 主要剧情功能 | 出现阶段 |\n| :--- | :---: | --- | ---: |\n| **旧祠堂** | 核心场景 | 家族记忆与真相浮出水面<br>承载家庭和解 | 1—20集 |\n| 桥头 | 外景 | ~~旧设定~~，_追逐与冲突_ | 中段 |'
  const dom = new JSDOM(renderToStaticMarkup(<DirectorDocumentBody text={text} />))
  try {
    const doc = dom.window.document
    assert.equal(doc.querySelector('h2')?.textContent, '全剧场景设计')
    assert.equal(doc.querySelectorAll('table').length, 1)
    assert.equal(doc.querySelectorAll('thead th[scope="col"]').length, 4)
    assert.equal(doc.querySelectorAll('tbody tr').length, 2)
    assert.equal(doc.querySelectorAll('tbody td').length, 8)
    assert.equal(doc.querySelector('tbody strong')?.textContent, '旧祠堂')
    assert.equal(doc.querySelector('tbody em')?.textContent, '追逐与冲突')
    assert.equal(doc.querySelector('tbody s')?.textContent, '旧设定')
    assert.equal(doc.querySelectorAll('tbody td br').length, 1)
    assert.equal(doc.querySelector('thead th:nth-child(2)')?.style.textAlign, 'center')
    assert.equal(doc.querySelector('tbody td:last-child')?.style.textAlign, 'right')
    assert.equal(doc.querySelector('[role="region"][aria-label="文档表格"]')?.getAttribute('tabindex'), '0')
    assert.equal(doc.querySelector('table')?.style.minWidth, '480px')
    assert.doesNotMatch(doc.body.textContent || '', /\| ---/)
  } finally { dom.window.close() }
})

test('unsafe HTML remains literal table text and ordinary document paragraphs stay readable', () => {
  const dom = new JSDOM(renderToStaticMarkup(<DirectorDocumentBody text={'说明正文。\n| 人物 | 说明 |\n| --- | --- |\n| 林晚\\|奶奶 | <img src=x onerror=alert(1)> |\n\n结尾正文。'} />))
  try {
    const doc = dom.window.document
    assert.equal(doc.querySelectorAll('img,script').length, 0)
    assert.equal(doc.querySelector('tbody td')?.textContent, '林晚|奶奶')
    assert.equal(doc.querySelector('tbody td:last-child')?.textContent, '<img src=x onerror=alert(1)>')
    assert.match(doc.body.textContent || '', /说明正文/)
    assert.match(doc.body.textContent || '', /结尾正文/)
  } finally { dom.window.close() }
})
