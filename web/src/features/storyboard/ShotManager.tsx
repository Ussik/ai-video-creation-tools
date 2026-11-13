import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Badge, Button, Checkbox, Loader, Modal, NumberInput, Select, Table, Tabs, Textarea, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, Clapperboard, Copy, ImageIcon, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import { api, json, type ProjectDetail, type Shot } from '../../shared/api/api'
import { useAppDialog } from '../../shared/ui/AppDialog'
import type { ShotManagementSnapshot as Snapshot, ShotManagementActionInput } from '@video-studio/shared/storyboard/shot-management'
import './shot-manager.css'

type Patch = Required<NonNullable<ShotManagementActionInput['patch']>>
type Action = Omit<ShotManagementActionInput, 'revision'>
export type ShotManagerProps = {
  opened: boolean
  onClose: () => void
  detail: ProjectDetail
  activeCanvasId?: string | null
  onRefresh: () => Promise<unknown>
  onAddToCanvas: (shotIds: string[], canvasId: string) => Promise<void>
  onNotice?: (message: string) => void
  onPlan?: (sceneIds?: string[]) => void
  onPlanClip?: () => void
  initialSceneIds?: string[]
  initialDesignId?: string | null
}
const allDesigns = '__all__', baseDesign = '__base__', allScenes = '__all__', noScene = '__none__'
const patchOf = (shot: Shot): Patch => ({ title: shot.title, duration: shot.duration, prompt: shot.prompt, image_prompt: shot.image_prompt || '', video_prompt: shot.video_prompt || '', start_state: shot.start_state || '', end_state: shot.end_state || '', cut_note: shot.cut_note || '' })
const errorText = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
const sceneLabel = (scene: Snapshot['scenes'][number]) => `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}`

function ShotManagerContent({ opened, onClose, detail, activeCanvasId, onRefresh, onAddToCanvas, onNotice, onPlan, onPlanClip, initialSceneIds, initialDesignId }: ShotManagerProps) {
  const initialScopeKey = JSON.stringify([initialDesignId, initialSceneIds || []])
  const appliedScope = useRef(initialScopeKey)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false), [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState(''), [conflict, setConflict] = useState(false)
  const [tab, setTab] = useState('shots'), [designId, setDesignId] = useState(allDesigns), [sceneId, setSceneId] = useState(allScenes), [query, setQuery] = useState('')
  const [showEmptyScenes, setShowEmptyScenes] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null), [draft, setDraft] = useState<Patch | null>(null)
  const [checkedIds, setCheckedIds] = useState<string[]>([]), [targetCanvasId, setTargetCanvasId] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false), [guarding, setGuarding] = useState(false)
  const [choosingPlanSource, setChoosingPlanSource] = useState(false)
  const live = useRef({ projectId: detail.id, opened }); live.current = { projectId: detail.id, opened }
  const lifecycle = useRef(0), generation = useRef(0), locked = useRef(false), guardLock = useRef(false)
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot
  const dialog = useAppDialog({ zIndex: 350 })
  const selected = snapshot?.shots.find(entry => entry.shot.id === selectedId) || null
  const selectedClip = snapshot?.designs.find(design => design.id === selected?.shot.design_id && design.source_type === 'clip')
  const original = selected ? patchOf(selected.shot) : null
  const dirty = !!draft && !!original && JSON.stringify(draft) !== JSON.stringify(original)
  const generationDirty = !!draft && !!original && (['prompt', 'image_prompt', 'video_prompt', 'duration', 'start_state', 'end_state'] as const)
    .some(key => draft[key] !== original[key])
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const blocked = loading || pending !== null || guarding
  const visible = useMemo(() => (snapshot?.shots || []).filter(entry => {
    if (!!entry.deleted_at !== (tab === 'trash')) return false
    if (designId !== allDesigns && (entry.shot.design_id || baseDesign) !== designId) return false
    if (sceneId !== allScenes && (entry.shot.source_scene_id || noScene) !== sceneId) return false
    const search = query.trim().toLocaleLowerCase()
    return !search || [entry.shot.title, entry.shot.prompt, entry.shot.image_prompt, entry.shot.video_prompt, entry.design_name, ...entry.canvas_refs.map(canvas => canvas.name)].join('\n').toLocaleLowerCase().includes(search)
  }), [snapshot, tab, designId, sceneId, query])
  const visibleIds = visible.map(entry => entry.shot.id)
  const activeEntries = snapshot?.shots.filter(entry => !entry.deleted_at) || []
  const trashedEntries = snapshot?.shots.filter(entry => entry.deleted_at) || []
  const scopedEntries = useMemo(() => (snapshot?.shots || []).filter(entry => !!entry.deleted_at === (tab === 'trash')
    && (designId === allDesigns || (entry.shot.design_id || baseDesign) === designId)), [snapshot, tab, designId])
  const sceneSummaries = useMemo(() => [{ id: allScenes, label: '全部场次', entries: scopedEntries }, ...(snapshot?.scenes || []).map(scene => ({
    id: scene.id, label: sceneLabel(scene), entries: scopedEntries.filter(entry => entry.shot.source_scene_id === scene.id),
  })).filter(scene => showEmptyScenes || scene.entries.length > 0), ...(scopedEntries.some(entry => !entry.shot.source_scene_id) ? [{ id: noScene, label: '未关联场次', entries: scopedEntries.filter(entry => !entry.shot.source_scene_id) }] : [])], [snapshot, scopedEntries, showEmptyScenes])
  const designOptions = useMemo(() => {
    const options = new Map<string, string>()
    const entries = (snapshot?.shots || []).filter(entry => !!entry.deleted_at === (tab === 'trash'))
    const availableIds = new Set(entries.map(entry => entry.shot.design_id || baseDesign))
    for (const design of snapshot?.designs || []) if (availableIds.has(design.id)) options.set(design.id, design.name || '基础方案')
    for (const entry of entries) if (!options.has(entry.shot.design_id || baseDesign)) options.set(entry.shot.design_id || baseDesign, entry.design_name || '基础方案')
    return [{ value: allDesigns, label: '全部方案' }, ...[...options].map(([value, label]) => ({ value, label }))]
  }, [snapshot, tab])
  const siblings = selected ? activeEntries.filter(entry => (entry.shot.design_id || null) === (selected.shot.design_id || null) && entry.shot.source_scene_id === selected.shot.source_scene_id).sort((a, b) => a.shot.position - b.shot.position) : []
  const siblingIndex = siblings.findIndex(entry => entry.shot.id === selectedId)
  const isCurrent = (projectId: string, sequence: number) => live.current.opened && live.current.projectId === projectId && generation.current === sequence

  function install(next: Snapshot, preferredId: string | null = selectedRef.current) {
    setSnapshot(next); snapshotRef.current = next
    const entry = next.shots.find(item => item.shot.id === preferredId)
    setSelectedId(entry?.shot.id || null); setDraft(entry ? patchOf(entry.shot) : null)
    if (!entry) setShowDetail(false)
    setCheckedIds(current => current.filter(id => next.shots.some(item => item.shot.id === id && !!item.deleted_at === (tab === 'trash'))))
  }
  async function load(initial = false) {
    const projectId = detail.id, sequence = ++generation.current
    setLoading(true); setError(''); setConflict(false)
    try {
      const next = await api<Snapshot>(`/projects/${projectId}/shot-management`)
      if (!isCurrent(projectId, sequence)) return false
      install(next, initial ? null : selectedRef.current)
      if (initial) {
        const currentCanvas = next.canvases.find(canvas => canvas.id === activeCanvasId)
        const currentDesign = next.designs.find(design => design.canvas_id === activeCanvasId)
        setDesignId(initialDesignId !== undefined ? initialDesignId || baseDesign : currentDesign?.id || (currentCanvas ? baseDesign : allDesigns))
        setSceneId(initialSceneIds?.length === 1 ? initialSceneIds[0] : allScenes)
        setShowEmptyScenes(!!initialSceneIds?.length)
        setTargetCanvasId(currentCanvas?.id || next.canvases[0]?.id || null)
      }
      return true
    } catch (issue) { if (isCurrent(projectId, sequence)) setError(errorText(issue)); return false }
    finally { if (isCurrent(projectId, sequence)) setLoading(false) }
  }
  useEffect(() => {
    lifecycle.current += 1; generation.current += 1; locked.current = false; guardLock.current = false
    setSnapshot(null); setSelectedId(null); setDraft(null); setCheckedIds([]); setTargetCanvasId(null)
    setTab('shots'); setDesignId(allDesigns); setSceneId(allScenes); setShowEmptyScenes(false); setQuery(''); setShowDetail(false); setPending(null); setGuarding(false); setError(''); setConflict(false)
    appliedScope.current = initialScopeKey
    if (opened) void load(true)
    return () => { lifecycle.current += 1; generation.current += 1 }
  }, [detail.id, opened])
  useEffect(() => {
    if (!opened) return
    function guardUnload(event: BeforeUnloadEvent) { if (dirtyRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guardUnload)
    return () => window.removeEventListener('beforeunload', guardUnload)
  }, [opened])
  useEffect(() => {
    if (!snapshot || dirty || pending || visible.some(entry => entry.shot.id === selectedId)) return
    const entry = visible[0]
    setSelectedId(entry?.shot.id || null); setDraft(entry ? patchOf(entry.shot) : null)
  }, [snapshot, visible, selectedId, dirty, pending])

  useEffect(() => {
    if (designId !== allDesigns && !designOptions.some(option => option.value === designId)) {
      setDesignId(allDesigns); setCheckedIds([]); setSelectedId(null); setDraft(null); setShowDetail(false)
    }
  }, [designId, designOptions])

  useEffect(() => {
    if (!snapshot || blocked || dirty || sceneSummaries.some(scene => scene.id === sceneId)) return
    setSceneId(allScenes); setCheckedIds([]); setSelectedId(null); setDraft(null); setShowDetail(false)
  }, [snapshot, blocked, dirty, sceneSummaries, sceneId])

  useEffect(() => {
    if (!opened || !snapshot || dirty || blocked || appliedScope.current === initialScopeKey) return
    appliedScope.current = initialScopeKey
    const epoch = lifecycle.current
    void load().then(accepted => {
      if (!accepted || lifecycle.current !== epoch || !live.current.opened || live.current.projectId !== detail.id) return
      if (initialDesignId !== undefined) setDesignId(initialDesignId || baseDesign)
      setSceneId(initialSceneIds?.length === 1 ? initialSceneIds[0] : allScenes)
      setShowEmptyScenes(!!initialSceneIds?.length)
      setSelectedId(null); setDraft(null); setCheckedIds([]); setShowDetail(false)
    })
  }, [initialScopeKey, opened, snapshot, dirty, blocked])

  async function guard(change: () => void | Promise<unknown>) {
    if (locked.current || guardLock.current) return
    const projectId = detail.id, sequence = generation.current, epoch = lifecycle.current
    guardLock.current = true; setGuarding(true)
    try {
      if (dirtyRef.current && !await dialog.confirm({ title: '放弃未保存的镜头修改？', message: '当前镜头有未保存修改。继续后将读取已保存的内容。', confirmLabel: '放弃修改', cancelLabel: '继续编辑' })) return
      if (!isCurrent(projectId, sequence)) return
      await change()
    } finally { if (lifecycle.current === epoch) { guardLock.current = false; if (live.current.projectId === projectId && live.current.opened) setGuarding(false) } }
  }
  function choose(id: string) {
    void guard(() => {
      const entry = snapshotRef.current?.shots.find(item => item.shot.id === id)
      setSelectedId(id); setDraft(entry ? patchOf(entry.shot) : null); setShowDetail(true); setError('')
    })
  }
  function filter(change: () => void) {
    void guard(() => { change(); setSelectedId(null); setDraft(null); setShowDetail(false); setCheckedIds([]); setError('') })
  }
  async function act(input: Action, notice: string): Promise<boolean> {
    const current = snapshotRef.current
    if (!current || locked.current || guardLock.current) return false
    const projectId = detail.id, sequence = generation.current
    locked.current = true; setPending(input.action); setError(''); setConflict(false)
    try {
      const next = await api<Snapshot>(`/projects/${projectId}/shot-management/actions`, json('POST', { ...input, revision: current.revision }))
      if (!isCurrent(projectId, sequence)) return false
      const duplicate = input.action === 'duplicate' ? next.shots.find(entry => !current.shots.some(old => old.shot.id === entry.shot.id)) : null
      const recycled = input.action === 'trash' || input.action === 'trash_many' || input.action === 'trash_design'
      install(next, duplicate?.shot.id || (recycled ? null : selectedRef.current))
      await onRefresh()
      if (isCurrent(projectId, sequence)) onNotice?.(notice)
      return isCurrent(projectId, sequence)
    } catch (issue) {
      if (isCurrent(projectId, sequence)) { setError(errorText(issue)); setConflict((issue as Error & { status?: number }).status === 409) }
      return false
    } finally { if (isCurrent(projectId, sequence)) { locked.current = false; setPending(null) } }
  }
  async function confirmAction(input: Action, options: Parameters<typeof dialog.confirm>[0], notice: string) {
    if (!snapshotRef.current || loading || locked.current || guardLock.current) return
    const projectId = detail.id, sequence = generation.current, epoch = lifecycle.current
    guardLock.current = true; setGuarding(true)
    try {
      const confirmed = await dialog.confirm(options)
      if (!confirmed || lifecycle.current !== epoch || !isCurrent(projectId, sequence)) return
      guardLock.current = false; setGuarding(false)
      await act(input, notice)
    } finally {
      if (lifecycle.current === epoch) {
        guardLock.current = false
        if (live.current.opened && live.current.projectId === projectId) setGuarding(false)
      }
    }
  }
  async function purgeShot() {
    if (!selected?.deleted_at || selected.purge_blockers?.length) return
    await confirmAction({ action: 'purge', shot_id: selected.shot.id }, {
      title: `彻底删除「${selected.shot.title}」？`, message: '删除后不可恢复；关联素材与生成记录保留。',
      confirmLabel: '彻底删除', cancelLabel: '取消', danger: true,
    }, '镜头已彻底删除')
  }
  async function purgeSelected() {
    const entries = trashedEntries.filter(entry => checkedIds.includes(entry.shot.id))
    if (!entries.length || entries.some(entry => entry.purge_blockers?.length)) return
    await confirmAction({ action: 'purge_many', shot_ids: entries.map(entry => entry.shot.id) }, {
      title: `彻底删除选中的 ${entries.length} 个镜头？`, message: '删除后不可恢复；关联素材与生成记录保留。',
      confirmLabel: '彻底删除', cancelLabel: '取消', danger: true,
    }, `已彻底删除 ${entries.length} 个镜头`)
  }
  async function purgeAsset(asset: Snapshot['trashed_assets'][number]) {
    if (asset.purge_blockers?.length) return
    await confirmAction({ action: 'purge_asset', asset_id: asset.id }, {
      title: `彻底删除「${asset.filename}」？`, message: '删除后不可恢复。移除素材记录，保留本地文件及生成记录。',
      confirmLabel: '彻底删除', cancelLabel: '取消', danger: true,
    }, '素材记录已彻底删除')
  }
  async function emptyTrash() {
    const current = snapshotRef.current
    if (!current) return
    const shots = current.shots.filter(entry => entry.deleted_at), assets = current.trashed_assets
    const blockers = current.empty_trash_blockers ?? [...shots.flatMap(entry => entry.purge_blockers || []), ...assets.flatMap(asset => asset.purge_blockers || [])]
    if ((!shots.length && !assets.length) || blockers.length) return
    await confirmAction({ action: 'empty_trash' }, {
      title: '清空整个项目的回收站？',
      message: `将彻底删除 ${shots.length} 个镜头和 ${assets.length} 个素材，不受当前方案、场次或搜索筛选影响。删除后不可恢复；保留本地文件、未回收的关联素材与生成记录。`,
      confirmLabel: '清空回收站', cancelLabel: '取消', danger: true,
    }, '回收站已清空')
  }
  async function recycle() {
    if (!selected || selected.delete_blockers.length || locked.current || guardLock.current) return
    const projectId = detail.id, sequence = generation.current
    guardLock.current = true; setGuarding(true)
    const confirmed = await dialog.confirm({ title: '将镜头移入回收站？', message: `「${selected.shot.title}」将从分镜列表中收起，可在回收站恢复。${dirty ? '当前未保存修改将被放弃。' : ''}`, confirmLabel: '移入回收站', cancelLabel: '取消', danger: true })
    guardLock.current = false
    if (!isCurrent(projectId, sequence)) return
    setGuarding(false)
    if (confirmed) await act({ action: 'trash', shot_id: selected.shot.id }, '镜头已移入回收站')
  }
  async function recycleSelected() {
    const entries = activeEntries.filter(entry => checkedIds.includes(entry.shot.id))
    if (!entries.length || entries.some(entry => entry.delete_blockers.length) || dirty || locked.current || guardLock.current) return
    const ids = entries.map(entry => entry.shot.id)
    const confirmed = await dialog.confirm({ title: `将 ${ids.length} 个镜头移入回收站？`,
      message: '这些镜头可在回收站恢复。素材、生成任务和方案记录会保留。', confirmLabel: '移入回收站', cancelLabel: '取消', danger: true })
    if (confirmed) await act({ action: 'trash_many', shot_ids: ids }, `已将 ${ids.length} 个镜头移入回收站`)
  }
  async function recycleOrRestoreDesign() {
    if (designId === allDesigns || dirty || locked.current || guardLock.current) return
    const isTrash = tab === 'trash'
    const entries = (isTrash ? trashedEntries : activeEntries).filter(entry => (entry.shot.design_id || baseDesign) === designId)
    if (!entries.length || !isTrash && entries.some(entry => entry.delete_blockers.length)) return
    const planName = designOptions.find(option => option.value === designId)?.label || '分镜方案'
    const action: Action = { action: isTrash ? 'restore_design' : 'trash_design', design_id: designId === baseDesign ? null : designId }
    const confirmed = await dialog.confirm({
      title: isTrash ? `恢复「${planName}」的 ${entries.length} 个镜头？` : `将「${planName}」的 ${entries.length} 个镜头移入回收站？`,
      message: isTrash ? '该方案中的已回收镜头会一并恢复，其他方案不受影响。' : '此操作可在回收站撤销。素材、生成任务、画布节点和方案记录会保留。',
      confirmLabel: isTrash ? '恢复方案' : '移入回收站', cancelLabel: '取消', danger: !isTrash,
    })
    if (!confirmed) return
    const succeeded = await act(action, isTrash ? `已恢复「${planName}」` : `已将「${planName}」移入回收站`)
    if (!succeeded) return
    setCheckedIds([]); setSelectedId(null); setDraft(null); setShowDetail(false)
    if (isTrash) setTab('shots')
  }
  async function addToCanvas() {
    if (!checkedIds.length || (!singlePendingDesign && !singleClipDesign && !targetCanvasId) || mixedPendingDesigns || mixedClipDesigns || locked.current || guardLock.current || dirtyRef.current) return
    const projectId = detail.id, sequence = generation.current, ids = [...checkedIds], canvasId = singleClipDesign ? singleClipDesign.canvas_id || '' : singlePendingDesign ? '' : targetCanvasId!
    locked.current = true; setPending('add'); setError('')
    try {
      await onAddToCanvas(ids, canvasId)
      if (!isCurrent(projectId, sequence)) return
      const next = await api<Snapshot>(`/projects/${projectId}/shot-management`)
      if (!isCurrent(projectId, sequence)) return
      install(next); setCheckedIds([]); await onRefresh()
      if (isCurrent(projectId, sequence)) onNotice?.(`已将 ${ids.length} 个镜头加入画布`)
    } catch (issue) { if (isCurrent(projectId, sequence) && (issue as Error)?.name !== 'AbortError') setError(errorText(issue)) }
    finally { if (isCurrent(projectId, sequence)) { locked.current = false; setPending(null) } }
  }
  const updateDraft = (patch: Partial<Patch>) => setDraft(current => current ? { ...current, ...patch } : current)
  const validDraft = !!draft && !!draft.title.trim() && Number.isFinite(draft.duration) && draft.duration >= 1 && draft.duration <= 30
  const assets = snapshot?.trashed_assets.filter(asset => !query.trim() || asset.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || []

  const shotImages = new Map<string, (typeof detail.assets)[number]>()
  const images = (detail.assets || []).filter(asset => asset.kind === 'image' && !asset.deleted_at)
  const imagesById = new Map(images.map(asset => [asset.id, asset]))
  for (const asset of [...images].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (asset.shot_id) shotImages.set(asset.shot_id, asset)
  }
  for (const entry of snapshot?.shots || []) {
    const selectedImage = imagesById.get(entry.shot.selected_asset_id || '')
    if (selectedImage) shotImages.set(entry.shot.id, selectedImage)
  }
  const checkedEntries = activeEntries.filter(entry => checkedIds.includes(entry.shot.id))
  const checkedRecycleBlockers = checkedEntries.flatMap(entry => entry.delete_blockers.map(reason => `${entry.shot.title}：${reason}`))
  const checkedPurgeBlockers = trashedEntries.filter(entry => checkedIds.includes(entry.shot.id)).flatMap(entry => (entry.purge_blockers || []).map(reason => `${entry.shot.title}：${reason}`))
  const trashPurgeBlockers = snapshot?.empty_trash_blockers ?? [...trashedEntries.flatMap(entry => (entry.purge_blockers || []).map(reason => `${entry.shot.title}：${reason}`)),
    ...(snapshot?.trashed_assets || []).flatMap(asset => (asset.purge_blockers || []).map(reason => `${asset.filename}：${reason}`))]
  const planEntries = (tab === 'trash' ? trashedEntries : activeEntries)
    .filter(entry => designId !== allDesigns && (entry.shot.design_id || baseDesign) === designId)
  const planRecycleBlockers = tab === 'trash' ? []
    : planEntries.flatMap(entry => entry.delete_blockers.map(reason => `${entry.shot.title}：${reason}`))
  const pendingEntries = checkedEntries.filter(entry => (snapshot?.designs.find(design => design.id === entry.shot.design_id) as (Snapshot['designs'][number] & { canvas_pending?: boolean }) | undefined)?.canvas_pending)
  const singlePendingDesign = pendingEntries.length > 0 && pendingEntries.length === checkedEntries.length
    && new Set(pendingEntries.map(entry => entry.shot.design_id)).size === 1
  const mixedPendingDesigns = pendingEntries.length > 0 && !singlePendingDesign
  const clipEntries = checkedEntries.filter(entry => snapshot?.designs.some(design => design.id === entry.shot.design_id && design.source_type === 'clip'))
  const singleClipDesign = clipEntries.length === checkedEntries.length && clipEntries.length > 0
    && new Set(clipEntries.map(entry => entry.shot.design_id)).size === 1
    ? snapshot?.designs.find(design => design.id === clipEntries[0].shot.design_id) : undefined
  const mixedClipDesigns = clipEntries.length > 0 && !singleClipDesign
  function planScenes() {
    const ids = sceneId !== allScenes && sceneId !== noScene ? [sceneId] : initialSceneIds
    onPlan?.(ids?.length ? ids : undefined)
  }
  function plan() {
    if (!onPlan && !onPlanClip) return
    void guard(() => {
      setDraft(original)
      if (onPlanClip && onPlan && snapshot?.scenes.length) setChoosingPlanSource(true)
      else if (onPlanClip) onPlanClip()
      else planScenes()
    })
  }

  return <><Modal opened={opened} onClose={() => void guard(onClose)} fullScreen withCloseButton={false} title={null} aria-label="项目分镜管理"
    closeOnClickOutside={false} closeOnEscape={!blocked}
    classNames={{ content: 'shot-manager-modal', body: 'shot-manager-body' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <section className={`shot-manager ${showDetail ? 'is-detail' : ''}`} aria-label="项目分镜管理内容" data-canvas-overlay onKeyDown={event => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation() }}>
      <header className="shot-manager-toolbar">
        <div className="shot-manager-heading">
          <Button variant="subtle" leftSection={<ArrowLeft size={16} />} aria-label="关闭分镜管理" disabled={blocked} onClick={() => void guard(onClose)}>返回画布</Button>
          <div className="shot-manager-title"><h1>分镜管理</h1><p>{detail.name}</p></div>
          <div className="shot-manager-heading-actions"><Tooltip label="重新读取分镜"><ActionIcon variant="subtle" aria-label="刷新分镜列表" disabled={blocked} onClick={() => void guard(() => load())}><RefreshCw size={17} /></ActionIcon></Tooltip>
            {(onPlan || onPlanClip) && <Button leftSection={<Clapperboard size={16} />} disabled={blocked} onClick={plan}>规划分镜</Button>}</div>
        </div>
        <div className="shot-manager-controls">
          <Tabs value={tab} onChange={value => value && value !== tab && filter(() => setTab(value))}><Tabs.List><Tabs.Tab value="shots" disabled={blocked}>分镜 · {activeEntries.length}</Tabs.Tab><Tabs.Tab value="trash" disabled={blocked}>回收站 · {trashedEntries.length + (snapshot?.trashed_assets.length || 0)}</Tabs.Tab></Tabs.List></Tabs>
          <div className="shot-manager-filters">
            <Select aria-label="分镜方案筛选" value={designId} data={designOptions} allowDeselect={false} disabled={blocked} onChange={value => value && filter(() => setDesignId(value))} />
            <Select className="shot-manager-mobile-scene" aria-label="分镜场次筛选" value={sceneId} data={sceneSummaries.map(scene => ({ value: scene.id, label: scene.label }))} allowDeselect={false} searchable disabled={blocked} onChange={value => value && filter(() => setSceneId(value))} />
            {designId !== allDesigns && planEntries.length > 0 && <Tooltip label={planRecycleBlockers.length ? `暂不能回收：${planRecycleBlockers.join('；')}` : tab === 'trash' ? `恢复此方案的 ${planEntries.length} 个镜头` : `将此方案的 ${planEntries.length} 个镜头移入回收站`}>
              <span className="shot-manager-plan-action"><Button size="xs" variant="default" color={tab === 'trash' ? undefined : 'red'}
                leftSection={tab === 'trash' ? <ArchiveRestore size={14} /> : <Trash2 size={14} />}
                disabled={blocked || dirty || !!planRecycleBlockers.length} loading={pending === (tab === 'trash' ? 'restore_design' : 'trash_design')}
                onClick={() => void recycleOrRestoreDesign()}>{tab === 'trash' ? '恢复方案' : '回收方案'}</Button></span>
            </Tooltip>}
            <TextInput aria-label="搜索分镜" placeholder={tab === 'trash' ? '搜索镜头或回收素材' : '搜索镜头、描述或画布'} value={query} disabled={blocked} leftSection={<Search size={15} />} onChange={event => { const value = event.currentTarget.value; filter(() => setQuery(value)) }} />
          </div>
        </div>
        <div className="shot-manager-view-actions">
          <Checkbox label="显示空场次" aria-label="显示空场次" size="xs" checked={showEmptyScenes} disabled={blocked} onChange={event => { const checked = event.currentTarget.checked; filter(() => setShowEmptyScenes(checked)) }} />
          {tab === 'trash' && <Tooltip label={trashPurgeBlockers.length ? `暂不能清空：${trashPurgeBlockers.join('；')}` : '彻底删除整个项目的回收记录，不受当前筛选影响'}>
            <span><Button size="compact-xs" color="red" variant="subtle" leftSection={<Trash2 size={13} />} disabled={blocked || (!trashedEntries.length && !snapshot?.trashed_assets.length) || !!trashPurgeBlockers.length} loading={pending === 'empty_trash'} onClick={() => void emptyTrash()}>清空回收站</Button></span>
          </Tooltip>}
        </div>
        {tab === 'trash' && trashPurgeBlockers.length > 0 && <p className="shot-manager-recycle-blockers shot-manager-trash-blockers" role="status">暂不能清空回收站：{trashPurgeBlockers.slice(0, 3).join('；')}{trashPurgeBlockers.length > 3 ? `；另有 ${trashPurgeBlockers.length - 3} 项引用` : ''}。请先解除引用，也可单独删除未被引用的项目。</p>}
        {planRecycleBlockers.length > 0 && <p className="shot-manager-recycle-blockers" role="status">暂不能回收此方案：{planRecycleBlockers.join('；')}。请先从引用画布或关联流程中解除这些引用。</p>}
      </header>
      {error && <div className="shot-manager-error" role="alert"><span>{error}</span>{conflict && <Button variant="subtle" size="compact-xs" disabled={blocked} onClick={() => void guard(() => load())}>重新读取最新版本</Button>}</div>}
      {generationDirty && <p className="shot-manager-save-impact" role="status">保存描述、提示词、时长或起止状态后，需要重新制作；当前选片和时间线将取消，历史素材与任务保留。</p>}
      {loading ? <div className="shot-manager-empty" role="status"><Loader size="sm" /><p>正在读取项目分镜…</p></div> : snapshot ? <>
        <div className="shot-manager-workspace">
          <nav className="shot-manager-scenes" aria-label="分镜场次导航">
            <div className="shot-manager-scenes-heading"><span>场次</span><span>{scopedEntries.length} 镜 · {scopedEntries.reduce((sum, entry) => sum + entry.shot.duration, 0)} 秒</span></div>
            {sceneSummaries.map(scene => <UnstyledButton key={scene.id} className={`shot-manager-scene ${sceneId === scene.id ? 'is-active' : ''}`} aria-label={`场次：${scene.label}`} aria-current={sceneId === scene.id ? 'page' : undefined} disabled={blocked} onClick={() => filter(() => setSceneId(scene.id))}>
              <span>{scene.label}</span><small>{scene.entries.length} 镜 · {scene.entries.reduce((sum, entry) => sum + entry.shot.duration, 0)} 秒</small>
            </UnstyledButton>)}
          </nav>
          <section className="shot-manager-list" aria-label={tab === 'trash' ? '回收站镜头列表' : '项目镜头列表'}>
            <div className="shot-manager-list-heading"><div><strong>{sceneId === allScenes ? '全部场次' : sceneId === noScene ? '未关联场次' : snapshot.scenes.some(scene => scene.id === sceneId) ? sceneLabel(snapshot.scenes.find(scene => scene.id === sceneId)!) : '所选场次'}</strong><span>{visible.length} 个镜头 · {visible.reduce((sum, entry) => sum + entry.shot.duration, 0)} 秒</span></div>
              <Checkbox aria-label="选择当前筛选的全部镜头" label="全选" checked={visibleIds.length > 0 && visibleIds.every(id => checkedIds.includes(id))} indeterminate={visibleIds.some(id => checkedIds.includes(id)) && !visibleIds.every(id => checkedIds.includes(id))} disabled={blocked || !visibleIds.length} onChange={event => { const checked = event.currentTarget.checked; setCheckedIds(current => checked ? [...new Set([...current, ...visibleIds])] : current.filter(id => !visibleIds.includes(id))) }} /></div>
            <div className="shot-manager-list-scroll">
              {visible.length > 0 && <Table className="shot-manager-table" aria-label="分镜镜头表" verticalSpacing="sm" horizontalSpacing="sm">
                <Table.Thead><Table.Tr><Table.Th className="shot-manager-check-cell"><span className="shot-manager-sr-only">选择镜头</span></Table.Th><Table.Th>镜号 / 画面与描述</Table.Th><Table.Th>时长</Table.Th><Table.Th>制作状态</Table.Th><Table.Th>画布</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{visible.map(entry => <Table.Tr className={`shot-manager-row ${selectedId === entry.shot.id ? 'is-selected' : ''}`} key={entry.shot.id}>
                  <Table.Td className="shot-manager-check-cell"><Checkbox aria-label={`选择镜头：${entry.shot.title}`} checked={checkedIds.includes(entry.shot.id)} disabled={blocked} onChange={event => { const checked = event.currentTarget.checked; setCheckedIds(current => checked ? [...new Set([...current, entry.shot.id])] : current.filter(id => id !== entry.shot.id)) }} /></Table.Td>
                  <Table.Td className="shot-manager-content-cell"><UnstyledButton className="shot-manager-row-open" disabled={blocked} aria-label={`编辑镜头：${entry.shot.title}`} aria-pressed={selectedId === entry.shot.id} onClick={() => choose(entry.shot.id)}>
                    <span className="shot-manager-row-preview">{shotImages.get(entry.shot.id) ? <img src={shotImages.get(entry.shot.id)!.url} alt={`${entry.shot.title}的分镜图`} loading="lazy" /> : <ImageIcon size={20} aria-hidden="true" />}</span>
                    <span className="shot-manager-row-copy"><span className="shot-manager-row-title"><span className="shot-manager-number">{String(entry.shot.position + 1).padStart(2, '0')}</span><strong>{entry.shot.title}</strong></span>
                    <span className="shot-manager-row-description">{entry.shot.prompt || '尚未填写镜头描述'}</span>
                          <span className="shot-manager-row-meta">{entry.design_name || '基础方案'} · {snapshot.scenes.find(scene => scene.id === entry.shot.source_scene_id)?.heading || (snapshot.designs.some(design => design.id === entry.shot.design_id && design.source_type === 'clip') ? '片段内容' : '未关联场次')}</span></span>
                  </UnstyledButton></Table.Td>
                  <Table.Td className="shot-manager-duration-cell">{entry.shot.duration}<small> 秒</small></Table.Td>
                  <Table.Td className="shot-manager-status-cell"><span className={`shot-manager-production-state ${entry.shot.selected_asset_id ? 'is-selected-output' : ''}`}>{entry.shot.selected_asset_id ? '已选片' : entry.asset_count > 0 ? '已有素材' : '待制作'}</span><small>素材 {entry.asset_count} 个</small></Table.Td>
                  <Table.Td className="shot-manager-canvas-cell"><span className="shot-manager-row-references">{entry.canvas_refs.length ? `画布：${entry.canvas_refs.map(canvas => canvas.name).join('、')}` : '未加入画布'}</span></Table.Td>
                </Table.Tr>)}</Table.Tbody>
              </Table>}
              {!visible.length && <div className="shot-manager-empty"><Clapperboard size={27} /><p>{query || sceneId !== allScenes ? '没有匹配的镜头' : tab === 'trash' ? '暂无已回收镜头' : '开始规划你的分镜'}</p><small>{tab === 'trash' ? '移入回收站的镜头可以恢复，也可确认后彻底删除。' : query ? '试试其他关键词或切换场次。' : onPlanClip ? '输入一段片段内容，使用分镜技能规划并保存镜头；也可以从已有剧本场次开始。' : '从剧本选择场次，规划并保存镜头，准备好后再加入画布制作。'}</small>{tab === 'shots' && (onPlan || onPlanClip) && !query && <Button variant="light" leftSection={<Plus size={15} />} disabled={blocked} onClick={plan}>开始规划分镜</Button>}</div>}
              {tab === 'trash' && <section className="shot-manager-asset-trash" aria-label="回收站素材"><h3>已回收素材 · {assets.length}</h3>{assets.map(asset => <div className="shot-manager-asset-row" key={asset.id}>
                <span><strong>{asset.filename}</strong><small>{asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '文本'}</small>{!!asset.purge_blockers?.length && <small className="shot-manager-asset-blockers">暂不能彻底删除：{asset.purge_blockers.join('；')}</small>}</span>
                <div className="shot-manager-asset-actions"><Button size="compact-xs" variant="default" leftSection={<ArchiveRestore size={13} />} disabled={blocked} loading={pending === 'restore_asset'} onClick={() => void act({ action: 'restore_asset', asset_id: asset.id }, '素材已恢复')}>恢复素材</Button>
                  <Button size="compact-xs" color="red" variant="subtle" aria-label={`彻底删除素材：${asset.filename}`} leftSection={<Trash2 size={13} />} disabled={blocked || !!asset.purge_blockers?.length} loading={pending === 'purge_asset'} onClick={() => void purgeAsset(asset)}>彻底删除</Button></div>
              </div>)}{!assets.length && <p className="shot-manager-help">暂无已回收素材</p>}</section>}
            </div>
            {tab === 'shots' && checkedIds.length > 0 && <div className="shot-manager-batch"><strong>已选 {checkedIds.length} 镜</strong>
              {singlePendingDesign ? <span className="shot-manager-pending-canvas">将创建此方案的画布</span> : singleClipDesign ? <span className="shot-manager-pending-canvas">将加入「{singleClipDesign.name}」的画布</span> : !mixedPendingDesigns && !mixedClipDesigns && <Select aria-label="加入目标画布" placeholder="选择目标画布" value={targetCanvasId} data={snapshot.canvases.map(canvas => ({ value: canvas.id, label: canvas.name }))} allowDeselect={false} searchable disabled={blocked} onChange={setTargetCanvasId} />}
              <Button size="xs" leftSection={<Trash2 size={14} />} disabled={blocked || dirty || !!checkedRecycleBlockers.length} loading={pending === 'trash_many'} onClick={() => void recycleSelected()}>批量移入回收站</Button>
              <Button size="xs" title={dirty ? '请先保存镜头修改' : undefined} leftSection={<Plus size={14} />} disabled={blocked || dirty || mixedPendingDesigns || mixedClipDesigns || (!singlePendingDesign && !singleClipDesign && !targetCanvasId)} loading={pending === 'add'} onClick={() => void addToCanvas()}>加入画布</Button>
              {(mixedPendingDesigns || mixedClipDesigns) && <p className="shot-manager-batch-help" role="status">请按方案分别加入画布</p>}{dirty && <p className="shot-manager-batch-help" role="status">当前镜头有未保存修改，请先保存，再执行批量操作。</p>}
              {checkedRecycleBlockers.length > 0 && <p className="shot-manager-batch-help shot-manager-batch-blockers" role="status">暂不能回收：{checkedRecycleBlockers.join('；')}。请先从引用画布或关联流程中解除这些引用。</p>}
            </div>}
            {tab === 'trash' && checkedIds.length > 0 && <div className="shot-manager-batch"><strong>已选 {checkedIds.length} 镜</strong>
              <Button size="xs" color="red" leftSection={<Trash2 size={14} />} disabled={blocked || !!checkedPurgeBlockers.length} loading={pending === 'purge_many'} onClick={() => void purgeSelected()}>批量彻底删除</Button>
              {checkedPurgeBlockers.length > 0 && <p className="shot-manager-batch-help shot-manager-batch-blockers" role="status">暂不能彻底删除：{checkedPurgeBlockers.join('；')}。请先解除引用。</p>}
            </div>}
          </section>
          <section className="shot-manager-detail" aria-label="镜头详情">
            {selected && draft ? <><header><ActionIcon className="shot-manager-back" variant="subtle" aria-label="返回镜头列表" disabled={blocked} onClick={() => void guard(() => { setShowDetail(false); setDraft(patchOf(selected.shot)) })}><ArrowLeft size={17} /></ActionIcon><div><span className="shot-manager-detail-eyebrow">镜头 {String(selected.shot.position + 1).padStart(2, '0')} · {selected.design_name || '基础方案'}</span><h2>{selected.deleted_at ? '已回收镜头' : '镜头详情'}</h2></div>{dirty && <Badge variant="light" color="yellow">未保存</Badge>}</header>
              <div className="shot-manager-detail-scroll"><div className="shot-manager-fields">
                {selectedClip && <section className="shot-manager-field-group shot-manager-clip-source" aria-label="片段来源"><h3>片段内容</h3><p>{selectedClip.source_text}</p><small>规划总时长 {selectedClip.total_duration} 秒</small></section>}
                <section className="shot-manager-field-group"><h3>镜头内容</h3><TextInput label="镜头标题" value={draft.title} disabled={blocked || !!selected.deleted_at} required onChange={event => updateDraft({ title: event.currentTarget.value })} /><div className="shot-manager-field-pair"><NumberInput label="镜头时长" suffix=" 秒" value={draft.duration} min={1} max={30} allowDecimal={false} disabled={blocked || !!selected.deleted_at} onChange={value => updateDraft({ duration: Number(value) })} /><Select label="关联场次" value={selected.shot.source_scene_id || noScene} data={[{ value: noScene, label: '未关联场次' }, ...snapshot.scenes.map(scene => ({ value: scene.id, label: sceneLabel(scene) }))]} searchable allowDeselect={false} disabled /></div><Textarea label="镜头描述" value={draft.prompt} minRows={3} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ prompt: event.currentTarget.value })} /></section>
                <section className="shot-manager-field-group"><h3>生成提示词</h3><Textarea label="图片提示词" value={draft.image_prompt} minRows={3} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ image_prompt: event.currentTarget.value })} /><Textarea label="视频提示词" value={draft.video_prompt} minRows={3} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ video_prompt: event.currentTarget.value })} /></section>
                <section className="shot-manager-field-group"><h3>起止状态与接镜</h3><Textarea label="起始状态" value={draft.start_state} minRows={2} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ start_state: event.currentTarget.value })} /><Textarea label="结束状态" value={draft.end_state} minRows={2} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ end_state: event.currentTarget.value })} /><Textarea label="剪辑备注" value={draft.cut_note} minRows={2} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ cut_note: event.currentTarget.value })} /></section>
              </div><div className="shot-manager-reference-summary"><h3>制作与引用</h3><p>{selected.canvas_refs.length ? `引用画布：${selected.canvas_refs.map(canvas => canvas.name).join('、')}` : '目前没有画布引用此镜头。'}</p><p>关联素材 {selected.asset_count} 个{selected.shot.selected_asset_id ? '，已选择成片素材。' : '。'}</p>{!selected.deleted_at && selected.delete_blockers.length > 0 && <div className="shot-manager-blockers"><strong>暂不能移入回收站</strong><ul>{selected.delete_blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}{!!selected.deleted_at && !!selected.purge_blockers?.length && <div className="shot-manager-blockers"><strong>暂不能彻底删除</strong><ul>{selected.purge_blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}</div></div>
              <footer>{selected.deleted_at ? <><Button size="xs" variant="default" leftSection={<ArchiveRestore size={14} />} disabled={blocked} loading={pending === 'restore'} onClick={() => void act({ action: 'restore', shot_id: selected.shot.id }, '镜头已恢复')}>恢复镜头</Button><Button size="xs" color="red" variant="subtle" aria-label="彻底删除镜头" leftSection={<Trash2 size={14} />} disabled={blocked || !!selected.purge_blockers?.length} loading={pending === 'purge'} onClick={() => void purgeShot()}>彻底删除</Button></> : <><div className="shot-manager-order"><Tooltip label="在同方案、同场次内上移"><ActionIcon variant="default" aria-label="上移镜头" disabled={blocked || dirty || siblingIndex <= 0} onClick={() => void act({ action: 'move', shot_id: selected.shot.id, direction: 'up' }, '镜头顺序已更新')}><ArrowUp size={15} /></ActionIcon></Tooltip><Tooltip label="在同方案、同场次内下移"><ActionIcon variant="default" aria-label="下移镜头" disabled={blocked || dirty || siblingIndex < 0 || siblingIndex >= siblings.length - 1} onClick={() => void act({ action: 'move', shot_id: selected.shot.id, direction: 'down' }, '镜头顺序已更新')}><ArrowDown size={15} /></ActionIcon></Tooltip><Button size="xs" variant="default" leftSection={<Copy size={14} />} disabled={blocked || dirty} loading={pending === 'duplicate'} onClick={() => void act({ action: 'duplicate', shot_id: selected.shot.id }, '镜头已复制')}>复制</Button><Tooltip label={selected.delete_blockers.length ? selected.delete_blockers.join('；') : '移入回收站后可恢复'}><ActionIcon variant="subtle" color="red" aria-label="移入回收站" disabled={blocked || selected.delete_blockers.length > 0} onClick={() => void recycle()}><Trash2 size={16} /></ActionIcon></Tooltip></div><Button size="xs" leftSection={<Save size={14} />} disabled={blocked || !dirty || !validDraft} loading={pending === 'update'} onClick={() => void act({ action: 'update', shot_id: selected.shot.id, patch: { ...draft, title: draft.title.trim() } }, '镜头修改已保存')}>保存修改</Button></>}</footer>
            </> : <div className="shot-manager-empty"><Clapperboard size={28} /><p>选择镜头查看详情</p><small>修改镜头内容与生成提示词，调整起止状态和接镜。</small></div>}
          </section>
        </div>
      </> : <div className="shot-manager-empty"><p>分镜列表暂不可用</p><Button variant="default" size="xs" onClick={() => void load()}>重试</Button></div>}
    </section>
  </Modal><Modal opened={choosingPlanSource} onClose={() => setChoosingPlanSource(false)} centered title="选择分镜来源" zIndex={230} size="sm">
    <div className="shot-manager-plan-source"><Button variant="default" fullWidth onClick={() => { setChoosingPlanSource(false); onPlanClip?.() }}>从片段内容规划</Button><p>输入一段想法或视频内容，使用分镜技能规划镜头。</p>
      <Button variant="default" fullWidth onClick={() => { setChoosingPlanSource(false); planScenes() }}>从剧本场次规划</Button><p>从已保存的剧本中选择场次，规划对应镜头。</p></div>
  </Modal>{dialog.dialog}</>
}

export default function ShotManager(props: ShotManagerProps) {
  return <ShotManagerContent key={`${props.detail.id}:${props.opened ? 'open' : 'closed'}`} {...props} />
}
