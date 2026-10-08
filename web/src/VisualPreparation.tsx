import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Checkbox, Loader, Modal, MultiSelect, Select, Textarea, TextInput, Tooltip } from '@mantine/core'
import { Check, Image as ImageIcon, Plus, RefreshCcw, Save, Trash2, Upload, WandSparkles, X } from 'lucide-react'
import { api, json } from './api'
import type { Asset, AssetTask, Model, ProjectDetail, VisualBoardPreview, VisualKind, VisualProfileDraft, VisualProjectData } from './api'
import { imageReferenceConfigError } from '../../backend/src/image-reference-config'
import { generationCost, imagePreferencePrompt, imageRatioError, imageRatios, imageRequestResolution, modelDefaultResolution, usesModelParameter } from './canvas-model-parameters'
import { useAppDialog } from './AppDialog'
import DirectorMessageTiming, { finishMessageTiming, type MessageTiming } from './DirectorMessageTiming'
import './visual-preparation.css'

const kinds: Array<{ value: VisualKind; label: string }> = [
  { value: 'character', label: '人物' }, { value: 'location', label: '场景' }, { value: 'prop', label: '道具' },
]
const views: Record<VisualKind, string> = {
  character: '正面、侧面、背面、四分之三视角；面部、发型、服装细节；身高比例、配色与材质标注。',
  location: '空间平面布局、多个方向的视图；门窗、通道、固定陈设的位置与尺寸；材质、配色及光源。',
  prop: '正面、侧面、背面、俯视；关键局部与使用状态；尺寸、结构、材质、纹样和配色。',
}
const emptyProfile = (): VisualProfileDraft => ({ kind: 'character', name: '', variant: '默认', definition: '', view_requirements: views.character, scene_ids: [] })
const dropdownProps = { withinPortal: true, zIndex: 450 }
type Props = {
  detail: ProjectDetail; models: Model[]; sceneIds?: string[]; shotId?: string;
  onRefresh: () => Promise<unknown>; onClose: () => void; onContinue?: () => Promise<void>;
  onOpenCanvas?: (profileIds: string[]) => void;
}

export default function VisualPreparation({ detail, models, sceneIds, shotId, onRefresh, onClose, onContinue, onOpenCanvas }: Props) {
  const [catalogModels, setCatalogModels] = useState(models)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [data, setData] = useState<VisualProjectData>({ visual_profiles: detail.visual_profiles || [], scene_visual_bindings: detail.scene_visual_bindings || [], shot_visual_bindings: detail.shot_visual_bindings || [] })
  const [selectedId, setSelectedId] = useState<string | null>(data.visual_profiles[0]?.id || null)
  const [form, setForm] = useState<VisualProfileDraft>(emptyProfile)
  const [drafts, setDrafts] = useState<VisualProfileDraft[] | null>(null)
  const [draftIndex, setDraftIndex] = useState(0)
  const [textModelId, setTextModelId] = useState(models.find(model => model.enabled && model.modality === 'text')?.id || '')
  const [imageModelId, setImageModelId] = useState(models.find(model => model.enabled && model.modality === 'image')?.id || '')
  const [ratio, setRatio] = useState('')
  const [busy, setBusy] = useState(false)
  const [analysis, setAnalysis] = useState<(MessageTiming & { status: 'running' | 'complete' | 'failed' }) | null>(null)
  const [error, setError] = useState('')
  const [task, setTask] = useState<AssetTask | null>(null)
  const [boardId, setBoardId] = useState<string | null>(null)
  const [boardReview, setBoardReview] = useState(false)
  const [boardPreview, setBoardPreview] = useState<VisualBoardPreview | null>(null)
  const [referencesByProfile, setReferencesByProfile] = useState<Record<string, string[]>>({})
  const [target, setTarget] = useState(shotId ? `shot:${shotId}` : sceneIds?.[0] ? `scene:${sceneIds[0]}` : detail.script.scenes[0] ? `scene:${detail.script.scenes[0].id}` : '')
  const [assets, setAssets] = useState(detail.assets)
  const fileInput = useRef<HTMLInputElement>(null)
  const referenceFileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const dialog = useAppDialog({ zIndex: 460 })
  const profile = data.visual_profiles.find(item => item.id === selectedId)
  const analyzing = analysis?.status === 'running'
  const generatingLabel = <span className="vp-generating">生成中<span className="vp-generating-dots" aria-hidden="true" /></span>
  const profileDirty = !!profile && (['kind', 'name', 'variant', 'definition', 'view_requirements'] as const).some(key => form[key] !== profile[key])
  const imageModel = catalogModels.find(model => model.id === imageModelId && model.enabled && model.modality === 'image')
  const referenceValues = selectedId ? referencesByProfile[selectedId] || [] : []
  const referenceProfileIds = referenceValues.filter(value => value.startsWith('profile:')).map(value => value.slice(8))
  const referenceAssetIds = referenceValues.filter(value => value.startsWith('asset:')).map(value => value.slice(6))
  const boardReferences = [
    ...referenceProfileIds.map(id => {
      const reference = data.visual_profiles.find(item => item.id === id)
      return { asset: assets.find(item => item.id === reference?.board_asset_id), name: reference ? `${reference.name} · ${reference.variant} · v${reference.revision}` : '设定已删除', value: `profile:${id}` }
    }),
    ...referenceAssetIds.map(id => {
      const asset = assets.find(item => item.id === id)
      return { asset, name: asset?.filename || '图片已删除', value: `asset:${id}` }
    }),
  ]
  const boardMode = referenceValues.length ? 'reference' : 'text'
  const boardReferenceError = boardReferences.some(reference => !reference.asset) ? '所选参考图已移除或尚未确认，请重新选择'
    : imageModel ? imageReferenceConfigError(imageModel.settings, referenceValues.length, boardMode) : null
  const ratios = Array.isArray(imageModel?.settings.ratios) ? imageModel.settings.ratios as string[] : imageRatios
  const configuredDefaultRatio = typeof imageModel?.settings.default_ratio === 'string' ? imageModel.settings.default_ratio : ''
  const boardRatio = ratios.includes(ratio) ? ratio : ratios.includes(configuredDefaultRatio) ? configuredDefaultRatio : ratios.includes('16:9') ? '16:9' : ratios[0] || '16:9'
  const defaultResolution = modelDefaultResolution(imageModel, Array.isArray(imageModel?.settings.resolutions) ? imageModel.settings.resolutions as string[] : [])
  const resolution = imageModel ? imageRequestResolution(imageModel, defaultResolution, { ratio: boardRatio, clarity: '', mode: boardMode }) : defaultResolution
  const boardParameters = { ratio: boardRatio, resolution: resolution || null, clarity: null, quality: null, background: null }
  const boardPrompt = imageModel && profile ? imagePreferencePrompt(imageModel, boardPreview?.prompt || profile.board_prompt, boardParameters, boardMode) : profile?.board_prompt
  const usesNativeRatio = !!imageModel && usesModelParameter(imageModel, 'ratio', boardMode)
  const boardRatioError = imageModel ? imageRatioError(imageModel, resolution, boardRatio, boardMode) : null
  const scopes = detail.script.scenes.filter(scene => !sceneIds || sceneIds.includes(scene.id))
  const sceneOptions = detail.script.scenes.map(scene => ({ value: scene.id, label: `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}` }))
  const selectedBindings = target.startsWith('shot:')
    ? data.shot_visual_bindings.filter(binding => binding.shot_id === target.slice(5))
    : data.scene_visual_bindings.filter(binding => binding.scene_id === target.slice(6))
  const scopeBindings = data.scene_visual_bindings.filter(binding => scopes.some(scene => scene.id === binding.scene_id))
  const missingCount = scopeBindings.filter(binding => binding.required && !data.visual_profiles.find(item => item.id === binding.profile_id)?.board_asset_id).length
  const candidate = boardId && boardId !== profile?.board_asset_id ? assets.find(asset => asset.id === boardId) : task?.result_asset
  const refreshModelCatalog = useCallback(async () => {
    setCatalogLoading(true)
    try {
      const next = await api<Model[]>('/models')
      if (mounted.current) setCatalogModels(next)
      return next
    } finally {
      if (mounted.current) setCatalogLoading(false)
    }
  }, [])

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setCatalogModels(models) }, [models])
  // The parent view can keep an older catalog after settings change or HMR.
  useEffect(() => {
    let cancelled = false
    void refreshModelCatalog().catch(issue => {
      if (!cancelled && mounted.current) setError(issue instanceof Error ? issue.message : String(issue))
    })
    return () => { cancelled = true }
  }, [refreshModelCatalog])
  useEffect(() => {
    setTextModelId(current => catalogModels.some(model => model.id === current && model.enabled && model.modality === 'text')
      ? current : catalogModels.find(model => model.enabled && model.modality === 'text')?.id || '')
    setImageModelId(current => catalogModels.some(model => model.id === current && model.enabled && model.modality === 'image')
      ? current : catalogModels.find(model => model.enabled && model.modality === 'image')?.id || '')
  }, [catalogModels])
  useEffect(() => {
    if (!profile) { setForm(emptyProfile()); setTask(null); setBoardId(null); return }
    setForm({ kind: profile.kind, name: profile.name, variant: profile.variant, definition: profile.definition, view_requirements: profile.view_requirements,
      scene_ids: data.scene_visual_bindings.filter(binding => binding.profile_id === profile.id).map(binding => binding.scene_id) })
    setBoardId(profile.board_asset_id)
    setTask(null)
    let cancelled = false
    if (profile.asset_task_id) void api<AssetTask>(`/asset-tasks/${profile.asset_task_id}`).then(value => {
      if (cancelled || !mounted.current) return
      setTask(value)
      // Restore the exact images used by the previous attempt on reopening.
      if (value.generation_job) {
        try {
          const request = JSON.parse(value.generation_job.request) as { reference_asset_ids?: string[] }
          if (Array.isArray(request.reference_asset_ids)) setReferencesByProfile(current => current[profile.id] ? current : {
            ...current, [profile.id]: request.reference_asset_ids!.map(id => `asset:${id}`),
          })
        } catch { /* Older task records may not contain a generation request. */ }
      }
    }).catch(issue => { if (!cancelled) setError(String(issue)) })
    return () => { cancelled = true }
  }, [profile?.id, profile?.revision, profile?.board_asset_id, profile?.asset_task_id])
  useEffect(() => { setAssets(detail.assets) }, [detail.assets])
  useEffect(() => {
    if (task?.status !== 'generating') return
    const timer = window.setInterval(() => {
      void api<AssetTask>(`/asset-tasks/${task.id}`).then(value => {
        if (!mounted.current) return
        setTask(value)
        if (value.result_asset) setAssets(current => [value.result_asset!, ...current.filter(asset => asset.id !== value.result_asset!.id)])
        if (value.status !== 'generating') void onRefresh()
      }).catch(issue => setError(String(issue)))
    }, 1800)
    return () => window.clearInterval(timer)
  }, [task?.id, task?.status, onRefresh])

  async function action(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await fn() } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (mounted.current) setBusy(false) }
  }
  async function reload() {
    setData(await api<VisualProjectData>(`/projects/${detail.id}/visual-profiles`))
    await onRefresh()
  }
  async function analyze() {
    if (busy) return
    const startedAt = performance.now()
    setAnalysis({ status: 'running', processing_started_at: startedAt })
    await action(async () => {
      try {
        const result = await api<{ profiles: VisualProfileDraft[] }>(`/projects/${detail.id}/visual-profiles/analyze`, json('POST', { model_id: textModelId, scene_ids: scopes.map(scene => scene.id) }))
        if (!result.profiles.length) throw new Error('所选场次没有需要整理的视觉对象')
        if (!mounted.current) return
        setDrafts(result.profiles); setDraftIndex(0)
        setAnalysis({ status: 'complete', ...finishMessageTiming(startedAt) })
      } catch (issue) {
        if (mounted.current) setAnalysis({ status: 'failed', ...finishMessageTiming(startedAt) })
        throw issue
      }
    })
  }
  async function saveProfile() {
    await action(async () => {
      if (profile) {
        await api(`/visual-profiles/${profile.id}`, json('PATCH', { kind: form.kind, name: form.name, variant: form.variant, definition: form.definition, view_requirements: form.view_requirements, expected_revision: profile.revision }))
      } else {
        const result = await api<VisualProjectData>(`/projects/${detail.id}/visual-profiles`, json('POST', { profiles: [form] }))
        setSelectedId(result.visual_profiles.find(item => item.kind === form.kind && item.name === form.name.trim() && item.variant === form.variant.trim())?.id || null)
      }
      await reload()
    })
  }
  async function saveBindings(bindings: Array<{ profile_id: string; required: boolean }>, refreshIds: string[] = []) {
    await action(async () => {
      const isShot = target.startsWith('shot:')
      const result = await api<VisualProjectData>(`/${isShot ? 'shots' : 'script-scenes'}/${target.slice(isShot ? 5 : 6)}/visual-bindings`, json('PUT', {
        bindings: bindings.map(({ profile_id, required }) => ({ profile_id, required })),
        ...(isShot ? { refresh_profile_ids: refreshIds } : {}),
      }))
      setData(result); await onRefresh()
    })
  }
  async function generateBoard() {
    if (!profile || !imageModel || !boardPreview) return
    if (boardRatioError) { setError(boardRatioError); return }
    if (boardReferenceError) { setError(boardReferenceError); return }
    await action(async () => {
      const result = await api<{ task_id: string; prompt: string }>(`/visual-profiles/${profile.id}/board-task`, json('POST', {
        expected_revision: profile.revision, model_id: imageModel.id, reference_profile_ids: referenceProfileIds,
        reference_asset_ids: referenceAssetIds, reference_signature: boardPreview.reference_signature,
      }))
      const generated = await api<{ task: AssetTask }>(`/asset-tasks/${result.task_id}/generate`, json('POST', {
        model_id: imageModel.id, prompt: imagePreferencePrompt(imageModel, result.prompt, boardParameters, boardPreview.mode),
        mode: boardPreview.mode, reference_asset_ids: boardPreview.reference_asset_ids,
        ratio: boardRatio, resolution: boardParameters.resolution,
      }))
      setTask(generated.task); setBoardReview(false); await reload()
    })
  }
  async function reviewBoard() {
    if (!profile) return
    await action(async () => {
      const next = await refreshModelCatalog()
      if (!next.some(model => model.id === imageModelId && model.enabled && model.modality === 'image')) {
        throw new Error('所选图片模型已停用或删除，请重新选择图片模型')
      }
      setBoardPreview(await api<VisualBoardPreview>(`/visual-profiles/${profile.id}/board-preview`, json('POST', {
        expected_revision: profile.revision, model_id: imageModelId,
        reference_profile_ids: referenceProfileIds, reference_asset_ids: referenceAssetIds,
      })))
      setBoardReview(true)
    })
  }
  async function confirmBoard(assetId: string) {
    if (!profile) return
    await action(async () => {
      await api(`/visual-profiles/${profile.id}`, json('PATCH', { board_asset_id: assetId, expected_revision: profile.revision }))
      await reload()
    })
  }
  async function uploadBoard(file: File) {
    await action(async () => {
      const payload = new FormData(); payload.append('file', file)
      const asset = await api<Asset>(`/projects/${detail.id}/assets`, { method: 'POST', body: payload })
      setAssets(current => [asset, ...current]); setBoardId(asset.id); await onRefresh()
    })
  }
  function selectReferences(values: string[]) {
    if (selectedId) setReferencesByProfile(current => ({ ...current, [selectedId]: values }))
  }
  async function uploadReference(file: File) {
    if (!profile) return
    await action(async () => {
      const payload = new FormData(); payload.append('file', file)
      const asset = await api<Asset>(`/projects/${detail.id}/assets`, { method: 'POST', body: payload })
      setAssets(current => [asset, ...current])
      setReferencesByProfile(current => ({ ...current, [profile.id]: [...current[profile.id] || [], `asset:${asset.id}`] }))
      await onRefresh()
    })
  }
  function editor(value: VisualProfileDraft, update: (patch: Partial<VisualProfileDraft>) => void, includeScenes = false) {
    return <div className="vp-fields">
      <div className="vp-field-row"><Select comboboxProps={dropdownProps} label="类型" value={value.kind} allowDeselect={false} data={kinds} onChange={kind => kind && update({ kind: kind as VisualKind, view_requirements: views[kind as VisualKind] })} />
        <TextInput label="名称" value={value.name} maxLength={100} onChange={event => update({ name: event.currentTarget.value })} />
        <TextInput label="服装 / 状态版本" value={value.variant} maxLength={100} onChange={event => update({ variant: event.currentTarget.value })} /></div>
      <Textarea label="固定视觉设定" autosize minRows={5} maxRows={10} maxLength={12000} value={value.definition} onChange={event => update({ definition: event.currentTarget.value })} />
      <Textarea label="信息图视图与细节" autosize minRows={3} maxRows={5} maxLength={3000} value={value.view_requirements} onChange={event => update({ view_requirements: event.currentTarget.value })} />
      {includeScenes && <MultiSelect comboboxProps={dropdownProps} label="使用场次" data={sceneOptions} value={value.scene_ids} onChange={scene_ids => update({ scene_ids })} searchable />}
    </div>
  }

  return <>
    <Modal opened onClose={onClose} closeOnClickOutside={false} closeOnEscape={!busy} withCloseButton={!busy} title="视觉设定" size={980} radius={16} centered zIndex={410} classNames={{ content: 'vp-modal', body: 'vp-body' }}>
      <div className="vp-topbar"><Select comboboxProps={dropdownProps} aria-label="整理设定的文本模型" placeholder="文本模型" value={textModelId || null} disabled={busy} data={catalogModels.filter(model => model.enabled && model.modality === 'text').map(model => ({ value: model.id, label: model.name }))} onChange={value => setTextModelId(value || '')} />
        <Button variant="default" className="vp-analyze-button" leftSection={<WandSparkles size={14} />} disabled={busy || !textModelId || !scopes.length || !!drafts} onClick={() => void analyze()}>整理设定草稿</Button>
        <Tooltip label="新增设定"><ActionIcon variant="default" aria-label="新增设定" disabled={busy || !!drafts} onClick={() => setSelectedId(null)}><Plus size={17} /></ActionIcon></Tooltip>
        <small>{data.visual_profiles.length ? `${data.visual_profiles.length} 份设定 · ${missingCount ? `${missingCount} 项必需信息图待确认` : '已绑定信息图齐备'}` : '尚未整理设定'}</small>
      </div>
      {analysis && <div className="vp-analysis-status" aria-busy={analyzing}>
        <span className="vp-analysis-label" role="status">{analyzing && <Loader size={14} color="gray.3" aria-hidden="true" />}{analyzing ? '正在整理人物、场景和道具设定' : analysis.status === 'complete' ? '设定草稿已整理完成' : '设定草稿整理失败'}</span>
        <DirectorMessageTiming {...analysis} pending={analyzing} title="本次视觉设定整理的处理用时" />
      </div>}
      {error && <div className="vp-error" role="alert">{error}<ActionIcon aria-label="关闭错误" variant="subtle" onClick={() => setError('')}><X size={14} /></ActionIcon></div>}
      {drafts ? <div className="vp-draft">
        <div className="vp-draft-header"><strong>待确认草稿 · {draftIndex + 1} / {drafts.length}</strong><Select comboboxProps={dropdownProps} aria-label="选择设定草稿" value={String(draftIndex)} data={drafts.map((draft, index) => ({ value: String(index), label: `${draft.name} · ${draft.variant}` }))} onChange={value => value && setDraftIndex(Number(value))} />
          <Tooltip label="移除此草稿"><ActionIcon aria-label="移除此草稿" variant="default" disabled={busy} onClick={() => { const next = drafts.filter((_, index) => index !== draftIndex); setDrafts(next.length ? next : null); setDraftIndex(0) }}><Trash2 size={15} /></ActionIcon></Tooltip></div>
        {editor(drafts[draftIndex]!, patch => setDrafts(current => current!.map((draft, index) => index === draftIndex ? { ...draft, ...patch } : draft)), true)}
        <div className="vp-actions"><Button variant="default" disabled={busy} onClick={() => setDrafts(null)}>放弃草稿</Button><Button variant="filled" loading={busy} leftSection={<Check size={14} />} disabled={drafts.some(draft => !draft.name.trim() || !draft.variant.trim() || !draft.definition.trim() || !draft.view_requirements.trim())} onClick={() => void action(async () => { setData(await api<VisualProjectData>(`/projects/${detail.id}/visual-profiles`, json('POST', { profiles: drafts }))); setDrafts(null); await onRefresh() })}>确认保存 {drafts.length} 份设定</Button></div>
      </div> : <div className="vp-layout">
        <nav className="vp-list" aria-label="设定档案">{data.visual_profiles.map(item => <button key={item.id} type="button" disabled={busy} className={selectedId === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
          <span>{kinds.find(kind => kind.value === item.kind)?.label}<small>v{item.revision}</small></span><strong>{item.name}</strong><small>{item.variant} · {item.board_asset_id ? '信息图已确认' : '信息图待确认'}</small>
        </button>)}{!data.visual_profiles.length && <p>暂无视觉设定</p>}</nav>
        <main className="vp-editor">
          <header><strong>{profile ? `${profile.name} · v${profile.revision}${profileDirty ? ' · 未保存修改' : ''}` : '新增设定'}</strong>{profile && <Tooltip label="删除设定"><ActionIcon variant="subtle" aria-label="删除设定" disabled={busy} onClick={() => void action(async () => {
            if (!await dialog.confirm({ title: '删除视觉设定', message: `删除「${profile.name}」及其场次绑定？`, danger: true })) return
            await api(`/visual-profiles/${profile.id}`, json('DELETE', {})); setSelectedId(null); await reload()
          })}><Trash2 size={15} /></ActionIcon></Tooltip>}</header>
          <fieldset disabled={busy || task?.status === 'generating'}>{editor(form, patch => setForm(current => ({ ...current, ...patch })), !profile)}</fieldset>
          <div className="vp-actions"><Button variant="default" leftSection={<Save size={14} />} disabled={busy || task?.status === 'generating' || !form.name.trim() || !form.variant.trim() || !form.definition.trim() || !form.view_requirements.trim()} onClick={() => void saveProfile()}>保存设定</Button></div>
          {profile && onOpenCanvas && <div className="vp-actions"><Button variant="default" leftSection={<ImageIcon size={14} />} disabled={busy || profileDirty} onClick={() => onOpenCanvas([profile.id])}>在画布制作设定图</Button></div>}
          {profile && !onOpenCanvas && <section className="vp-board">
            <header><strong>设定信息图</strong><span>{profile.board_asset_id ? '已确认' : task?.status === 'generating' ? generatingLabel : '待确认'}</span></header>
            {profile.board_asset_id && assets.find(asset => asset.id === profile.board_asset_id) && <a href={assets.find(asset => asset.id === profile.board_asset_id)!.url} target="_blank" rel="noreferrer"><img className="vp-approved-board" src={assets.find(asset => asset.id === profile.board_asset_id)!.url} alt={`${profile.name} 已确认信息图`} /></a>}
            {candidate && candidate.id !== profile.board_asset_id && <div className="vp-candidate"><a href={candidate.url} target="_blank" rel="noreferrer"><img src={candidate.url} alt={`${profile.name} 待审核信息图`} /></a><Button variant="default" leftSection={<Check size={14} />} disabled={busy || profileDirty || task?.status === 'generating'} onClick={() => void confirmBoard(candidate.id)}>确认使用此信息图</Button></div>}
            {task?.error && <p className="vp-error">{task.error}</p>}
            <div className="vp-board-controls"><Select comboboxProps={dropdownProps} aria-label="选择已有图片作为信息图" placeholder="选择项目图片" searchable value={boardId} data={assets.filter(asset => asset.kind === 'image').map(asset => ({ value: asset.id, label: asset.filename }))} onChange={setBoardId} />
              <Tooltip label="上传信息图"><ActionIcon variant="default" aria-label="上传信息图" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={16} /></ActionIcon></Tooltip></div>
            <input type="file" hidden ref={fileInput} accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadBoard(file); event.currentTarget.value = '' }} />
            <div className="vp-reference-controls"><MultiSelect comboboxProps={dropdownProps} aria-label="生成参考图" label="生成参考图" placeholder="选择设定图或项目图片" searchable maxValues={10} value={referenceValues} disabled={busy || task?.status === 'generating'} onChange={selectReferences} data={[
              { group: '已确认设定图', items: data.visual_profiles.filter(item => item.board_asset_id && item.id !== profile.id).map(item => ({ value: `profile:${item.id}`, label: `${item.name} · ${item.variant} · v${item.revision}` })) },
              { group: '项目图片', items: assets.filter(asset => asset.kind === 'image' && (!data.visual_profiles.some(item => item.board_asset_id === asset.id) || referenceAssetIds.includes(asset.id))).map(asset => ({ value: `asset:${asset.id}`, label: asset.filename })) },
            ]} /><Tooltip label="上传参考图"><ActionIcon variant="default" aria-label="上传参考图" disabled={busy || task?.status === 'generating' || referenceValues.length >= 10} onClick={() => referenceFileInput.current?.click()}><Upload size={16} /></ActionIcon></Tooltip></div>
            <input type="file" hidden ref={referenceFileInput} accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadReference(file); event.currentTarget.value = '' }} />
            {!!boardReferences.length && <div className="vp-reference-images">{boardReferences.map((reference, index) => <figure key={reference.value}>
              {reference.asset && <a href={reference.asset.url} target="_blank" rel="noreferrer"><img src={reference.asset.url} alt={reference.name} /></a>}
              <figcaption>参考图 {index + 1} · {reference.name}</figcaption>
              <Tooltip label="移除参考图"><ActionIcon variant="subtle" aria-label={`移除参考图 ${reference.name}`} disabled={busy || task?.status === 'generating'} onClick={() => selectReferences(referenceValues.filter(value => value !== reference.value))}><X size={14} /></ActionIcon></Tooltip>
            </figure>)}</div>}
            <div className="vp-board-controls"><Select comboboxProps={dropdownProps} aria-label="信息图图片模型" placeholder="图片模型" value={imageModelId || null} disabled={busy || catalogLoading} data={catalogModels.filter(model => model.enabled && model.modality === 'image').map(model => ({ value: model.id, label: model.name }))} onChange={value => setImageModelId(value || '')} />
              <Select comboboxProps={dropdownProps} aria-label="信息图画幅" value={boardRatio} disabled={busy || catalogLoading} data={ratios} onChange={value => setRatio(value || '')} />
              <Button variant="default" className="vp-board-generate-button" leftSection={<ImageIcon size={14} />} disabled={busy || catalogLoading || profileDirty || !imageModel || task?.status === 'generating'} onClick={() => void reviewBoard()}>生成信息图</Button></div>
            {catalogLoading && <p className="vp-catalog-status" role="status"><Loader size={12} color="gray.3" aria-hidden="true" />正在更新模型配置</p>}
            {boardReferenceError && <p className="vp-reference-note" role="status">{boardReferenceError}</p>}
          </section>}
          <section className="vp-bindings"><header><strong>场次 / 镜头引用</strong></header>
            <Select comboboxProps={dropdownProps} aria-label="选择绑定场次或镜头" value={target || null} searchable placeholder="选择场次或镜头" data={[
              { group: '场次', items: sceneOptions.map(option => ({ ...option, value: `scene:${option.value}` })) },
              { group: '镜头', items: detail.shots.map(shot => ({ value: `shot:${shot.id}`, label: `${shot.position + 1}. ${shot.title}` })) },
            ]} onChange={value => setTarget(value || '')} />
            {target.startsWith('scene:') && detail.shots.some(shot => shot.source_scene_id === target.slice(6)) && <div className="vp-actions"><Button variant="default" leftSection={<Plus size={14} />} disabled={busy} onClick={() => void action(async () => {
              setData(await api<VisualProjectData>(`/script-scenes/${target.slice(6)}/visual-bindings/apply-to-shots`, json('POST', {})))
              await onRefresh()
            })}>应用到本场镜头</Button></div>}
            {target && data.visual_profiles.map(item => {
              const binding = selectedBindings.find(binding => binding.profile_id === item.id)
              const snapshot = target.startsWith('shot:') ? data.shot_visual_bindings.find(binding => binding.shot_id === target.slice(5) && binding.profile_id === item.id) : null
              return <div className="vp-binding" key={item.id}><Checkbox label={`${item.name} · ${item.variant}`} checked={!!binding} disabled={busy} onChange={event => void saveBindings(event.currentTarget.checked ? [...selectedBindings, { profile_id: item.id, required: true }] : selectedBindings.filter(binding => binding.profile_id !== item.id))} />
                {binding && <><Checkbox label="必需" checked={binding.required} disabled={busy} onChange={event => { const required = event.currentTarget.checked; void saveBindings(selectedBindings.map(binding => binding.profile_id === item.id ? { ...binding, required } : binding)) }} />
                  <small>{snapshot ? `v${snapshot.revision} · ${snapshot.board_asset_id ? '就绪' : '待图'}` : item.board_asset_id ? '就绪' : '待图'}</small>
                  {snapshot && snapshot.revision !== item.revision && <Tooltip label={`更新为 v${item.revision}`}><ActionIcon variant="default" aria-label={`更新 ${item.name} 的镜头设定版本`} disabled={busy} onClick={() => void saveBindings(selectedBindings, [item.id])}><RefreshCcw size={14} /></ActionIcon></Tooltip>}</>}
              </div>
            })}
          </section>
        </main>
      </div>}
      <footer className="vp-footer"><Button variant="default" disabled={busy} onClick={onClose}>关闭</Button>{onOpenCanvas && <Button variant="default" disabled={busy || !!drafts} onClick={() => onOpenCanvas([])}>进入设定画布</Button>}{onContinue && <Button variant="filled" disabled={busy || !!drafts} onClick={() => void action(onContinue)}>继续加入画布</Button>}</footer>
    </Modal>
    <Modal opened={boardReview} onClose={() => setBoardReview(false)} title="确认生成信息图" centered size={640} radius={16} zIndex={430} classNames={{ content: 'vp-modal', body: 'vp-review-body' }}>
      <div className="vp-board-review">
        <dl className="vp-board-parameters">
          <div><dt>图片模型</dt><dd>{imageModel?.name}</dd></div>
          <div><dt>画幅</dt><dd>{boardRatio}</dd></div>
          {(!usesNativeRatio || !!resolution) && <div><dt>图片尺寸</dt><dd>{resolution || (boardRatioError ? '未配置对应尺寸' : '模型默认')}</dd></div>}
          <div><dt>预估费用</dt><dd>{imageModel && generationCost(imageModel, { duration: 1, resolution: boardParameters.resolution }, 1) || '模型未配置费用'}</dd></div>
          {!!boardPreview?.reference_names.length && <div><dt>生成参考图</dt><dd>{boardPreview.reference_names.join('、')}</dd></div>}
        </dl>
        {!!boardReferences.length && <div className="vp-reference-images">{boardReferences.map((reference, index) => <figure key={reference.value}>
          {reference.asset && <a href={reference.asset.url} target="_blank" rel="noreferrer"><img src={reference.asset.url} alt={reference.name} /></a>}
          <figcaption>参考图 {index + 1} · {reference.name}</figcaption>
        </figure>)}</div>}
        {boardRatioError && <p className="vp-board-size-note" role="status">{boardRatioError}</p>}
        {boardReferenceError && <p className="vp-reference-note" role="status">{boardReferenceError}</p>}
        <pre>{boardPrompt}</pre><div className="vp-actions"><Button variant="default" disabled={busy} onClick={() => setBoardReview(false)}>返回</Button><Button variant="filled" loading={busy} disabled={catalogLoading || !imageModel || !boardPreview || !!boardRatioError || !!boardReferenceError} onClick={() => void generateBoard()}>确认生成</Button></div>
      </div>
    </Modal>
    {dialog.dialog}
  </>
}
