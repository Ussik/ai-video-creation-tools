import { useCallback, useEffect, useState } from 'react'
import { api } from '../../shared/api/api'
import type { CreativeSkillSelection, SkillPolicy, SkillSelections, SkillStage, SkillTaskContext } from '../../shared/api/skills-api'
import { MAX_AUXILIARY_SKILLS, skillStageOptions } from '../../shared/api/skills-api'
import { SKILLS_LIBRARY_CHANGED } from './skills-library-events'

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

type CreativeSkillOptions = { rememberSelections?: boolean; task?: SkillTaskContext; automatic?: boolean }

export function useCreativeSkills(projectId?: string, active = true, { rememberSelections = false, automatic = true }: CreativeSkillOptions = {}) {
  const storageKey = rememberSelections && projectId ? `creative-prompt-skills:${projectId}` : undefined
  const [policies, setPolicies] = useState<SkillPolicy[]>([]), [overrides, setOverrides] = useState<SkillSelections>(() => readSelections(storageKey))
  const [loadedScope, setLoadedScope] = useState<string | undefined>(projectId)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => { setOverrides(readSelections(storageKey)); setPolicies([]) }, [projectId, storageKey])
  useEffect(() => { if (!active && !storageKey) setOverrides({}) }, [active, storageKey])
  useEffect(() => {
    // A library update refreshes available versions without changing the creator's choices.
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener(SKILLS_LIBRARY_CHANGED, refresh)
    return () => window.removeEventListener(SKILLS_LIBRARY_CHANGED, refresh)
  }, [])
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
  const selection = (stage: SkillStage): CreativeSkillSelection => {
    if (loadedScope !== projectId) return { ids: [], source: 'default', reason: '', task_label: '' }
    const policy = scopedPolicies.find(item => item.stage === stage)
    if (!policy) return { ids: [], source: 'default', reason: '', task_label: '' }
    const manual = overrides[stage]
    if (manual !== undefined) return { ids: [...manual], source: 'manual', task_label: '手动选择',
      reason: storageKey ? '沿用你在此浏览器为本项目记住的选择。' : '沿用你为本次创作选择的技能。' }
    if (automatic) return { ids: [], source: 'automatic', task_label: '模型自动选择',
      reason: '发送任务后，由模型根据任务和可用技能选择；实际使用的技能与选择理由会显示在执行结果中。' }
    return { ids: policy.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : [], source: 'default', reason: '', task_label: '' }
  }
  const ids = (stage: SkillStage) => selection(stage).ids
  const requestIds = (stage: SkillStage) => {
    const selected = selection(stage)
    return selected.source === 'automatic' ? undefined : [...selected.ids]
  }
  const change = (stage: SkillStage, values: string[]) => {
    setOverrides(current => ({ ...current, [stage]: [...values] }))
    // Merge the latest stored choices so another node/stage cannot overwrite
    // selections made since this editor mounted.
    if (storageKey) writeSelections(storageKey, { ...readSelections(storageKey), [stage]: values })
  }
  const useAutomatic = useCallback((stage?: SkillStage) => {
    setOverrides(current => { if (!stage) return {}; const next = { ...current }; delete next[stage]; return next })
    if (storageKey) {
      const next = stage ? readSelections(storageKey) : {}
      if (stage) delete next[stage]
      writeSelections(storageKey, next)
    }
  }, [storageKey])
  const reload = useCallback((stage?: SkillStage, { keepSelection = false }: { keepSelection?: boolean } = {}) => {
    if (!keepSelection) useAutomatic(stage)
    setRevision(value => value + 1)
  }, [useAutomatic])
  // Omitted stages are selected by the model during execution. An explicit []
  // remains a creator's instruction to use only the built-in rules.
  const snapshot = (): SkillSelections => scopedPolicies.length
    ? Object.fromEntries(scopedPolicies.filter(policy => overrides[policy.stage] !== undefined)
      .map(policy => [policy.stage, [...overrides[policy.stage]!]])) : {}
  const selections = snapshot()
  return { policies: scopedPolicies, ids, requestIds, selection, change, selections, snapshot, useAutomatic, error,
    loading: loading || active && !scopedPolicies.length && !error, reload }
}
