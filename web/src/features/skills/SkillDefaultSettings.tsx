import { useEffect, useState } from 'react'
import { Button, SegmentedControl } from '@mantine/core'
import CreativeSkillSelector from './CreativeSkillSelector'
import { useCreativeSkills } from './useCreativeSkills'

export default function SkillDefaultSettings({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const [scope, setScope] = useState('global')
  useEffect(() => { if (!projectId) setScope('global') }, [projectId])
  const selectedProject = scope === 'project' ? projectId : undefined
  const skills = useCreativeSkills(selectedProject)
  return <section className="creative-skill-defaults" aria-label="默认创作技能">
    <header><div><h2>默认创作技能</h2><p>各环节选择一个主技能，其他同类技能保留为备选。项目可以覆盖全局默认。</p></div>
      {projectId && <SegmentedControl value={scope} onChange={setScope} data={[{ value: 'global', label: '全局默认' }, { value: 'project', label: '当前项目' }]} />}</header>
    {scope === 'project' && <p className="creative-skill-description">项目：{projectName}</p>}
    {skills.error && <p className="creative-skill-error" role="alert">{skills.error}<Button onClick={() => skills.reload()} data-workspace-control="" variant="subtle">重试</Button></p>}
    {skills.loading && <p role="status" className="creative-skill-description">正在读取默认配置…</p>}
    {skills.policies.map(policy => <div className="creative-skill-default-row" key={policy.stage}><div><strong>{policy.label}</strong><small>{policy.source === 'project' ? '项目自定义' : '全局默认'}</small></div>
      <CreativeSkillSelector stage={policy.stage} policies={skills.policies} ids={skills.ids(policy.stage)} onChange={values => skills.change(policy.stage, values)}
        projectId={selectedProject} loading={skills.loading} error={skills.error} onDefaultsChanged={() => skills.reload(policy.stage)} /></div>)}
  </section>
}
