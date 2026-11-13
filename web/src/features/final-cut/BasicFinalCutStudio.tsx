import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { ActionIcon, Badge, Button, Checkbox, FileButton, Modal, NumberInput, Select, Tabs, Textarea, TextInput, UnstyledButton } from '@mantine/core'
import { ArrowDown, ArrowUp, Captions, Check, Copy, Download, Film, Image as ImageIcon, Mic2, Music2, Plus, Save, Trash2, Upload } from 'lucide-react'
import { editingCutDurationMs, type EditingCut, type EditingCutCaption, type EditingCutClip, type EditingCutSpeech } from '@video-studio/shared/media/editing-cut'
import type { Asset, Job, ProjectDetail } from '../../shared/api/api'
import { api, json } from '../../shared/api/api'
import { StudioMediaPlayer } from '../../shared/ui/media/StudioMediaPlayer'
import { assetPresentations } from '../assets/asset-presentation'
import TimelinePreview from './TimelinePreview'
import BasicCutReviewPanel from './BasicCutReviewPanel'
import { basicCutReviewSignature } from './basic-cut-review'
import { editingCutExportId, editingCutExportRevision, editingCutIssues, editingCutPreview } from './editing-cut-preview'
import type { FinalCutAssetStatus } from './final-cut-asset-status'
import { useFinalCutAssetStates } from './useFinalCutAssetStates'
import { useEditingCuts } from './useEditingCuts'
import './basic-final-cut-studio.css'

export interface BasicFinalCutStudioProps {
  detail: ProjectDetail
  sourceCanvasId?: string | null
  onRefresh: () => Promise<unknown>
  onOpenSpeech: (lineId?: string) => void
  onNotice: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
}

type Pending = { kind: 'select'; id: string } | { kind: 'new' } | { kind: 'reload' }
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`
const milliseconds = (value: string | number) => Math.round(Number(value || 0) * 1000)
const freshId = () => crypto.randomUUID()

/** All edits live in an independent cut; source shots, assets and speech selections stay read-only. */
export default function BasicFinalCutStudio({ detail, sourceCanvasId, onRefresh, onOpenSpeech, onNotice, onDirtyChange }: BasicFinalCutStudioProps) {
  const studio = useRef<HTMLElement>(null)
  const editor = useEditingCuts(detail.id, sourceCanvasId)
  const { draft, dirty, busy } = editor
  const [clipId, setClipId] = useState<string | null>(null), [speechId, setSpeechId] = useState<string | null>(null)
  const [panel, setPanel] = useState<string | null>('clip'), [mode, setMode] = useState<string | null>('cut')
  const [assetFilter, setAssetFilter] = useState<string | null>('all'), [query, setQuery] = useState('')
  const [assetStatus, setAssetStatus] = useState<'all' | FinalCutAssetStatus>('all')
  const [sourceId, setSourceId] = useState<string | null>(null), [audioChoice, setAudioChoice] = useState<string | null>(null)
  const [extraAssets, setExtraAssets] = useState<Asset[]>([]), [localJobs, setLocalJobs] = useState<Job[]>([])
  const [durations, setDurations] = useState<Map<string, number>>(() => new Map())
  const durationRequests = useRef(new Map<string, Promise<number>>())
  const exactDurations = useRef(new Map<string, number>())
  const [work, setWork] = useState(''), [issue, setIssue] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [createOpen, setCreateOpen] = useState(false), [createName, setCreateName] = useState(''), [copyDraft, setCopyDraft] = useState(false)
  const [importText, setImportText] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const currentProject = useRef(detail.id); currentProject.current = detail.id
  const callbacks = useRef({ onRefresh, onNotice, onDirtyChange }); callbacks.current = { onRefresh, onNotice, onDirtyChange }
  const blocked = busy || !!work
  const assets = useMemo(() => [...new Map([...extraAssets, ...detail.assets].map(asset => [asset.id, asset])).values()], [detail.assets, extraAssets])
  const names = useMemo(() => assetPresentations({ ...detail, assets }), [detail, assets])
  const assetConfirmation = useFinalCutAssetStates(detail, sourceCanvasId, assets)
  const assetStates = assetConfirmation.states
  const speechAssets = useMemo(() => {
    const result = new Map<string, { name: string; text: string }>()
    for (const line of detail.speech?.lines || []) {
      const voice = detail.speech?.voices.find(item => item.id === line.voice_id)
      const takes = [...line.takes].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      takes.forEach((take, index) => {
        if (!take.asset_id) return
        const text = take.text.trim() || line.text.trim()
        result.set(take.asset_id, { text, name: [text || '配音', voice?.name || take.speaker, `候选 ${index + 1}`].filter(Boolean).join(' · ') })
      })
    }
    return result
  }, [detail.speech])
  const audioAssets = assets.filter(asset => asset.kind === 'audio')
  const assetName = (id: string) => speechAssets.get(id)?.name || names.get(id)?.title || assets.find(asset => asset.id === id)?.filename || '素材已不存在'
  const source = assets.find(asset => asset.id === sourceId)
  const clip = draft?.clips.find(item => item.id === clipId) || draft?.clips[0]
  const speech = draft?.speech.find(item => item.id === speechId) || draft?.speech[0]
  const duration = draft ? editingCutDurationMs(draft) : 0
  const inputIssues = draft ? editingCutIssues(draft, assets, exactDurations.current) : []
  const exportIssues = draft ? editingCutIssues(draft, assets, exactDurations.current, true) : []
  const preview = draft ? editingCutPreview(draft, assets, exactDurations.current) : null
  const jobs = [...new Map([...localJobs, ...detail.jobs].map(job => [job.id, job])).values()]
    .filter(job => draft && job.job_type === 'export' && editingCutExportId(job.request) === draft.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const activeExport = jobs.find(job => job.status === 'queued' || job.status === 'running')
  const latestExport = jobs.find(job => job.status === 'succeeded' && assets.some(asset => asset.id === job.result_asset_id))
  const latestExportRevision = latestExport ? editingCutExportRevision(latestExport.request) : null
  const exportIsCurrent = !dirty && latestExportRevision !== null && latestExportRevision === draft?.revision
  const exportedAsset = assets.find(asset => asset.id === latestExport?.result_asset_id)
  const latestFailed = jobs[0]?.status === 'failed' ? jobs[0] : null
  const visibleAssets = assets.filter(asset => asset.kind !== 'text' && (assetFilter === 'all' || asset.kind === assetFilter)
    && (assetStatus === 'all' || assetStates.get(asset.id)?.status === assetStatus)
    && `${assetName(asset.id)} ${asset.filename}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  useEffect(() => { callbacks.current.onDirtyChange?.(dirty) }, [dirty])
  useEffect(() => () => callbacks.current.onDirtyChange?.(false), [])
  useEffect(() => {
    setClipId(null); setSpeechId(null); setSourceId(null); setExtraAssets([]); setLocalJobs([])
    setDurations(new Map()); durationRequests.current.clear(); exactDurations.current.clear(); setIssue(''); setMode('cut'); setWork('')
  }, [detail.id])
  useEffect(() => { setClipId(null); setSpeechId(null); setIssue(''); setMode('cut'); setReviewOpen(false) }, [draft?.id])
  useEffect(() => {
    if (!activeExport) return
    const timer = window.setInterval(() => { void callbacks.current.onRefresh().catch(() => {}) }, 2000)
    return () => window.clearInterval(timer)
  }, [activeExport?.id, activeExport?.status])

  function rememberDuration(assetId: string, value: number) {
    if (Number.isFinite(value) && value > 0) setDurations(current => new Map(current).set(assetId, exactDurations.current.get(assetId) ?? Math.round(value)))
  }
  async function assetDuration(asset: Asset): Promise<number> {
    const cached = exactDurations.current.get(asset.id)
    if (cached) return cached
    const known = detail.speech?.lines.flatMap(line => line.takes).find(take => take.asset_id === asset.id)?.duration_ms
    if (known && known > 0) { exactDurations.current.set(asset.id, known); rememberDuration(asset.id, known); return known }
    const running = durationRequests.current.get(asset.id)
    if (running) return running
    const projectId = detail.id
    const request = (async () => {
      const value = (await api<{ duration_ms: number }>(`/assets/${asset.id}/metadata`)).duration_ms
      if (currentProject.current === projectId) { exactDurations.current.set(asset.id, value); rememberDuration(asset.id, value) }
      return value
    })().finally(() => durationRequests.current.delete(asset.id))
    durationRequests.current.set(asset.id, request)
    return request
  }

  function updateClip(patch: Partial<EditingCutClip>) {
    if (clip) editor.update(cut => ({ ...cut, clips: cut.clips.map(item => item.id === clip.id ? { ...item, ...patch } : item) }))
  }
  function updateSpeech(patch: Partial<EditingCutSpeech>) {
    if (speech) editor.update(cut => ({ ...cut, speech: cut.speech.map(item => item.id === speech.id ? { ...item, ...patch } : item) }))
  }
  function updateCaption(id: string, patch: Partial<EditingCutCaption>) {
    editor.update(cut => ({ ...cut, captions: cut.captions.map(item => item.id === id ? { ...item, ...patch } : item) }))
  }
  async function action(label: string, operation: () => Promise<void>) {
    if (blocked) return
    const projectId = detail.id; setWork(label); setIssue('')
    try { await operation() }
    catch (error) { if (currentProject.current === projectId) setIssue(error instanceof Error ? error.message : String(error)) }
    finally { if (currentProject.current === projectId) setWork('') }
  }
  async function addAsset(asset: Asset) {
    if (!draft) return
    const projectId = detail.id, cutId = draft.id
    await action('add', async () => {
      if (asset.kind === 'audio') {
        const length = await assetDuration(asset), id = freshId()
        if (currentProject.current !== projectId) return
        editor.update(cut => cut.id === cutId ? ({ ...cut, speech: [...cut.speech, { id, asset_id: asset.id, label: speechAssets.get(asset.id)?.text || assetName(asset.id), start_ms: 0, in_ms: 0, out_ms: length, gain: 1 }] }) : cut)
        setSpeechId(id); setPanel('speech')
      } else if (asset.kind === 'video' || asset.kind === 'image') {
        const length = asset.kind === 'image' ? 3000 : await assetDuration(asset), id = freshId()
        if (currentProject.current !== projectId) return
        editor.update(cut => cut.id === cutId ? ({ ...cut, clips: [...cut.clips, { id, asset_id: asset.id, title: assetName(asset.id), in_ms: 0, out_ms: length, source_audio_gain: 1, source_audio_fade_ms: 15 }] }) : cut)
        setClipId(id); setPanel('clip'); setMode('cut')
      }
    })
  }
  async function replaceSpeech(assetId: string | null) {
    const asset = audioAssets.find(item => item.id === assetId)
    if (!asset || !speech || asset.id === speech.asset_id) return
    const projectId = detail.id, cutId = draft?.id, targetId = speech.id
    await action('replace', async () => {
      const length = await assetDuration(asset)
      if (currentProject.current !== projectId) return
      editor.update(cut => cut.id === cutId ? ({ ...cut, speech: cut.speech.map(item => item.id === targetId ? { ...item, asset_id: asset.id, in_ms: 0, out_ms: length } : item) }) : cut)
    })
  }
  async function upload(files: File[]) {
    if (!files.length) return
    await action('upload', async () => {
      const projectId = detail.id
      for (const file of files) {
        const body = new FormData(); body.append('file', file)
        const asset = await api<Asset>(`/projects/${projectId}/assets`, { method: 'POST', body })
        if (currentProject.current !== projectId) return
        setExtraAssets(current => [asset, ...current]); setSourceId(asset.id); setMode('source')
      }
      await callbacks.current.onRefresh(); callbacks.current.onNotice(`已导入 ${files.length} 个素材，可添加到当前剪辑`)
    })
  }
  function moveClip(id: string, direction: number) {
    editor.update(cut => {
      const next = [...cut.clips], from = next.findIndex(item => item.id === id), to = from + direction
      if (from < 0 || to < 0 || to >= next.length) return cut
      ;[next[from], next[to]] = [next[to], next[from]]
      return { ...cut, clips: next }
    })
  }
  function execute(next: Pending) {
    if (next.kind === 'select') editor.select(next.id)
    else if (next.kind === 'reload') void editor.load()
    else { setCreateName(`${detail.name} · 新剪辑`); setCopyDraft(false); setCreateOpen(true) }
  }
  function request(next: Pending) {
    if (blocked || next.kind === 'select' && next.id === draft?.id) return
    if (dirty) setPending(next); else execute(next)
  }
  async function saveDraft() {
    if (inputIssues.length) { setIssue(inputIssues[0]); return null }
    const result = await editor.save()
    if (result) callbacks.current.onNotice('独立剪辑已保存')
    return result
  }
  async function exportCut() {
    if (!draft || blocked) return
    if (exportIssues.length) { setIssue(exportIssues[0]); return }
    const cut = dirty ? await saveDraft() : draft
    if (!cut) return
    await action('export', async () => {
      const job = await api<Job>(`/projects/${detail.id}/editing-cuts/${cut.id}/export`, json('POST', { revision: cut.revision }))
      setLocalJobs(current => [job, ...current]); callbacks.current.onNotice('正在导出当前独立剪辑')
      await callbacks.current.onRefresh()
    })
  }
  function captionFromSpeech() {
    if (!speech) return
    editor.update(cut => ({ ...cut, captions: [...cut.captions, { id: freshId(), start_ms: speech.start_ms,
      end_ms: speech.start_ms + speech.out_ms - speech.in_ms, text: speech.label || '新字幕' }] }))
    setPanel('captions')
  }

  return <section ref={studio} className="basic-cut-studio" aria-label="基础成片工作台">
    <header className="basic-cut-toolbar">
      <div className="basic-cut-title"><span>独立剪辑</span><Select aria-label="选择独立剪辑" placeholder={editor.loading ? '正在读取剪辑…' : '选择或新建剪辑'} value={draft?.id || null}
        data={editor.cuts.map(cut => ({ value: cut.id, label: cut.name }))} searchable allowDeselect={false} disabled={blocked || editor.loading} onChange={id => id && request({ kind: 'select', id })} /></div>
      <Button variant="default" leftSection={<Plus size={15} />} disabled={blocked || editor.loading} onClick={() => request({ kind: 'new' })}>新建剪辑</Button>
      {draft && <><Badge color={dirty ? 'yellow' : 'teal'} variant="light">{dirty ? '有未保存修改' : '已保存'}</Badge><span className="basic-cut-duration">{draft.clips.length} 个片段 · {seconds(duration)}</span>
        <Button variant="default" leftSection={<Save size={15} />} loading={busy} disabled={blocked || !dirty || !!inputIssues.length} onClick={() => void saveDraft()}>保存剪辑</Button>
        <Button leftSection={<Download size={15} />} loading={work === 'export' || !!activeExport} disabled={blocked || !!activeExport || !!exportIssues.length} onClick={() => void exportCut()}>{dirty ? '保存并导出' : '导出视频'}</Button></>}
    </header>
    {(editor.error || issue) && <div className="basic-cut-error" role="alert"><span>{issue || editor.error}</span>
      {editor.conflict ? <><Button size="compact-xs" variant="default" onClick={() => request({ kind: 'reload' })}>重新读取服务器版本</Button><Button size="compact-xs" onClick={() => { setCreateName(`${draft?.name || detail.name} · 副本`); setCopyDraft(true); setCreateOpen(true) }}>另存为新剪辑</Button></>
        : editor.error && <Button size="compact-xs" variant="subtle" onClick={() => request({ kind: 'reload' })}>重新加载</Button>}</div>}
    {editor.restored && dirty && <p className="basic-cut-help" role="status">已恢复本机未保存的剪辑草稿，请检查后保存。</p>}
    {editor.loading ? <div className="basic-cut-empty" role="status">正在读取独立剪辑…</div> : !draft ? <div className="basic-cut-empty"><Film size={32} /><h2>从素材开始剪一部新片</h2><p>导入视频或图片，排列与取段，再加入配音、配乐和字幕。</p><Button onClick={() => request({ kind: 'new' })} leftSection={<Plus size={16} />}>创建第一个剪辑</Button></div> : <>
      <div className="basic-cut-grid">
        <aside className="basic-cut-assets" aria-label="剪辑素材库">
          <div className="basic-cut-section-head"><h2>项目素材 <small>{visibleAssets.length}</small></h2><FileButton onChange={files => void upload(files)} multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4">{props => <Button {...props} size="compact-xs" variant="default" disabled={blocked} leftSection={<Upload size={14} />}>导入素材</Button>}</FileButton></div>
          <TextInput aria-label="搜索剪辑素材" placeholder="搜索素材" value={query} onChange={event => setQuery(event.currentTarget.value)} />
          <div className="basic-cut-asset-status-filters" role="group" aria-label="素材确认状态">
            {([{ value: 'all', label: '全部' }, { value: 'confirmed', label: '已确认' }, { value: 'candidate', label: '候选' }, { value: 'other', label: '其他' }] as const).map(item =>
              <UnstyledButton key={item.value} type="button" aria-label={`筛选素材状态：${item.label}`} aria-pressed={assetStatus === item.value}
                disabled={item.value !== 'all' && (assetConfirmation.loading || !!assetConfirmation.error)}
                title={item.value === 'confirmed' ? '画布当前使用、镜头或配音已选用及设定已确认的素材' : item.value === 'other' ? '导入、导出、归档及旧版素材' : undefined}
                onClick={() => setAssetStatus(item.value)}>{item.label}</UnstyledButton>)}
          </div>
          {assetConfirmation.loading && <p className="basic-cut-help" role="status">正在同步画布确认状态…</p>}
          {assetConfirmation.error && <div className="basic-cut-asset-status-error" role="alert"><span>未能读取画布确认状态</span><Button size="compact-xs" variant="subtle" onClick={assetConfirmation.retry}>重试状态同步</Button></div>}
          <Tabs value={assetFilter} onChange={setAssetFilter}><Tabs.List><Tabs.Tab value="all">全部</Tabs.Tab><Tabs.Tab value="video">视频</Tabs.Tab><Tabs.Tab value="image">图片</Tabs.Tab><Tabs.Tab value="audio">音频</Tabs.Tab></Tabs.List></Tabs>
          <div className="basic-cut-asset-list">{visibleAssets.map(asset => <div className={`basic-cut-asset${sourceId === asset.id ? ' is-selected' : ''}`} key={asset.id}>
            <UnstyledButton className="basic-cut-asset-main" aria-label={`预览素材：${assetName(asset.id)}`} onClick={() => { setSourceId(asset.id); setMode('source') }}>
              <div className="basic-cut-asset-thumb">{asset.kind === 'image' ? <img src={asset.url} alt="" loading="lazy" /> : asset.kind === 'video' ? <video src={asset.url} muted playsInline preload="metadata" onLoadedMetadata={event => rememberDuration(asset.id, event.currentTarget.duration * 1000)} /> : <Music2 size={21} />}</div>
              <div><strong>{assetName(asset.id)}</strong><div className="basic-cut-asset-meta">
                <Badge size="xs" variant="light" data-status={assetStates.get(asset.id)?.status} color={assetStates.get(asset.id)?.status === 'confirmed' ? 'teal' : assetStates.get(asset.id)?.status === 'candidate' ? 'yellow' : 'gray'}
                  leftSection={assetStates.get(asset.id)?.status === 'confirmed' ? <Check size={10} /> : undefined}>{assetStates.get(asset.id)?.status === 'candidate' && (assetConfirmation.loading || assetConfirmation.error) ? '状态待同步' : assetStates.get(asset.id)?.label}</Badge>
                <small>{asset.kind === 'video' ? '视频' : asset.kind === 'image' ? '图片' : '音频'}{durations.has(asset.id) ? ` · ${seconds(durations.get(asset.id)!)}` : ''}</small>
              </div></div>
            </UnstyledButton><ActionIcon variant="subtle" aria-label={`添加${asset.kind === 'audio' ? '配音' : '片段'}：${assetName(asset.id)}`} disabled={blocked} onClick={() => void addAsset(asset)}><Plus size={16} /></ActionIcon>
          </div>)}{!visibleAssets.length && <p className="basic-cut-help">没有匹配素材，可导入本地文件或清除筛选。</p>}</div>
        </aside>

        <div className="basic-cut-preview-column" role="region" aria-label="剪辑预览">
          <Tabs value={mode} onChange={setMode}><Tabs.List><Tabs.Tab value="cut">成片预览</Tabs.Tab><Tabs.Tab value="source" disabled={!source}>素材预览</Tabs.Tab></Tabs.List></Tabs>
          <div className="basic-cut-player">
          {mode === 'source' && source ? <div className="basic-cut-source-preview"><div className="basic-cut-source-stage">{source.kind === 'image' ? <img src={source.url} alt={assetName(source.id)} /> : <StudioMediaPlayer key={source.id} kind={source.kind === 'audio' ? 'audio' : 'video'} src={source.url} preload="metadata" onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => rememberDuration(source.id, event.currentTarget.duration * 1000)} />}</div><div className="basic-cut-section-head"><strong>{assetName(source.id)}</strong><Button size="xs" disabled={blocked} onClick={() => void addAsset(source)} leftSection={<Plus size={14} />}>{source.kind === 'audio' ? '加入配音轨道' : '添加到末尾'}</Button></div></div>
            : preview && draft.clips.length ? <TimelinePreview clips={preview.clips} shots={preview.shots} assets={assets} ratio={draft.ratio} speechAudio={preview.speechAudio}
              musicAsset={assets.find(asset => asset.id === draft.music_asset_id)} audioSettings={draft.audio_settings} captions={draft.captions} active={!reviewOpen} />
              : <div className="basic-cut-preview-empty"><Film size={36} /><strong>把第一个素材添加到时间线</strong><span>可以重复使用同一素材，并分别设置取段。</span></div>}
          </div>
          {!!exportIssues.length && <p className="basic-cut-help" role="status">{exportIssues[0]}</p>}
          {activeExport && <p className="basic-cut-export-status" role="status"><span className="status-dot" />{activeExport.status === 'queued' ? '导出任务排队中…' : '正在合成画面、声音与字幕…'}<small>完成后可在这里下载。</small></p>}
          {latestFailed && <div className="basic-cut-error" role="alert">导出失败：{latestFailed.error || '请检查素材后重新导出'}<Button size="compact-xs" variant="default" disabled={blocked || !!exportIssues.length} onClick={() => void exportCut()}>重试导出</Button></div>}
          {exportedAsset && <div className="basic-cut-download"><Check size={16} /><span>{exportIsCurrent ? '本剪辑当前成片' : latestExportRevision === null ? '导出版本未确认 · 请导出当前修改' : '较早版本成片 · 请导出当前修改'}{latestExportRevision !== null ? `（v${latestExportRevision}）` : ''}</span><Button component="a" href={exportedAsset.url} download variant="light" size="xs" leftSection={<Download size={14} />}>下载 MP4</Button></div>}
        </div>

        <aside className="basic-cut-inspector" aria-label="独立剪辑设置">
          <Tabs value={panel} onChange={setPanel}><Tabs.List grow><Tabs.Tab value="clip">片段</Tabs.Tab><Tabs.Tab value="speech">配音</Tabs.Tab><Tabs.Tab value="music">配乐</Tabs.Tab><Tabs.Tab value="captions">字幕</Tabs.Tab></Tabs.List></Tabs>
          <div className="basic-cut-inspector-content">
            {panel === 'clip' && <><TextInput label="剪辑名称" value={draft.name} disabled={blocked} onChange={event => { const name = event.currentTarget.value; editor.update(cut => ({ ...cut, name })) }} /><Select label="输出画幅" value={draft.ratio} data={['16:9', '9:16']} allowDeselect={false} disabled={blocked} onChange={value => value && editor.update(cut => ({ ...cut, ratio: value as EditingCut['ratio'] }))} />
              <p className="basic-cut-help">画幅与声音设置只用于当前剪辑。导出为 720p、24fps。</p>
              {clip ? <><div className="basic-cut-divider" /><TextInput label="片段名称" value={clip.title} disabled={blocked} onChange={event => updateClip({ title: event.currentTarget.value })} /><p className="basic-cut-help">{assetName(clip.asset_id)}{durations.has(clip.asset_id) ? ` · 原素材 ${seconds(durations.get(clip.asset_id)!)}` : ''}</p>
                <div className="basic-cut-pair"><NumberInput label="素材入点" suffix=" 秒" value={clip.in_ms / 1000} min={0} step={.1} decimalScale={3} disabled={blocked || assets.find(asset => asset.id === clip.asset_id)?.kind === 'image'} onChange={value => updateClip({ in_ms: milliseconds(value) })} /><NumberInput label={assets.find(asset => asset.id === clip.asset_id)?.kind === 'image' ? '画面停留' : '素材出点'} suffix=" 秒" value={clip.out_ms / 1000} min={.2} step={.1} decimalScale={3} disabled={blocked} onChange={value => updateClip({ out_ms: milliseconds(value) })} /></div>
                <NumberInput label="原声音量" suffix=" %" value={Math.round(clip.source_audio_gain * 100)} min={0} max={200} step={10} disabled={blocked || assets.find(asset => asset.id === clip.asset_id)?.kind === 'image'} onChange={value => updateClip({ source_audio_gain: Number(value) / 100 })} /><NumberInput label="原声首尾淡变" suffix=" 毫秒" value={clip.source_audio_fade_ms} min={0} max={500} step={10} disabled={blocked} onChange={value => updateClip({ source_audio_fade_ms: Number(value) })} />
                <Button variant="default" size="xs" disabled={blocked} onClick={() => updateClip({ source_audio_gain: clip.source_audio_gain ? 0 : 1 })}>{clip.source_audio_gain ? '静音当前片段' : '恢复当前原声'}</Button></>
                : <p className="basic-cut-help">添加画面后，可在这里调整取段和原声。</p>}</>}
            {panel === 'speech' && <><div className="basic-cut-section-head"><h3>独立配音轨道</h3><Button variant="subtle" size="compact-xs" onClick={() => onOpenSpeech()} leftSection={<Mic2 size={14} />}>制作配音</Button></div><p className="basic-cut-help">选择已有音频，或制作新候选后返回刷新。替换只作用于当前剪辑。</p><Button variant="default" size="xs" disabled={blocked} onClick={() => void action('refresh', async () => { await onRefresh() })}>刷新音频素材</Button>
              <Select label="添加音频素材" placeholder="选择旁白或对白" searchable clearable value={audioChoice} data={audioAssets.map(asset => ({ value: asset.id, label: assetName(asset.id) }))} disabled={blocked} onChange={setAudioChoice} /><Button size="xs" disabled={blocked || !audioChoice} onClick={() => { const asset = audioAssets.find(item => item.id === audioChoice); if (asset) void addAsset(asset) }} leftSection={<Plus size={14} />}>添加配音</Button>
              {!!draft.speech.length && <><div className="basic-cut-divider" /><Select label="编辑配音片段" value={speech?.id || null} data={draft.speech.map((item, i) => ({ value: item.id, label: `${i + 1}. ${item.label || assetName(item.asset_id)}` }))} allowDeselect={false} onChange={setSpeechId} />{speech && <><Select label="替换配音素材" value={speech.asset_id} searchable data={audioAssets.map(asset => ({ value: asset.id, label: assetName(asset.id) }))} allowDeselect={false} disabled={blocked} onChange={id => void replaceSpeech(id)} /><StudioMediaPlayer key={speech.asset_id} kind="audio" src={assets.find(asset => asset.id === speech.asset_id)?.url} preload="metadata" onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement & HTMLAudioElement>) => rememberDuration(speech.asset_id, event.currentTarget.duration * 1000)} /><Textarea label="配音标注／字幕正文" minRows={2} autosize value={speech.label} disabled={blocked} onChange={event => updateSpeech({ label: event.currentTarget.value })} /><NumberInput label="成片开始位置" suffix=" 秒" value={speech.start_ms / 1000} min={0} step={.1} decimalScale={3} disabled={blocked} onChange={value => updateSpeech({ start_ms: milliseconds(value) })} /><div className="basic-cut-pair"><NumberInput label="音频入点" suffix=" 秒" value={speech.in_ms / 1000} min={0} step={.1} decimalScale={3} disabled={blocked} onChange={value => updateSpeech({ in_ms: milliseconds(value) })} /><NumberInput label="音频出点" suffix=" 秒" value={speech.out_ms / 1000} min={.001} step={.1} decimalScale={3} disabled={blocked} onChange={value => updateSpeech({ out_ms: milliseconds(value) })} /></div><NumberInput label="配音音量" suffix=" %" value={Math.round(speech.gain * 100)} min={0} max={200} step={10} disabled={blocked} onChange={value => updateSpeech({ gain: Number(value) / 100 })} /><Button variant="default" size="xs" disabled={blocked} onClick={captionFromSpeech} leftSection={<Captions size={14} />}>用此配音创建字幕</Button><Button color="red" variant="subtle" size="xs" disabled={blocked} onClick={() => editor.update(cut => ({ ...cut, speech: cut.speech.filter(item => item.id !== speech.id) }))} leftSection={<Trash2 size={14} />}>移除此配音</Button></>}</>}
            </>}
            {panel === 'music' && <><h3>背景配乐</h3><Select label="配乐素材" placeholder="不使用配乐" searchable clearable value={draft.music_asset_id} disabled={blocked} data={audioAssets.map(asset => ({ value: asset.id, label: assetName(asset.id) }))} onChange={id => editor.update(cut => ({ ...cut, music_asset_id: id }))} />{draft.music_asset_id && <StudioMediaPlayer key={draft.music_asset_id} kind="audio" src={assets.find(asset => asset.id === draft.music_asset_id)?.url} preload="metadata" />}<p className="basic-cut-help">配乐从成片起点播放并循环至结尾。</p><NumberInput label="配乐音量" suffix=" %" value={Math.round(draft.audio_settings.music_gain * 100)} min={0} max={100} step={5} disabled={blocked} onChange={value => editor.update(cut => ({ ...cut, audio_settings: { ...cut.audio_settings, music_gain: Number(value) / 100 } }))} /><Checkbox label="配音时降低配乐" checked={draft.audio_settings.duck_music} disabled={blocked} onChange={event => { const checked = event.currentTarget.checked; editor.update(cut => ({ ...cut, audio_settings: { ...cut.audio_settings, duck_music: checked } })) }} /><Checkbox label="配音时降低视频原声" checked={draft.audio_settings.duck_source} disabled={blocked} onChange={event => { const checked = event.currentTarget.checked; editor.update(cut => ({ ...cut, audio_settings: { ...cut.audio_settings, duck_source: checked } })) }} /></>}
            {panel === 'captions' && <><div className="basic-cut-section-head"><h3>字幕</h3><Button size="compact-xs" variant="default" disabled={blocked} leftSection={<Plus size={14} />} onClick={() => editor.update(cut => ({ ...cut, captions: [...cut.captions, { id: freshId(), start_ms: 0, end_ms: Math.min(3000, duration) || 3000, text: '新字幕' }] }))}>添加字幕</Button></div><p className="basic-cut-help">白字黑描边，底部安全区。字幕随当前剪辑保存，并写入导出画面。</p>
              {draft.captions.map((caption, i) => <div className="basic-cut-caption" key={caption.id}><div className="basic-cut-section-head"><strong>字幕 {i + 1}</strong><ActionIcon aria-label={`删除字幕 ${i + 1}`} color="red" variant="subtle" disabled={blocked} onClick={() => editor.update(cut => ({ ...cut, captions: cut.captions.filter(item => item.id !== caption.id) }))}><Trash2 size={14} /></ActionIcon></div><Textarea label={`字幕 ${i + 1} 正文`} value={caption.text} minRows={2} autosize disabled={blocked} onChange={event => updateCaption(caption.id, { text: event.currentTarget.value })} /><div className="basic-cut-pair"><NumberInput label={`字幕 ${i + 1} 开始`} suffix=" 秒" value={caption.start_ms / 1000} min={0} step={.1} decimalScale={3} disabled={blocked} onChange={value => updateCaption(caption.id, { start_ms: milliseconds(value) })} /><NumberInput label={`字幕 ${i + 1} 结束`} suffix=" 秒" value={caption.end_ms / 1000} min={.001} step={.1} decimalScale={3} disabled={blocked} onChange={value => updateCaption(caption.id, { end_ms: milliseconds(value) })} /></div></div>)}
              {!draft.captions.length && <p className="basic-cut-help">可逐句添加字幕，或从配音标注生成。</p>}
              <div className="basic-cut-divider" /><Textarea label="批量字幕文本" description="每行一句，依次各停留 3 秒；添加后可修改时间" value={importText} onChange={event => setImportText(event.currentTarget.value)} minRows={3} disabled={blocked} /><Button variant="default" size="xs" disabled={blocked || !importText.trim()} onClick={() => { const texts = importText.split('\n').map(text => text.trim()).filter(Boolean); const start = draft.captions.reduce((max, item) => Math.max(max, item.end_ms), 0); editor.update(cut => ({ ...cut, captions: [...cut.captions, ...texts.map((text, i) => ({ id: freshId(), start_ms: start + i * 3000, end_ms: start + (i + 1) * 3000, text }))] })); setImportText('') }}>添加多句字幕</Button>
            </>}
          </div>
        </aside>
      </div>

      <section className="basic-cut-timeline" aria-label="独立剪辑时间线"><div className="basic-cut-section-head"><h2>入片顺序 <small>{seconds(duration)}</small></h2><BasicCutReviewPanel key={draft.id} cut={draft} assets={assets} durations={durations} disabled={blocked || !!inputIssues.length} onOpenChange={opened => {
            if (opened) studio.current?.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => media.pause())
            setReviewOpen(opened)
          }}
          onApply={(fromId, toId, fromOut, toIn, signature) => editor.update(current => {
            const index = current.clips.findIndex(item => item.id === fromId)
            if (index < 0 || current.clips[index + 1]?.id !== toId || basicCutReviewSignature(current, fromId, toId, assets) !== signature) return current
            return { ...current, clips: current.clips.map((item, i) => i === index ? { ...item, out_ms: fromOut } : i === index + 1 ? { ...item, in_ms: toIn } : item) }
          })} /><span className="basic-cut-help">选择片段调整取段，用箭头改变顺序</span></div>
        <div className="basic-cut-clip-strip">{draft.clips.map((item, i) => { const asset = assets.find(asset => asset.id === item.asset_id); return <div key={item.id} className={`basic-cut-clip${item.id === clip?.id ? ' is-selected' : ''}`}>
          <UnstyledButton className="basic-cut-clip-select" aria-label={`编辑片段 ${i + 1}：${item.title}`} onClick={() => { setClipId(item.id); setPanel('clip'); setMode('cut') }}><div className="basic-cut-clip-thumb">{asset?.kind === 'image' ? <img src={asset.url} alt="" /> : asset?.kind === 'video' ? <video src={asset.url} muted playsInline preload="metadata" /> : <ImageIcon size={20} />}</div><strong>{String(i + 1).padStart(2, '0')} · {item.title}</strong><small>{seconds(item.out_ms - item.in_ms)}</small></UnstyledButton>
          <div className="basic-cut-clip-actions"><ActionIcon variant="subtle" aria-label={`前移片段 ${i + 1}`} disabled={blocked || i === 0} onClick={() => moveClip(item.id, -1)}><ArrowUp size={14} /></ActionIcon><ActionIcon variant="subtle" aria-label={`后移片段 ${i + 1}`} disabled={blocked || i === draft.clips.length - 1} onClick={() => moveClip(item.id, 1)}><ArrowDown size={14} /></ActionIcon><ActionIcon variant="subtle" aria-label={`复制片段 ${i + 1}`} disabled={blocked} onClick={() => { const id = freshId(); editor.update(cut => ({ ...cut, clips: cut.clips.flatMap(part => part.id === item.id ? [part, { ...part, id }] : [part]) })); setClipId(id); setPanel('clip') }}><Copy size={14} /></ActionIcon><ActionIcon variant="subtle" color="red" aria-label={`移除片段 ${i + 1}`} disabled={blocked} onClick={() => editor.update(cut => ({ ...cut, clips: cut.clips.filter(part => part.id !== item.id) }))}><Trash2 size={14} /></ActionIcon></div>
        </div> })}{!draft.clips.length && <p className="basic-cut-help">画面轨道为空，从左侧素材库点击「＋」开始。</p>}</div>
        <div className="basic-cut-audio-summary">{draft.speech.map((item, i) => <UnstyledButton key={item.id} onClick={() => { setSpeechId(item.id); setPanel('speech') }} className="basic-cut-audio-pill"><Mic2 size={13} /><span>{item.label || `配音 ${i + 1}`}</span><small>{seconds(item.start_ms)}–{seconds(item.start_ms + item.out_ms - item.in_ms)}</small></UnstyledButton>)}{draft.music_asset_id && <span className="basic-cut-music-pill"><Music2 size={13} />{assetName(draft.music_asset_id)}</span>}{!!draft.captions.length && <UnstyledButton className="basic-cut-audio-pill" onClick={() => setPanel('captions')}><Captions size={13} />{draft.captions.length} 句字幕</UnstyledButton>}</div>
      </section>
    </>}

    <Modal opened={!!pending} onClose={() => !blocked && setPending(null)} title="当前剪辑有未保存修改" centered closeOnClickOutside={false}>
      <p className="basic-cut-help">先保存再继续，或放弃本次修改。已有素材不会被删除。</p><div className="basic-cut-dialog-actions"><Button variant="default" disabled={blocked} onClick={() => setPending(null)}>继续编辑</Button><Button variant="subtle" color="red" disabled={blocked} onClick={() => { if (!pending) return; const next = pending; editor.discard(); setPending(null); execute(next) }}>放弃修改并继续</Button><Button loading={busy} disabled={blocked || !!inputIssues.length || editor.conflict} onClick={() => void (async () => { if (!pending) return; const next = pending; if (await saveDraft()) { setPending(null); execute(next) } })()}>保存后继续</Button></div>
    </Modal>
    <Modal opened={createOpen} onClose={() => !busy && setCreateOpen(false)} title={copyDraft ? '另存为独立剪辑' : '新建独立剪辑'} centered>
      <TextInput label="新剪辑名称" value={createName} autoFocus disabled={busy} onChange={event => setCreateName(event.currentTarget.value)} /><p className="basic-cut-help">{copyDraft ? '复制当前草稿的编排和声音，不改写原剪辑。' : '从空时间线开始，使用项目素材自由编排。'}</p><div className="basic-cut-dialog-actions"><Button variant="default" disabled={busy} onClick={() => setCreateOpen(false)}>取消</Button><Button loading={busy} disabled={busy || !createName.trim()} onClick={() => void (async () => { if (await editor.create(createName.trim(), draft?.ratio || detail.ratio, copyDraft)) setCreateOpen(false) })()}>创建剪辑</Button></div>
    </Modal>
  </section>
}
