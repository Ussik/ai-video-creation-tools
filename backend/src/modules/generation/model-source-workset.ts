import { createHash } from 'node:crypto'
type Range = { offset: number; length: number }
export type SourceWorkset = { source_id: string; version: string; total_length: number; global_constraints: string;
  selected_ranges: Range[]; read_receipts: Range[]; completed_units: Array<{ id: string; hash: string }> }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
/** Immutable, lossless resource pages. A locator is never counted as a read:
 * only text returned by read() advances the receipt. */
export function createSourceWorkset(sourceId: string, content: string, globalConstraints = '') {
  const version = hash(content), receipts: Range[] = []
  const read = (requestedVersion: string, offset: number, length: number) => {
    if (requestedVersion !== version) throw new Error('资料版本已变化，请重新读取索引')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length || !Number.isSafeInteger(length) || length < 1 || length > 16000) throw new Error('资料读取范围无效')
    const text = content.slice(offset, offset + length), next = offset + text.length
    if (text.length) {
      let start = offset, end = next
      for (let index = receipts.length - 1; index >= 0; index--) { const range = receipts[index]!; if (range.offset <= end && range.offset + range.length >= start) { start = Math.min(start, range.offset); end = Math.max(end, range.offset + range.length); receipts.splice(index, 1) } }
      receipts.push({ offset: start, length: end - start }); receipts.sort((a,b) => a.offset-b.offset)
    }
    return { source_id: sourceId, version, offset, next_offset: next, total_length: content.length, text,
      page_end: next === content.length, complete_source: receipts.length === 1 && receipts[0]!.offset === 0 && receipts[0]!.length === content.length }
  }
  return { version, read, snapshot: (): SourceWorkset => ({ source_id: sourceId, version, total_length: content.length,
    global_constraints: globalConstraints, selected_ranges: [], read_receipts: structuredClone(receipts), completed_units: [] }) }
}

export function createModelResultResources() {
  const resources = new Map<string, ReturnType<typeof createSourceWorkset>>()
  return {
    externalize(value: unknown) {
      const content = JSON.stringify(value)
      if (content.length <= 48000) return value
      const resourceId = hash(content), resource = createSourceWorkset(resourceId, content)
      resources.set(resourceId, resource)
      return { resource_id: resourceId, version: resource.version, total_length: content.length, complete_source: false,
        content_omitted: true, instruction: '这是完整工具结果的读取句柄，不代表已读取正文。使用 read_model_resource 按字符分页读取完整 JSON；不得据此宣称已核对原文。' }
    },
    read(id: string, version: string, offset: number, length: number) {
      const resource = resources.get(id)
      if (!resource) throw new Error('资料句柄已失效，请重新执行原读取工具')
      return resource.read(version, offset, length)
    },
  }
}
