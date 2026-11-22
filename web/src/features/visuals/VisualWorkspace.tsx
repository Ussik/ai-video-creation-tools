import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button, Menu, Select, TextInput, UnstyledButton } from '@mantine/core'
import { ArrowLeft, Box, ChevronDown, ImageIcon, Layers3, MapPin, Plus, Search, Users, WandSparkles } from 'lucide-react'
import { api, json, type Model, type ProjectDetail, type Provider, type VisualKind, type VisualProfile } from '../../shared/api/api'
import { useAppDialog } from '../../shared/ui/AppDialog'
import { visualBoardJobs, visualCandidateAssets } from '../canvas/canvas-visual-profiles'
import type { ProjectCanvasInfo } from '../canvas/project-canvases'
import VisualProfileInspector from './VisualProfileInspector'
import VisualProfileOrganizer from './VisualProfileOrganizer'
import VisualCandidateManager from './VisualCandidateManager'
import VisualBindingEditor from './VisualBindingEditor'
import { visualKinds } from './VisualProfileFields'
import '../canvas/canvas-visual-profiles.css'
import './visual-workspace.css'

type Props = {
  detail: ProjectDetail
  models: Model[]
  providers: Provider[]
  onRefresh: () => Promise<void>
  headerControls?: React.ReactNode
  onClose: () => void
  onNotice?: (message: string) => void
  onOpenCanvas?: (profile: VisualProfile) => void
  registerNavigationGuard?: (guard: (() => Promise<boolean>) | null) => void
  onWorkspaceChange?: (workspace: 'script' | 'canvas' | 'visuals' | 'speech' | 'studio' | 'settings' | 'source') => void
}
type Mode = 'inspect' | 'create' | 'organize' | 'bindings'
const paneSizes = {
  nav: { label: '调整分类栏宽度', initial: 205, min: 160, max: 360, direction: 1 },
  inspector: { label: '调整属性栏宽度', initial: 290, min: 260, max: 440, direction: -1 },
}
type Pane = keyof typeof paneSizes
const kindIcons = { character: Users, location: MapPin, prop: Box }
const kindName = (kind: VisualKind) => visualKinds.find(item => item.value === kind)?.label || kind

export default function VisualWorkspace({ detail, models, providers, onRefresh, onClose, headerControls, onNotice, onOpenCanvas, registerNavigationGuard, onWorkspaceChange }: Props) {
  const profiles = detail.visual_profiles || []
  const [canvases, setCanvases] = useState<ProjectCanvasInfo[]>([])
  useEffect(() => {
    const controller = new AbortController()
    void api<ProjectCanvasInfo[]>(`/projects/${detail.id}/canvases`, { signal: controller.signal }).then(setCanvases).catch(() => {})
    return () => controller.abort()
  }, [detail.id])
  const [kind, setKind] = useState<'all' | VisualKind>('all')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(profiles[0]?.id || null)
  const [mode, setMode] = useState<Mode>('inspect')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [candidateId, setCandidateId] = useState<string | null>(null)
  const [localNotice, setLocalNotice] = useState('')
  const [widths, setWidths] = useState({ nav: paneSizes.nav.initial, inspector: paneSizes.inspector.initial })
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null)
  const { confirm, dialog } = useAppDialog({ zIndex: 500 })
  const selected = profiles.find(profile => profile.id === selectedId)
  const candidate = profiles.find(profile => profile.id === candidateId)
  const draftsRef = useRef({ busy, dirty, modal: !!candidate || !!dialog })
  draftsRef.current = { busy, dirty, modal: !!candidate || !!dialog }
  const scopeProfiles = profiles.filter(profile => scope === 'all' || (profile.design_id || 'project') === scope)
  const visible = scopeProfiles.filter(profile => (kind === 'all' || profile.kind === kind)
    && `${profile.name} ${profile.variant} ${profile.definition}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const scopeOptions = useMemo(() => {
    const scopes = [...new Set(profiles.flatMap(profile => profile.design_id ? [profile.design_id] : []))]
    return [{ value: 'all', label: '全部制作方案' }, { value: 'project', label: '项目公共设定' }, ...scopes.map(id => ({ value: id,
      label: canvases.find(canvas => canvas.design_id === id)?.name || `分镜方案 ${scopes.indexOf(id) + 1}` }))]
  }, [profiles, canvases])
  const scopeId = scope === 'all' || scope === 'project' ? null : scope
  const isGenerating = (profile?: VisualProfile) => !!profile && (detail.asset_tasks.some(task => task.id === profile.asset_task_id && task.status === 'generating') || visualBoardJobs(profile, detail.jobs).some(job => job.status === 'queued' || job.status === 'running'))
  const notice = useCallback((message: string) => { setLocalNotice(message); onNotice?.(message) }, [onNotice])
  const canLeave = useCallback(async () => {
    if (draftsRef.current.busy || draftsRef.current.modal) return false
    if (draftsRef.current.dirty && !await confirm({ title: '离开当前设定', message: '当前设定有未保存的修改，离开后将丢弃这些修改。', confirmLabel: '丢弃并离开', cancelLabel: '继续编辑' })) return false
    return true
  }, [confirm])
  const navigation = useRef(canLeave)
  navigation.current = canLeave
  useEffect(() => {
    registerNavigationGuard?.(() => navigation.current())
    return () => registerNavigationGuard?.(null)
  }, [registerNavigationGuard])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (draftsRef.current.dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  useEffect(() => {
    if (!localNotice) return
    const timer = window.setTimeout(() => setLocalNotice(''), 3500)
    return () => window.clearTimeout(timer)
  }, [localNotice])
  async function changeView(next: () => void) {
    if (!await canLeave()) return
    setDirty(false); setBusy(false); next()
  }
  function inspect(profile: VisualProfile) {
    if (selectedId === profile.id && mode === 'inspect') return
    void changeView(() => { setSelectedId(profile.id); setMode('inspect') })
  }
  function locateProfile(profile: VisualProfile) {
    void changeView(() => { setScope('all'); setKind('all'); setQuery(''); setSelectedId(profile.id); setMode('inspect') })
  }
  async function close() { if (await canLeave()) onClose() }
  function paneSeparator(pane: Pane) {
    const { label, min, max, direction } = paneSizes[pane]
    const resize = (width: number) => setWidths(current => ({
      ...current, [pane]: Math.min(max, Math.max(min, width)),
    }))
    return <div className="visual-workspace-separator" role="separator" tabIndex={0}
      aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={widths[pane]}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointer: event.pointerId, x: event.clientX, width: widths[pane] }
      }}
      onPointerMove={event => {
        const start = drag.current
        if (start?.pointer === event.pointerId) resize(start.width + (event.clientX - start.x) * direction)
      }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        resize(widths[pane] + (event.key === 'ArrowRight' ? 10 : -10) * direction)
      }} />
  }
  const inspector = mode === 'organize' ? <VisualProfileOrganizer key={`organize:${scopeId || 'project'}`} detail={detail} models={models} providers={providers} designId={scopeId}
    onRefresh={onRefresh} onClose={() => void changeView(() => setMode('inspect'))} onBusyChange={setBusy} onDirtyChange={setDirty} />
    : mode === 'bindings' && selected ? <VisualBindingEditor key={`bindings:${selected.id}`} detail={detail} context={{ profileId: selected.id }} onRefresh={onRefresh}
      onClose={() => void changeView(() => setMode('inspect'))} onBusyChange={setBusy} onLocate={locateProfile} />
    : mode === 'create' || selected ? <VisualProfileInspector key={mode === 'create' ? `new:${scopeId || 'project'}` : selected!.id}
      profile={mode === 'create' ? undefined : selected} inCanvas={false} detail={detail} designId={scopeId} models={models} providers={providers} generating={isGenerating(selected)}
      onRefresh={onRefresh} onClose={() => void changeView(() => { setMode('inspect'); setSelectedId(null) })} onBindings={() => void changeView(() => setMode('bindings'))}
      onBusyChange={setBusy} onDirtyChange={setDirty} onSaved={profile => { setSelectedId(profile.id); setMode('inspect'); notice('设定已保存') }}
      onDeleted={() => { setSelectedId(null); setMode('inspect'); notice('设定已删除') }} onLocateProfile={locateProfile}
      canvasActionLabel="在画布打开" onOpenCanvas={profile => { if (onOpenCanvas) onOpenCanvas(profile); else onClose() }} />
    : <aside className="visual-workspace-empty-inspector"><ImageIcon size={28} strokeWidth={1.4} /><p>选择一份设定，查看与编辑属性。</p></aside>

  return <section className="visual-workspace" aria-label="视觉设定工作台" data-v4-page="visual">
    <header className="visual-workspace-heading">
      <div className="visual-workspace-identity">
        <UnstyledButton type="button" className="visual-workspace-back" disabled={busy || !!dialog || !!candidate}
          onClick={() => void close()} aria-label={`返回画布 · ${detail.name}`}>
          <ArrowLeft size={15} aria-hidden="true" /><span>{detail.name}</span>
        </UnstyledButton>
        <h1>视觉设定</h1>
      </div>
      <div className="visual-workspace-actions">
        {headerControls}
        {onWorkspaceChange && <Menu position="bottom-end">
          <Menu.Target><Button variant="subtle" size="xs" rightSection={<ChevronDown size={14} />}>相关工作区</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => onWorkspaceChange('settings')}>创作设定</Menu.Item>
            <Menu.Item onClick={() => onWorkspaceChange('speech')}>配音</Menu.Item>
            <Menu.Item onClick={() => onWorkspaceChange('canvas')}>画布引用</Menu.Item>
            <Menu.Item onClick={() => onWorkspaceChange('studio')}>成片检查</Menu.Item>
          </Menu.Dropdown>
        </Menu>}
        <Button variant="default" size="xs" leftSection={<WandSparkles size={15} />} disabled={busy} onClick={() => void changeView(() => setMode('organize'))}>整理设定</Button>
      </div>
    </header>
    <div className="visual-workspace-layout" style={{ '--visual-nav-width': `${widths.nav}px`, '--visual-inspector-width': `${widths.inspector}px` } as CSSProperties}>
      <nav className="visual-workspace-nav" aria-label="视觉设定分类">
        <h2>视觉设定</h2>
        {[{ value: 'all' as const, label: '全部设定', Icon: Layers3 }, ...visualKinds.map(item => ({ ...item, value: item.value as VisualKind, Icon: kindIcons[item.value as VisualKind] }))].map(item => <UnstyledButton key={item.value} aria-pressed={kind === item.value} className={kind === item.value ? 'is-active' : ''} onClick={() => setKind(item.value)}><item.Icon size={16} /><span>{item.label}</span><small>{scopeProfiles.filter(profile => item.value === 'all' || profile.kind === item.value).length}</small></UnstyledButton>)}
        {detail.project_visual_style?.label && <div className="visual-workspace-style"><span>项目画风</span><strong>{detail.project_visual_style.label}</strong></div>}
        <div className="visual-workspace-create"><Button leftSection={<Plus size={15} />} disabled={busy} onClick={() => void changeView(() => { setSelectedId(null); setMode('create') })}>新建设定</Button></div>
      </nav>
      {paneSeparator('nav')}
      <section className="visual-workspace-main" aria-label="项目视觉设定">
        <div className="visual-workspace-tools"><h2>项目视觉系统</h2><TextInput aria-label="搜索视觉设定" placeholder="搜索名称或设定内容" leftSection={<Search size={15} />} value={query} onChange={event => setQuery(event.currentTarget.value)} />
          <Select aria-label="视觉设定制作方案" value={scope} data={scopeOptions} allowDeselect={false} onChange={value => { if (value) void changeView(() => { setScope(value); setMode('inspect'); setSelectedId(profiles.find(profile => value === 'all' || (profile.design_id || 'project') === value)?.id || null) }) }} /></div>
        <div className="visual-workspace-grid">{visible.map(profile => {
          const board = detail.assets.find(asset => asset.id === profile.board_asset_id) || detail.assets.find(asset => profile.reference_assets?.some(reference => reference.asset_id === asset.id && reference.status === 'confirmed'))
          const Icon = kindIcons[profile.kind]
          const generating = isGenerating(profile)
          const count = visualCandidateAssets(profile, detail).length
          return <article key={profile.id} className={`visual-workspace-card${selectedId === profile.id && mode === 'inspect' ? ' is-selected' : ''}`}>
            <UnstyledButton className="visual-workspace-card-main" aria-label={`编辑视觉设定：${profile.name} · ${profile.variant}`} aria-pressed={selectedId === profile.id && mode === 'inspect'} onClick={() => inspect(profile)}>
              <div className="visual-workspace-card-art">{board?.kind === 'image' ? <img src={board.url} alt={`${profile.name}设定图`} loading="lazy" /> : <Icon size={38} strokeWidth={1.2} />}<span>{kindName(profile.kind)}</span></div>
              <div className="visual-workspace-card-copy"><span>{profile.variant} · v{profile.revision}</span><strong>{profile.name}</strong><p>{profile.display_definition || profile.definition}</p><small>{generating ? '生成中' : profile.definition_status === 'draft' ? '草稿待确认' : profile.board_asset_id ? '已确认设定图' : '待制作设定图'}</small></div>
            </UnstyledButton>
            <footer><Button size="compact-xs" variant="subtle" disabled={busy || dirty} onClick={() => setCandidateId(profile.id)}>候选图 {count}</Button><Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => void changeView(() => { setSelectedId(profile.id); setMode('bindings') })}>查看引用</Button></footer>
          </article>
        })}</div>
        {!visible.length && <div className="visual-workspace-empty"><ImageIcon size={32} strokeWidth={1.3} /><strong>{profiles.length ? '没有符合条件的设定' : '建立项目的视觉设定'}</strong>{profiles.length ? <Button variant="subtle" size="xs" onClick={() => { setKind('all'); setQuery(''); setScope('all') }}>清除筛选</Button> : <Button variant="default" size="sm" leftSection={<Plus size={15} />} disabled={busy} onClick={() => void changeView(() => setMode('create'))}>新建设定</Button>}</div>}
        {profiles.length > 0 && <footer className="visual-workspace-summary"><span>{new Set(detail.scene_visual_bindings?.map(binding => binding.scene_id)).size} 个场次 · {new Set(detail.shot_visual_bindings?.map(binding => binding.shot_id)).size} 个镜头引用</span></footer>}
      </section>
      {paneSeparator('inspector')}
      <div className="visual-workspace-inspector">{inspector}</div>
    </div>
    {localNotice && <div className="visual-workspace-notice" role="status">{localNotice}</div>}
    {candidate && <VisualCandidateManager key={candidate.id} profile={candidate} detail={detail} models={models} generating={isGenerating(candidate)} onClose={() => setCandidateId(null)} onRefresh={onRefresh}
      onConfirm={async assetId => { await api(`/visual-profiles/${candidate.id}`, json('PATCH', { board_asset_id: assetId, expected_revision: candidate.revision, expected_style_version: detail.project_visual_style?.version })); await onRefresh(); notice('已确认使用此设定图') }} />}
    {dialog}
  </section>
}
