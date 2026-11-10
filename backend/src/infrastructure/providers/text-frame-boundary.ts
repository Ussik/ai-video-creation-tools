import { TextProviderError } from './text-errors.js'

/** Bound a single unparsed event, never cumulative screenplay content. */
export const textFrameByteLimit = 4 * 1024 * 1024
function frameTooLarge(): never { throw new TextProviderError('模型返回的单条传输事件过大，已停止读取；已验证成果保留。', false, 'response_frame_too_large') }
export function assertTextFrameBoundary(value: string) {
  if (Buffer.byteLength(value) > textFrameByteLimit) frameTooLarge()
}

/** Include all lines of one not-yet-closed SSE event, including comments and
 * metadata; a stream of small complete events may be arbitrarily long. */
export function createTextFrameBoundary() {
  let bytes = 0
  return { line(value: string) {
    if (value === '') { bytes = 0; return }
    bytes += Buffer.byteLength(value) + 1
    if (bytes > textFrameByteLimit) frameTooLarge()
  }, pending(value: string) { if (bytes + Buffer.byteLength(value) > textFrameByteLimit) frameTooLarge() } }
}
