import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import type { useScriptDocumentSearch } from './useScriptDocumentSearch'

export function ScriptDocumentSearch({ search }: { search: ReturnType<typeof useScriptDocumentSearch> }) {
  if (!search.opened) return null
  const { query, matches, activeMatch, activeIndex } = search
  return <div id="script-full-text-search" className="script-search-panel" role="search" aria-label="剧本文档全文搜索">
    <div className="script-search-heading"><strong>全文搜索</strong><span>全部剧本文档</span></div>
    <div className="script-search-controls">
      <label className="script-search-field">
        <Search size={15} aria-hidden="true" />
        <input ref={search.inputRef} aria-label="搜索全部剧本文档" placeholder="输入关键词" value={query}
          onChange={event => search.changeQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              search.move(event.shiftKey ? -1 : 1)
            }
          }} />
        <span className="script-search-count" role="status" aria-live="polite">{query.trim() ? `${matches.length ? activeIndex + 1 : 0} / ${matches.length}` : ''}</span>
      </label>
      <button type="button" aria-label="上一个搜索结果" title="上一个（Shift + Enter）" disabled={!matches.length} onClick={() => search.move(-1)}><ArrowUp size={16} /></button>
      <button type="button" aria-label="下一个搜索结果" title="下一个（Enter）" disabled={!matches.length} onClick={() => search.move(1)}><ArrowDown size={16} /></button>
      <button type="button" aria-label="关闭全文搜索" title="关闭（Esc）" onClick={search.close}><X size={16} /></button>
    </div>
    <div className="script-search-caption">
      <span>{activeMatch?.title || (query.trim() ? '未找到匹配内容' : '搜索大纲、人物、场景、道具及各集正文')}</span>
      <small>Enter 下一条 · Esc 关闭</small>
    </div>
  </div>
}
