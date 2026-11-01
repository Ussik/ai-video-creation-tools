import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Select, UnstyledButton, NumberInput, ActionIcon, Button, Modal, Textarea, TextInput, Tooltip } from '@mantine/core'
import { Archive, ArchiveRestore, Check, Crop, ImagePlus, Plus, Sparkles, Star } from 'lucide-react'
import { visualReferenceAssetsApi } from '../../shared/api/api'
import type { Model, ProjectDetail, Provider, VisualProfile, VisualReferenceAsset, VisualReferenceCrop, VisualReferencePreview, VisualReferencePreviewInput, VisualReferencePurpose, VisualReferenceView } from '../../shared/api/api'
import { visualReferencePurposeLabels, visualReferenceViewLabels } from '@video-studio/shared/visuals/visual-reference-types'
import { generationCost, imageGenerationDefaults, imageRatioError, imageRatios, imageRequestResolution, modelDefaultResolution } from '../canvas/canvas-model-parameters'
import { preferredModel } from '../models/model-defaults'
import './visual-reference-assets.css'

type Props = {
  profile: VisualProfile
  detail: ProjectDetail
  models: Model[]
  providers?: Provider[]
  disabled?: boolean
  disabledReason?: string
  onRefresh: () => Promise<void>
  onBusyChange?: (busy: boolean) => void
}
type AddMode = 'existing' | 'crop' | 'generate'
const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Crop coordinates refer to the original image, without object-fit letterboxing. */
export function normalizedReferenceCrop(value: VisualReferenceCrop): VisualReferenceCrop {
  const x = Math.min(.99, unit(value.x)), y = Math.min(.99, unit(value.y))
  return { x, y, width: Math.max(.01, Math.min(1 - x, unit(value.width))), height: Math.max(.01, Math.min(1 - y, unit(value.height))) }
}
export function referenceCropFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): VisualReferenceCrop {
  const left = unit(Math.min(start.x, end.x)), top = unit(Math.min(start.y, end.y))
  return normalizedReferenceCrop({ x: left, y: top, width: unit(Math.max(start.x, end.x)) - left, height: unit(Math.max(start.y, end.y)) - top })
}
export function referenceAssetNeedsReview(reference: VisualReferenceAsset, profile: VisualProfile, styleVersion?: string): boolean {
  return reference.revision !== profile.revision || !styleVersion || reference.style_version !== styleVersion
}

function viewLabel(view: VisualReferenceView, kind: VisualProfile['kind']) {
  if (kind === 'character' && view === 'front') return '正面全身'
  if (kind === 'character' && view === 'back') return '背面全身'
  if (kind === 'location' && view === 'side') return '侧向机位'
  return visualReferenceViewLabels[view]
}
function viewsFor(kind: VisualProfile['kind']): VisualReferenceView[] {
  return kind === 'character' ? ['face', 'front', 'three_quarter', 'side', 'back', 'detail']
    : kind === 'location' ? ['wide', 'reverse', 'side', 'layout', 'detail'] : ['front', 'three_quarter', 'side', 'back', 'detail']
}
function purposeFor(view: VisualReferenceView, kind: VisualProfile['kind']): VisualReferencePurpose {
  return view === 'detail' ? 'detail' : kind === 'location' ? 'space' : kind === 'prop' ? 'structure'
    : view === 'front' || view === 'back' ? 'costume' : 'identity'
}
function modelOptions(model: Model | undefined, key: string, fallback: string[] = []): string[] {
  const value = model?.settings[key]
  return Array.isArray(value) && value.some(item => typeof item === 'string') ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : fallback
}

export default function VisualReferenceAssets({ profile, detail, models, providers, disabled, disabledReason, onRefresh, onBusyChange }: Props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AddMode>('existing')
  const [showArchived, setShowArchived] = useState(false)
  const [view, setView] = useState<VisualReferenceView>(profile.kind === 'location' ? 'wide' : profile.kind === 'prop' ? 'front' : 'face')
  const [purpose, setPurpose] = useState<VisualReferencePurpose>(purposeFor(view, profile.kind))
  const [label, setLabel] = useState('')
  const [sourceId, setSourceId] = useState(profile.board_asset_id || '')
  const [referenceIds, setReferenceIds] = useState<string[]>(profile.board_asset_id ? [profile.board_asset_id] : [])
  const [modelId, setModelId] = useState('')
  const [ratio, setRatio] = useState('')
  const [resolution, setResolution] = useState('')
  const [candidateCount, setCandidateCount] = useState<1 | 2 | 4>(1)
  const [crop, setCrop] = useState<VisualReferenceCrop>({ x: .1, y: .1, width: .8, height: .8 })
  const [imageRatio, setImageRatio] = useState(1)
  const [imageFailed, setImageFailed] = useState(false)
  const [preview, setPreview] = useState<VisualReferencePreview | null>(null)
  const [previewInputKey, setPreviewInputKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dragging = useRef<{ pointer: number; start: { x: number; y: number } } | null>(null)
  const styleVersion = detail.project_visual_style?.version
  const references = profile.reference_assets || []
  const archived = references.filter(item => item.status === 'archived')
  const visible = references.filter(item => (item.status === 'archived') === showArchived)
  const imageModels = models.filter(model => model.enabled && model.modality === 'image'
    && (!providers || providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo')))
  const model = imageModels.find(item => item.id === modelId) || preferredModel(imageModels)
  const assets = detail.assets.filter(asset => asset.kind === 'image' && asset.project_id === detail.id)
    .sort((left, right) => Number(right.id === profile.board_asset_id) - Number(left.id === profile.board_asset_id) || right.created_at.localeCompare(left.created_at))
  const source = assets.find(asset => asset.id === sourceId)
  const locked = !!disabled || busy || !styleVersion
  const referenceInput: VisualReferencePreviewInput = { expected_revision: profile.revision, expected_style_version: styleVersion || '',
    view, purpose, label: label.trim() || undefined, model_id: model?.id || '', reference_asset_ids: referenceIds }
  const inputKey = JSON.stringify(referenceInput)
  const previewCurrent = !!preview && previewInputKey === inputKey
  const defaults = imageGenerationDefaults(model)
  const resolutions = modelOptions(model, 'resolutions')
  const selectedResolution = resolutions.includes(resolution) ? resolution : modelDefaultResolution(model, resolutions)
  const imageMode = referenceIds.length ? 'reference' : 'text'
  const ratioOptions = modelOptions(model, 'ratios', imageRatios).filter(value => !model || !imageRatioError(model,
    imageRequestResolution(model, selectedResolution, { ratio: value, clarity: defaults.clarity, mode: imageMode }), value, imageMode))
  const preferredRatio = profile.kind === 'location' ? '16:9' : view === 'face' || view === 'detail' ? '1:1' : '3:4'
  const selectedRatio = ratioOptions.includes(ratio) ? ratio : ratioOptions.includes(preferredRatio) ? preferredRatio : ratioOptions[0] || ''
  const requestResolution = model ? imageRequestResolution(model, selectedResolution, { ratio: selectedRatio, clarity: defaults.clarity, mode: imageMode }) : ''
  const estimatedCost = model && generationCost(model, { resolution: requestResolution, duration: 0 }, candidateCount)
  const context = { expected_revision: profile.revision, expected_style_version: styleVersion || '' }
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
  useEffect(() => { setImageRatio(1); setImageFailed(false); dragging.current = null }, [sourceId])
  useEffect(() => {
    if (viewsFor(profile.kind).includes(view)) return
    const next = viewsFor(profile.kind)[0]
    setView(next); setPurpose(purposeFor(next, profile.kind)); setRatio('')
  }, [profile.kind, view])

  async function action(run: () => Promise<void>) {
    if (locked) return
    setBusy(true); setError(''); setNotice('')
    try { await run() } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setBusy(false) }
  }
  function openAdd() {
    setSourceId(profile.board_asset_id || assets[0]?.id || '')
    setReferenceIds(profile.board_asset_id ? [profile.board_asset_id] : [])
    setMode('existing'); setLabel(''); setPreview(null); setPrompt(''); setError(''); setNotice(''); setOpen(true)
  }
  async function saveAsset() {
    if (!source) return
    await action(async () => {
      const input = { ...context, asset_id: source.id, view, purpose, label: label.trim() || undefined }
      if (mode === 'crop') await visualReferenceAssetsApi.crop(profile.id, { ...input, crop: normalizedReferenceCrop(crop) })
      else await visualReferenceAssetsApi.register(profile.id, input)
      await onRefresh(); setOpen(false); setNotice('参考图已加入候选，核对后可确认使用')
    })
  }
  async function update(reference: VisualReferenceAsset, patch: { status?: VisualReferenceAsset['status']; is_default?: boolean }) {
    await action(async () => { await visualReferenceAssetsApi.update(profile.id, reference.id, { ...context, ...patch }); await onRefresh() })
  }
  async function prepare() {
    if (!model) return
    await action(async () => {
      const result = await visualReferenceAssetsApi.preview(profile.id, referenceInput)
      setPreview(result); setPreviewInputKey(inputKey); setPrompt(result.prompt)
    })
  }
  async function generate() {
    if (!model || !previewCurrent || !preview || !selectedRatio || !prompt.trim()) return
    await action(async () => {
      await visualReferenceAssetsApi.generate(profile.id, { ...referenceInput, reference_signature: preview.reference_signature,
        prompt: prompt.trim(), ratio: selectedRatio, resolution: requestResolution || null,
        clarity: defaults.clarity, quality: defaults.quality, background: defaults.background, candidate_count: candidateCount })
      await onRefresh(); setOpen(false); setNotice('已提交独立参考图生成，完成后会出现在候选中')
    })
  }
  function pointerPosition(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: unit((event.clientX - bounds.left) / bounds.width), y: unit((event.clientY - bounds.top) / bounds.height) }
  }
  const cropRatio = imageRatio * crop.width / crop.height
  const referenceJobs = detail.jobs.flatMap(job => {
    try {
      const request = JSON.parse(job.request || '{}') as Record<string, unknown>
      return request.visual_reference_generation === true && request.visual_profile_id === profile.id && request.visual_profile_revision === profile.revision
        ? [{ job, request }] : []
    } catch { return [] }
  }).sort((left, right) => right.job.created_at.localeCompare(left.job.created_at))
  const activeJobs = referenceJobs.filter(({ job }) => job.status === 'queued' || job.status === 'running')
  const failedJobs = referenceJobs.filter(({ job }) => job.status === 'failed')
  function assetPicker(multiple = false) {
    return <div className="pc-reference-source-grid" aria-label={multiple ? '选择生成依据' : '选择参考图片'}>{assets.map(asset => {
      const selected = multiple ? referenceIds.includes(asset.id) : sourceId === asset.id
      return <UnstyledButton type="button" key={asset.id} aria-label={`选择图片：${asset.filename}`} aria-pressed={selected} disabled={busy || multiple && !selected && referenceIds.length >= 10}
        onClick={() => {
          if (!multiple) { setSourceId(asset.id); setCrop({ x: .1, y: .1, width: .8, height: .8 }) }
          else setReferenceIds(current => current.includes(asset.id) ? current.filter(id => id !== asset.id) : current.length < 10 ? [...current, asset.id] : current)
        }}><img src={asset.url} alt={asset.filename} loading="lazy" /><span>{asset.id === profile.board_asset_id ? '已确认信息图' : asset.filename}</span>{selected && <Check size={13} />}</UnstyledButton>
    })}{!assets.length && <p>暂无项目图片。先生成或上传一张设定图，再添加独立参考。</p>}</div>
  }
  function referenceRow(reference: VisualReferenceAsset) {
    const asset = detail.assets.find(item => item.id === reference.asset_id)
    const stale = referenceAssetNeedsReview(reference, profile, styleVersion)
    const usable = !stale && !!asset
    const caption = reference.label || viewLabel(reference.view, profile.kind)
    return <li className="pc-reference-asset" key={reference.id}>
      {asset ? <a className="pc-reference-asset-thumb" href={asset.url} target="_blank" rel="noreferrer" aria-label={`查看独立参考图：${caption}`}><img src={asset.url} alt={caption} loading="lazy" /></a>
        : <span className="pc-reference-asset-thumb">图片缺失</span>}
      <div className="pc-reference-asset-copy"><strong>{caption}</strong><span>{viewLabel(reference.view, profile.kind)} · {visualReferencePurposeLabels[reference.purpose]}</span>
        <small className={stale ? 'pc-reference-review-needed' : ''}>v{reference.revision} · {stale ? reference.revision !== profile.revision ? '旧版设定 · 需复核' : '画风已变化 · 需复核' : !asset ? '图片缺失' : reference.status === 'confirmed' ? reference.is_default ? '已确认 · 默认参考' : '已确认' : reference.status === 'archived' ? '已归档' : '候选待确认'}</small>
      </div>
      <div className="pc-reference-asset-actions">
        {reference.status === 'candidate' && <Tooltip label={usable ? '核对并确认参考图' : '版本或画风已变化，请重新制作'}><ActionIcon variant="subtle" aria-label={`确认参考图：${caption}`} disabled={locked || !usable} onClick={() => void update(reference, { status: 'confirmed' })}><Check size={14} /></ActionIcon></Tooltip>}
        {reference.status === 'confirmed' && <Tooltip label={reference.is_default ? '取消默认参考' : '设为此视角的默认参考'}><ActionIcon variant="subtle" aria-label={`${reference.is_default ? '取消默认' : '设为默认'}参考：${caption}`} disabled={locked || !usable} onClick={() => void update(reference, { is_default: !reference.is_default })}><Star size={14} fill={reference.is_default ? 'currentColor' : 'none'} /></ActionIcon></Tooltip>}
        <Tooltip label={reference.status === 'archived' ? stale ? '旧版本仅保留归档，重新制作后可使用' : '恢复为候选' : '归档参考图'}><ActionIcon variant="subtle" aria-label={`${reference.status === 'archived' ? '恢复' : '归档'}参考图：${caption}`} disabled={locked || reference.status === 'archived' && stale} onClick={() => void update(reference, { status: reference.status === 'archived' ? 'candidate' : 'archived' })}>{reference.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}</ActionIcon></Tooltip>
      </div>
    </li>
  }
  return <section className="pc-reference-assets" aria-label="独立参考图管理">
    <div className="pc-reference-assets-heading"><strong>独立参考图 <span>{references.filter(item => item.status !== 'archived').length}</span></strong>
      <Button variant="default" size="xs" leftSection={<Plus size={13} />} disabled={locked} onClick={openAdd}>添加参考图</Button></div>
    <p className="pc-reference-assets-help">按镜头需要添加面部、全身或场景机位，确认后在镜头引用中选择。</p>
    {disabledReason && <p className="pc-reference-assets-help">{disabledReason}</p>}
    {!!activeJobs.length && <p className="pc-reference-assets-help" role="status">正在生成 {activeJobs.length} 张参考候选…</p>}
    {!!failedJobs.length && <WorkspaceDisclosure className="pc-reference-job-failures" label={<>独立参考图生成失败 · {failedJobs.length} 张 · 查看原因</>}>

      <ul aria-label="独立参考图生成失败原因">{failedJobs.map(({ job, request }) => {
        const failedView = request.visual_reference_view as VisualReferenceView
        const name = typeof request.visual_reference_label === 'string' && request.visual_reference_label ||
          (failedView in visualReferenceViewLabels ? viewLabel(failedView, profile.kind) : '独立参考图')
        return <li key={job.id}><strong>{name}</strong><span>{models.find(item => item.id === job.model_id)?.name || '图片生成'}{job.created_at ? ` · ${new Date(job.created_at).toLocaleString('zh-CN')}` : ''}</span>
          <p>{job.error?.trim() || '生成失败，服务未返回具体原因。可调整参数后重新提交。'}</p></li>
      })}</ul>
    </WorkspaceDisclosure>}
    {!!archived.length && <UnstyledButton type="button" className="pc-reference-archive-toggle" aria-pressed={showArchived} disabled={busy} onClick={() => setShowArchived(value => !value)}>{showArchived ? '返回候选与已确认' : `已归档 · ${archived.length}`}</UnstyledButton>}
    {!!visible.length && <ul className="pc-reference-asset-list">{visible.map(referenceRow)}</ul>}
    {visible.some(reference => referenceAssetNeedsReview(reference, profile, styleVersion)) && <p className="pc-reference-assets-help">旧设定或旧画风的参考图需依据当前设定重新制作，确认后才可用于当前版本。</p>}
    {!visible.length && <p className="pc-reference-assets-empty">{showArchived ? '暂无归档参考图' : '尚未添加独立参考图'}</p>}
    {notice && <p className="pc-reference-assets-help" role="status">{notice}</p>}
    {error && !open && <p className="pc-visual-error" role="alert">{error}</p>}
    <Modal opened={open} onClose={() => { if (!busy) setOpen(false) }} centered size="min(860px, calc(100vw - 32px))" radius={16} title={`添加独立参考图 · ${profile.name}`}
      closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}
      classNames={{ content: 'pc-confirm-modal pc-reference-modal', header: 'pc-confirm-modal-header', body: 'pc-confirm-modal-body', close: 'pc-confirm-modal-close' }}>
      <div className="pc-reference-add">
        <div className="pc-reference-methods" role="group" aria-label="添加参考图方式">{([
          ['existing', '选择现有图', ImagePlus], ['crop', '裁切单张参考', Crop], ['generate', '按角度生成', Sparkles],
        ] as const).map(([value, caption, Icon]) => <UnstyledButton type="button" key={value} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); setError('') }}><Icon size={14} />{caption}</UnstyledButton>)}</div>
        <div className="pc-reference-fields"><label>视角<Select aria-label="独立参考视角" value={view} disabled={busy} onChange={value => { const next = (value || '') as VisualReferenceView; setView(next); setPurpose(purposeFor(next, profile.kind)); setRatio('') }} data={viewsFor(profile.kind).map(item => ({ value: item, label: viewLabel(item, profile.kind) }))} allowDeselect={false} searchable={false} /></label>
          <label>用途<Select aria-label="独立参考用途" value={purpose} disabled={busy} onChange={value => setPurpose((value || '') as VisualReferencePurpose)} data={Object.entries(visualReferencePurposeLabels).map(([value, label]) => ({ value, label }))} allowDeselect={false} searchable={false} /></label>
          <TextInput label="名称（可选）" aria-label="独立参考名称" placeholder={`${profile.name} · ${viewLabel(view, profile.kind)}`} value={label} maxLength={120} disabled={busy} onChange={event => setLabel(event.currentTarget.value)} /></div>
        {mode === 'existing' && <><p className="pc-reference-assets-help">选择本项目的一张独立图片。图片会登记为候选，原文件保留。</p>{assetPicker()}
          {source?.id === profile.board_asset_id && <p className="pc-reference-assets-help">当前选中信息图母版，建议切换到「裁切单张参考」提取单个视角。</p>}
          {source && <div className="pc-reference-existing-preview"><img src={source.url} alt={`参考图预览：${source.filename}`} /><span>{source.filename}</span></div>}</>}
        {mode === 'crop' && <><p className="pc-reference-assets-help">在原图上拖出矩形，保留完整的单个视角。裁切会另存图片，请核对右侧预览中的面部、身体和细节。</p>{assetPicker()}
          {source && <div className="pc-reference-crop-workspace"><div><strong>原图 · 拖动选择</strong><div className="pc-reference-crop-original" style={{ aspectRatio: imageRatio, maxWidth: 380 * imageRatio }}
            aria-label="在原图上拖动选择裁切区域" onPointerDown={event => {
              if (busy || event.button !== 0) return
              event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId)
              dragging.current = { pointer: event.pointerId, start: pointerPosition(event) }
            }} onPointerMove={event => { if (dragging.current?.pointer === event.pointerId) setCrop(referenceCropFromPoints(dragging.current.start, pointerPosition(event))) }}
            onPointerUp={event => { if (dragging.current?.pointer === event.pointerId) { setCrop(referenceCropFromPoints(dragging.current.start, pointerPosition(event))); dragging.current = null } }}
            onPointerCancel={() => { dragging.current = null }}>
            <img src={source.url} alt="裁切原图" draggable={false} onError={() => setImageFailed(true)} onLoad={event => { const { naturalWidth, naturalHeight } = event.currentTarget; if (naturalWidth && naturalHeight) setImageRatio(naturalWidth / naturalHeight) }} />
            <div className="pc-reference-crop-rectangle" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} />
          </div></div><div><strong>裁切预览</strong><div className="pc-reference-crop-preview" style={{ aspectRatio: cropRatio, maxWidth: 320 * cropRatio }} aria-label="独立参考裁切预览">
            <img src={source.url} alt="选定区域预览" draggable={false} style={{ width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%` }} /></div>
            <div className="pc-reference-crop-values">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['左', '上', '宽', '高'][index]} %<NumberInput  min={0} max={100} step={.1} aria-label={`裁切${['左侧位置', '顶部位置', '宽度', '高度'][index]}百分比`} value={Number((crop[key] * 100).toFixed(1))} disabled={busy} onChange={next => { const value = Number(next) / 100; setCrop(current => normalizedReferenceCrop({ ...current, [key]: value })) }} clampBehavior="none" /></label>)}</div>
            <Button type="button" className="pc-reference-text-action" disabled={busy} onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })} data-workspace-control="" variant="subtle">重置为整张图</Button>
          </div></div>}{imageFailed && <p className="pc-visual-error" role="alert">原图加载失败，请重新选择图片。</p>}</>}
        {mode === 'generate' && <><p className="pc-reference-assets-help">以确认的信息图或所选图片为依据，只生成单个对象的单一视角。先预览并编辑提示词，再提交生成。</p>
          <div className="pc-reference-generation-settings"><label>图片模型<Select aria-label="独立参考生成模型" value={model?.id || ''} disabled={busy || !imageModels.length} onChange={value => { setModelId((value || '')); setRatio(''); setResolution('') }} data={imageModels.map(item => ({ value: item.id, label: item.name }))} allowDeselect={false} searchable={true} /></label>
            <label>画幅<Select aria-label="独立参考生成画幅" value={selectedRatio} disabled={busy || !ratioOptions.length} onChange={value => setRatio((value || ''))} data={ratioOptions} allowDeselect={false} searchable={false} /></label>
            {!!resolutions.length && <label>分辨率<Select aria-label="独立参考生成分辨率" value={selectedResolution} disabled={busy} onChange={value => setResolution((value || ''))} data={resolutions} allowDeselect={false} searchable={false} /></label>}
            <label>候选数量<Select aria-label="独立参考候选数量" value={String(candidateCount)} disabled={busy} onChange={value => setCandidateCount(Number((value || '')) as 1 | 2 | 4)} data={[1, 2, 4].map(value => ({ value: String(value), label: value + ' 张' }))} allowDeselect={false} searchable={false} /></label>
          </div>
          <div className="pc-reference-generation-source-label"><strong>参考依据 · {referenceIds.length} 张</strong><span>点击图片选择或取消 · 最多 10 张</span></div>{assetPicker(true)}
          {!referenceIds.length && <p className="pc-reference-assets-help">未选择图片，将按固定文字设定生成。加入母版或现有参考图有助于保持一致。</p>}
          <Button variant="default" size="xs" disabled={locked || !model} onClick={() => void prepare()}>{preview ? '重新预览提示词' : '预览提示词'}</Button>
          {preview && <div className="pc-reference-prompt-preview"><Textarea label="独立参考提示词" aria-label="独立参考生成提示词" value={prompt} disabled={busy} autosize minRows={6} maxRows={12} maxLength={80000} onChange={event => setPrompt(event.currentTarget.value)} />
            {!previewCurrent && <p className="pc-reference-review-needed" role="status">视角、用途、设定或参考依据已变化，请重新预览。</p>}
            {preview.style_warnings?.map(warning => <p className="pc-reference-review-needed" key={warning}>{warning}</p>)}</div>}</>}
        {error && <p className="pc-visual-error" role="alert">{error}</p>}
        <div className="pc-reference-add-footer"><span>{mode === 'generate' ? estimatedCost ? `预计 ${estimatedCost} · ${candidateCount} 张候选` : '提交后生成候选，确认后才用于镜头' : '不会替换已确认的信息图'}</span>
          <Button variant="default" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button variant="default" leftSection={mode === 'generate' ? <Sparkles size={14} /> : mode === 'crop' ? <Crop size={14} /> : <Plus size={14} />}
            disabled={locked || (mode === 'generate' ? !model || !previewCurrent || !selectedRatio || !prompt.trim() : !source || mode === 'crop' && imageFailed)}
            onClick={() => void (mode === 'generate' ? generate() : saveAsset())}>{busy ? '正在处理…' : mode === 'generate' ? `生成 ${candidateCount} 张候选` : mode === 'crop' ? '保存裁切候选' : '加入参考候选'}</Button>
        </div>
      </div>
    </Modal>
  </section>
}
