import { createHash } from 'node:crypto'

export const resourceReadPageLimit = 48_000
type Value = Record<string, unknown>
type Position = { index: number; offset: number }
export type ResourceReadSection = { key: string; values: Value[]; start?: number; limit: number; singleton?: boolean }
export type ResourceReadDelivery = { section: string; index: number; value: Value; offset: number; next_offset: number; total_length: number }
type Cursor = { v: 1; project: string; tool: string; query: string; source: string; positions: Position[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function reject(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }

/** Budget the serialized envelope too. Each fragment is a slice of JSON.stringify(value). */
export function resourceReadPage(input: {
  projectId: string; tool: string; query: Record<string, unknown>; cursor?: string; sections: ResourceReadSection[]
  metadata: (positions: Position[]) => Record<string, unknown>
}) {
  const query = hash(input.query), source = hash(input.sections.map(section => [section.key, section.values]))
  let positions = input.sections.map(section => ({ index: section.start || 0, offset: 0 }))
  if (input.cursor) {
    let cursor: Cursor
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()) as Cursor } catch { reject('续读游标无效，请重新读取') }
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || cursor.v !== 1 || cursor.project !== input.projectId || cursor.tool !== input.tool || cursor.query !== query) reject('续读游标与项目或查询不匹配，请使用原续读参数')
    if (cursor.source !== source) reject('读取源版本已变化，请重新读取，不能拼接不同版本的片段', 409)
    if (!Array.isArray(cursor.positions) || cursor.positions.length !== input.sections.length || cursor.positions.some((position, index) => {
      const section = input.sections[index]!
      return !position || !Number.isSafeInteger(position.index) || !Number.isSafeInteger(position.offset)
        || position.index < (section.start || 0) || position.index > section.values.length || position.offset < 0
        || (position.index === section.values.length ? position.offset !== 0 : position.offset >= JSON.stringify(section.values[position.index]).length)
    })) reject('续读位置无效，请重新读取')
    positions = cursor.positions.map(position => ({ ...position }))
  }
  const output: Record<string, unknown> = {}, fragments: Value[] = [], deliveries: ResourceReadDelivery[] = []
  for (const section of input.sections) output[section.key] = section.singleton ? null : []
  const render = () => {
    const complete = positions.every((position, index) => position.index === input.sections[index]!.values.length)
    const cursor: Cursor = { v: 1, project: input.projectId, tool: input.tool, query, source, positions }
    return { ...output, ...input.metadata(positions), complete, source_version: source, fragments,
      continuation: complete ? null : { ...input.query, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') } }
  }
  const fits = () => JSON.stringify(render()).length <= resourceReadPageLimit
  if (!fits()) reject('读取参数过长，无法在单页预算内返回续读信息，请缩小查询范围')
  let exhausted = false
  for (let sectionIndex = 0; sectionIndex < input.sections.length && !exhausted; sectionIndex++) {
    const section = input.sections[sectionIndex]!, position = positions[sectionIndex]!
    let delivered = 0
    while (position.index < section.values.length && delivered < section.limit) {
      const index = position.index, value = section.values[index]!, serialized = JSON.stringify(value), start = position.offset
      if (!start) {
        if (section.singleton) output[section.key] = value
        else (output[section.key] as Value[]).push(value)
        position.index++
        if (fits()) {
          deliveries.push({ section: section.key, index, value, offset: 0, next_offset: serialized.length, total_length: serialized.length })
          delivered++; continue
        }
        position.index--
        if (section.singleton) output[section.key] = null
        else (output[section.key] as Value[]).pop()
      }
      const fragment: Value = { section: section.key, index, ...(typeof value.id === 'string' ? { id: value.id } : {}),
        ...(typeof value.version === 'string' ? { version: value.version } : {}), serialized_fragment: '', offset: start, next_offset: start, total_length: serialized.length, complete: false }
      fragments.push(fragment)
      const setEnd = (end: number) => {
        fragment.serialized_fragment = serialized.slice(start, end); fragment.next_offset = end; fragment.complete = end === serialized.length
        position.index = end === serialized.length ? index + 1 : index
        position.offset = end === serialized.length ? 0 : end
      }
      const boundary = (end: number) => end > start && end < serialized.length
        && serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff
        && serialized.charCodeAt(end) >= 0xdc00 && serialized.charCodeAt(end) <= 0xdfff ? end - 1 : end
      let end = start
      setEnd(serialized.length)
      if (fits()) end = serialized.length
      else {
        let low = start + 1, high = serialized.length - 1
        while (low <= high) {
          const candidate = Math.floor((low + high) / 2)
          setEnd(boundary(candidate))
          if (fits()) { end = boundary(candidate); low = candidate + 1 } else high = candidate - 1
        }
      }
      if (end === start) { fragments.pop(); position.index = index; position.offset = start; exhausted = true; break }
      setEnd(end)
      deliveries.push({ section: section.key, index, value, offset: start, next_offset: end, total_length: serialized.length })
      if (end < serialized.length) { exhausted = true; break }
      delivered++
    }
  }
  const result = render()
  if (!deliveries.length && !result.complete) reject('单页预算不足以返回有效片段，请缩小查询范围')
  return { result, deliveries, source }
}

/** Only union ranges actually sent to the caller; a cursor's claimed progress grants no access. */
export function resourceReadTracker() {
  const ranges = new Map<string, Array<[number, number]>>()
  return (source: string, delivery: ResourceReadDelivery) => {
    const key = `${source}:${delivery.section}:${delivery.index}`
    const combined = [...(ranges.get(key) || []), [delivery.offset, delivery.next_offset] as [number, number]].sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const range of combined) {
      const previous = merged.at(-1)
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
      else merged.push([...range])
    }
    ranges.set(key, merged)
    return merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === delivery.total_length
  }
}
