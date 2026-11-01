import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { VIDEO_ANALYSIS_MAX_DURATION_MS } from '@video-studio/shared/media/video-prompt-analysis'
import { mediaDir, type Asset } from '../../infrastructure/database/db.js'
import type { TextVideoInput } from '../../infrastructure/providers/text-video-input.js'

const MAX_PREPARED_BYTES = 40 * 1024 * 1024
function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }

async function runFfmpeg(args: string[], signal: AbortSignal, timeoutMs: number, probe = false): Promise<string> {
  signal.throwIfAborted()
  const binary = ffmpegPath as unknown as string | null
  if (!binary) fail('FFmpeg 不可用，请检查后端依赖')
  return new Promise((resolve, reject) => {
    // The uploaded video must be self-contained: no network protocols or
    // playlists, and no path supplied by the request reaches this function.
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'mov', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostics = '', timedOut = false
    const stop = () => child.kill('SIGKILL')
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    timer.unref()
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', stop) }
    child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-12_000) })
    child.on('error', () => { done(); reject(new Error('无法启动视频处理，请检查 FFmpeg 依赖')) })
    child.on('close', code => {
      done()
      if (signal.aborted) { reject(signal.reason); return }
      if (timedOut) { reject(new Error('视频处理超时，请缩小分析范围后重试')); return }
      if (code !== 0 && !probe) { reject(new Error('视频无法解码，请重新上传有效的 MP4 或 MOV 文件')); return }
      resolve(diagnostics)
    })
  })
}

export async function videoAnalysisLocation(asset: Asset, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let location: string, root: string
  try { [location, root] = await Promise.all([realpath(asset.path), realpath(mediaDir)]) }
  catch { return fail('视频文件不存在，请重新上传', 404) }
  if (!location.startsWith(`${resolve(root)}${sep}`)) fail('视频不在项目素材目录中')
  const file = await open(location, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || !info.size || info.size > 300 * 1024 * 1024) fail('请选择不超过 300 MB 的有效视频')
  } finally { await file.close() }
  signal.throwIfAborted()
  return location
}

/** Probe the source without imposing the review feature's 60-second limit. */
export async function videoAnalysisDuration(path: string, signal: AbortSignal): Promise<number> {
  const diagnostics = await runFfmpeg(['-i', path], signal, 20_000, true)
  if (!/Video:/.test(diagnostics)) fail('所选文件没有可读取的视频画面，请上传 MP4 或 MOV 视频')
  const match = diagnostics.match(/\n\s*Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) fail('无法读取视频时长，请重新上传有效视频')
  const duration = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000)
  if (!Number.isSafeInteger(duration) || duration <= 0) fail('视频时长无效')
  return duration
}

export function videoAnalysisRange(durationMs: number, startMs: number, endMs: number | null | undefined): { start_ms: number; end_ms: number } {
  const end = endMs ?? durationMs
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(end)
    || startMs < 0 || end > durationMs || startMs >= end) fail('分析范围无效，请选择视频时长内的起止位置')
  if (end - startMs < 1000) fail('请至少选择 1 秒视频进行分析')
  if (end - startMs > VIDEO_ANALYSIS_MAX_DURATION_MS) fail('单次视频反推最长 180 秒，请缩小分析范围')
  return { start_ms: startMs, end_ms: end }
}

/** Bound size/resolution and remove audio before any bytes leave the machine. */
export async function prepareVideoAnalysis(path: string, startMs: number, endMs: number, fps: number, signal: AbortSignal): Promise<TextVideoInput> {
  const duration = endMs - startMs
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || duration < 1000 || duration > VIDEO_ANALYSIS_MAX_DURATION_MS
    || !Number.isFinite(fps) || fps < 0.2 || fps > 5) fail('视频分析范围或采样率无效')
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'video-prompt-analysis-'))
  const output = join(directory, 'analysis.mp4')
  try {
    await runFfmpeg(['-loglevel', 'error', '-ss', String(startMs / 1000), '-i', path,
      '-t', String(duration / 1000), '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', "fps=24,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-maxrate', '1200k', '-bufsize', '2400k',
      '-threads', '2', '-filter_threads', '1', '-pix_fmt', 'yuv420p', '-map_metadata', '-1',
      '-movflags', '+faststart', '-fs', String(MAX_PREPARED_BYTES), output], signal, 120_000)
    signal.throwIfAborted()
    const info = await stat(output)
    if (!info.size || info.size >= MAX_PREPARED_BYTES) fail('视频压缩后仍过大，请缩小分析范围')
    // A size-capped or prematurely terminated encode can exit successfully.
    // Do not report the unprocessed tail as if it had been submitted.
    const encodedDuration = await videoAnalysisDuration(output, signal)
    if (Math.abs(encodedDuration - duration) > 500) fail('视频片段未完整处理，请缩小范围或重新上传')
    const bytes = await readFile(output)
    signal.throwIfAborted()
    return { data_url: `data:video/mp4;base64,${bytes.toString('base64')}`, duration_ms: duration, fps }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
