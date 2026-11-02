import type { ManagedPromptBlockName } from '@video-studio/shared/visuals/prompt-document'
import type { PromptSectionBlock } from '@video-studio/shared/visuals/prompt-section-document'

type ReferenceLabel = { assetId: string; label: string }
type SectionOrigin = { category: string; source: string; parameters?: boolean }

/** User-facing terminology can evolve without rewriting persisted section markers. */
export function promptSectionLabel(name?: string): string {
  return name === '设定图固定要求' ? '主要创作内容' : name || '正文'
}

const origins = {
  '镜头视觉设定': { category: '视觉设定', source: '镜头绑定与参考对象' },
  '图片参考图用途': { category: '参考使用', source: '当前图片参考' },
  '视频参考图用途': { category: '参考使用', source: '当前视频参考' },
  '项目画风约束': { category: '画风', source: '项目画风' },
  '图片生成要求': { category: '生成参数', source: '本节点图片参数', parameters: true },
  '视频生成要求': { category: '生成参数', source: '本节点视频参数', parameters: true },
  '基础身份参考': { category: '参考使用', source: '基础版本参考图' },
  '设定图固定要求': { category: '视觉设定', source: '对象设定与视图要求' },
  '生成参数约束': { category: '生成参数', source: '本节点生成参数', parameters: true },
  '基础版本与本次状态变化': { category: '视觉设定', source: '基础版本与当前状态' },
  '生成参考图': { category: '参考使用', source: '本次设定图参考' },
} satisfies Record<ManagedPromptBlockName, SectionOrigin>

export function readablePromptSection(text: string, references: ReferenceLabel[] = []): string {
  const labels = new Map(references.map(reference => [reference.assetId, reference.label]))
  return text.replace(/^【[^】\n]+】\n?/, '').replace(/\n?【[^】\n]+结束】$/, '')
    .replace(/\[\[ref:([^\]]+)\]\]/g, (_, id: string) => `@${labels.get(id) || '原参考图片'}`)
}

export function promptSectionDetails(block: PromptSectionBlock, references: ReferenceLabel[] = []) {
  const origin: SectionOrigin = block.name ? origins[block.name] : { category: '正文', source: '本节点' }
  const pending = !block.deleted && block.pendingSourceText !== undefined
  const customized = block.deleted || block.sourceText === undefined || block.text !== block.sourceText
  const summary = readablePromptSection(block.deleted ? block.pendingSourceText ?? block.sourceText ?? '' : block.text, references)
    .replace(/\s+/g, ' ').trim()
  return { ...origin, pending, customized,
    state: block.deleted ? '已移除' : pending ? '待确认' : customized ? '本节点自定义' : '沿用来源',
    summary: summary.length > 84 ? `${summary.slice(0, 84)}…` : summary || '暂无内容',
  }
}

export type PromptSectionDiffLine = { kind: 'same' | 'removed' | 'added'; text: string }

/** Compare displayed content only; large replacements avoid an unbounded LCS matrix. */
export function promptSectionLineDiff(beforeText: string, afterText: string): PromptSectionDiffLine[] {
  const before = beforeText ? beforeText.split('\n') : [], after = afterText ? afterText.split('\n') : []
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const left = before.slice(prefix, before.length - suffix), right = after.slice(prefix, after.length - suffix)
  const middle: PromptSectionDiffLine[] = []
  if (left.length * right.length > 1_000_000) {
    middle.push(...left.map(text => ({ kind: 'removed' as const, text })), ...right.map(text => ({ kind: 'added' as const, text })))
  } else {
    const width = right.length + 1, lcs = new Uint32Array((left.length + 1) * width)
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
      lcs[i * width + j] = left[i] === right[j] ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
    let i = 0, j = 0
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { middle.push({ kind: 'same', text: left[i++]! }); j++ }
      else if (i < left.length && (j === right.length || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) middle.push({ kind: 'removed', text: left[i++]! })
      else middle.push({ kind: 'added', text: right[j++]! })
    }
  }
  return [...before.slice(0, prefix).map(text => ({ kind: 'same' as const, text })), ...middle,
    ...before.slice(before.length - suffix).map(text => ({ kind: 'same' as const, text }))]
}
