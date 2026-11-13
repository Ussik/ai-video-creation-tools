import { spawn } from 'node:child_process'
import { setTimeout, clearTimeout } from 'node:timers'
import ffmpegPath from 'ffmpeg-static'
import { mediaExecutionSignal } from '../providers/media-execution.js'

/** Decode the complete video stream. An HTTP success or container header is
 * insufficient: HTML, audio-only content and corrupt/truncated frames fail. */
export async function validateVideoResult(path: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ duration_ms: number; frames: number }> {
  const signal = options.signal || mediaExecutionSignal()
  signal?.throwIfAborted()
  const binary = ffmpegPath as unknown as string | null
  if (!binary) throw new Error('无法校验视频，请检查后端 FFmpeg 依赖。')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
      '-i', path, '-map', '0:v:0', '-an', '-sn', '-dn', '-progress', 'pipe:1', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let progress = '', stderr = '', timedOut = false, settled = false
    const abort = () => { child.kill('SIGKILL') }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs ?? 60_000)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', chunk => { progress = (progress + chunk.toString()).slice(-10000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
    const finish = (issue?: Error) => {
      if (settled) return; settled = true
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(signal.reason); return }
      if (issue) { reject(issue); return }
      const frames = Number([...progress.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1] || 0)
      const duration = Number([...progress.matchAll(/^out_time_us=(\d+)/gm)].at(-1)?.[1] || 0) / 1000
      if (!Number.isFinite(duration) || duration <= 0 || !frames || !progress.includes('progress=end') || /invalid|error|corrupt|partial file/i.test(stderr)) {
        reject(new Error('模型返回的文件无法完整解码为有效视频，已保留原任务和恢复信息。')); return
      }
      resolve({ duration_ms: Math.round(duration), frames })
    }
    child.once('error', () => finish(new Error('无法校验视频，请检查后端 FFmpeg 依赖。')))
    child.once('close', code => finish(timedOut ? new Error('视频校验超时，尚未保存为可用成果。') : code !== 0 ? new Error('模型返回的文件无法完整解码为有效视频，已保留原任务和恢复信息。') : undefined))
  })
}
