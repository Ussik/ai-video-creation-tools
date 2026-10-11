import { useState } from 'react'
import { ActionIcon, Popover } from '@mantine/core'
import { Info } from 'lucide-react'
import type { Asset, Job, Model, Provider, Shot } from './api'
import './job-information.css'

const statusLabels = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' }
const modeLabels: Record<string, string> = {
  first_frame: '首帧', first_last_frame: '首尾帧', reference: '参考生成', edit: '编辑', extend: '延长视频',
}
const valueLabels: Record<string, string> = {
  standard: '标准', high: '高', medium: '中', low: '低', hd: '高清',
  auto: '自动', transparent: '透明', opaque: '不透明',
}

function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  return null
}

function readRequest(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

type Props = {
  job: Job
  model?: Model
  provider?: Provider
  shot?: Shot
  projectName: string
  assets: Asset[]
}

export default function JobInformationPopover({ job, model, provider, shot, projectName, assets }: Props) {
  const [opened, setOpened] = useState(false)
  const request = readRequest(job.request)
  const image = model?.modality === 'image'
  const exported = job.job_type === 'export'
  const speech = request?.tts && typeof request.tts === 'object' ? request.tts as Record<string, unknown> : null
  const mode = displayValue(request?.mode)
  const prompt = typeof request?.prompt === 'string' ? request.prompt : null
  const parameters: Array<[string, string | null]> = exported ? [] : speech ? [
    ['角色', displayValue(request?.voice_name)], ['音色 ID', displayValue(speech.speaker)], ['语速', displayValue(speech.speech_rate)],
  ] : [
    ['生成模式', mode === 'text' ? (image ? '文生图' : model?.modality === 'video' ? '文生视频' : '文本生成') : mode ? modeLabels[mode] || mode : null],
    ['比例', displayValue(request?.ratio)],
    ['分辨率', displayValue(request?.resolution)],
    ['清晰度', displayValue(request?.clarity)],
    ['画质', displayValue(request?.quality)],
    ['背景', displayValue(request?.background)],
    ...(!image ? [
      ['时长', displayValue(request?.duration) ? `${displayValue(request?.duration)} 秒` : null],
      ['生成声音', displayValue(request?.generate_audio)],
      ['草稿模式', displayValue(request?.draft)],
    ] as Array<[string, string | null]> : []),
  ]
  const referenceIds = Array.isArray(request?.reference_asset_ids)
    ? request.reference_asset_ids.filter((id): id is string => typeof id === 'string' && !!id.trim()) : []
  const referenceVideo = displayValue(request?.reference_video_url)
  const exportProject = request?.project && typeof request.project === 'object'
    ? request.project as Record<string, unknown> : null
  const clips = Array.isArray(request?.clips) ? request.clips : []
  const submittedAt = new Date(job.created_at)

  return <Popover opened={opened} onChange={setOpened} position="bottom-end" offset={8}
    width="min(520px, calc(100vw - 24px))" withinPortal zIndex={220} trapFocus returnFocus
    preventPositionChangeWhenVisible={false}
    middlewares={{
      flip: { padding: 12 }, shift: { padding: 12 },
      size: { padding: 12, apply: ({ availableHeight, elements }) => {
        elements.floating.style.maxHeight = `${Math.max(0, Math.min(640, availableHeight))}px`
      } },
    }}
    classNames={{ dropdown: 'job-info-popover' }}>
    <Popover.Target>
      <ActionIcon variant="subtle" className="job-info-trigger" aria-label="查看任务信息"
        title="查看任务信息" aria-expanded={opened} aria-haspopup="dialog" onClick={() => setOpened(!opened)}>
        <Info size={18} />
      </ActionIcon>
    </Popover.Target>
    <Popover.Dropdown role="dialog" aria-label="任务详情">
      <div className="job-info-heading"><strong>任务详情</strong><span className={`job-status status-${job.status}`}>{exported && job.status === 'running' ? '导出中' : statusLabels[job.status]}</span></div>
      <div className="job-info-content" tabIndex={0}>
        {job.error && <section className="job-info-text job-info-error"><h2>失败原因</h2><p>{job.error}</p></section>}
        <dl>
          <div><dt>任务类型</dt><dd>{exported ? '成片导出' : speech ? '配音生成' : image ? '图片生成' : model?.modality === 'video' ? '视频生成' : '生成任务'}</dd></div>
          <div><dt>所属项目</dt><dd>{projectName}</dd></div>
          {job.shot_id && <div><dt>目标镜头</dt><dd>{shot?.title || `镜头不可用（${job.shot_id}）`}</dd></div>}
          {!exported && <div><dt>模型</dt><dd>{speech ? '豆包 TTS 2.0 · 标准音色' : model?.name || (job.model_id ? `模型不可用（${job.model_id}）` : '未记录')}</dd></div>}
          {provider && <div><dt>服务商</dt><dd>{provider.name}</dd></div>}
          <div><dt>提交时间</dt><dd>{Number.isNaN(submittedAt.getTime()) ? job.created_at : submittedAt.toLocaleString('zh-CN', { hour12: false })}</dd></div>
          <div><dt>任务 ID</dt><dd>{job.id}</dd></div>
          {job.external_id && <div><dt>外部任务 ID</dt><dd>{job.external_id}</dd></div>}
          {parameters.filter(([, value]) => value !== null).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{valueLabels[value!] || value}</dd></div>)}
          {exported && displayValue(exportProject?.ratio) && <div><dt>比例</dt><dd>{displayValue(exportProject?.ratio)}</dd></div>}
          {exported && Array.isArray(request?.clips) && <div><dt>片段数量</dt><dd>{clips.length}</dd></div>}
        </dl>
        {!!referenceIds.length && <section className="job-info-references"><h2>参考素材 · {referenceIds.length}</h2><ul>
          {referenceIds.map((id, index) => {
            const asset = assets.find(item => item.id === id)
            return <li key={`${id}-${index}`}>
              {asset?.kind === 'image' && <img src={asset.url} alt={asset.filename} loading="lazy" />}
              <div><span>{asset?.filename || '参考素材不可用'}</span><small>{id}</small></div>
            </li>
          })}
        </ul></section>}
        {referenceVideo && <section className="job-info-text"><h2>参考视频</h2><p>{referenceVideo}</p></section>}
        {prompt?.trim() && <section className="job-info-text"><h2>{speech ? '朗读正文' : '实际提交提示词'}</h2><p>{prompt}</p></section>}
        {speech && displayValue(speech.instructions) && <section className="job-info-text"><h2>表演指令</h2><p>{displayValue(speech.instructions)}</p></section>}
        {speech && displayValue(speech.context_text) && <section className="job-info-text"><h2>情境参考</h2><p>{displayValue(speech.context_text)}</p></section>}
        {!exported && request && !prompt?.trim() && <p className="job-info-empty">此任务未记录提示词。</p>}
        {!request && job.request.trim() && <section className="job-info-text"><h2>原始请求记录</h2><p>{job.request}</p></section>}
      </div>
    </Popover.Dropdown>
  </Popover>
}
