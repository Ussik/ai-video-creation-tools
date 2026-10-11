import { WorkspaceDisclosure } from './WorkspaceDisclosure'
import { useEffect, useRef, useState } from 'react'
import { UnstyledButton, Button, Checkbox, Modal, NumberInput, Select, Textarea, TextInput } from '@mantine/core'
import { Check, ChevronRight, Clapperboard, LoaderCircle, Plus, Puzzle, Trash2 } from 'lucide-react'
import { api, json } from './api'
import type { Model, ProjectDetail, ScriptCanvasCheck, ScriptCanvasPlan, ScriptCanvasResult } from './api'
import type { StoryboardPlanningContext, StoryboardPlanningResult, StoryboardShotDraft } from '../../backend/src/storyboard-planning-types'
import { requestScriptCanvas } from './script-canvas-handoff'
import './storyboard-planner.css'
import CreativeSkillSelector from './CreativeSkillSelector'
import type { SkillPolicy } from './skills-api'

type Props = {
  opened: boolean; onClose: () => void; detail: ProjectDetail; models: Model[]; initialSceneIds: string[];
  onRefresh: () => Promise<unknown>; onOpenCanvas: () => void; onNotice: (message: string) => void
}
const batchLimit = 10
const toggle = (values: string[], id: string, checked: boolean) => checked ? [...values, id] : values.filter(value => value !== id)
const errorText = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
function planIssue(result: StoryboardPlanningResult): string {
  for (const scene of result.scenes) {
    if (!scene.shots.length || scene.shots.length > 30) return '每场需要 1 至 30 个镜头'
    if (!Number.isInteger(scene.scene_duration) || scene.scene_duration < 1 || scene.scene_duration > 30) return '每场规划时长应为 1 至 30 秒'
    if (scene.shots.some(shot => !Number.isInteger(shot.duration) || shot.duration < 1 || shot.duration > 30)) return '每镜时长应为 1 至 30 秒'
    if (scene.shots.reduce((sum, shot) => sum + shot.duration, 0) !== scene.scene_duration) return `「${scene.scene_heading}」镜头合计时长需要等于本场规划时长`
    if (scene.shots.some(shot => !shot.title.trim() || !shot.prompt.trim() || !shot.image_prompt.trim() || !shot.video_prompt.trim())) return '请填写镜头标题、描述及图片和视频提示词'
  }
  return ''
}
const planned = (scene: StoryboardPlanningContext['scenes'][number]) => scene.planned === true
const needsCanvasNodes = (scene: StoryboardPlanningContext['scenes'][number]) => planned(scene) &&
  typeof scene.canvas_shot_count === 'number' && scene.canvas_shot_count < scene.shot_count
export default function StoryboardPlanner({ opened, onClose, detail, models, initialSceneIds, onRefresh, onOpenCanvas, onNotice }: Props) {
  const [sceneIds, setSceneIds] = useState<string[]>([]), [documentIds, setDocumentIds] = useState<string[]>([]), [skillIds, setSkillIds] = useState<string[]>([])
  const [referenceSkillIds, setReferenceSkillIds] = useState<string[]>([])
  const [referenceReloading, setReferenceReloading] = useState(false)
  const [context, setContext] = useState<StoryboardPlanningContext | null>(null), [modelId, setModelId] = useState('')
  const [shotsPerScene, setShotsPerScene] = useState<number | string>(''), [useTarget, setUseTarget] = useState(false), [target, setTarget] = useState<number | string>(45)
  const [instructions, setInstructions] = useState(''), [pending, setPending] = useState<'context' | 'plan' | 'references' | 'save' | null>(null)
  const [saveLabel, setSaveLabel] = useState('正在加入画布')
  const [error, setError] = useState(''), [result, setResult] = useState<StoryboardPlanningResult | null>(null), [elapsed, setElapsed] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0), [view, setView] = useState<'setup' | 'preview'>('setup')
  const [focusedSceneId, setFocusedSceneId] = useState(''), [replanExisting, setReplanExisting] = useState(false)
  const initialized = useRef(false), skillInitialized = useRef(false), referenceSkillInitialized = useRef(false)
  const serial = useRef(0), requestId = useRef(''), applied = useRef<ScriptCanvasResult | null>(null), prepared = useRef<ScriptCanvasResult | null>(null), imported = useRef<ScriptCanvasResult | null>(null), controller = useRef<AbortController | null>(null)
  const rangeIds = initialSceneIds.length ? initialSceneIds : detail.script.scenes.map(scene => scene.id)
  const rangeKey = rangeIds.join(',')
  const eligibleModels = models.filter(model => model.modality === 'text' && model.enabled)
  useEffect(() => () => { serial.current++; controller.current?.abort() }, [])
  useEffect(() => {
    if (!opened) { serial.current++; controller.current?.abort(); return }
    initialized.current = false; skillInitialized.current = false; referenceSkillInitialized.current = false
    setSceneIds(rangeIds.slice(0, batchLimit)); setDocumentIds([]); setSkillIds([]); setReferenceSkillIds([]); setReferenceReloading(false); setContext(null); setResult(null); setError(''); setInstructions('')
    setUseTarget(false); setShotsPerScene(''); setReplanExisting(false); setView('setup'); setFocusedSceneId(''); setModelId(eligibleModels[0]?.id || '')
    applied.current = null; prepared.current = null; imported.current = null
    // Opening loads metadata only; the creator explicitly starts any model work.
  }, [opened, detail.id])
  useEffect(() => {
    if (!opened) return
    const turn = ++serial.current
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort
    setContext(null); setResult(null); applied.current = null; prepared.current = null; imported.current = null
    if (!rangeIds.length) { setPending(null); return }
    setPending('context'); setError('')
    api<StoryboardPlanningContext>(`/projects/${detail.id}/script/storyboard/context`, { ...json('POST', { scene_ids: rangeIds }), signal: abort.signal })
      .then(value => {
        if (turn !== serial.current) return
        setContext(value); setDocumentIds(current => current.filter(id => value.documents.some(document => document.id === id)))
        if (!skillInitialized.current) { setSkillIds(value.default_skill_ids || []); skillInitialized.current = true }
        if (!referenceSkillInitialized.current) { setReferenceSkillIds(value.reference_preparation?.default_skill_ids || []); referenceSkillInitialized.current = true }
        if (!initialized.current) {
          const missing = value.scenes.filter(needsCanvasNodes), unplanned = value.scenes.filter(scene => !planned(scene))
          const batch = (missing.length ? missing : unplanned.length ? unplanned : value.scenes).slice(0, batchLimit)
          const selected = batch.map(scene => scene.id)
          setSceneIds(selected); setFocusedSceneId(selected[0] || ''); setView(batch.every(planned) ? 'preview' : 'setup'); initialized.current = true
        }
      })
      .catch(issue => { if (turn === serial.current && !abort.signal.aborted) setError(errorText(issue)) })
      .finally(() => { if (turn === serial.current) setPending(null) })
    return () => abort.abort()
  }, [opened, detail.id, rangeKey, refreshKey])
  useEffect(() => {
    if (pending !== 'plan' && pending !== 'references') return
    const started = Date.now(); setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  const selected = context?.scenes.filter(scene => sceneIds.includes(scene.id)) || []
  const savedScenes = context?.scenes.filter(planned) || []
  const unplannedScenes = context?.scenes.filter(scene => !planned(scene)) || []
  const planningScenes = selected.filter(scene => replanExisting || !planned(scene))
  const reusedScenes = selected.filter(scene => !planningScenes.some(item => item.id === scene.id))
  const planningIds = planningScenes.map(scene => scene.id)
  const hasPreview = !!result || selected.length > 0 && !planningScenes.length
  const total = planningScenes.reduce((sum, scene) => sum + scene.duration, 0)
  const minimum = planningScenes.reduce((sum, scene) => sum + Math.max(1, scene.shot_count), 0) || 1
  const invalidTarget = useTarget && (!Number.isInteger(Number(target)) || Number(target) < minimum || Number(target) > planningScenes.length * 30)
  const automaticShotCount = String(shotsPerScene).trim() === ''
  const invalidShotCount = !automaticShotCount && (!Number.isInteger(Number(shotsPerScene)) || Number(shotsPerScene) < 2 || Number(shotsPerScene) > 8)
  const issue = result ? planIssue(result) : ''
  const previewScenes = selected.map(scene => result?.scenes.find(item => item.scene_id === scene.id) || {
    scene_id: scene.id, scene_heading: scene.heading, scene_duration: scene.duration,
    shots: (context?.existing_shots || []).filter(shot => shot.scene_id === scene.id),
  })
  const focusedScene = previewScenes.find(scene => scene.scene_id === focusedSceneId) || previewScenes[0]
  const focusedIsDraft = !!result?.scenes.some(scene => scene.scene_id === focusedScene?.scene_id)
  const previewCount = previewScenes.reduce((sum, scene) => sum + scene.shots.length, 0)
  const skillPolicy: SkillPolicy | null = context ? context.skill_policy || {
    stage: 'storyboard', label: '分镜规划', primary_id: context.default_skill_ids?.[0] || null,
    auxiliary_ids: context.default_skill_ids?.slice(1) || [], source: 'global', warning: '', skills: context.skills,
  } : null
  const primarySkill = skillPolicy?.skills.find(skill => skill.id === skillIds[0])
  const auxiliarySkills = skillIds.slice(1).map(id => skillPolicy?.skills.find(skill => skill.id === id)?.name || '技能需重新选择')
  const defaultIds = skillPolicy ? [skillPolicy.primary_id, ...skillPolicy.auxiliary_ids].filter((id): id is string => !!id) : []
  const usesDefaults = defaultIds.length === skillIds.length && defaultIds.every((id, index) => skillIds[index] === id)
  const skillSource = usesDefaults ? skillPolicy?.source === 'project' ? '项目默认' : '全局默认' : '本次选择'
  const referencePolicy = context?.reference_preparation?.skill_policy
  const referencePrimary = referencePolicy?.skills.find(skill => skill.id === referenceSkillIds[0])
  const referenceDefaults = referencePolicy?.primary_id ? [referencePolicy.primary_id, ...referencePolicy.auxiliary_ids] : []
  const referenceUsesDefaults = referenceSkillIds.length === referenceDefaults.length && referenceSkillIds.every((id, index) => id === referenceDefaults[index])
  const referenceNeedsAnalysis = selected.filter(scene => context?.reference_preparation?.needs_analysis.includes(scene.id))
  async function reloadReferencePolicy() {
    const turn = serial.current
    setReferenceReloading(true)
    try {
      const defaults = await api<{ policies: SkillPolicy[] }>(`/projects/${detail.id}/skills/defaults`)
      if (turn !== serial.current) return
      const policy = defaults.policies.find(policy => policy.stage === 'visual_assets')
      if (!policy) throw new Error('参考设定技能配置未读取，请重试')
      const ids = policy.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : []
      setReferenceSkillIds(ids)
      setContext(current => current?.reference_preparation ? { ...current, reference_preparation: {
        ...current.reference_preparation, skill_policy: policy, default_skill_ids: ids,
      } } : current)
    } catch (issue) { if (turn === serial.current) setError(errorText(issue)) }
    finally { if (turn === serial.current) setReferenceReloading(false) }
  }
  function resetDraft() { setResult(null); setError(''); applied.current = null; prepared.current = null; imported.current = null }
  function chooseScene(id: string, checked: boolean) {
    const next = toggle(sceneIds, id, checked)
    resetDraft(); setSceneIds(next); setUseTarget(false); setFocusedSceneId(checked ? id : next[0] || '')
    setView(!replanExisting && next.length && next.every(id => context?.scenes.some(scene => scene.id === id && planned(scene))) ? 'preview' : 'setup')
  }
  function chooseBatch(scenes: StoryboardPlanningContext['scenes']) {
    const batch = scenes.slice(0, batchLimit), ids = batch.map(scene => scene.id)
    resetDraft(); setSceneIds(ids); setUseTarget(false); setReplanExisting(false); setFocusedSceneId(ids[0] || '')
    setView(batch.length && batch.every(planned) ? 'preview' : 'setup')
  }
  async function startPlanning() {
    if (!context || pending || !planningIds.length || invalidTarget || invalidShotCount || !eligibleModels.some(model => model.id === modelId)) return
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    setPending('plan'); resetDraft()
    try {
      const sameScope = context.scenes.length === planningIds.length && context.scenes.every(scene => planningIds.includes(scene.id))
      const scope = sameScope ? context : await api<StoryboardPlanningContext>(`/projects/${detail.id}/script/storyboard/context`, { ...json('POST', { scene_ids: planningIds }), signal: abort.signal })
      if (turn !== serial.current) return
      const value = await api<StoryboardPlanningResult>(`/projects/${detail.id}/script/storyboard/plan`, { ...json('POST', {
        signature: scope.signature, scene_ids: planningIds, document_ids: documentIds, skill_ids: skillIds, model_id: modelId,
        ...(!automaticShotCount ? { shots_per_scene: Number(shotsPerScene) } : {}), ...(useTarget ? { target_duration: Number(target) } : {}), instructions,
      }), signal: abort.signal })
      if (turn !== serial.current) return
      requestId.current = crypto.randomUUID(); setResult(value); setFocusedSceneId(value.scenes[0]?.scene_id || ''); setView('preview')
    } catch (issue) { if (turn === serial.current) setError(errorText(issue)) }
    finally { if (turn === serial.current) setPending(null) }
  }
  function updateShot(sceneId: string, index: number, values: Partial<StoryboardShotDraft>) {
    if (applied.current) return
    setResult(current => current && { ...current, scenes: current.scenes.map(scene => scene.scene_id !== sceneId ? scene : { ...scene, shots: scene.shots.map((shot, i) => i === index ? { ...shot, ...values } : shot) }) })
  }
  async function addToCanvas() {
    if (!context || pending || referenceReloading || !sceneIds.length || (result ? !!issue : !!planningScenes.length)) return
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    const active = () => turn === serial.current && !abort.signal.aborted
    setPending('save'); setSaveLabel('正在保存分镜'); setError('')
    try {
      if (result && !applied.current) {
        const saved = await api<ScriptCanvasResult>(`/projects/${detail.id}/script/storyboard/commit`, { ...json('POST', {
          signature: result.signature, request_id: requestId.current,
          scenes: result.scenes.map(({ scene_id, scene_duration, shots }) => ({ scene_id, scene_duration, shots })),
        }), signal: abort.signal })
        if (!active()) return
        applied.current = saved
      }
      if (!imported.current) {
        // Saving the plan changes its source version. Always check references
        // afterwards and use the fresh preparation signature.
        setSaveLabel('正在检查参考设定')
        const check = await api<ScriptCanvasCheck>(`/projects/${detail.id}/script/canvas/check`, { ...json('POST', { scene_ids: sceneIds }), signal: abort.signal })
        if (!active()) return
        if (check.needs_analysis.length) {
          if (!eligibleModels.some(model => model.id === modelId)) throw new Error('请选择文本模型，先整理分镜所需的人物、场景与道具设定，再加入画布。')
          setPending('references')
          const plan = await api<ScriptCanvasPlan>(`/projects/${detail.id}/script/canvas/prepare`, { ...json('POST', {
            scene_ids: sceneIds, signature: check.signature, model_id: modelId, skill_ids: referenceSkillIds,
          }), signal: abort.signal })
          if (!active()) return
          setPending('save'); setSaveLabel('正在保存参考设定')
          const references = await api<ScriptCanvasResult>(`/projects/${detail.id}/script/canvas/commit`, { ...json('POST', {
            scene_ids: plan.scene_ids, signature: plan.signature, profiles: plan.profiles, reference_usage_version: plan.reference_usage_version,
          }), signal: abort.signal })
          if (!active()) return
          prepared.current = references
        }
        setSaveLabel('正在加入画布')
        const canvas = await api<ScriptCanvasResult>(`/projects/${detail.id}/script/storyboard/canvas`, { ...json('POST', { scene_ids: sceneIds, mode: 'existing' }), signal: abort.signal })
        if (!active()) return
        imported.current = canvas
      }
      await onRefresh()
      if (!active()) return
      const canvas = { ...imported.current,
        created_shots: imported.current.created_shots + (applied.current?.created_shots || 0) + (prepared.current?.created_shots || 0),
        created_profiles: imported.current.created_profiles + (applied.current?.created_profiles || 0) + (prepared.current?.created_profiles || 0),
        updated_shot_ids: [...new Set([...(imported.current.updated_shot_ids || []), ...(applied.current?.updated_shot_ids || [])])],
      }
      const missing = canvas.shot_visual_bindings.some(binding => binding.usage !== 'none' && binding.required && !binding.board_asset_id && !binding.reference_assets?.length)
      requestScriptCanvas(detail.id, detail.ratio, canvas); onOpenCanvas(); onNotice(missing ? '分镜与参考设定已加入画布，请先生成并确认必需信息图' : '分镜与参考设定已加入画布'); onClose()
    } catch (issue) { if (active()) setError(`${applied.current ? '分镜已保存，后续操作失败，可重试：' : ''}${errorText(issue)}`) }
    finally { if (active()) setPending(null) }
  }
  function cancelPlanning() { serial.current++; controller.current?.abort(); setPending(null) }
  const locked = !!pending || !!applied.current
  const sceneLabel = (id: string) => context?.scenes.find(scene => scene.id === id)?.heading || detail.script.scenes.find(scene => scene.id === id)?.heading || ''
  return <Modal opened={opened} onClose={() => { if (!pending || pending === 'context') onClose() }} title="加入画布" centered radius={18} size="min(940px, calc(100vw - 32px))" zIndex={240}
    classNames={{ content: 'storyboard-planner', header: 'storyboard-planner-header', body: 'storyboard-planner-body', close: 'storyboard-planner-close' }}
    closeButtonProps={{ disabled: !!pending && pending !== 'context', 'aria-label': '关闭分镜规划' }} closeOnClickOutside={!pending} closeOnEscape={!pending}>
    <div className="storyboard-planner-workspace">
      <aside className="storyboard-planner-sidebar" aria-label="分镜场次">
        <header><strong>场次</strong><span>已选 {sceneIds.length} / {rangeIds.length}</span></header>
        <p className="storyboard-planner-note">每批最多 {batchLimit} 场，可分批加入</p>
        <div className="storyboard-planner-selection-tools" aria-label="场次批次选择">
          <Button type="button" disabled={locked || !savedScenes.length} title="复用已规划分镜，优先补齐缺少的画布节点" onClick={() => chooseBatch([...savedScenes.filter(needsCanvasNodes), ...savedScenes.filter(scene => !needsCanvasNodes(scene))])} data-workspace-control="" variant="subtle">已规划</Button>
          <Button type="button" disabled={locked || !unplannedScenes.length} onClick={() => chooseBatch(unplannedScenes)} data-workspace-control="" variant="subtle">待规划</Button>
          <Button type="button" disabled={locked || !sceneIds.length} onClick={() => chooseBatch([])} data-workspace-control="" variant="subtle">清空选择</Button>
        </div>
        <div className="storyboard-planner-scene-list">
          {rangeIds.map((id, index) => {
            const meta = context?.scenes.find(scene => scene.id === id), checked = sceneIds.includes(id), draftScene = result?.scenes.find(scene => scene.scene_id === id)
            const count = draftScene?.shots.length || meta?.shot_count || 0
            return <div key={id} className={`storyboard-planner-scene-item${checked ? ' is-selected' : ''}${view === 'preview' && focusedScene?.scene_id === id ? ' is-focused' : ''}`}>
              <Checkbox aria-label={`选择场次：${sceneLabel(id)}`} checked={checked} disabled={locked || !checked && sceneIds.length >= batchLimit} onChange={event => chooseScene(id, event.currentTarget.checked)} />
              <UnstyledButton type="button" className="storyboard-planner-scene-button" disabled={locked || !checked && sceneIds.length >= batchLimit} title={!checked && sceneIds.length >= batchLimit ? '本批已选满，可清空选择或切换已规划场次' : undefined} onClick={() => { if (checked && hasPreview) { setFocusedSceneId(id); setView('preview') } else chooseScene(id, !checked) }}>
                <span className="storyboard-planner-scene-number">{String(index + 1).padStart(2, '0')}</span>
                <strong>{sceneLabel(id)}</strong><small>{meta?.duration || detail.script.scenes.find(scene => scene.id === id)?.duration || 0} 秒<span>{draftScene ? `草稿 · ${count} 镜` : meta && planned(meta) ? `${typeof meta.canvas_shot_count !== 'number' ? '已规划' : needsCanvasNodes(meta) ? meta.canvas_shot_count ? '待补齐' : '待加入' : '已加入'} · ${count} 镜` : '待规划'}</span></small>
              </UnstyledButton>
            </div>
          })}
        </div>
      </aside>
      <main className="storyboard-planner-main">
        <nav className="storyboard-planner-tabs" aria-label="分镜工作步骤">
          <UnstyledButton type="button" aria-label="规划设置" aria-current={view === 'setup' ? 'step' : undefined} onClick={() => setView('setup')}><span>1</span>规划设置</UnstyledButton><ChevronRight size={13} />
          <UnstyledButton type="button" aria-label="分镜预览" aria-current={view === 'preview' ? 'step' : undefined} disabled={!hasPreview} onClick={() => setView('preview')}><span>{hasPreview ? <Check size={11} /> : '2'}</span>分镜预览</UnstyledButton>
          <small>确认后准备参考设定并加入画布</small>
        </nav>
        <div className="storyboard-planner-scroll">
          {error && <div className="storyboard-planner-error" role="alert"><span>{error}</span>{!applied.current && <Button variant="subtle" size="compact-xs" disabled={!!pending} onClick={() => setRefreshKey(key => key + 1)}>刷新资料</Button>}</div>}
          {!context ? <div className="storyboard-planner-empty">{pending === 'context' ? <><LoaderCircle size={22} /><strong>正在读取剧本与分镜</strong></> : <><Clapperboard size={24} /><strong>没有可用场次</strong></>}</div>
          : !sceneIds.length ? <div className="storyboard-planner-empty"><Clapperboard size={24} /><strong>选择要加入画布的场次</strong><p>从左侧勾选场次，再规划镜头。</p></div>
          : view === 'setup' ? <>
            <header className="storyboard-planner-section-title"><h3>{result ? '调整规划设置' : planningScenes.length ? '规划所选场次' : '所选分镜已准备好'}</h3><p>{planningScenes.length ? `${planningScenes.length} 场待规划${reusedScenes.length ? `，另有 ${reusedScenes.length} 场复用已保存分镜` : ''}。生成后可以逐镜修改，再确认加入。` : '可以预览已保存镜头后直接加入，也可以重新规划。'}</p></header>
            {planningScenes.length > 0 && <>
              <section className="storyboard-planner-skill-card" aria-label="本次分镜技能">
                <header><span>本次分镜规划</span><small>{skillSource}</small></header>
                <div className="storyboard-planner-skill-choice"><span className="storyboard-planner-primary-skill"><Puzzle size={15} /><strong title={primarySkill?.name}>{skillIds.length && !primarySkill ? '技能需重新选择' : primarySkill?.name || '基础分镜规则'}</strong></span>
                  <CreativeSkillSelector stage="storyboard" projectId={detail.id} ids={skillIds} disabled={locked} appearance="planner" triggerLabel="更换" position="bottom-end"
                    policies={skillPolicy ? [skillPolicy] : []}
                    onDefaultsChanged={() => { skillInitialized.current = false; setRefreshKey(value => value + 1) }} onChange={values => { setSkillIds(values); resetDraft() }} />
                </div>
                <p>主技能<span>·</span>辅助技能 {auxiliarySkills.length} 个{auxiliarySkills.length > 0 && <span className="storyboard-planner-auxiliary-names">{auxiliarySkills.join(' · ')}</span>}</p>
              </section>
              <div className="storyboard-planner-settings"><Select label="文本模型" aria-label="分镜规划文本模型" data={eligibleModels.map(model => ({ value: model.id, label: model.name }))} value={modelId || null} allowDeselect={false} disabled={locked}
                onChange={value => { setModelId(value || ''); resetDraft() }} comboboxProps={{ zIndex: 350 }} />
                <NumberInput label="每场建议镜头数" placeholder="自动分析" description="留空时，按各场剧情与时长自动确定" inputWrapperOrder={['label', 'input', 'description', 'error']} min={2} max={8} allowDecimal={false} value={shotsPerScene} disabled={locked} onChange={value => { setShotsPerScene(value); resetDraft() }} /></div>
              {!eligibleModels.length && <p className="storyboard-planner-error">请先配置并启用文本模型，再开始规划。</p>}
              <Textarea label="导演要求" placeholder="例如：保留全部对白，强调人物反应和动作衔接" maxLength={4000} rows={2} value={instructions} disabled={locked} onChange={event => { setInstructions(event.currentTarget.value); resetDraft() }} />
              <WorkspaceDisclosure className="storyboard-planner-disclosure" label={<><span>参考资料</span><small>{documentIds.length ? `已选 ${documentIds.length} 份` : '可选'}</small></>}>
                <div className="storyboard-planner-disclosure-body"><p className="storyboard-planner-note">所选场次正文、项目画幅与画风会用于规划。勾选其他文档可补充人物、世界观等设定。</p>
                  <div className="storyboard-planner-source-list">{context.documents.map(document => <Checkbox key={document.id} label={`${document.title} · ${document.characters.toLocaleString()} 字`} checked={documentIds.includes(document.id)} disabled={locked}
                    onChange={event => { const checked = event.currentTarget.checked; setDocumentIds(current => toggle(current, document.id, checked)); resetDraft() }} />)}</div>
                  {!!context.project.style && <WorkspaceDisclosure className="storyboard-planner-details" label={<>查看项目画风</>}><p>{context.project.style}</p></WorkspaceDisclosure>}
                </div>
              </WorkspaceDisclosure>
            </>}
            <WorkspaceDisclosure className="storyboard-planner-disclosure" label={<><span>时长与重新规划</span><small>{useTarget ? `${target} 秒` : '保留原时长'}</small></>}><div className="storyboard-planner-disclosure-body">
              {selected.some(scene => planned(scene)) && <Checkbox label="重新规划已有分镜" checked={replanExisting} disabled={locked} onChange={event => { setReplanExisting(event.currentTarget.checked); setUseTarget(false); resetDraft() }} />}
              {!!planningScenes.length && <><Checkbox label={`指定本次总时长（源场次合计 ${total} 秒）`} checked={useTarget} disabled={locked} onChange={event => { setUseTarget(event.currentTarget.checked); resetDraft() }} />
                {useTarget && <NumberInput label="本次目标时长" suffix=" 秒" min={minimum} max={planningScenes.length * 30} value={target} disabled={locked} onChange={value => { setTarget(value); resetDraft() }} />}
                {invalidTarget && <p className="storyboard-planner-error">本次总时长应在 {minimum} 至 {planningScenes.length * 30} 秒之间。</p>}
                <p className="storyboard-planner-note">默认保留剧本场次时长；调整后会在确认时同步场次时长。</p></>}
              {selected.some(scene => scene.shot_count) && <p className="storyboard-planner-note">重新规划会保留已有镜头及素材关联，调整内容后请核对素材是否仍适用。</p>}
            </div></WorkspaceDisclosure>
          </> : focusedScene && <>
            <WorkspaceDisclosure className="storyboard-planner-disclosure storyboard-planner-reference-preparation" label={<><span>参考图准备</span><small>{result ? '确认时检查与整理' : referenceNeedsAnalysis.length ? `待整理 ${referenceNeedsAnalysis.length} 场` : '复用已整理设定'}</small></>}>

              <div className="storyboard-planner-disclosure-body">
                <p className="storyboard-planner-note">确认时会整理所需人物、场景与关键道具设定，并和分镜一起加入画布。先生成并确认必需信息图，再生成依赖它们的分镜；已有设定与确认图会复用。</p>
                <section className="storyboard-planner-skill-card" aria-label="本次参考设定技能">
                  <header><span>参考设定整理</span><small>{referenceUsesDefaults ? referencePolicy?.source === 'project' ? '项目默认' : '全局默认' : '本次选择'}</small></header>
                  <div className="storyboard-planner-skill-choice"><span className="storyboard-planner-primary-skill"><Puzzle size={15} /><strong>{referenceSkillIds.length && !referencePrimary ? '技能需重新选择' : referencePrimary?.name || '基础设定规则'}</strong></span>
                    <CreativeSkillSelector stage="visual_assets" projectId={detail.id} ids={referenceSkillIds} disabled={!!pending || !!imported.current || referenceReloading} appearance="prompt" triggerLabel="更换" position="bottom-end" policies={referencePolicy ? [referencePolicy] : []}
                      onDefaultsChanged={() => void reloadReferencePolicy()} onChange={values => { setReferenceSkillIds(values); setError('') }} />
                  </div>
                  <p>主技能<span>·</span>辅助技能 {Math.max(0, referenceSkillIds.length - 1)} 个</p>
                </section>
                <Select label="整理设定的文本模型" aria-label="整理参考设定文本模型" data={eligibleModels.map(model => ({ value: model.id, label: model.name }))} value={modelId || null} allowDeselect={false} disabled={!!pending || !!imported.current} onChange={value => setModelId(value || '')} comboboxProps={{ zIndex: 350 }} />
                {!eligibleModels.length && referenceNeedsAnalysis.length > 0 && <p className="storyboard-planner-error">这些场次还需要整理参考设定，请先启用一个文本模型。</p>}
              </div>
            </WorkspaceDisclosure>
            <header className="storyboard-planner-section-title"><h3>{focusedScene.scene_heading}</h3><p>{focusedScene.shots.length} 个镜头 · {focusedScene.scene_duration} 秒 · {focusedIsDraft ? '未保存草稿，可修改后确认' : '复用已保存分镜'}</p></header>
            {result && <WorkspaceDisclosure className="storyboard-planner-used-sources" label={<><Puzzle size={13} /><span>已使用：{result.used_skills[0]?.name || '基础分镜规则'}<small>辅助技能 {Math.max(0, result.used_skills.length - 1)} 个<span>·</span>参考资料 {result.source_documents.length} 份</small></span><ChevronRight size={13} /></>}>

              <div className="storyboard-planner-used-details"><p>参考文档：{result.source_documents.map(document => document.title).join(' · ') || '未选择额外文档'}</p>{result.used_skills.map((skill, index) => <p key={skill.id}><strong>{index === 0 ? '主技能' : '辅助技能'} · {skill.name}</strong><small>版本 {skill.revision.slice(0, 8)} · {skill.files.join(' · ')}</small></p>)}</div>
            </WorkspaceDisclosure>}
            {issue && <p className="storyboard-planner-error" role="status">{issue}</p>}
            <fieldset key={focusedScene.scene_id} disabled={locked} className="storyboard-planner-preview">
              {focusedIsDraft && <NumberInput label="本场规划时长" suffix=" 秒" min={1} max={30} value={focusedScene.scene_duration} onChange={value => setResult(current => current && { ...current, scenes: current.scenes.map(item => item.scene_id === focusedScene.scene_id ? { ...item, scene_duration: Number(value) } : item) })} />}
              {focusedScene.shots.map((shot, index) => <WorkspaceDisclosure key={`${focusedScene.scene_id}-${index}`} className="storyboard-planner-shot" initiallyOpen={index === 0} label={<><span className="storyboard-planner-shot-number">{String(index + 1).padStart(2, '0')}</span><strong>{shot.title}</strong><span>{shot.duration} 秒</span></>}>

                <div className="storyboard-planner-shot-fields"><div className="storyboard-planner-settings"><TextInput label="镜头标题" readOnly={!focusedIsDraft} maxLength={120} value={shot.title} onChange={event => updateShot(focusedScene.scene_id, index, { title: event.currentTarget.value })} /><NumberInput label="镜头时长" readOnly={!focusedIsDraft} hideControls={!focusedIsDraft} suffix=" 秒" min={1} max={30} value={shot.duration} onChange={value => updateShot(focusedScene.scene_id, index, { duration: Number(value) })} /></div>
                  {(['prompt', 'image_prompt', 'video_prompt'] as const).map((key, field) => <Textarea key={key} label={['镜头描述', '首帧图片提示词', '动作与运镜视频提示词'][field]} readOnly={!focusedIsDraft} value={shot[key]} autosize minRows={key === 'prompt' ? 2 : 3} maxRows={8} maxLength={key === 'prompt' ? 10000 : 20000} onChange={event => updateShot(focusedScene.scene_id, index, { [key]: event.currentTarget.value })} />)}
                  <WorkspaceDisclosure className="storyboard-planner-details" label={<>起止状态与接镜</>}><div className="storyboard-planner-continuity">{(['start_state', 'end_state', 'cut_note'] as const).map((key, field) => <Textarea key={key} label={['开始状态', '结束状态', '接镜要求'][field]} readOnly={!focusedIsDraft} value={shot[key]} rows={2} maxLength={2000} onChange={event => updateShot(focusedScene.scene_id, index, { [key]: event.currentTarget.value })} />)}</div></WorkspaceDisclosure>
                  {focusedIsDraft && !shot.shot_id && <Button variant="subtle" size="xs" leftSection={<Trash2 size={13} />} onClick={() => setResult(current => current && { ...current, scenes: current.scenes.map(item => item.scene_id === focusedScene.scene_id ? { ...item, shots: item.shots.filter((_, i) => i !== index) } : item) })}>移除新增镜头</Button>}
                </div>
              </WorkspaceDisclosure>)}
              {focusedIsDraft && <Button variant="default" size="xs" leftSection={<Plus size={13} />} disabled={focusedScene.shots.length >= Math.min(30, focusedScene.scene_duration)} onClick={() => setResult(current => current && { ...current, scenes: current.scenes.map(item => item.scene_id === focusedScene.scene_id ? { ...item, shots: [...item.shots, { shot_id: null, title: '新增镜头', prompt: '', image_prompt: '', video_prompt: '', duration: 1, start_state: '', end_state: '', cut_note: '' }] } : item) })}>添加镜头</Button>}
            </fieldset>
          </>}
        </div>
      </main>
    </div>
    <footer className="storyboard-planner-actions">
      <div className="storyboard-planner-footer-status" role="status">{pending ? <><LoaderCircle size={14} />{pending === 'context' ? '正在读取资料' : pending === 'save' ? saveLabel : pending === 'references' ? `正在整理参考设定 · ${elapsed} 秒` : `正在规划分镜 · ${elapsed} 秒`}</> : <>{hasPreview ? `${sceneIds.length} 场 · ${previewCount} 个镜头` : `${sceneIds.length} 场已选`}<small>{hasPreview ? '先补齐参考图，再生成分镜' : '先规划，再确认加入'}</small></>}</div>
      {pending === 'plan' || pending === 'references' ? <Button variant="default" onClick={cancelPlanning}>{pending === 'references' ? '取消整理' : '取消规划'}</Button> : <Button variant="subtle" disabled={pending === 'save'} onClick={onClose}>取消</Button>}
      {hasPreview ? <Button className="storyboard-planner-primary" leftSection={<Plus size={14} />} disabled={!!pending || referenceReloading || !!issue} onClick={() => void addToCanvas()}>确认加入画布</Button>
        : <Button className="storyboard-planner-primary" leftSection={<Clapperboard size={14} />} disabled={locked || !context || !planningIds.length || invalidTarget || invalidShotCount || !eligibleModels.some(model => model.id === modelId)} onClick={() => void startPlanning()}>开始规划</Button>}
    </footer>
  </Modal>
}
