import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Loader, Modal, NumberInput, Select, Textarea, TextInput, UnstyledButton } from '@mantine/core'
import { AlertCircle, Clapperboard, Puzzle, Save } from 'lucide-react'
import type { ClipStoryboardCommitInput, ClipStoryboardContext, ClipStoryboardPlanInput, ClipStoryboardResult, ClipStoryboardShotDraft } from '@video-studio/shared/storyboard/clip-storyboard'
import { api, json, type Model, type ProjectDetail, type ScriptCanvasResult } from '../../shared/api/api'
import { useAppDialog } from '../../shared/ui/AppDialog'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import CreativeSkillSelector from '../skills/CreativeSkillSelector'
import './clip-storyboard-planner.css'

export type ClipStoryboardPlannerProps = {
  opened: boolean
  onClose: () => void
  detail: ProjectDetail
  models: Model[]
  onRefresh: () => Promise<unknown>
  onSaved: (result: ScriptCanvasResult) => void | Promise<void>
  onNotice: (message: string) => void
}
type Phase = 'context' | 'plan' | 'review' | 'save' | null
const fixedAssignment = { source: 'default' as const, task_kind: 'storyboard' as const, reason: '按分镜规划功能使用固定主技能与辅助技能，可以手动更换。', task_label: '分镜规划 · 按功能分配' }
const errorText = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
function planIssue(result: ClipStoryboardResult): string {
  if (!result.shots.length || result.shots.length > 30) return '需要 1 至 30 个镜头'
  if (result.shots.some(shot => !Number.isInteger(shot.duration) || shot.duration < 1 || shot.duration > 30)) return '每镜时长应为 1 至 30 秒'
  if (result.shots.reduce((sum, shot) => sum + shot.duration, 0) !== result.total_duration) return `镜头合计时长需要等于片段总时长 ${result.total_duration} 秒`
  if (result.shots.some(shot => !shot.title.trim() || !shot.prompt.trim() || !shot.image_prompt.trim() || !shot.video_prompt.trim())) return '请填写每镜标题、描述及图片和视频提示词'
  return ''
}

function ClipStoryboardPlannerContent({ opened, onClose, detail, models, onRefresh, onSaved, onNotice }: ClipStoryboardPlannerProps) {
  const dialog = useAppDialog({ zIndex: 390 })
  const [context, setContext] = useState<ClipStoryboardContext | null>(null), [contextRevision, setContextRevision] = useState(0)
  const [contextStale, setContextStale] = useState(false)
  const [sourceText, setSourceText] = useState(''), [duration, setDuration] = useState<number | string>(30), [shotsCount, setShotsCount] = useState<number | string>('')
  const [instructions, setInstructions] = useState('')
  const [targetVideoModelId, setTargetVideoModelId] = useState('')
  const [manualSkills, setManualSkills] = useState<string[] | null>(null)
  const [result, setResult] = useState<ClipStoryboardResult | null>(null), [view, setView] = useState<'setup' | 'preview'>('setup')
  const [phase, setPhase] = useState<Phase>(null), [error, setError] = useState(''), [guarding, setGuarding] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0), [savedResult, setSavedResult] = useState<ScriptCanvasResult | null>(null)
  const [resultModelId, setResultModelId] = useState('')
  const live = useRef(opened); live.current = opened
  const serial = useRef(0), operation = useRef(false), guardLock = useRef(false), controller = useRef<AbortController | null>(null)
  const applied = useRef<ScriptCanvasResult | null>(null), requestId = useRef('')
  const latest = useRef({ onClose, onRefresh, onSaved, onNotice }); latest.current = { onClose, onRefresh, onSaved, onNotice }
  const eligibleModels = models.filter(model => model.modality === 'text' && model.enabled)
  const videoModels = models.filter(model => model.modality === 'video' && model.enabled)
  const locked = !!phase || guarding
  const settingsLocked = locked || !!savedResult
  const { modelId: currentModel, selectModel } = useSharedModelSelection('text', eligibleModels, { active: opened, locked: settingsLocked })
  const automaticCount = String(shotsCount).trim() === ''
  const validDuration = Number.isInteger(Number(duration)) && Number(duration) >= 1 && Number(duration) <= 120
  const validCount = automaticCount || Number.isInteger(Number(shotsCount)) && Number(shotsCount) >= 1 && Number(shotsCount) <= 30
  const validSetup = !!sourceText.trim() && sourceText.trim().length <= 20_000 && instructions.length <= 4_000 && validDuration && validCount
  const issue = result && !savedResult && resultModelId !== currentModel ? '文本模型已切换，当前分镜预览仍保留，请重新规划后保存。' : result ? planIssue(result) : ''
  const skillIds = manualSkills ?? (context?.skill_policy.primary_id ? [context.skill_policy.primary_id, ...context.skill_policy.auxiliary_ids] : [])
  const primarySkill = context?.skills.find(skill => skill.id === skillIds[0])

  useEffect(() => {
    if (!opened) return
    setSourceText(''); setDuration(30); setShotsCount(''); setInstructions('')
    setTargetVideoModelId('')
    setManualSkills(null); setResult(null); setResultModelId(''); setSavedResult(null); setView('setup'); setError(''); setGuarding(false); setContextStale(false)
    applied.current = null; requestId.current = ''; guardLock.current = false
  }, [opened])
  useEffect(() => {
    const turn = ++serial.current
    controller.current?.abort(); operation.current = false
    if (!opened) { setPhase(null); return }
    const abort = new AbortController(); controller.current = abort
    setPhase('context'); setContext(null); setError('')
    api<ClipStoryboardContext>(`/projects/${detail.id}/storyboard/clip/context`, { signal: abort.signal })
      .then(value => { if (live.current && turn === serial.current && !abort.signal.aborted) { setContext(value); setContextStale(false) } })
      .catch(issue => { if (live.current && turn === serial.current && !abort.signal.aborted) setError(errorText(issue)) })
      .finally(() => { if (live.current && turn === serial.current && !abort.signal.aborted) setPhase(null) })
    return () => { serial.current++; abort.abort(); controller.current?.abort() }
  }, [opened, detail.id, contextRevision])
  useEffect(() => {
    if (!opened || !result || savedResult) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [opened, result, savedResult])

  async function confirmDiscard(): Promise<boolean> {
    if (!result || applied.current) return true
    if (guardLock.current) return false
    const turn = serial.current
    guardLock.current = true; setGuarding(true)
    const accepted = await dialog.confirm({ title: '放弃未保存的分镜预览？', message: '当前镜头预览和手动修改尚未保存，继续后将丢失。', confirmLabel: '放弃预览', cancelLabel: '继续编辑', danger: true })
    if (!live.current || turn !== serial.current) return false
    guardLock.current = false; setGuarding(false)
    return accepted
  }
  async function changeSettings(change: () => void) {
    if (operation.current || guardLock.current || savedResult) return
    const turn = serial.current
    if (!await confirmDiscard()) {
      if (live.current && turn === serial.current) setSettingsRevision(revision => revision + 1)
      return
    }
    if (!live.current || turn !== serial.current) return
    setResult(null); setResultModelId(''); requestId.current = ''; setError(''); change()
  }
  async function requestClose() {
    if (phase === 'save' || guardLock.current || !await confirmDiscard()) return
    serial.current++; controller.current?.abort(); operation.current = false
    latest.current.onClose()
  }
  async function startPlan() {
    if (!context || contextStale || !validSetup || !currentModel || operation.current || guardLock.current || applied.current) return
    if (!await confirmDiscard()) return
    if (!live.current || operation.current) return
    operation.current = true
    const turn = ++serial.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort
    const active = () => live.current && turn === serial.current && !abort.signal.aborted
    setPhase('plan'); setError(''); setResult(null)
    const input: ClipStoryboardPlanInput = { signature: context.signature, source_text: sourceText.trim(), total_duration: Number(duration), instructions,
      model_id: currentModel, ...(!automaticCount ? { shots_count: Number(shotsCount) } : {}), ...(manualSkills !== null ? { skill_ids: manualSkills } : {}),
      ...(targetVideoModelId ? { target_video_model_id: targetVideoModelId } : {}) }
    try {
      const value = await api<ClipStoryboardResult>(`/projects/${detail.id}/storyboard/clip/plan`, { ...json('POST', input), signal: abort.signal })
      if (!active()) return
      if ((value.target_video_model_id || '') !== targetVideoModelId) throw new Error('返回的目标视频模型不匹配，请重新规划')
      if (value.source_text !== input.source_text || value.total_duration !== input.total_duration || value.instructions !== input.instructions) throw new Error('返回的片段内容或规划设置不匹配，请重新规划')
      if (value.shots.some(shot => 'shot_id' in shot)) throw new Error('片段新方案包含旧镜头，请重新规划')
      const problem = planIssue(value)
      if (problem) throw new Error(`分镜规划结果未通过校验：${problem}`)
      requestId.current = crypto.randomUUID(); setResultModelId(currentModel); setResult(value); setView('preview')
    } catch (issue) {
      if (active()) { setError(errorText(issue)); if ((issue as { status?: number })?.status === 409) setContextStale(true) }
    }
    finally { if (active()) { operation.current = false; setPhase(null) } }
  }
  function updateShot(index: number, patch: Partial<ClipStoryboardShotDraft>) {
    if (operation.current || applied.current) return
    setResult(current => current && { ...current, shots: current.shots.map((shot, i) => i === index ? { ...shot, ...patch,
      ...(shot.continuity_plan ? { continuity_plan: { ...shot.continuity_plan, status: 'edited' as const } } : {}) } : shot),
      directing_review: current.directing_review ? { ...current.directing_review, status: 'edited', content_signature: undefined, issues: [] } : undefined })
  }
  async function reviewDraft() {
    if (!result || issue || operation.current || applied.current) return
    const candidate = result, turn = ++serial.current, abort = new AbortController(); controller.current = abort
    operation.current = true; setPhase('review'); setError('')
    try {
      const report = await api<NonNullable<ClipStoryboardResult['directing_review']>>(`/projects/${detail.id}/storyboard/clip/review`, { ...json('POST', {
        signature: candidate.signature, source_text: candidate.source_text, total_duration: candidate.total_duration, instructions: candidate.instructions,
        shots: candidate.shots, model_id: currentModel, ...(candidate.target_video_model_id ? { target_video_model_id: candidate.target_video_model_id } : {}),
      }), signal: abort.signal })
      if (live.current && turn === serial.current && !abort.signal.aborted) setResult(current => current === candidate ? { ...current, directing_review: report } : current)
    } catch (issue) { if (live.current && turn === serial.current && !abort.signal.aborted) setError(errorText(issue)) }
    finally { if (live.current && turn === serial.current) { operation.current = false; setPhase(null) } }
  }
  async function savePlan() {
    if ((!result && !applied.current) || contextStale && !applied.current || issue || operation.current || guardLock.current) return
    operation.current = true
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    const active = () => live.current && turn === serial.current && !abort.signal.aborted
    setPhase('save'); setError('')
    try {
      if (!applied.current && result) {
        const input: ClipStoryboardCommitInput = { request_id: requestId.current, signature: result.signature, source_text: result.source_text,
          total_duration: result.total_duration, instructions: result.instructions, shots: result.shots,
          ...(result.target_video_model_id ? { target_video_model_id: result.target_video_model_id } : {}) }
        const saved = await api<ScriptCanvasResult>(`/projects/${detail.id}/storyboard/clip/commit`, { ...json('POST', input), signal: abort.signal })
        if (!active()) return
        applied.current = saved; setSavedResult(saved)
      }
      const saved = applied.current
      if (!saved || !active()) return
      await latest.current.onRefresh()
      if (!active()) return
      await latest.current.onSaved(saved)
      if (!active()) return
      latest.current.onNotice('片段分镜方案已保存'); latest.current.onClose()
    } catch (issue) {
      if (active()) {
        setError(`${applied.current ? '分镜方案已保存，返回分镜管理失败，可重试：' : ''}${errorText(issue)}`)
        if (!applied.current && (issue as { status?: number })?.status === 409) setContextStale(true)
      }
    }
    finally { if (active()) { operation.current = false; setPhase(null) } }
  }
  function reloadContext() { void changeSettings(() => { setView('setup'); setContextRevision(revision => revision + 1) }) }

  return <><Modal opened={opened} onClose={() => void requestClose()} title="片段规划分镜" size="min(960px, calc(100vw - 32px))" centered zIndex={340}
    closeOnClickOutside={false} closeOnEscape={phase !== 'save' && !guarding} closeButtonProps={{ disabled: phase === 'save' || guarding, 'aria-label': '关闭片段分镜规划' }}
    classNames={{ content: 'clip-storyboard-planner', header: 'clip-storyboard-header', body: 'clip-storyboard-body' }}>
    <div className="clip-storyboard-workspace" data-canvas-overlay onKeyDown={event => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation() }}>
      <nav className="clip-storyboard-tabs" aria-label="片段分镜规划步骤"><UnstyledButton aria-current={view === 'setup' ? 'step' : undefined} disabled={locked} onClick={() => setView('setup')}>规划设置</UnstyledButton>
        <UnstyledButton aria-current={view === 'preview' ? 'step' : undefined} disabled={locked || !result} onClick={() => setView('preview')}>镜头预览</UnstyledButton><span>{detail.name}</span></nav>
      <div key={settingsRevision} className="clip-storyboard-scroll">
        {view === 'setup' ? <section className="clip-storyboard-setup" aria-label="片段规划设置">
          <p className="clip-storyboard-description">描述这段视频的内容，规划并保存镜头，准备好后再从分镜管理加入画布制作。</p>
          <Textarea label="片段内容" aria-label="片段内容" placeholder="例如：少女冲进车站，发现最后一班列车已经离开。她停在空站台前，手机忽然响起。" minRows={5} autosize maxRows={12} maxLength={20_000} value={sourceText} disabled={settingsLocked}
            onChange={event => { const value = event.currentTarget.value; void changeSettings(() => setSourceText(value)) }} />
          <div className="clip-storyboard-settings-grid"><NumberInput label="总时长" aria-label="总时长" description="1–120 秒" inputWrapperOrder={['label', 'input', 'description', 'error']} value={duration} min={1} max={120} allowDecimal={false} disabled={settingsLocked}
            onChange={value => { if (value !== duration) void changeSettings(() => setDuration(value)) }} />
            <NumberInput label="建议镜头数" aria-label="建议镜头数" description="可选，1–30 镜" inputWrapperOrder={['label', 'input', 'description', 'error']} placeholder="自动分析" value={shotsCount} min={1} max={30} allowDecimal={false} disabled={settingsLocked}
              onChange={value => { if (value !== shotsCount) void changeSettings(() => setShotsCount(value)) }} />
            <Select className="clip-storyboard-model-field" label="规划文本模型" aria-label="规划文本模型" data={eligibleModels.map(model => ({ value: model.id, label: model.name }))} value={currentModel || null} placeholder="选择文本模型" allowDeselect={false} disabled={settingsLocked} comboboxProps={{ zIndex: 370 }}
              onChange={value => { if (value && value !== currentModel) void changeSettings(() => selectModel(value)) }} /></div>
          {!eligibleModels.length && <p className="clip-storyboard-help">请先在模型设置中启用一个文本模型。</p>}
          <Select label="目标视频模型（可选）" aria-label="目标视频模型" placeholder="尚未指定，使用通用制作约束" clearable value={targetVideoModelId || null}
            data={videoModels.map(model => ({ value: model.id, label: model.name }))} disabled={settingsLocked} comboboxProps={{ zIndex: 370 }}
            onChange={value => void changeSettings(() => setTargetVideoModelId(value || ''))} />
          <Textarea label="导演要求" aria-label="导演要求" placeholder="可选，例如节奏、景别、运镜、台词落点或接镜要求" minRows={2} autosize maxRows={6} maxLength={4_000} value={instructions} disabled={settingsLocked}
            onChange={event => { const value = event.currentTarget.value; void changeSettings(() => setInstructions(value)) }} />
          <section className="clip-storyboard-skills" aria-label="本次分镜技能"><div><Puzzle size={16} /><strong>{primarySkill?.name || '基础分镜规则'}</strong><span>{manualSkills === null ? '按功能分配' : '手动选择'} · 辅助技能 {Math.max(0, skillIds.length - 1)} 个</span></div>
            <CreativeSkillSelector stage="storyboard" projectId={detail.id} ids={skillIds} policies={context ? [context.skill_policy] : []} disabled={settingsLocked} loading={phase === 'context'} error={!context && phase !== 'context' ? '技能配置未读取' : undefined} appearance="planner" triggerLabel="更换"
              selection={manualSkills === null ? fixedAssignment : { source: 'manual', task_kind: 'storyboard', reason: '按你为本次片段规划选择的技能执行。', task_label: '手动选择' }}
              onChange={ids => void changeSettings(() => setManualSkills(ids))} onUseAutomatic={() => void changeSettings(() => setManualSkills(null))} onDefaultsChanged={reloadContext} onRetry={reloadContext} />
            <p>{manualSkills === null ? fixedAssignment.reason : manualSkills.length ? '主技能负责镜头规划，辅助技能补充具体规则。' : '本次仅使用基础分镜规则。'}</p></section>
        </section> : result && <section className="clip-storyboard-preview" aria-label="片段分镜预览">
          <header><div><strong>{result.shots.length} 个镜头</strong><span>合计 {result.shots.reduce((sum, shot) => sum + shot.duration, 0)} / {result.total_duration} 秒</span></div><p>{savedResult ? '方案已保存，可返回分镜管理继续制作。' : '检查并修改镜头内容，确认后保存。'}</p></header>
          {result.directing_review && <section className="clip-storyboard-help" role="status">
            <p>{result.directing_review.status === 'edited' ? '草稿已修改，当前版本尚未复核。' : result.directing_review.status === 'needs_work' ? '当前草稿有需修复的首帧或接镜冲突。' : '首帧、运镜、声音设计与接镜文字复核已完成。实际素材仍需播放检查。'}</p>
            {result.directing_review.issues.map((item, index) => <p key={index}>第{item.shot_index + 1}镜：{item.message} 依据：{item.evidence} 建议：{item.repair}</p>)}
            {!savedResult && <Button variant="default" size="xs" loading={phase === 'review'} disabled={locked || !!issue} onClick={() => void reviewDraft()}>复查当前草稿</Button>}
          </section>}
          <section className="clip-storyboard-used-skills" aria-label="实际使用的分镜技能"><strong>实际使用{!result.used_skills.length && '：基础分镜规则'}</strong>
            {result.used_skills.map((skill, index) => <p key={skill.id}><span>{skill.role === 'auxiliary' || !skill.role && index > 0 ? '辅助技能' : '主技能'} · {skill.name}</span><small>版本 {skill.revision.slice(0, 8)}</small></p>)}
            {result.skill_assignment?.reason && <p className="clip-storyboard-assignment">选择理由：{result.skill_assignment.reason}</p>}</section>
          {result.shots.map((shot, index) => {
            const label = `镜头 ${index + 1}`
            return <section className="clip-storyboard-shot" aria-label={`${label}内容`} key={index}><header><span>{String(index + 1).padStart(2, '0')}</span><h3>{shot.title || '未命名镜头'}</h3><small>{shot.duration} 秒</small></header>
              <div className="clip-storyboard-shot-fields"><div className="clip-storyboard-shot-heading"><TextInput label="镜头标题" aria-label={`${label} 标题`} value={shot.title} maxLength={120} disabled={locked || !!savedResult} onChange={event => updateShot(index, { title: event.currentTarget.value })} />
                <NumberInput label="镜头时长" aria-label={`${label} 时长`} value={shot.duration} min={1} max={30} allowDecimal={false} disabled={locked || !!savedResult} onChange={value => updateShot(index, { duration: Number(value) })} /></div>
                <Textarea label="镜头描述" aria-label={`${label} 描述`} value={shot.prompt} minRows={2} autosize maxLength={10_000} disabled={locked || !!savedResult} onChange={event => updateShot(index, { prompt: event.currentTarget.value })} />
                <Textarea label="首帧图片提示词" aria-label={`${label} 首帧图片提示词`} value={shot.image_prompt} minRows={2} autosize maxLength={20_000} disabled={locked || !!savedResult} onChange={event => updateShot(index, { image_prompt: event.currentTarget.value })} />
                <Textarea label="视频动作与运镜提示词" aria-label={`${label} 视频动作与运镜提示词`} value={shot.video_prompt} minRows={2} autosize maxLength={20_000} disabled={locked || !!savedResult} onChange={event => updateShot(index, { video_prompt: event.currentTarget.value })} />
                <div className="clip-storyboard-continuity"><Textarea label="起始状态" aria-label={`${label} 起始状态`} value={shot.start_state} minRows={2} autosize maxLength={2_000} disabled={locked || !!savedResult} onChange={event => updateShot(index, { start_state: event.currentTarget.value })} />
                  <Textarea label="结束状态" aria-label={`${label} 结束状态`} value={shot.end_state} minRows={2} autosize maxLength={2_000} disabled={locked || !!savedResult} onChange={event => updateShot(index, { end_state: event.currentTarget.value })} /></div>
                <Textarea label="接镜说明" aria-label={`${label} 接镜说明`} value={shot.cut_note} minRows={2} autosize maxLength={2_000} disabled={locked || !!savedResult} onChange={event => updateShot(index, { cut_note: event.currentTarget.value })} /></div>
            </section>
          })}
        </section>}
        {(error || contextStale || view === 'preview' && issue) && <Alert color="red" icon={<AlertCircle size={16} />} role="alert">{error || (contextStale ? '配置已更新，请重新读取配置后继续规划。' : issue)}{(!context || contextStale) && phase !== 'context' && <Button size="compact-xs" variant="subtle" onClick={reloadContext}>重新读取配置</Button>}</Alert>}
        {phase && <div className="clip-storyboard-progress" role="status"><Loader size="xs" /><span>{phase === 'context' ? '正在读取项目与技能配置' : phase === 'plan' ? '正在规划镜头' : savedResult ? '正在返回分镜管理' : '正在保存分镜方案'}</span></div>}
      </div>
      <footer className="clip-storyboard-footer"><p>{savedResult ? '方案已保存' : result ? '保存后可在分镜管理继续编辑' : `${context?.project.ratio || detail.ratio} · 按项目画风规划`}</p><Button variant="default" disabled={phase === 'save' || guarding} onClick={() => void requestClose()}>{phase === 'plan' ? '取消规划' : '取消'}</Button>
        {view === 'setup' && !savedResult ? <Button leftSection={<Clapperboard size={15} />} loading={phase === 'plan'} disabled={locked || !context || contextStale || !validSetup || !currentModel} onClick={() => void startPlan()}>开始规划</Button>
          : <Button leftSection={<Save size={15} />} loading={phase === 'save'} disabled={locked || !result || contextStale && !savedResult || !!issue} onClick={() => void savePlan()}>{savedResult ? '重试返回分镜管理' : '保存分镜'}</Button>}</footer>
    </div>
  </Modal>{dialog.dialog}</>
}

export default function ClipStoryboardPlanner(props: ClipStoryboardPlannerProps) {
  return <ClipStoryboardPlannerContent key={props.detail.id} {...props} />
}
