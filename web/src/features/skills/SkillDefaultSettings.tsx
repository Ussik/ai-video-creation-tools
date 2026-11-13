import { useEffect, useState } from 'react'
import { Button, SegmentedControl } from '@mantine/core'
import CreativeSkillSelector from './CreativeSkillSelector'
import { api } from '../../shared/api/api'
import type { SkillTaskKind, SkillTaskPolicy } from '../../shared/api/skills-api'
import { skillTaskDefinitions } from '@video-studio/shared/skills/skill-recommendation'
import { SKILLS_LIBRARY_CHANGED } from './skills-library-events'

export default function SkillDefaultSettings({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const [scope, setScope] = useState('global')
  const [policies, setPolicies] = useState<SkillTaskPolicy[]>([]), [overrides, setOverrides] = useState<Partial<Record<SkillTaskKind, string[]>>>({})
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => { if (!projectId) setScope('global') }, [projectId])
  const selectedProject = scope === 'project' ? projectId : undefined
  useEffect(() => { setPolicies([]); setOverrides({}) }, [selectedProject])
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener(SKILLS_LIBRARY_CHANGED, refresh)
    return () => window.removeEventListener(SKILLS_LIBRARY_CHANGED, refresh)
  }, [])
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError('')
    api<{ policies: SkillTaskPolicy[] }>(selectedProject ? `/projects/${selectedProject}/skills/task-defaults` : '/skills/task-defaults', { signal: abort.signal })
      .then(value => {
        if (!Array.isArray(value.policies) || !value.policies.length) throw new Error('任务技能配置返回格式无效，请重新读取')
        if (!abort.signal.aborted) setPolicies(value.policies)
      })
      .catch(issue => { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [selectedProject, revision])
  const reload = (task?: SkillTaskKind) => {
    if (task) setOverrides(current => { const next = { ...current }; delete next[task]; return next })
    setRevision(value => value + 1)
  }
  return <section className="creative-skill-defaults" aria-label="默认创作技能">
    <header><div><h2>默认创作技能</h2><p>按具体功能配置固定的主技能与必要的辅助技能。辅助默认不选；手动选择优先，项目配置覆盖全局配置。自由对话仍可由模型选择技能。</p></div>
      {projectId && <SegmentedControl value={scope} onChange={setScope} data={[{ value: 'global', label: '全局默认' }, { value: 'project', label: '当前项目' }]} />}</header>
    {scope === 'project' && <p className="creative-skill-description">项目：{projectName}</p>}
    {error && <p className="creative-skill-error" role="alert">{error}<Button onClick={() => reload()} data-workspace-control="" variant="subtle">重试</Button></p>}
    {loading && <p role="status" className="creative-skill-description">正在读取默认配置…</p>}
    {skillTaskDefinitions.flatMap(definition => {
      const policy = policies.find(item => item.task === definition.kind)
      if (!policy) return []
      const ids = overrides[policy.task] ?? (policy.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : [])
      return [<div className="creative-skill-default-row" key={policy.task} data-skill-task={policy.task}><div><strong>{policy.label}</strong><small>{policy.source === 'project' ? '项目自定义' : policy.source === 'builtin' ? '内置默认' : '全局默认'}</small></div>
        <CreativeSkillSelector stage={policy.stage} policies={[policy]} ids={ids} onChange={values => setOverrides(current => ({ ...current, [policy.task]: values }))}
          selection={{ source: overrides[policy.task] !== undefined ? 'manual' : 'default', task_kind: policy.task, task_label: `${policy.label} · 固定技能`, reason: '此处配置该功能的主技能与辅助技能，保存后生效。' }}
          projectId={selectedProject} loading={loading} error={error} onDefaultsChanged={() => reload(policy.task)} /></div>]
    })}
  </section>
}
