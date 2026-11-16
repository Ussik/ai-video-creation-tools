import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

const keys = ['LANGFUSE_TRACING', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL',
  'LANGFUSE_TRACING_SAMPLING_RATE', 'VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS', 'VIDEO_STUDIO_LANGFUSE_MAX_PENDING']
const configurationError = () => new Error('Langfuse 本机配置无法读取或格式无效；未启动开发服务，请检查 .env.langfuse.local。')

// parseEnv accepts incomplete assignments and unmatched quotes. Reject those
// before loading a private configuration, without echoing its text or errors.
function parseConfiguration(raw) {
  const text = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (text.includes('\0')) throw configurationError()
  let offset = 0
  while (offset < text.length) {
    let end = text.indexOf('\n', offset)
    if (end === -1) end = text.length
    const line = text.slice(offset, end)
    if (/^\s*(?:#.*)?$/.test(line)) { offset = end + 1; continue }
    const assignment = /^[\t ]*(?:export[\t ]+)?[A-Za-z_][A-Za-z0-9_]*[\t ]*=[\t ]*/.exec(line)
    if (!assignment) throw configurationError()
    const start = offset + assignment[0].length, quote = text[start]
    if (['"', "'", '`'].includes(quote)) {
      const closing = text.indexOf(quote, start + 1)
      if (closing === -1) throw configurationError()
      end = text.indexOf('\n', closing + 1)
      if (end === -1) end = text.length
      if (!/^[\t ]*(?:#.*)?$/.test(text.slice(closing + 1, end))) throw configurationError()
    }
    offset = end + 1
  }
  return parseEnv(text)
}

function tracingState(env) {
  if (env.LANGFUSE_TRACING === undefined || env.LANGFUSE_TRACING === 'false') return 'disabled'
  if (env.LANGFUSE_TRACING !== 'true') return 'incomplete'
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim(), secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!publicKey || !secretKey || /[:\r\n]/.test(publicKey) || /[\r\n]/.test(secretKey)) return 'incomplete'
  try {
    const url = new URL(env.LANGFUSE_BASE_URL?.trim() || '')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) return 'incomplete'
  } catch { return 'incomplete' }
  const rate = env.LANGFUSE_TRACING_SAMPLING_RATE === undefined ? 1 : Number(env.LANGFUSE_TRACING_SAMPLING_RATE)
  const timeout = env.VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS === undefined ? 3000 : Number(env.VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS)
  const pending = env.VIDEO_STUDIO_LANGFUSE_MAX_PENDING === undefined ? 256 : Number(env.VIDEO_STUDIO_LANGFUSE_MAX_PENDING)
  if (!Number.isFinite(rate) || rate < 0 || rate > 1 || !Number.isInteger(timeout) || timeout < 50 || timeout > 10000 ||
      !Number.isInteger(pending) || pending < 1 || pending > 256) return 'incomplete'
  return 'enabled'
}

/** Load only this repository's dedicated Langfuse file. Existing process
 * values, including false or an empty value, always take precedence. */
export function loadDevEnvironment(root, env = process.env) {
  const file = resolve(root, '.env.langfuse.local')
  let loaded = false
  try {
    let info
    try { info = lstatSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw configurationError()
      const values = parseConfiguration(readFileSync(file, 'utf8'))
      for (const key of keys) if (!Object.hasOwn(env, key) && Object.hasOwn(values, key)) env[key] = values[key]
      loaded = true
    }
  } catch { throw configurationError() }
  return { state: tracingState(env), loaded, samplingDisabled: env.LANGFUSE_TRACING_SAMPLING_RATE !== undefined && Number(env.LANGFUSE_TRACING_SAMPLING_RATE) === 0 }
}

export function devEnvironmentMessage(configuration) {
  if (configuration.state === 'incomplete') return '[Langfuse] 配置不完整或无效，追踪未启用；请运行 npm run langfuse:check -- --config=.env.langfuse.local 核对。'
  if (configuration.state === 'enabled') return configuration.samplingDisabled
    ? '[Langfuse] 追踪配置已启用，但采样率为 0，本次不导出追踪。'
    : '[Langfuse] 追踪配置已启用；连接是否可用请用 langfuse:smoke 验证。'
  return '[Langfuse] 追踪已关闭；可通过 .env.langfuse.local 或进程环境启用。'
}
