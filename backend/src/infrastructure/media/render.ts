import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ffmpegPath from 'ffmpeg-static'
import { mediaDir, type MediaAsset } from '../providers/providers.js'
import { defaultAudioMix, speechIntervals, type AudioMixSettings, type SpeechAudioClip } from '@video-studio/shared/media/speech-timeline'

export interface RenderProject {
  id: string
  ratio: '16:9' | '9:16'
  music_asset_id?: string | null
}

export interface RenderClip {
  title: string
  asset_id: string
  in_ms: number
  out_ms: number
  source_duration_ms: number | null
  source_audio_gain?: number
  source_audio_fade_ms?: number
}

function ffmpeg(): string {
  const binary = ffmpegPath as unknown as string | null
  if (!binary) throw new Error('FFmpeg 不可用，请重新安装后端依赖')
  return binary
}

async function run(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 120000)
    timer.unref()
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-1600) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(timedOut ? 'FFmpeg 处理超时，请缩小制作范围或检查素材' : stderr || `FFmpeg 退出状态 ${code}`)) })
  })
}

const durationCache = new Map<string, number>()

export function probeVideoDurationMs(path: string): number {
  const source = statSync(path)
  const cacheKey = `${path}:${source.size}:${source.mtimeMs}`
  const cached = durationCache.get(cacheKey)
  if (cached !== undefined) return cached

  // The container duration can extend past the final video frame when audio is longer.
  const tempDir = mkdtempSync(join(tmpdir(), 'video-track-probe-'))
  const videoOnly = join(tempDir, 'video.mkv')
  try {
    const remux = spawnSync(ffmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', path,
      '-map', '0:v:0', '-an', '-c:v', 'copy', videoOnly,
    ], { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
    if (remux.error) throw remux.error
    if (remux.status !== 0) throw new Error(remux.stderr || '无法读取视频画面轨')

    const result = spawnSync(ffmpeg(), ['-hide_banner', '-i', videoOnly], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    })
    if (result.error) throw result.error
    const match = result.stderr?.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
    if (!match) throw new Error('无法读取视频素材的时长')
    const milliseconds = Math.floor((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000)
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error('视频素材的时长无效')
    if (durationCache.size >= 128) durationCache.clear()
    durationCache.set(cacheKey, milliseconds)
    return milliseconds
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function extractVideoFrame(path: string, timeMs: number): Promise<Buffer> {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new Error('取帧时间无效')
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-ss', String(timeMs / 1000), '-i', path,
      '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0, stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 20 * 1024 * 1024) child.kill()
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1600) })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0 || !size || size > 20 * 1024 * 1024) reject(new Error(stderr || '无法提取视频画面'))
      else resolve(Buffer.concat(chunks))
    })
  })
}

async function hasAudio(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(ffmpeg(), ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000) })
    child.on('error', reject)
    child.on('close', () => resolve(/\bAudio:/.test(stderr)))
  })
}

export async function render(
  project: RenderProject,
  clips: RenderClip[],
  assetsById: Record<string, MediaAsset>,
  speechAudio: SpeechAudioClip[] = [],
  audioSettings: AudioMixSettings = defaultAudioMix,
): Promise<string> {
  if (!clips.length) throw new Error('请先为至少一个分镜选定图片或视频')
  if (!/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error('无效的项目 ID')
  const totalMs = clips.reduce((sum, clip) => sum + clip.out_ms - clip.in_ms, 0)
  if (!Number.isFinite(audioSettings.music_gain) || audioSettings.music_gain < 0 || audioSettings.music_gain > 1) throw new Error('配乐音量无效')
  for (const audio of speechAudio) {
    const asset = assetsById[audio.asset_id]
    if (!asset || asset.kind !== 'audio') throw new Error('入片配音素材不存在')
    if (audio.stale || !Number.isSafeInteger(audio.start_ms) || !Number.isSafeInteger(audio.end_ms) ||
      !Number.isSafeInteger(audio.in_ms) || !Number.isSafeInteger(audio.out_ms) || audio.in_ms < 0 ||
      audio.out_ms <= audio.in_ms || audio.start_ms < 0 || audio.end_ms > totalMs ||
      audio.end_ms - audio.start_ms !== audio.out_ms - audio.in_ms ||
      !Number.isFinite(audio.gain) || audio.gain < 0 || audio.gain > 2) throw new Error('入片配音版本或播放区间无效')
    await stat(asset.path)
  }
  const [width, height] = project.ratio === '9:16' ? [720, 1280] : [1280, 720]
  const outputDir = join(mediaDir, project.id)
  await mkdir(outputDir, { recursive: true })
  const finalPath = join(outputDir, `export-${randomUUID()}.mp4`)
  const tempDir = await mkdtemp(join(outputDir, '.render-'))
  const videoFilters = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'fps=24',
  ].join(',')
  try {
    const segments: string[] = []
    for (const [index, clip] of clips.entries()) {
      const asset = assetsById[clip.asset_id]
      if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) throw new Error(`分镜「${clip.title}」的素材不可用于导出`)
      try { await stat(asset.path) } catch { throw new Error(`分镜「${clip.title}」的素材文件不存在`) }
      if (!Number.isSafeInteger(clip.in_ms) || !Number.isSafeInteger(clip.out_ms) ||
        clip.in_ms < 0 || clip.out_ms - clip.in_ms < 200) throw new Error(`分镜「${clip.title}」的剪辑区间无效`)
      const audioGain = clip.source_audio_gain ?? 1
      const audioFadeMs = clip.source_audio_fade_ms ?? 0
      if (!Number.isFinite(audioGain) || audioGain < 0 || audioGain > 2 ||
        !Number.isSafeInteger(audioFadeMs) || audioFadeMs < 0 || audioFadeMs > 500) {
        throw new Error(`分镜「${clip.title}」的原声设置无效`)
      }
      if (asset.kind === 'video') {
        const actualDuration = probeVideoDurationMs(asset.path)
        if (clip.source_duration_ms === null || clip.out_ms > actualDuration || clip.out_ms > clip.source_duration_ms) {
          throw new Error(`分镜「${clip.title}」的剪辑区间超出视频素材时长`)
        }
      } else if (clip.in_ms !== 0) throw new Error(`分镜「${clip.title}」的图片入点必须为 0`)
      const duration = (clip.out_ms - clip.in_ms) / 1000
      const start = clip.in_ms / 1000
      const end = clip.out_ms / 1000
      const name = `${String(index).padStart(3, '0')}.mp4`
      const segment = join(tempDir, name)
      const inputs = asset.kind === 'image' ? ['-loop', '1', '-framerate', '24', '-i', asset.path] : ['-i', asset.path]
      const audioInput = asset.kind === 'video' && await hasAudio(asset.path) ? '0:a' : '1:a'
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
      const videoTrim = asset.kind === 'video' ? `trim=start=${start}:end=${end}` : `trim=duration=${duration}`
      const audioTrim = audioInput === '0:a' ? `atrim=start=${start}:end=${end}` : `atrim=duration=${duration}`
      const fadeDuration = Math.min(audioFadeMs / 1000, duration / 2)
      const audioFilters = [audioTrim, 'asetpts=PTS-STARTPTS', `volume=${audioGain}`]
      if (fadeDuration > 0) {
        audioFilters.push(`afade=t=in:st=0:d=${fadeDuration}`, `afade=t=out:st=${duration - fadeDuration}:d=${fadeDuration}`)
      }
      audioFilters.push('apad', `atrim=duration=${duration}`)
      const filters = `[0:v]${videoTrim},setpts=PTS-STARTPTS,${videoFilters}[v];` +
        `[${audioInput}]${audioFilters.join(',')}[a]`
      await run([
        ...inputs, '-filter_complex', filters, '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-t', String(duration), segment,
      ])
      segments.push(name)
    }
    const concatList = join(tempDir, 'segments.txt')
    await writeFile(concatList, segments.map((name) => `file '${name}'\n`).join(''))
    const joined = join(tempDir, 'joined.mp4')
    await run(['-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', joined])
    if (project.music_asset_id || speechAudio.length) {
      const totalDuration = totalMs / 1000
      const intervals = speechIntervals(speechAudio)
      const active = intervals.map(([start, end]) => `gte(t,${start / 1000})*lt(t,${end / 1000})`).join('+') || '0'
      const duck = `if(gt(${active},0),0.25,1)`
      const inputs = ['-i', joined]
      const filters = [`[0:a]volume='${audioSettings.duck_source ? duck : '1'}':eval=frame[original]`]
      const mixed = ['[original]']
      for (const [index, audio] of speechAudio.entries()) {
        inputs.push('-i', assetsById[audio.asset_id]!.path)
        const length = (audio.out_ms - audio.in_ms) / 1000
        const fade = Math.min(0.015, length / 2)
        filters.push(`[${index + 1}:a]atrim=start=${audio.in_ms / 1000}:end=${audio.out_ms / 1000},asetpts=PTS-STARTPTS,volume=${audio.gain},` +
          `afade=t=in:d=${fade},afade=t=out:st=${length - fade}:d=${fade},adelay=${audio.start_ms}:all=1,apad,atrim=duration=${totalDuration}[speech${index}]`)
        mixed.push(`[speech${index}]`)
      }
      if (project.music_asset_id) {
        const music = assetsById[project.music_asset_id]
        if (!music || music.kind !== 'audio') throw new Error('项目配乐文件不存在')
        try { await stat(music.path) } catch { throw new Error('项目配乐文件不存在') }
        // Materialize a finite music stream before mixing; infinite looping inputs can
        // leave FFmpeg's multi-input filter graph waiting after the last video frame.
        const loopedMusic = join(tempDir, 'music.m4a')
        await run(['-stream_loop', '-1', '-i', music.path, '-vn', '-t', String(totalDuration), '-c:a', 'aac', '-ar', '48000', loopedMusic])
        inputs.push('-i', loopedMusic)
        filters.push(`[${speechAudio.length + 1}:a]atrim=duration=${totalDuration},asetpts=PTS-STARTPTS,volume='${audioSettings.music_gain}*(${audioSettings.duck_music ? duck : '1'})':eval=frame[music]`)
        mixed.push('[music]')
      }
      filters.push(`${mixed.join('')}amix=inputs=${mixed.length}:duration=first:dropout_transition=0:normalize=0[a]`)
      const mixScript = join(tempDir, 'audio-mix.txt')
      await writeFile(mixScript, filters.join(';'))
      await run([
        ...inputs, '-filter_complex_script', mixScript,
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac',
        '-movflags', '+faststart', '-t', String(totalDuration), finalPath,
      ])
    } else {
      await run(['-i', joined, '-c', 'copy', '-movflags', '+faststart', finalPath])
    }
    if (!(await stat(finalPath)).size) throw new Error('导出的视频文件为空')
    return finalPath
  } catch (error) {
    await rm(finalPath, { force: true })
    throw error
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
