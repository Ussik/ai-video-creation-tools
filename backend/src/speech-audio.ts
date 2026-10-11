import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

/** Measure the decoded audio track, independent of subtitles and container estimates. */
export async function probeSpeechDurationMs(path: string): Promise<number> {
  const binary = ffmpegPath as unknown as string | null
  if (!binary) throw new Error('无法校验语音文件，请重新安装后端 FFmpeg 依赖。')
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-progress', 'pipe:1', '-f', 'null', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-64 * 1024) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
    child.once('error', () => {
      clearTimeout(timer)
      reject(new Error('无法校验语音文件，请检查后端 FFmpeg 依赖。'))
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) { reject(new Error('语音文件校验超时，未保存为可用候选。')); return }
      const times = [...output.matchAll(/^out_time_us=(\d+)$/gm)].map(match => Number(match[1]))
      const durationMs = Math.round(Math.max(0, ...times) / 1000)
      if (code !== 0 || !Number.isFinite(durationMs) || durationMs <= 0 || /Invalid data|Error while decoding/i.test(stderr)) {
        reject(new Error('语音服务返回的文件无法解码为有效音频，未保存为可用候选。'))
        return
      }
      resolve(durationMs)
    })
  })
}
