import { useEffect, useRef, useState } from 'react'
import { api, json } from '../../shared/api/api'
import { isScriptThemeCategory, type ScriptThemeCategory } from '@video-studio/shared/script/script-theme-catalog'

type Visuals = { primary: ScriptThemeCategory | null; fusion: ScriptThemeCategory | null }
type Match = { key: string; status: 'pending' | 'ready' | 'error'; visuals?: Visuals }
export function useThemeVisuals(projectId: string, modelId: string, genre: string, fusion: string, open: boolean) {
  const cache = useRef(new Map<string, Visuals>())
  const [match, setMatch] = useState<Match | null>(null)
  const [retry, setRetry] = useState(0)
  const key = JSON.stringify([projectId, modelId, genre, fusion])
  const needsMatch = Boolean((genre && !isScriptThemeCategory(genre)) || (fusion && !isScriptThemeCategory(fusion)))
  useEffect(() => {
    if (!open || !needsMatch || !modelId) return
    const cached = cache.current.get(key)
    if (cached) { setMatch({ key, status: 'ready', visuals: cached }); return }
    const controller = new AbortController()
    setMatch({ key, status: 'pending' })
    // Rapid wheel/drag selections should not start a model request per step.
    const timer = window.setTimeout(() => {
      void api<Visuals>(`/projects/${projectId}/script/themes/visuals`, {
        ...json('POST', { model_id: modelId, genre, genre_fusion: fusion }), signal: controller.signal,
      }).then(visuals => {
        if (controller.signal.aborted) return
        if (cache.current.size >= 20) cache.current.delete(cache.current.keys().next().value!)
        cache.current.set(key, visuals)
        setMatch({ key, status: 'ready', visuals })
      }).catch(() => {
        if (!controller.signal.aborted) setMatch({ key, status: 'error' })
      })
    }, 300)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [key, projectId, modelId, genre, fusion, open, needsMatch, retry])
  const current = match?.key === key ? match : null
  return {
    primary: isScriptThemeCategory(genre) ? genre : current?.visuals?.primary || null,
    fusion: isScriptThemeCategory(fusion) ? fusion : current?.visuals?.fusion || null,
    status: needsMatch ? !modelId ? 'unavailable' : current?.status || 'pending' : 'ready',
    retry: () => setRetry(value => value + 1),
  }
}
