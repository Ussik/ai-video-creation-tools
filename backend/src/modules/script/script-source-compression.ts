/**
 * Script Source Index Compression Module (Simplified)
 *
 * Uses JSON field extraction instead of LLM calls
 *
 * Benefits:
 * - No additional LLM calls
 * - Immediate execution
 * - Reduces from ~40K tokens to ~2-3K tokens
 */

/**
 * Compress script source index (text-based, no LLM call)
 */
export function compressScriptSourceIndex(sourceIndexData: any): string {
  const summary: string[] = []

  summary.push('## 剧本分析摘要\n')

  // Extract chapters
  if (sourceIndexData.chapters && Array.isArray(sourceIndexData.chapters)) {
    summary.push(`### 章节（共${sourceIndexData.chapters.length}章）`)
    sourceIndexData.chapters.slice(0, 15).forEach((ch: any) => {
      summary.push(`- 第${ch.number || ch.chapter_number || '?'}章：${ch.title || ch.chapter_title || '未命名'}`)
    })
    if (sourceIndexData.chapters.length > 15) {
      summary.push(`- ... 及其他${sourceIndexData.chapters.length - 15}章`)
    }
    summary.push('')
  }

  // Extract characters
  if (sourceIndexData.characters && Array.isArray(sourceIndexData.characters)) {
    summary.push(`### 主要人物（共${sourceIndexData.characters.length}个）`)
    sourceIndexData.characters.slice(0, 20).forEach((c: any) => {
      const name = c.name || c.character_name || '未命名'
      const desc = c.description || c.role || c.summary || ''
      summary.push(`- **${name}**：${desc.slice(0, 150)}`)
    })
    if (sourceIndexData.characters.length > 20) {
      summary.push(`- ... 及其他${sourceIndexData.characters.length - 20}个人物`)
    }
    summary.push('')
  }

  // Extract locations
  if (sourceIndexData.locations && Array.isArray(sourceIndexData.locations)) {
    summary.push(`### 场景（共${sourceIndexData.locations.length}个）`)
    sourceIndexData.locations.slice(0, 20).forEach((l: any) => {
      const name = l.name || l.location_name || '未命名'
      const desc = l.description || l.summary || ''
      summary.push(`- **${name}**：${desc.slice(0, 100)}`)
    })
    if (sourceIndexData.locations.length > 20) {
      summary.push(`- ... 及其他${sourceIndexData.locations.length - 20}个场景`)
    }
    summary.push('')
  }

  // Extract summary/plot if available
  if (sourceIndexData.summary || sourceIndexData.plot || sourceIndexData.story) {
    summary.push('### 故事概述')
    const plot = sourceIndexData.summary || sourceIndexData.plot || sourceIndexData.story
    summary.push(typeof plot === 'string' ? plot.slice(0, 500) : JSON.stringify(plot).slice(0, 500))
    summary.push('')
  }

  return summary.join('\n')
}
