import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { SkillPolicy, SkillSelections, SkillStage } from './skills-api'
import { MAX_AUXILIARY_SKILLS, skillStageOptions } from './skills-api'

function readSelections(key?: string): SkillSelections {
  if (!key) return {}
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const selections: SkillSelections = {}
    for (const { value: stage } of skillStageOptions) {
      const ids = value[stage]
      if (Array.isArray(ids) && ids.length <= MAX_AUXILIARY_SKILLS + 1
        && ids.every(id => typeof id === 'string' && id.trim()) && new Set(ids).size === ids.length) selections[stage] = ids
    }
    return selections
  } catch { return {} }
}
function writeSelections(key: string, selections: SkillSelections) {
  try { window.localStorage.setItem(key, JSON.stringify(selections)) } catch { /* Storage may be disabled. */ }
}

export function useCreativeSkills(projectId?: string, active = true, { rememberSelections = false }: { rememberSelections?: boolean } = {}) {
  const storageKey = rememberSelections && projectId ? `creative-prompt-skills:${projectId}` : undefined
  const [policies, setPolicies] = useState<SkillPolicy[]>([]), [overrides, setOverrides] = useState<SkillSelections>(() => readSelections(storageKey))
  const [loadedScope, setLoadedScope] = useState<string | undefined>(projectId)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => { setOverrides(readSelections(storageKey)); setPolicies([]) }, [projectId, storageKey])
  useEffect(() => { if (!active && !storageKey) setOverrides({}) }, [active, storageKey])
  useEffect(() => {
    if (!active) return
    const abort = new AbortController(); setLoading(true); setError('')
    api<{ policies: SkillPolicy[] }>(projectId ? `/projects/${projectId}/skills/defaults` : '/skills/defaults', { signal: abort.signal })
      .then(value => { if (!Array.isArray(value.policies) || !value.policies.length) throw new Error('技能配置返回格式无效，请重新读取'); if (!abort.signal.aborted) { setPolicies(value.policies); setLoadedScope(projectId) } })
      .catch(issue => { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [projectId, active, revision, storageKey])
  const scopedPolicies = loadedScope === projectId ? policies : []
  const ids = (stage: SkillStage) => {
    if (loadedScope !== projectId) return []
    const policy = scopedPolicies.find(item => item.stage === stage)
    return overrides[stage] ?? (policy?.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : [])
  }
  const change = (stage: SkillStage, values: string[]) => {
    setOverrides(current => ({ ...current, [stage]: values }))
    // Merge the latest stored choices so another node/stage cannot overwrite
    // selections made since this editor mounted.
    if (storageKey) writeSelections(storageKey, { ...readSelections(storageKey), [stage]: values })
  }
  const reload = useCallback((stage?: SkillStage, { keepSelection = false }: { keepSelection?: boolean } = {}) => {
    if (!keepSelection) {
      setOverrides(current => { if (!stage) return {}; const next = { ...current }; delete next[stage]; return next })
      if (storageKey) {
        const next = stage ? readSelections(storageKey) : {}
        if (stage) delete next[stage]
        writeSelections(storageKey, next)
      }
    }
    setRevision(value => value + 1)
  }, [storageKey])
  const selections: SkillSelections = scopedPolicies.length ? Object.fromEntries(scopedPolicies.map(policy => [policy.stage, ids(policy.stage)])) : {}
  return { policies: scopedPolicies, ids, change, selections, error, loading: loading || active && !scopedPolicies.length && !error, reload }
}
