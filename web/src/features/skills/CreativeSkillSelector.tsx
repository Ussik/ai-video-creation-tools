import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { useState } from 'react'
import { UnstyledButton, Button, MultiSelect, Popover, Select, type PopoverProps } from '@mantine/core'
import { ChevronDown, Puzzle, SlidersHorizontal } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { CreativeSkillSelection, SkillPolicy, SkillStage } from '../../shared/api/skills-api'
import { skillStageOptions, MAX_AUXILIARY_SKILLS } from '../../shared/api/skills-api'
import './creative-skills.css'

type Props = { stage: SkillStage; policies: SkillPolicy[]; ids: string[]; onChange: (ids: string[]) => void;
  selection?: Pick<CreativeSkillSelection, 'source' | 'reason' | 'task_label' | 'task_kind'>; onUseAutomatic?: () => void;
  projectId?: string; disabled?: boolean; onDefaultsChanged?: () => void; onRetry?: () => void; loading?: boolean; error?: string; appearance?: 'default' | 'chat' | 'planner' | 'prompt'; position?: PopoverProps['position']; triggerLabel?: string; withinPortal?: boolean }
export default function CreativeSkillSelector({ stage, policies, ids, onChange, selection, onUseAutomatic, projectId, disabled, onDefaultsChanged, onRetry, loading, error: loadError, appearance = 'default', position, triggerLabel, withinPortal = true }: Props) {
  const [opened, setOpened] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const policy = policies.find(item => item.stage === stage), skills = policy?.skills || []
  const stageLabel = policy?.label || skillStageOptions.find(item => item.value === stage)!.label
  const primary = skills.find(skill => skill.id === ids[0]), missing = ids.some(id => !skills.some(skill => skill.id === id))
  const rulesOnlySkills = skills.filter(skill => ids.includes(skill.id) && skill.integration?.mode === 'rules_only' && skill.integration.tool_requirements.length)
  const automatic = selection?.source === 'automatic'
  const fixedTask = selection?.task_kind
  const restoreLabel = fixedTask ? '恢复按功能分配' : '恢复模型自动选择'
  const defaultIds = policy?.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : []
  const matchesDefaults = !!policy && ids.length === defaultIds.length && ids.every((id, index) => id === defaultIds[index])
  const selectionSource = !policy ? '配置未读取' : automatic ? '模型自动选择' : selection?.source === 'manual' ? appearance === 'prompt' ? '已记住的选择' : '手动选择'
    : fixedTask ? '按功能分配' : matchesDefaults ? policy.source === 'project' ? '项目默认' : policy.source === 'builtin' ? '内置默认' : '全局默认' : appearance === 'prompt' ? '已记住的选择' : '本次选择'
  const contextual = appearance === 'planner' || appearance === 'prompt'
  const operationLabel = appearance === 'planner' ? '规划' : '整理'
  const menuLabel = appearance === 'planner' ? '分镜规划技能' : `${stageLabel}技能`
  async function save(reset = false) {
    setPending(true); setError(''); setNotice('')
    try {
      const scope = projectId ? `/projects/${projectId}/skills` : '/skills'
      const url = fixedTask ? `${scope}/task-defaults/${fixedTask}` : `${scope}/defaults/${stage}`
      await api(url, reset ? { method: 'DELETE' } : json('PUT', { primary_id: ids[0] || null, auxiliary_ids: ids.slice(1) }))
      onDefaultsChanged?.(); setNotice(reset ? projectId ? '已恢复全局默认' : '已恢复内置默认' : projectId ? '已保存为本项目默认' : '已保存为全局默认')
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setPending(false) }
  }
  const compact = appearance !== 'default', variant = compact ? ` is-${appearance}` : ''
  const defaultsActions = <footer>{(projectId || fixedTask) && <Button variant="subtle" size="xs" disabled={pending || disabled || !!loadError || !policy} onClick={() => void save(true)}>{projectId ? '恢复全局默认' : '恢复内置默认'}</Button>}
    <Button variant="default" size="xs" disabled={pending || disabled || automatic || missing || !policy || !!loadError} onClick={() => void save()}>{projectId ? '设为项目默认' : '设为全局默认'}</Button></footer>
  return <Popover opened={opened} onChange={value => { if (!pending) { setOpened(value); setNotice(''); setError('') } }} withinPortal={withinPortal} position={position || (appearance === 'chat' ? 'top-end' : 'bottom-start')} offset={8} withArrow={false} shadow="md" width="min(360px, calc(100vw - 32px))" zIndex={370}
    middlewares={compact ? { shift: { padding: 12 }, size: { padding: 12, apply: ({ availableHeight, elements }) => {
      elements.floating.style.maxHeight = `${Math.max(0, Math.min(460, availableHeight))}px`
    } } } : undefined}>
    <Popover.Target><UnstyledButton type="button" className={`creative-skill-trigger${variant}${triggerLabel ? ' is-label' : ''}`} aria-label={`${stageLabel}技能选择`} aria-expanded={opened} disabled={disabled || loading || pending}
      onClick={() => { setOpened(value => !value); setNotice(''); setError('') }}>{triggerLabel ? <><SlidersHorizontal size={14} /><span>{triggerLabel}</span></> : <><Puzzle size={14} /><span><span>{loading ? '正在读取技能' : loadError ? '技能配置未读取' : automatic ? '模型自动选择' : missing ? '技能需重新选择' : primary?.name || '基础创作规则'}</span>{ids.length > 1 && <small>辅助 {ids.length - 1}</small>}</span><ChevronDown size={12} /></>}</UnstyledButton></Popover.Target>
    {/* The portaled panel is still part of the node's editing session. */}
    <Popover.Dropdown className={`creative-skill-popover${variant}`} aria-label={contextual ? menuLabel : undefined} data-canvas-overlay>
      <header><strong>{menuLabel}</strong><span>{selection || contextual ? selectionSource : projectId ? policy?.source === 'project' ? '项目默认' : '沿用全局默认' : '全局默认'}</span></header>
      {(loadError || error || policy?.warning) && <p className="creative-skill-error" role="alert">{error || loadError || policy?.warning}</p>}
      {loadError && <Button size="xs" variant="subtle" onClick={onRetry || onDefaultsChanged}>重新读取配置</Button>}
      {selection && !!policy && <section className="creative-skill-recommendation" aria-label="技能分配依据">
        {selection.task_label && <strong>{selection.task_label}</strong>}
        {selection.reason && <p>{selection.reason}</p>}
        {selection.source === 'manual' && onUseAutomatic && <Button variant="subtle" size="xs" disabled={pending || disabled || !!loadError}
          onClick={() => { onUseAutomatic(); setNotice(fixedTask ? '已恢复按功能分配' : '已恢复模型自动选择') }}>{restoreLabel}</Button>}
      </section>}
      <Select label="主技能" aria-label={`${stage}主技能`} value={automatic ? '__automatic__' : ids[0] || '__base__'} allowDeselect={false} disabled={pending || disabled || !!loadError || !policy} searchable
        data={[...(onUseAutomatic && !fixedTask ? [{ value: '__automatic__', label: '模型自动选择' }] : []), { value: '__base__', label: '基础创作规则（不使用外部 Skill）' }, ...skills.map(skill => ({ value: skill.id, label: skill.name }))]} comboboxProps={{ withinPortal: false }}
        onOptionSubmit={value => { if (value === '__automatic__') onUseAutomatic?.(); else onChange(value && value !== '__base__' ? [value, ...ids.slice(1).filter(id => id !== value)] : []); setNotice('') }} />
      {primary && (compact ? <WorkspaceDisclosure className="creative-skill-about" key={primary.id} label={<>查看技能说明</>}><p>{primary.description}</p></WorkspaceDisclosure> : <p className="creative-skill-description">{primary.description}</p>)}
      <MultiSelect label={`辅助技能 · 可选，最多 ${MAX_AUXILIARY_SKILLS} 个`} aria-label={`${stage}辅助技能`} value={ids.slice(1)} maxValues={MAX_AUXILIARY_SKILLS} disabled={pending || disabled || !ids.length || !!loadError} searchable
        data={skills.filter(skill => skill.id !== ids[0]).map(skill => ({ value: skill.id, label: skill.name }))} comboboxProps={{ withinPortal: false }}
        onChange={values => { onChange([ids[0], ...values]); setNotice('') }} />
      {!!rulesOnlySkills.length && <p className="creative-skill-note" aria-label="技能接入范围">{rulesOnlySkills.map(skill => skill.name).join('、')}：{rulesOnlySkills[0]!.integration!.note}</p>}
      {!contextual && <><p className="creative-skill-description">{fixedTask ? '此功能使用固定的主技能与辅助技能；手动更换仅影响本次操作，保存默认后供后续同类任务使用。' : onUseAutomatic ? '自由对话可由模型选择技能；手动选择后，本次任务按你的选择执行。先手动选择技能，才能保存为默认。' : '保存默认后，供后续创作使用；辅助技能补充主技能，项目设定和你的明确要求优先。'}</p>
        {compact && <p className="creative-skill-note">辅助技能补充主技能，已确认设定和你的要求优先。</p>}</>}
      {notice && <p role="status" className="creative-skill-description">{notice}</p>}
      {contextual ? <WorkspaceDisclosure className="creative-skill-more-config" label={<>更多配置</>}>
        <p className="creative-skill-description">{appearance === 'prompt'
          ? '本项目会在此浏览器记住主技能和辅助技能，后续同类提示词整理会沿用。保存默认后，项目默认也会更新。'
          : `切换仅用于本次${operationLabel}；${fixedTask ? '默认按功能分配固定技能' : '自由任务可由模型选择'}，手动选择优先。`}</p>
        <p className="creative-skill-note">辅助技能补充主技能，已确认设定和你的要求优先。</p>
        {defaultsActions}
      </WorkspaceDisclosure> : defaultsActions}
    </Popover.Dropdown>
  </Popover>
}
