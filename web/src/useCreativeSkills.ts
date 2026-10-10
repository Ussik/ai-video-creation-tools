import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { SkillPolicy, SkillSelections, SkillStage } from './skills-api'

export function useCreativeSkills(projectId?: string, active = true) {
  const [policies, setPolicies] = useState<SkillPolicy[]>([]), [overrides, setOverrides] = useState<SkillSelections>({})
  const [loadedScope, setLoadedScope] = useState<string | undefined>(projectId)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => { setOverrides({}); setPolicies([]) }, [projectId])
  useEffect(() => { if (!active) setOverrides({}) }, [active])
  useEffect(() => {
    if (!active) return
    const abort = new AbortController(); setLoading(true); setError('')
    api<{ policies: SkillPolicy[] }>(projectId ? `/projects/${projectId}/skills/defaults` : '/skills/defaults', { signal: abort.signal })
      .then(value => { if (!Array.isArray(value.policies) || !value.policies.length) throw new Error('技能配置返回格式无效，请重新读取'); if (!abort.signal.aborted) { setPolicies(value.policies); setLoadedScope(projectId) } })
      .catch(issue => { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [projectId, active, revision])
  const scopedPolicies = loadedScope === projectId ? policies : []
  const ids = (stage: SkillStage) => {
    if (loadedScope !== projectId) return []
    const policy = scopedPolicies.find(item => item.stage === stage)
    return overrides[stage] ?? (policy?.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : [])
  }
  const change = (stage: SkillStage, values: string[]) => setOverrides(current => ({ ...current, [stage]: values }))
  const reload = useCallback((stage?: SkillStage) => { setOverrides(current => { if (!stage) return {}; const next = { ...current }; delete next[stage]; return next }); setRevision(value => value + 1) }, [])
  const selections: SkillSelections = scopedPolicies.length ? Object.fromEntries(scopedPolicies.map(policy => [policy.stage, ids(policy.stage)])) : {}
  return { policies: scopedPolicies, ids, change, selections, error, loading: loading || active && !scopedPolicies.length && !error, reload }
}
