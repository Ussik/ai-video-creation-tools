import { spawn } from 'node:child_process'
import { open, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import { mediaDir, type Asset } from '../../infrastructure/database/db.js'
import type { TextImageInput } from '../../infrastructure/providers/text-image-input.js'
import type { TextVideoInput } from '../../infrastructure/providers/text-video-input.js'

function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
async function ffmpeg(args: string[], signal: AbortSignal, outputLimit = 4 * 1024 * 1024): Promise<{ output: Buffer; diagnostics: string }> {
  signal.throwIfAborted()
  const binary = ffmpegPath as unknown as string | null
  if (!binary) return fail('FFmpeg 不可用，请检查后端依赖')
  return new Promise((resolve, reject) => {
    // Only self-contained local media containers are accepted. In particular a
    // playlist uploaded as a video must not make FFmpeg fetch network URLs.
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe',
      '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpegvideo', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let length = 0, diagnostics = '', stopped = false
    const stop = () => { stopped = true; child.kill('SIGKILL') }
    const timer = setTimeout(stop, 20_000); timer.unref()
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > outputLimit) stop(); else chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000) })
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', stop) }
    child.on('error', error => { done(); reject(error) })
    child.on('close', code => {
      done()
      if (signal.aborted) return reject(signal.reason)
      if (stopped) return reject(new Error('视频画面处理超时或输出过大，请使用较短片段'))
      // A metadata-only probe intentionally exits with no output file.
      if (code !== 0 && !(args.length === 2 && args[0] === '-i')) return reject(new Error('视频无法读取或解码'))
      resolve({ output: Buffer.concat(chunks), diagnostics })
    })
  })
}

export async function reviewMediaLocation(asset: Asset, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let location: string, root: string
  try { [location, root] = await Promise.all([realpath(asset.path), realpath(mediaDir)]) }
  catch { return fail('视频文件不存在，请重新上传', 404) }
  if (!location.startsWith(`${resolve(root)}${sep}`)) fail('视频不在项目素材目录中')
  const file = await open(location, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size <= 0 || info.size > 300 * 1024 * 1024) fail('请选择不超过 300 MB 的有效视频')
  } finally { await file.close() }
  return location
}

export async function reviewVideoDuration(path: string, signal: AbortSignal): Promise<number> {
  const { diagnostics } = await ffmpeg(['-i', path], signal)
  if (!/Video:/.test(diagnostics)) return fail('所选文件没有可读取的视频画面')
  const match = diagnostics.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return fail('无法读取视频时长')
  const duration = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000)
  if (duration <= 0 || duration > 60_000) fail('成片复核支持最长 60 秒的视频，请先选取镜头片段')
  return duration
}

export async function reviewFrame(path: string, timeMs: number, signal: AbortSignal, width = 640): Promise<Buffer> {
  const result = await ffmpeg(['-loglevel', 'error', '-ss', String(timeMs / 1000), '-i', path,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], signal)
  if (!result.output.length) fail('该时间位置没有可读取的画面')
  return result.output
}

export function reviewSampleTimes(durationMs: number, finalFrameMs = Math.max(0, durationMs - 250)): number[] {
  const count = Math.min(96, Math.max(2, Math.ceil(durationMs / 250)))
  const final = Math.max(0, Math.min(durationMs - 1, finalFrameMs))
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(final * index / (count - 1))))]
}

export async function reviewContactSheets(path: string, durationMs: number, signal: AbortSignal): Promise<{ images: TextImageInput[]; sample_times_ms: number[] }> {
  // Leave at least one source frame interval at EOF; seeking later than the
  // final frame otherwise returns no image for low-frame-rate uploads.
  const { diagnostics } = await ffmpeg(['-i', path], signal)
  const fps = Number(diagnostics.match(/Video:[^\n]*?\b(\d+(?:\.\d+)?) fps\b/)?.[1])
  const finalFrameMs = durationMs - Math.max(250, Number.isFinite(fps) && fps > 0 ? Math.ceil(1000 / fps) + 10 : 1000)
  const sample_times_ms = reviewSampleTimes(durationMs, finalFrameMs), frames: Buffer[] = []
  // Two decoders at a time keep multiple concurrent reviews bounded.
  for (let index = 0; index < sample_times_ms.length; index += 2) {
    const batch = await Promise.all(sample_times_ms.slice(index, index + 2).map(time => reviewFrame(path, time, signal, 384)))
    for (let offset = 0; offset < batch.length; offset++) {
      const time = sample_times_ms[index + offset]!, frame = await sharp(batch[offset]!).resize(384, 216, { fit: 'contain', background: '#151515' }).toBuffer()
      const label = Buffer.from(`<svg width="384" height="28"><rect width="384" height="28" fill="#151515"/><text x="10" y="20" fill="white" font-size="16">${(time / 1000).toFixed(3)} s</text></svg>`)
      frames.push(await sharp({ create: { width: 384, height: 244, channels: 3, background: '#151515' } })
        .composite([{ input: frame, top: 0, left: 0 }, { input: label, top: 216, left: 0 }]).jpeg({ quality: 85 }).toBuffer())
    }
    signal.throwIfAborted()
  }
  const images: TextImageInput[] = []
  for (let index = 0; index < frames.length; index += 12) {
    const batch = frames.slice(index, index + 12)
    const sheet = await sharp({ create: { width: 1152, height: Math.ceil(batch.length / 3) * 244, channels: 3, background: '#151515' } })
      .composite(batch.map((input, offset) => ({ input, top: Math.floor(offset / 3) * 244, left: offset % 3 * 384 })))
      .jpeg({ quality: 90 }).toBuffer()
    images.push({ data_url: `data:image/jpeg;base64,${sheet.toString('base64')}`, detail: 'high' })
  }
  return { images, sample_times_ms }
}

export async function reviewNativeVideo(path: string, durationMs: number, signal: AbortSignal): Promise<TextVideoInput> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (info.size > 25 * 1024 * 1024) fail('整段视频理解目前支持不超过 25 MB 的 MP4，请压缩视频或选择看图模型进行抽帧复核')
    const bytes = await file.readFile()
    signal.throwIfAborted()
    if (bytes.length < 12 || bytes.subarray(4, 8).toString() !== 'ftyp') fail('整段视频理解目前支持 MP4，请转换格式或选择看图模型进行抽帧复核')
    return { data_url: `data:video/mp4;base64,${bytes.toString('base64')}`, duration_ms: durationMs }
  } finally { await file.close() }
}
