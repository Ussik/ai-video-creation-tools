import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditingCut } from '@video-studio/shared/media/editing-cut'
import { api, json } from '../../shared/api/api'
import { editingCutInput } from './editing-cut-preview'

export function editingCutDraftKey(projectId: string, cutId: string) { return `editing-cut-draft:${projectId}:${cutId}` }

export function useEditingCuts(projectId: string, sourceCanvasId?: string | null) {
  const [cuts, setCuts] = useState<EditingCut[]>([])
  const [draft, setDraft] = useState<EditingCut | null>(null)
  const [saved, setSaved] = useState<EditingCut | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [conflict, setConflict] = useState(false), [restored, setRestored] = useState(false)
  const request = useRef(0), project = useRef(projectId), busyRef = useRef(false)
  project.current = projectId
  const draftRef = useRef(draft); draftRef.current = draft
  const dirty = !!draft && !!saved && JSON.stringify(editingCutInput(draft)) !== JSON.stringify(editingCutInput(saved))
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty

  function install(cut: EditingCut | null, restore = true) {
    setSaved(cut); setError(''); setConflict(false); setRestored(false)
    let next = cut
    if (cut && restore) {
      try {
        const local = JSON.parse(sessionStorage.getItem(editingCutDraftKey(projectId, cut.id)) || 'null') as EditingCut | null
        if (local?.id === cut.id && local.project_id === projectId && Array.isArray(local.clips) && Array.isArray(local.speech) && Array.isArray(local.captions)) {
          next = local; setRestored(true)
          if (local.revision !== cut.revision) { setConflict(true); setError('服务器版本已变化，已保留你的本地草稿。可另存为新剪辑，或重新读取服务器版本。') }
        }
      } catch { /* An unreadable local cache never replaces server data. */ }
    }
    setDraft(next)
    if (cut) try { sessionStorage.setItem(`editing-cut-active:${projectId}`, cut.id) } catch { /* optional cache */ }
  }

  const load = useCallback(async () => {
    const sequence = ++request.current
    setLoading(true); setError('')
    try {
      const result = await api<{ cuts: EditingCut[] }>(`/projects/${projectId}/editing-cuts`)
      if (sequence !== request.current || project.current !== projectId) return
      setCuts(result.cuts)
      let remembered: string | null = null
      try { remembered = sessionStorage.getItem(`editing-cut-active:${projectId}`) } catch { /* optional cache */ }
      const current = result.cuts.find(cut => cut.id === draftRef.current?.id || cut.id === remembered)
        || result.cuts.find(cut => sourceCanvasId && cut.source_canvas_id === sourceCanvasId) || result.cuts[0] || null
      install(current)
    } catch (issue) { if (sequence === request.current) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (sequence === request.current) setLoading(false) }
  }, [projectId])

  useEffect(() => {
    setDraft(null); setSaved(null); setCuts([]); busyRef.current = false; setBusy(false); void load()
    return () => { request.current += 1 }
  }, [load])

  useEffect(() => {
    if (!draft || draft.project_id !== projectId) return
    try {
      const key = editingCutDraftKey(projectId, draft.id)
      if (dirty) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key)
    } catch { /* Editing remains available when browser storage is full. */ }
  }, [draft, dirty, projectId])

  useEffect(() => {
    function guard(event: BeforeUnloadEvent) {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])

  function update(change: (cut: EditingCut) => EditingCut) { setDraft(current => current ? change(current) : current) }
  function select(id: string) { const cut = cuts.find(item => item.id === id); if (cut) install(cut) }
  function discard() {
    if (draft) try { sessionStorage.removeItem(editingCutDraftKey(projectId, draft.id)) } catch { /* optional cache */ }
    install(saved, false)
  }
  async function save(): Promise<EditingCut | null> {
    const cut = draftRef.current
    if (!cut || busyRef.current) return null
    busyRef.current = true; setBusy(true); setError('')
    try {
      const result = await api<EditingCut>(`/projects/${projectId}/editing-cuts/${cut.id}`, json('PUT', editingCutInput(cut)))
      if (project.current !== projectId || draftRef.current?.id !== cut.id) return null
      setCuts(current => current.map(item => item.id === result.id ? result : item)); install(result, false)
      return result
    } catch (issue) {
      if (project.current === projectId) {
        setConflict((issue as Error & { status?: number }).status === 409)
        setError(issue instanceof Error ? issue.message : String(issue))
      }
      return null
    } finally { if (project.current === projectId) { busyRef.current = false; setBusy(false) } }
  }
  async function create(name: string, ratio: '16:9' | '9:16', copy = false): Promise<EditingCut | null> {
    if (busyRef.current) return null
    busyRef.current = true; setBusy(true); setError('')
    const original = draftRef.current
    try {
      let result = await api<EditingCut>(`/projects/${projectId}/editing-cuts`, json('POST', { name, ratio, source_canvas_id: sourceCanvasId || null }))
      if (copy && original) result = await api<EditingCut>(`/projects/${projectId}/editing-cuts/${result.id}`,
        json('PUT', { ...editingCutInput(original), name, revision: result.revision, source_canvas_id: sourceCanvasId || null }))
      if (project.current !== projectId) return null
      if (copy && original) try { sessionStorage.removeItem(editingCutDraftKey(projectId, original.id)) } catch { /* optional cache */ }
      setCuts(current => [result, ...current]); install(result, false)
      return result
    } catch (issue) { if (project.current === projectId) setError(issue instanceof Error ? issue.message : String(issue)); return null }
    finally { if (project.current === projectId) { busyRef.current = false; setBusy(false) } }
  }
  return { cuts, draft, dirty, busy, loading, error, conflict, restored, load, update, select, discard, save, create }
}
