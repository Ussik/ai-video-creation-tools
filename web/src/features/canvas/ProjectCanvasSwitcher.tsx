import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { UnstyledButton, ActionIcon, Button, Menu, Modal, TextInput } from '@mantine/core'
import { Check, ChevronDown, LoaderCircle, PenLine, Plus, Trash2, ArrowRight } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import { useAppDialog } from '../../shared/ui/AppDialog'
import { preferredCanvas, rememberCanvas, rememberedCanvas, type ProjectCanvasInfo } from './project-canvases'
import type { CanvasSession } from './ProjectCanvas'
import { readScriptCanvasRequest } from '../script/script-canvas-handoff'
import './project-canvases.css'

export type CanvasActions = { revision: () => string | undefined; leave: () => Promise<boolean>; move: (target: string) => Promise<boolean> }
function ProjectCanvasSwitcher({ projectId, children }: {
  projectId: string;
  children: (canvas: ProjectCanvasInfo, session: CanvasSession, menu: ReactNode, register: (actions: CanvasActions | null) => void, viewportChanged: (viewport: ProjectCanvasInfo['viewport']) => void) => ReactNode;
}) {
  const { confirm, dialog } = useAppDialog()
  const [canvases, setCanvases] = useState<ProjectCanvasInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ProjectCanvasInfo | null>(null)
  const [name, setName] = useState('')
  const actions = useRef<CanvasActions | null>(null)
  const sessions = useRef(new Map<string, CanvasSession>())
  const viewportWrites = useRef(new Map<string, Promise<unknown>>())
  const mounted = useRef(true)
  const operation = useRef(false)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const resumeHandoff = useRef<(() => void) | null>(null)
  const register = useRef((next: CanvasActions | null) => { actions.current = next; if (next) resumeHandoff.current?.() }).current
  const reload = async () => {
    const next = await api<ProjectCanvasInfo[]>(`/projects/${projectId}/canvases`)
    if (mounted.current) setCanvases(next)
    return next
  }
  useEffect(() => {
    mounted.current = true
    void reload().then(next => {
      if (!mounted.current) return
      const request = readScriptCanvasRequest(projectId)
      const requested = request?.result.design_id ? next.find(canvas => canvas.id === request.canvas_id) : undefined
      if (request?.result.design_id && !requested) throw new Error('新方案画布尚未读取，请重新载入')
      const selected = requested || preferredCanvas(next, rememberedCanvas(projectId))
      if (!selected) throw new Error('项目没有可用画布')
      setActiveId(selected.id); rememberCanvas(projectId, selected.id)
    }).catch(issue => { if (mounted.current) setError(issue instanceof Error ? issue.message : String(issue)) })
    return () => { mounted.current = false }
  }, [projectId])
  const active = canvases.find(canvas => canvas.id === activeId)
  const select = (canvas: ProjectCanvasInfo) => { activeIdRef.current = canvas.id; setActiveId(canvas.id); rememberCanvas(projectId, canvas.id) }
  const perform = async (work: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { await work() } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { operation.current = false; if (mounted.current) { setBusy(false); resumeHandoff.current?.() } }
  }
  useEffect(() => {
    let active = true
    const openRequestedCanvas = async () => {
      if (!active || operation.current) return
      let request
      try { request = readScriptCanvasRequest(projectId) }
      catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); return }
      if (!request?.result.design_id || !request.canvas_id || request.canvas_id === activeIdRef.current) return
      if (!actions.current) return
      operation.current = true; setBusy(true); setError('')
      try {
        if (!await actions.current.leave() || !active) return
        const next = await reload()
        if (!active) return
        const current = readScriptCanvasRequest(projectId)
        if (!current || current.id !== request.id) return
        const target = next.find(canvas => canvas.id === current.canvas_id)
        if (!target) throw new Error('新方案画布尚未读取，请重试打开画布')
        select(target)
      } catch (issue) { if (active) setError(issue instanceof Error ? issue.message : String(issue)) }
      finally {
        operation.current = false
        if (active) {
          setBusy(false)
          // A newer request can arrive while edits are saving or metadata is loading.
          // Resume that request once, while a failed current request waits for an explicit retry.
          try { if (readScriptCanvasRequest(projectId)?.id !== request.id) void openRequestedCanvas() }
          catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
        }
      }
    }
    const open = () => { void openRequestedCanvas() }
    resumeHandoff.current = open
    open(); window.addEventListener('script-canvas-open', open)
    return () => { active = false; resumeHandoff.current = null; window.removeEventListener('script-canvas-open', open) }
  }, [projectId])
  const switchTo = (canvas: ProjectCanvasInfo) => void perform(async () => {
    if (canvas.id === activeId) return
    if (!actions.current || !await actions.current.leave()) return
    select(canvas)
  })
  const create = () => void perform(async () => {
    if (!actions.current || !await actions.current.leave()) return
    const canvas = await api<ProjectCanvasInfo>(`/projects/${projectId}/canvases`, json('POST', {}))
    setCanvases(current => [...current, canvas]); select(canvas)
  })
  const remove = () => active && void perform(async () => {
    if (!actions.current || !await actions.current.leave()) return
    const revision = actions.current.revision()
    if (!revision) throw new Error('画布尚未加载')
    if (!await confirm({ title: `删除「${active.name}」`, message: '删除这张画布的节点和连线。项目中的镜头、素材、视觉设定和生成任务会保留。', confirmLabel: '删除画布', danger: true })) return
    const result = await api<{ canvas_id: string }>(`/projects/${projectId}/canvases/${active.id}`, json('DELETE', { revision }))
    sessions.current.delete(active.id)
    for (const key of [`project-canvas-draft:${active.id === projectId ? projectId : `${projectId}:${active.id}`}`, `project-canvas-viewport:${active.id === projectId ? projectId : `${projectId}:${active.id}`}`]) {
      try { window.localStorage.removeItem(key) } catch { /* Storage may be disabled. */ }
    }
    const next = await reload()
    select(next.find(canvas => canvas.id === result.canvas_id) || next[0])
  })
  const move = (target: ProjectCanvasInfo) => void perform(async () => {
    if (!actions.current || !await actions.current.move(target.id)) return
    const session = sessions.current.get(target.id)
    if (session) { session.history = { past: [], future: [] }; session.selection = undefined }
    await reload(); select(target)
  })
  const viewportChanged = (viewport: ProjectCanvasInfo['viewport']) => {
    if (!active) return
    setCanvases(current => current.map(canvas => canvas.id === active.id ? { ...canvas, viewport } : canvas))
    const previous = viewportWrites.current.get(active.id) || Promise.resolve()
    const pending = previous.catch(() => {}).then(() => api(`/projects/${projectId}/canvases/${active.id}`, json('PATCH', { viewport })))
    viewportWrites.current.set(active.id, pending)
    void pending.catch(issue => {
      if (mounted.current) setError(`画布视角保存失败：${issue instanceof Error ? issue.message : String(issue)}`)
    })
  }
  if (!active) return <div className="pc-loading">{error || <><LoaderCircle size={20} className="pc-spin" />正在载入画布</>}{error && <Button onClick={() => window.location.reload()}>重新载入</Button>}</div>
  let session = sessions.current.get(active.id)
  if (!session) { session = { history: { past: [], future: [] } }; sessions.current.set(active.id, session) }
  const menu = <div className="pc-canvas-switcher" data-canvas-overlay>
    <Menu position="bottom-start" width={280} shadow="md" withinPortal>
      <Menu.Target><UnstyledButton type="button" className="pc-canvas-switch-button" aria-label="切换画布" disabled={busy}><span>{active.name}</span><ChevronDown size={15} /></UnstyledButton></Menu.Target>
      <Menu.Dropdown data-canvas-overlay>
        <div className="pc-canvas-menu-heading"><span>画布</span><ActionIcon type="button" aria-label="新增画布" disabled={busy} onClick={create} data-workspace-control=""><Plus size={19} /></ActionIcon></div>
        {canvases.map(canvas => <Menu.Item key={canvas.id} onClick={() => switchTo(canvas)} disabled={busy} rightSection={canvas.id === active.id ? <Check size={17} /> : undefined}><span className="pc-canvas-menu-name">{canvas.name}</span></Menu.Item>)}
        <Menu.Divider />
        <Menu.Item leftSection={<PenLine size={15} />} onClick={() => { setEditing(active); setName(active.name) }} disabled={busy}>重命名当前画布</Menu.Item>
        {canvases.length > 1 && <Menu.Sub><Menu.Sub.Target><Menu.Sub.Item leftSection={<ArrowRight size={15} />} disabled={busy}>将所选节点移至</Menu.Sub.Item></Menu.Sub.Target><Menu.Sub.Dropdown data-canvas-overlay>{canvases.filter(canvas => canvas.id !== active.id).map(canvas => <Menu.Item key={canvas.id} onClick={() => move(canvas)}>{canvas.name}</Menu.Item>)}</Menu.Sub.Dropdown></Menu.Sub>}
        <Menu.Item leftSection={<Trash2 size={15} />} color="red" disabled={busy || canvases.length < 2} onClick={remove}>删除当前画布</Menu.Item>
      </Menu.Dropdown>
    </Menu>
    {error && <span className="pc-canvas-switch-error" role="alert" title={error}>{error}</span>}
  </div>
  return <>
    {children(active, session, menu, register, viewportChanged)}
    {dialog}
    <Modal opened={!!editing} onClose={() => { if (!busy) setEditing(null) }} title="重命名画布" size="sm">
      <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        if (!editing || !name.trim()) return
        const updated = await api<ProjectCanvasInfo>(`/projects/${projectId}/canvases/${editing.id}`, json('PATCH', { name: name.trim() }))
        setCanvases(current => current.map(canvas => canvas.id === updated.id ? updated : canvas)); setEditing(null)
      }) }}><TextInput label="画布名称" value={name} maxLength={80} onChange={event => setName(event.currentTarget.value)} autoFocus />
      <Button type="submit" disabled={!name.trim()} loading={busy} mt="md">保存名称</Button></form>
    </Modal>
  </>
}

export default memo(ProjectCanvasSwitcher)
