import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Badge, Button, Checkbox, Loader, Modal, NumberInput, Select, Tabs, Textarea, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, Clapperboard, Copy, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
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
}
const allDesigns = '__all__', baseDesign = '__base__', allScenes = '__all__', noScene = '__none__'
const patchOf = (shot: Shot): Patch => ({ title: shot.title, duration: shot.duration, prompt: shot.prompt, image_prompt: shot.image_prompt || '', video_prompt: shot.video_prompt || '', start_state: shot.start_state || '', end_state: shot.end_state || '', cut_note: shot.cut_note || '' })
const errorText = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
const sceneLabel = (scene: Snapshot['scenes'][number]) => `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}`

function ShotManagerContent({ opened, onClose, detail, activeCanvasId, onRefresh, onAddToCanvas, onNotice }: ShotManagerProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false), [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState(''), [conflict, setConflict] = useState(false)
  const [tab, setTab] = useState('shots'), [designId, setDesignId] = useState(allDesigns), [sceneId, setSceneId] = useState(allScenes), [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null), [draft, setDraft] = useState<Patch | null>(null)
  const [checkedIds, setCheckedIds] = useState<string[]>([]), [targetCanvasId, setTargetCanvasId] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false), [guarding, setGuarding] = useState(false)
  const live = useRef({ projectId: detail.id, opened }); live.current = { projectId: detail.id, opened }
  const lifecycle = useRef(0), generation = useRef(0), locked = useRef(false), guardLock = useRef(false)
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot
  const dialog = useAppDialog({ zIndex: 350 })
  const selected = snapshot?.shots.find(entry => entry.shot.id === selectedId) || null
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
  const designOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const design of snapshot?.designs || []) options.set(design.id || baseDesign, design.name || '基础方案')
    for (const entry of snapshot?.shots || []) if (!options.has(entry.shot.design_id || baseDesign)) options.set(entry.shot.design_id || baseDesign, entry.design_name || '基础方案')
    if (designId !== allDesigns && !options.has(designId)) options.set(designId, '当前方案')
    return [{ value: allDesigns, label: '全部方案' }, ...[...options].map(([value, label]) => ({ value, label }))]
  }, [snapshot, designId])
  const siblings = selected ? activeEntries.filter(entry => (entry.shot.design_id || null) === (selected.shot.design_id || null) && entry.shot.source_scene_id === selected.shot.source_scene_id).sort((a, b) => a.shot.position - b.shot.position) : []
  const siblingIndex = siblings.findIndex(entry => entry.shot.id === selectedId)
  const isCurrent = (projectId: string, sequence: number) => live.current.opened && live.current.projectId === projectId && generation.current === sequence

  function install(next: Snapshot, preferredId: string | null = selectedRef.current) {
    setSnapshot(next); snapshotRef.current = next
    const entry = next.shots.find(item => item.shot.id === preferredId)
    setSelectedId(entry?.shot.id || null); setDraft(entry ? patchOf(entry.shot) : null)
    setCheckedIds(current => current.filter(id => next.shots.some(item => item.shot.id === id && !item.deleted_at)))
  }
  async function load(initial = false) {
    const projectId = detail.id, sequence = ++generation.current
    setLoading(true); setError(''); setConflict(false)
    try {
      const next = await api<Snapshot>(`/projects/${projectId}/shot-management`)
      if (!isCurrent(projectId, sequence)) return
      install(next, initial ? null : selectedRef.current)
      if (initial) {
        const currentCanvas = next.canvases.find(canvas => canvas.id === activeCanvasId)
        const currentDesign = next.designs.find(design => design.canvas_id === activeCanvasId)
        setDesignId(currentDesign?.id || (currentCanvas ? baseDesign : allDesigns))
        setTargetCanvasId(currentCanvas?.id || next.canvases[0]?.id || null)
      }
    } catch (issue) { if (isCurrent(projectId, sequence)) setError(errorText(issue)) }
    finally { if (isCurrent(projectId, sequence)) setLoading(false) }
  }
  useEffect(() => {
    lifecycle.current += 1; generation.current += 1; locked.current = false; guardLock.current = false
    setSnapshot(null); setSelectedId(null); setDraft(null); setCheckedIds([]); setTargetCanvasId(null)
    setTab('shots'); setDesignId(allDesigns); setSceneId(allScenes); setQuery(''); setShowDetail(false); setPending(null); setGuarding(false); setError(''); setConflict(false)
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

  async function guard(change: () => void | Promise<void>) {
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
  async function act(input: Action, notice: string) {
    const current = snapshotRef.current
    if (!current || locked.current || guardLock.current) return
    const projectId = detail.id, sequence = generation.current
    locked.current = true; setPending(input.action); setError(''); setConflict(false)
    try {
      const next = await api<Snapshot>(`/projects/${projectId}/shot-management/actions`, json('POST', { ...input, revision: current.revision }))
      if (!isCurrent(projectId, sequence)) return
      const duplicate = input.action === 'duplicate' ? next.shots.find(entry => !current.shots.some(old => old.shot.id === entry.shot.id)) : null
      install(next, duplicate?.shot.id || selectedRef.current)
      await onRefresh()
      if (isCurrent(projectId, sequence)) onNotice?.(notice)
    } catch (issue) {
      if (isCurrent(projectId, sequence)) { setError(errorText(issue)); setConflict((issue as Error & { status?: number }).status === 409) }
    } finally { if (isCurrent(projectId, sequence)) { locked.current = false; setPending(null) } }
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
  async function addToCanvas() {
    if (!checkedIds.length || !targetCanvasId || locked.current || guardLock.current || dirtyRef.current) return
    const projectId = detail.id, sequence = generation.current, ids = [...checkedIds], canvasId = targetCanvasId
    locked.current = true; setPending('add'); setError('')
    try {
      await onAddToCanvas(ids, canvasId)
      if (!isCurrent(projectId, sequence)) return
      const next = await api<Snapshot>(`/projects/${projectId}/shot-management`)
      if (!isCurrent(projectId, sequence)) return
      install(next); setCheckedIds([]); await onRefresh()
      if (isCurrent(projectId, sequence)) onNotice?.(`已将 ${ids.length} 个镜头加入画布`)
    } catch (issue) { if (isCurrent(projectId, sequence)) setError(errorText(issue)) }
    finally { if (isCurrent(projectId, sequence)) { locked.current = false; setPending(null) } }
  }
  const updateDraft = (patch: Partial<Patch>) => setDraft(current => current ? { ...current, ...patch } : current)
  const validDraft = !!draft && !!draft.title.trim() && Number.isFinite(draft.duration) && draft.duration >= 1 && draft.duration <= 30
  const assets = snapshot?.trashed_assets.filter(asset => !query.trim() || asset.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || []

  return <><Modal opened={opened} onClose={() => void guard(onClose)} title="项目分镜管理" centered size="min(1280px, calc(100vw - 32px))" radius={14}
    closeOnClickOutside={false} closeOnEscape={!blocked} closeButtonProps={{ disabled: blocked, 'aria-label': '关闭分镜管理' }}
    classNames={{ content: 'shot-manager-modal', header: 'shot-manager-header', body: 'shot-manager-body' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <section className={`shot-manager ${showDetail ? 'is-detail' : ''}`} aria-label="项目分镜管理内容" data-canvas-overlay onKeyDown={event => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation() }}>
      <div className="shot-manager-toolbar">
        <div className="shot-manager-heading"><div><h2>{detail.name}</h2><p>集中管理各方案的镜头与画布引用</p></div><Tooltip label="重新读取分镜"><ActionIcon variant="default" aria-label="刷新分镜列表" disabled={blocked} onClick={() => void guard(() => load())}><RefreshCw size={16} /></ActionIcon></Tooltip></div>
        <Tabs value={tab} onChange={value => value && value !== tab && filter(() => setTab(value))}><Tabs.List><Tabs.Tab value="shots">分镜 · {activeEntries.length}</Tabs.Tab><Tabs.Tab value="trash">回收站 · {trashedEntries.length + (snapshot?.trashed_assets.length || 0)}</Tabs.Tab></Tabs.List></Tabs>
        <div className="shot-manager-filters"><Select aria-label="分镜方案筛选" value={designId} data={designOptions} allowDeselect={false} disabled={blocked} onChange={value => value && filter(() => setDesignId(value))} /><Select aria-label="分镜场次筛选" value={sceneId} data={[{ value: allScenes, label: '全部场次' }, { value: noScene, label: '未关联场次' }, ...(snapshot?.scenes || []).map(scene => ({ value: scene.id, label: sceneLabel(scene) }))]} allowDeselect={false} searchable disabled={blocked} onChange={value => value && filter(() => setSceneId(value))} /><TextInput aria-label="搜索分镜" placeholder={tab === 'trash' ? '搜索镜头或回收素材' : '搜索镜头、描述或引用画布'} value={query} disabled={blocked} leftSection={<Search size={15} />} onChange={event => { const value = event.currentTarget.value; filter(() => setQuery(value)) }} /></div>
      </div>
      {error && <div className="shot-manager-error" role="alert"><span>{error}</span>{conflict && <Button variant="subtle" size="compact-xs" disabled={blocked} onClick={() => void guard(() => load())}>重新读取最新版本</Button>}</div>}
      {generationDirty && <p className="shot-manager-save-impact" role="status">保存描述、提示词、时长或起止状态后，需要重新制作；当前选片和时间线将取消，历史素材与任务保留。</p>}
      {loading ? <div className="shot-manager-empty" role="status"><Loader size="sm" /><p>正在读取项目分镜…</p></div> : snapshot ? <>
        {tab === 'shots' && <div className="shot-manager-batch"><Checkbox aria-label="选择当前筛选的全部镜头" label={`已选 ${checkedIds.length} 个镜头`} checked={visibleIds.length > 0 && visibleIds.every(id => checkedIds.includes(id))} indeterminate={visibleIds.some(id => checkedIds.includes(id)) && !visibleIds.every(id => checkedIds.includes(id))} disabled={blocked || !visibleIds.length} onChange={event => { const checked = event.currentTarget.checked; setCheckedIds(current => checked ? [...new Set([...current, ...visibleIds])] : current.filter(id => !visibleIds.includes(id))) }} /><Select aria-label="加入目标画布" placeholder="选择目标画布" value={targetCanvasId} data={snapshot.canvases.map(canvas => ({ value: canvas.id, label: canvas.name }))} allowDeselect={false} searchable disabled={blocked} onChange={setTargetCanvasId} /><Button size="xs" title={dirty ? '请先保存镜头修改' : undefined} leftSection={<Plus size={14} />} disabled={blocked || dirty || !checkedIds.length || !targetCanvasId} loading={pending === 'add'} onClick={() => void addToCanvas()}>加入画布</Button>{dirty && <p className="shot-manager-batch-help" role="status">当前镜头有未保存修改，请先保存，再加入画布。</p>}</div>}
        <div className="shot-manager-workspace">
          <div className="shot-manager-list" aria-label={tab === 'trash' ? '回收站镜头列表' : '项目镜头列表'}>
            <div className="shot-manager-list-heading"><span>{tab === 'trash' ? '已回收镜头' : '镜头列表'}</span><span>{visible.length} 个</span></div>
            <div className="shot-manager-list-scroll">{visible.map(entry => <article className={`shot-manager-row ${selectedId === entry.shot.id ? 'is-selected' : ''}`} key={entry.shot.id}>
              {tab === 'shots' && <Checkbox aria-label={`选择镜头：${entry.shot.title}`} checked={checkedIds.includes(entry.shot.id)} disabled={blocked} onChange={event => { const checked = event.currentTarget.checked; setCheckedIds(current => checked ? [...current, entry.shot.id] : current.filter(id => id !== entry.shot.id)) }} />}
              <UnstyledButton className="shot-manager-row-open" disabled={blocked} aria-label={`编辑镜头：${entry.shot.title}`} aria-pressed={selectedId === entry.shot.id} onClick={() => choose(entry.shot.id)}><span className="shot-manager-row-title"><span className="shot-manager-number">{String(entry.shot.position + 1).padStart(2, '0')}</span><strong>{entry.shot.title}</strong><span>{entry.shot.duration} 秒</span></span><span className="shot-manager-row-meta">{entry.design_name || '基础方案'} · {snapshot.scenes.find(scene => scene.id === entry.shot.source_scene_id)?.heading || '未关联场次'}</span><span className="shot-manager-row-references">{entry.canvas_refs.length ? `画布：${entry.canvas_refs.map(canvas => canvas.name).join('、')}` : '未被画布引用'}</span><span className="shot-manager-row-assets">素材 {entry.asset_count} 个{entry.shot.selected_asset_id ? ' · 已有选片' : ''}</span></UnstyledButton>
            </article>)}{!visible.length && <div className="shot-manager-empty"><Clapperboard size={25} /><p>{query || sceneId !== allScenes ? '没有匹配的镜头' : tab === 'trash' ? '暂无已回收镜头' : '当前方案暂无镜头'}</p><small>{designId !== allDesigns ? '可切换“全部方案”查看项目中的其他镜头。' : '规划分镜后，镜头会显示在这里。'}</small></div>}
            {tab === 'trash' && <section className="shot-manager-asset-trash" aria-label="回收站素材"><h3>已回收素材 · {assets.length}</h3>{assets.map(asset => <div className="shot-manager-asset-row" key={asset.id}><span><strong>{asset.filename}</strong><small>{asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '文本'}</small></span><Button size="compact-xs" variant="default" leftSection={<ArchiveRestore size={13} />} disabled={blocked} loading={pending === 'restore_asset'} onClick={() => void act({ action: 'restore_asset', asset_id: asset.id }, '素材已恢复')}>恢复素材</Button></div>)}{!assets.length && <p className="shot-manager-help">暂无已回收素材</p>}</section>}
            </div>
          </div>
          <section className="shot-manager-detail" aria-label="镜头详情">
            {selected && draft ? <><header><ActionIcon className="shot-manager-back" variant="subtle" aria-label="返回镜头列表" disabled={blocked} onClick={() => void guard(() => { setShowDetail(false); setDraft(patchOf(selected.shot)) })}><ArrowLeft size={17} /></ActionIcon><div><h3>{selected.deleted_at ? '已回收镜头' : '编辑镜头'}</h3><span>{selected.design_name || '基础方案'} · {selected.shot.duration} 秒</span></div>{dirty && <Badge variant="light" color="yellow">未保存</Badge>}</header>
              <div className="shot-manager-detail-scroll"><div className="shot-manager-fields"><TextInput label="镜头标题" value={draft.title} disabled={blocked || !!selected.deleted_at} required onChange={event => updateDraft({ title: event.currentTarget.value })} /><div className="shot-manager-field-pair"><NumberInput label="镜头时长" suffix=" 秒" value={draft.duration} min={1} max={30} allowDecimal={false} disabled={blocked || !!selected.deleted_at} onChange={value => updateDraft({ duration: Number(value) })} /><Select label="关联场次" value={selected.shot.source_scene_id || noScene} data={[{ value: noScene, label: '未关联场次' }, ...snapshot.scenes.map(scene => ({ value: scene.id, label: sceneLabel(scene) }))]} searchable allowDeselect={false} disabled /></div><Textarea label="镜头描述" value={draft.prompt} minRows={3} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ prompt: event.currentTarget.value })} /><Textarea label="图片提示词" value={draft.image_prompt} minRows={3} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ image_prompt: event.currentTarget.value })} /><Textarea label="视频提示词" value={draft.video_prompt} minRows={3} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ video_prompt: event.currentTarget.value })} /><Textarea label="起始状态" value={draft.start_state} minRows={2} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ start_state: event.currentTarget.value })} /><Textarea label="结束状态" value={draft.end_state} minRows={2} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ end_state: event.currentTarget.value })} /><Textarea label="剪辑备注" value={draft.cut_note} minRows={2} autosize disabled={blocked || !!selected.deleted_at} onChange={event => updateDraft({ cut_note: event.currentTarget.value })} /></div>
                <div className="shot-manager-reference-summary"><h4>引用与素材</h4><p>{selected.canvas_refs.length ? `引用画布：${selected.canvas_refs.map(canvas => canvas.name).join('、')}` : '目前没有画布引用此镜头。'}</p><p>关联素材 {selected.asset_count} 个{selected.shot.selected_asset_id ? '，已选择成片素材。' : '。'}</p>{!selected.deleted_at && selected.delete_blockers.length > 0 && <div className="shot-manager-blockers"><strong>暂不能移入回收站</strong><ul>{selected.delete_blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}</div>
              </div>
              <footer>{selected.deleted_at ? <Button size="xs" leftSection={<ArchiveRestore size={14} />} disabled={blocked} loading={pending === 'restore'} onClick={() => void act({ action: 'restore', shot_id: selected.shot.id }, '镜头已恢复')}>恢复镜头</Button> : <><div className="shot-manager-order"><Tooltip label="在同方案、同场次内上移"><ActionIcon variant="default" aria-label="上移镜头" disabled={blocked || dirty || siblingIndex <= 0} onClick={() => void act({ action: 'move', shot_id: selected.shot.id, direction: 'up' }, '镜头顺序已更新')}><ArrowUp size={15} /></ActionIcon></Tooltip><Tooltip label="在同方案、同场次内下移"><ActionIcon variant="default" aria-label="下移镜头" disabled={blocked || dirty || siblingIndex < 0 || siblingIndex >= siblings.length - 1} onClick={() => void act({ action: 'move', shot_id: selected.shot.id, direction: 'down' }, '镜头顺序已更新')}><ArrowDown size={15} /></ActionIcon></Tooltip><Button size="xs" variant="default" leftSection={<Copy size={14} />} disabled={blocked || dirty} loading={pending === 'duplicate'} onClick={() => void act({ action: 'duplicate', shot_id: selected.shot.id }, '镜头已复制')}>复制</Button><Tooltip label={selected.delete_blockers.length ? selected.delete_blockers.join('；') : '移入回收站后可恢复'}><Button size="xs" variant="subtle" color="red" leftSection={<Trash2 size={14} />} disabled={blocked || selected.delete_blockers.length > 0} onClick={() => void recycle()}>移入回收站</Button></Tooltip></div><Button size="xs" leftSection={<Save size={14} />} disabled={blocked || !dirty || !validDraft} loading={pending === 'update'} onClick={() => void act({ action: 'update', shot_id: selected.shot.id, patch: { ...draft, title: draft.title.trim() } }, '镜头修改已保存')}>保存修改</Button></>}</footer>
            </> : <div className="shot-manager-empty"><Clapperboard size={28} /><p>选择镜头查看详情</p><small>编辑提示词、检查画布引用或整理镜头顺序。</small></div>}
          </section>
        </div>
      </> : <div className="shot-manager-empty"><p>分镜列表暂不可用</p><Button variant="default" size="xs" onClick={() => void load()}>重试</Button></div>}
    </section>
  </Modal>{dialog.dialog}</>
}

export default function ShotManager(props: ShotManagerProps) {
  return <ShotManagerContent key={`${props.detail.id}:${props.opened ? 'open' : 'closed'}`} {...props} />
}
