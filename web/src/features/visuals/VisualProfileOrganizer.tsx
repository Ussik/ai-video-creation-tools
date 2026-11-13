import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Loader, MultiSelect, Select } from '@mantine/core'
import { Check, Trash2, WandSparkles, X } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { Model, ProjectDetail, Provider, VisualProfileDraft } from '../../shared/api/api'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import DirectorMessageTiming, { finishMessageTiming, type MessageTiming } from '../script/DirectorMessageTiming'
import { useCreativeSkills } from '../skills/useCreativeSkills'
import CreativeSkillSelector from '../skills/CreativeSkillSelector'
import type { SkillAssignment } from '../../shared/api/skills-api'
import VisualProfileFields, { validVisualProfile, visualDropdownProps } from './VisualProfileFields'
import { newVisualProfileDrafts, visualProfileDraftIdentity, visualProfileDraftRelationError } from './visual-profile-inheritance'

function sourceVersion(detail: ProjectDetail, designId?: string | null) {
  return JSON.stringify([designId || null, detail.script, detail.project_visual_style?.version,
    detail.visual_profiles?.filter(profile => (profile.design_id || null) === (designId || null)).map(profile => [profile.id, profile.revision, profile.base_profile_id || null, profile.state_delta || ''])])
}
type Props = {
  detail: ProjectDetail; models: Model[]; onRefresh: () => Promise<void>; onClose: () => void;
  onBusyChange: (busy: boolean) => void; onDirtyChange: (dirty: boolean) => void;
  designId?: string | null; providers?: Provider[];
}

export default function VisualProfileOrganizer({ detail, models, providers, designId, onRefresh, onClose, onBusyChange, onDirtyChange }: Props) {
  const scopedProfiles = (detail.visual_profiles || []).filter(profile => (profile.design_id || null) === (designId || null))
  const scenes = detail.script.scenes.filter(scene => {
    const currentShots = detail.shots.filter(shot => shot.source_scene_id === scene.id && !shot.superseded_by)
    return currentShots.length ? currentShots.every(shot => (shot.design_id || null) === (designId || null)) : !designId
  })
  const skillControl = useCreativeSkills(detail.id)
  const [usedSkills, setUsedSkills] = useState<string[]>([])
  const [usedAssignment, setUsedAssignment] = useState<SkillAssignment>()
  const [catalog, setCatalog] = useState(models)
  const availableModels = catalog.filter(model => model.enabled && model.modality === 'text'
    && (!providers || providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo')))
  const [sceneIds, setSceneIds] = useState(scenes.slice(0, 100).map(scene => scene.id))
  const [drafts, setDrafts] = useState<VisualProfileDraft[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const { modelId, selectModel } = useSharedModelSelection('text', availableModels, { locked: busy })
  const [draftModelId, setDraftModelId] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<(MessageTiming & { phase: 'running' | 'complete' | 'failed' | 'cancelled' }) | null>(null)
  const request = useRef<AbortController | null>(null)
  const version = useRef('')
  const currentDetail = useRef(detail)
  currentDetail.current = detail
  const sourceChanged = !!drafts.length && version.current !== sourceVersion(detail, designId)
  const modelChanged = !!drafts.length && draftModelId !== modelId
  const stale = sourceChanged || modelChanged
  const relationError = drafts.map(draft => visualProfileDraftRelationError(draft, scopedProfiles, drafts)).find(Boolean)
  useEffect(() => {
    const controller = new AbortController()
    void api<Model[]>('/models', { signal: controller.signal }).then(setCatalog).catch(issue => { if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) })
    return () => { controller.abort(); request.current?.abort() }
  }, [])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  useEffect(() => { onDirtyChange(!!drafts.length); return () => onDirtyChange(false) }, [drafts.length, onDirtyChange])
  async function analyze(restart = false) {
    if (busy || !sceneIds.length || !modelId || skillControl.loading || !!skillControl.error) return
    const controller = new AbortController()
    request.current = controller
    const startedAt = performance.now(), signature = sourceVersion(detail, designId)
    setBusy(true); setError(''); setStatus({ phase: 'running', processing_started_at: startedAt })
    try {
      const result = await api<{ profiles: VisualProfileDraft[]; skills?: Array<{ name: string }>; skill_assignment?: SkillAssignment }>(`/projects/${detail.id}/visual-profiles/analyze`, { ...json('POST', { ...(restart ? { restart: true } : {}), model_id: modelId, scene_ids: sceneIds, skill_ids: skillControl.requestIds('visual_assets'), ...(designId ? { design_id: designId } : {}) }), signal: controller.signal })
      if (controller.signal.aborted) return
      if (signature !== sourceVersion(currentDetail.current, designId)) throw new Error('剧本资料已发生变化，请重新整理，避免使用过期草稿。')
      const next = newVisualProfileDrafts(result.profiles, (currentDetail.current.visual_profiles || []).filter(profile => (profile.design_id || null) === (designId || null)))
        .map(draft => ({ ...draft, draft_key: draft.draft_key || crypto.randomUUID() }))
      if (!next.length) throw new Error('没有发现缺少的视觉设定。已有设定可从左侧列表选择后编辑。')
      version.current = signature
      setDraftModelId(modelId)
      setUsedSkills(result.skills?.map(skill => skill.name) || []); setUsedAssignment(result.skill_assignment); setDrafts(next); setIndex(0); setStatus({ phase: 'complete', ...finishMessageTiming(startedAt) })
    } catch (issue) {
      if (!controller.signal.aborted) { setError(issue instanceof Error ? issue.message : String(issue)); setStatus({ phase: 'failed', ...finishMessageTiming(startedAt) }) }
    } finally { if (request.current === controller) { request.current = null; setBusy(false) } }
  }
  async function save() {
    if (busy || stale || !drafts.length || relationError || drafts.some(draft => !validVisualProfile(draft))) return
    setBusy(true); setError('')
    try {
      const known = new Set((currentDetail.current.visual_profiles || []).filter(profile => (profile.design_id || null) === (designId || null)).map(visualProfileDraftIdentity))
      const seen = new Set<string>()
      for (const draft of drafts) {
        const key = visualProfileDraftIdentity(draft)
        if (known.has(key) || seen.has(key)) throw new Error(`「${draft.name} · ${draft.variant}」已存在或在草稿中重复，请调整名称 / 版本或移除此草稿。`)
        seen.add(key)
      }
      await api(`/projects/${detail.id}/visual-profiles`, json('POST', { profiles: drafts, ...(designId ? { design_id: designId } : {}) }))
      setDrafts([]); setIndex(0)
      await onRefresh()
      setStatus(null)
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setBusy(false) }
  }
  return <aside className="pc-visual-panel pc-profile-inspector" aria-label="批量整理视觉设定" data-canvas-overlay>
    <header><div><small>设定工具</small><strong>批量整理草稿</strong></div><ActionIcon variant="subtle" aria-label="关闭批量整理" disabled={busy} onClick={onClose}><X size={16} /></ActionIcon></header>
    <div className="pc-profile-inspector-fields">
      <p className="pc-visual-note">从剧本补充缺少的人物、场景与道具设定。检查后保存到左侧列表，再用加号加入画布。</p>
      {error && <p className="pc-visual-error" role="alert">{error}</p>}
      {status && <div className="pc-visual-progress" role="status" aria-busy={status.phase === 'running'}><span>{status.phase === 'running' && <Loader size={14} color="gray" />}{status.phase === 'running' ? '正在整理设定' : status.phase === 'complete' ? '草稿已整理，等待检查' : status.phase === 'cancelled' ? '已停止，已完成结果可在重试时复用' : '整理失败，可重试继续'}</span><DirectorMessageTiming {...status} pending={status.phase === 'running'} title="整理视觉设定的处理用时" /></div>}
      {drafts.length ? <>
        <p className="creative-skill-description">使用技能：{usedSkills.join(' · ') || '基础创作规则'}</p>
        {usedAssignment?.reason && <p className="creative-skill-description">选择理由：{usedAssignment.reason}</p>}
        {sourceChanged && <p className="pc-visual-note" role="alert">剧本资料已变化，请放弃草稿后重新整理。</p>}
        {modelChanged && <p className="pc-visual-note" role="alert">文本模型已切换，当前草稿已保留。请重新整理，或切回原模型后保存。</p>}
        {relationError && <p className="pc-visual-error" role="alert">{relationError}</p>}
        <div className="pc-visual-draft-select"><Select label={`检查草稿 · ${index + 1} / ${drafts.length}`} aria-label="选择设定草稿" value={String(index)} data={drafts.map((draft, i) => ({ value: String(i), label: `${draft.name} · ${draft.variant}` }))} allowDeselect={false} disabled={busy} comboboxProps={visualDropdownProps} onChange={value => { if (value !== null) setIndex(Number(value)) }} />
          <ActionIcon variant="subtle" aria-label="移除此草稿" disabled={busy} onClick={() => { setDrafts(current => current.filter((_, i) => i !== index)); setIndex(0) }}><Trash2 size={15} /></ActionIcon></div>
        <fieldset disabled={busy}><VisualProfileFields value={drafts[index]!} onChange={patch => setDrafts(current => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft))}
          profiles={scopedProfiles} drafts={drafts} scenes={scenes} /></fieldset>
      </> : <fieldset disabled={busy}>
        <Select label="文本模型" aria-label="整理设定的文本模型" value={modelId || null} placeholder="选择文本模型" allowDeselect={false} data={availableModels.map(model => ({ value: model.id, label: model.name }))} comboboxProps={visualDropdownProps} onChange={value => value && selectModel(value)} />
        <MultiSelect label={`整理场次 · ${sceneIds.length} / ${scenes.length}`} aria-label="整理场次" searchable maxValues={100} value={sceneIds} data={scenes.map(scene => ({ value: scene.id, label: `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}` }))} comboboxProps={visualDropdownProps} onChange={setSceneIds} />
        {scenes.length > 100 && <p className="pc-visual-note">每批最多 100 个场次，请分批整理。</p>}
        <CreativeSkillSelector stage="visual_assets" policies={skillControl.policies} ids={skillControl.ids('visual_assets')} onChange={values => skillControl.change('visual_assets', values)}
          selection={skillControl.selection('visual_assets')} onUseAutomatic={() => skillControl.useAutomatic('visual_assets')}
          projectId={detail.id} disabled={busy} loading={skillControl.loading} error={skillControl.error} onDefaultsChanged={() => skillControl.reload('visual_assets')} />
      </fieldset>}
    </div>
    <footer>{busy && request.current && <Button variant="default" onClick={() => { request.current?.abort(); setStatus(current => current ? { ...current, phase: 'cancelled' } : null) }}>停止整理</Button>}{drafts.length ? <><Button variant="default" disabled={busy} onClick={() => { setDrafts([]); setStatus(null); setError('') }}>放弃草稿</Button><Button variant="default" leftSection={<Check size={14} />} disabled={busy || stale || !!relationError || drafts.some(draft => !validVisualProfile(draft))} onClick={() => void save()}>确认保存 {drafts.length} 份设定</Button></>
      : <>{(status?.phase === 'failed' || status?.phase === 'cancelled') && <Button variant="subtle" disabled={busy || !sceneIds.length || !modelId || skillControl.loading || !!skillControl.error} onClick={() => void analyze(true)}>重新整理</Button>}<Button variant="default" leftSection={<WandSparkles size={14} />} disabled={busy || !sceneIds.length || !modelId || skillControl.loading || !!skillControl.error} onClick={() => void analyze()}>{status?.phase === 'failed' || status?.phase === 'cancelled' ? '继续整理' : '整理设定草稿'}</Button></>}
    </footer>
  </aside>
}
