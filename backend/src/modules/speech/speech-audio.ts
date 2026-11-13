import { mediaExecutionSignal } from '../../infrastructure/providers/media-execution.js'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

/** Measure the decoded audio track, independent of subtitles and container estimates. */
export async function probeSpeechDurationMs(path: string): Promise<number> {
  const signal = mediaExecutionSignal()
  signal?.throwIfAborted()
  const binary = ffmpegPath as unknown as string | null
  if (!binary) throw new Error('无法校验语音文件，请重新安装后端 FFmpeg 依赖。')
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const abort = () => { child.kill('SIGKILL') }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let decodedBytes = 0
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => { decodedBytes += chunk.length })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
    child.once('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new Error('无法校验语音文件，请检查后端 FFmpeg 依赖。'))
    })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(signal.reason); return }
      if (timedOut) { reject(new Error('语音文件校验超时，未保存为可用候选。')); return }
      // Count decoded samples: FFmpeg progress can report the last frame's start
      // timestamp, which drops a partial frame at the end of a PCM input.
      const durationMs = Math.floor(decodedBytes / 2 / 48000 * 1000)
      if (code !== 0 || !Number.isFinite(durationMs) || durationMs <= 0 || /Invalid data|Error while decoding/i.test(stderr)) {
        reject(new Error('语音服务返回的文件无法解码为有效音频，未保存为可用候选。'))
        return
      }
      resolve(durationMs)
    })
  })
}
