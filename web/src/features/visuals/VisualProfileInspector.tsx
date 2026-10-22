import { useEffect, useState } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { ArrowUpRight, Save, Trash2, X } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { Model, ProjectDetail, VisualProfile, VisualProfileDraft, VisualProjectData } from '../../shared/api/api'
import VisualProfileFields, { emptyVisualProfile, validVisualProfile } from './VisualProfileFields'
import VisualReferenceAssets from './VisualReferenceAssets'
import { useAppDialog } from '../../shared/ui/AppDialog'
import { visualProfileBaseReadiness, visualProfileDraftRelationError, visualProfileLabel } from './visual-profile-inheritance'

type Props = {
  profile?: VisualProfile; inCanvas: boolean; detail: ProjectDetail; generating: boolean; onRefresh: () => Promise<void>;
  onClose: () => void; onBindings: () => void; onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void; onSaved: (profile: VisualProfile) => void;
  onDeleted: (profile: VisualProfile) => void; onOpenCanvas: (profile: VisualProfile) => void;
  models?: Model[]; designId?: string | null;
}

export default function VisualProfileInspector({ profile, inCanvas, detail, models = [], designId, generating, onRefresh, onClose, onBindings, onDirtyChange, onBusyChange, onSaved, onDeleted, onOpenCanvas }: Props) {
  const scopeId = profile ? profile.design_id || null : designId || null
  const scopedProfiles = (detail.visual_profiles || []).filter(item => (item.design_id || null) === scopeId)
  const creationScenes = detail.script.scenes.filter(scene => {
    const currentShots = detail.shots.filter(shot => shot.source_scene_id === scene.id && !shot.superseded_by)
    return currentShots.length ? currentShots.every(shot => (shot.design_id || null) === scopeId) : !scopeId
  })
  const initial = (): VisualProfileDraft => profile ? { ...profile, scene_ids: [] } : emptyVisualProfile()
  const [draft, setDraft] = useState<VisualProfileDraft>(initial)
  const [baseline, setBaseline] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const busy = saving || referenceBusy
  const [error, setError] = useState('')
  const dialog = useAppDialog()
  // Do not replace unsaved edits on a polling refresh. A concurrent revision
  // remains the expected revision below, so the server can reject stale edits.
  const [expectedRevision, setExpectedRevision] = useState(profile?.revision)
  const dirty = baseline
    ? (['kind', 'name', 'variant', 'definition', 'view_requirements'] as const).some(key => draft[key] !== baseline[key]) ||
      (draft.base_profile_id || null) !== (baseline.base_profile_id || null) || (draft.state_delta || '') !== (baseline.state_delta || '')
    : draft.name !== '' || draft.definition !== '' || draft.variant !== '默认' || draft.kind !== 'character' || draft.view_requirements !== emptyVisualProfile().view_requirements || !!draft.scene_ids.length || !!draft.base_profile_id || !!draft.base_draft_key || !!draft.state_delta
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  useEffect(() => {
    if (!profile || !baseline || profile.revision <= baseline.revision || dirty || saving) return
    setDraft({ ...profile, scene_ids: [] }); setBaseline(profile); setExpectedRevision(profile.revision)
  }, [profile, baseline, dirty, saving])
  const scenes = (detail.scene_visual_bindings || []).filter(binding => binding.profile_id === profile?.id)
  const shots = (detail.shot_visual_bindings || []).filter(binding => binding.profile_id === profile?.id)
  const dependents = (detail.visual_profiles || []).filter(item => item.base_profile_id === profile?.id)
  const relationError = visualProfileDraftRelationError(draft, scopedProfiles, [], profile?.id)
  const inheritance = profile ? visualProfileBaseReadiness({ ...profile, ...draft }, detail) : undefined
  async function save() {
    if (busy || generating || relationError) return
    setSaving(true); setError('')
    try {
      let saved: VisualProfile
      if (profile) {
        saved = await api<VisualProfile>(`/visual-profiles/${profile.id}`, json('PATCH', { kind: draft.kind, name: draft.name, variant: draft.variant,
          definition: draft.definition, view_requirements: draft.view_requirements, base_profile_id: draft.base_profile_id || null,
          state_delta: draft.state_delta || '', expected_revision: expectedRevision, definition_status: 'ready' }))
      } else {
        if (scopedProfiles.some(item => item.kind === draft.kind && item.name === draft.name.trim() && item.variant === draft.variant.trim())) throw new Error('同名同版本的设定已存在，请从左侧列表选择后编辑。')
        const result = await api<VisualProjectData>(`/projects/${detail.id}/visual-profiles`, json('POST', { profiles: [draft], ...(scopeId ? { design_id: scopeId } : {}) }))
        if (result.created_profile_ids && !result.created_profile_ids.length) throw new Error('同名同版本的设定已存在，请从左侧列表选择后编辑。')
        const created = result.visual_profiles.find(item => (item.design_id || null) === scopeId && (result.created_profile_ids?.length
          ? result.created_profile_ids.includes(item.id)
          : item.kind === draft.kind && item.name === draft.name.trim() && item.variant === draft.variant.trim()))
        if (!created) throw new Error('保存结果中没有找到新增设定，请刷新列表后查看。')
        saved = created
      }
      setDraft({ ...saved, scene_ids: [] }); setBaseline(saved); setExpectedRevision(saved.revision)
      onSaved(saved)
      await onRefresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setSaving(false) }
  }
  async function remove() {
    if (!profile || busy || generating || shots.length || dependents.length) return
    if (!await dialog.confirm({ title: '删除视觉设定', message: `删除「${profile.name}」及其场次引用和画布设定节点？已生成的图片仍保留在素材库。`, danger: true })) return
    setSaving(true); setError('')
    try {
      await api(`/visual-profiles/${profile.id}`, json('DELETE', {}))
      onDeleted(profile); await onRefresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setSaving(false) }
  }
  return <>
    <aside className="pc-visual-panel pc-profile-inspector" aria-label={profile ? '设定档案编辑' : '新增视觉设定'} data-canvas-overlay>
      <header><div><small>{profile ? '编辑视觉设定' : '新增视觉设定'}</small><strong>{profile ? `${profile.name} · v${profile.revision}` : '创建可复用的设定'}</strong></div><Tooltip label="关闭设定编辑"><ActionIcon variant="subtle" aria-label="关闭设定编辑" disabled={busy} onClick={onClose}><X size={16} /></ActionIcon></Tooltip></header>
      <div className="pc-profile-inspector-fields">
        {profile?.definition_status === 'draft' && <p className="pc-visual-note">模型整理的草稿，可修改后确认。</p>}
        {detail.project_visual_style && detail.project_visual_style.source !== 'unspecified' && <p className="pc-visual-note">项目画风：{detail.project_visual_style.label}</p>}
        {profile && expectedRevision !== profile.revision && <div className="pc-visual-progress" role="status"><span>设定版本已更新，当前编辑内容保留。</span><Button variant="default" size="xs" disabled={saving} onClick={() => {
          void (async () => {
            if (dirty && !await dialog.confirm({ title: '加载最新设定', message: '这会替换当前未保存的修改。', confirmLabel: '加载最新', cancelLabel: '保留修改' })) return
            setDraft({ ...profile, scene_ids: [] }); setBaseline(profile); setExpectedRevision(profile.revision); setError('')
          })()
        }}>加载最新设定</Button></div>}
        <fieldset disabled={busy || generating}><VisualProfileFields value={draft} onChange={patch => setDraft(current => ({ ...current, ...patch }))}
          profiles={scopedProfiles} profileId={profile?.id} onLocateBase={dirty ? undefined : onOpenCanvas} scenes={profile ? undefined : creationScenes} /></fieldset>
        {inheritance?.waitingProfile && <div className="pc-profile-inheritance is-waiting" role="status"><span>请先确认「{visualProfileLabel(inheritance.waitingProfile)}」的基础图，再生成当前状态。</span>
          <Button variant="default" size="xs" disabled={busy || dirty} onClick={() => onOpenCanvas(inheritance.waitingProfile!)}>前往基础图</Button></div>}
        {error && <p className="pc-visual-error" role="alert">{error}</p>}
        {profile && <VisualReferenceAssets profile={profile} detail={detail} models={models} disabled={dirty || saving || generating}
          disabledReason={dirty ? '先保存设定，再添加或确认对应版本的参考图。' : generating ? '信息图生成完成后可管理独立参考。' : undefined}
          onRefresh={onRefresh} onBusyChange={setReferenceBusy} />}
        {profile && <div className="pc-profile-usage"><strong>使用范围 · {scenes.length} 场 / {shots.length} 镜头</strong>
          {scenes.slice(0, 3).map(binding => <span key={binding.scene_id}>{detail.script.scenes.find(scene => scene.id === binding.scene_id)?.heading}</span>)}
          <Button variant="default" size="xs" onClick={onBindings} disabled={busy}>管理使用范围</Button>
          {shots.length > 0 && <p className="pc-visual-note">删除设定前，请先在使用范围中移除镜头引用。</p>}
          {dependents.length > 0 && <p className="pc-visual-note">{dependents.length} 份状态设定沿用此基础，调整继承关系后可删除。</p>}
        </div>}
      </div>
      <footer>{profile && <Tooltip label={shots.length ? '先移除镜头引用后可删除' : dependents.length ? '先调整状态设定的继承关系后可删除' : '删除设定'}><ActionIcon variant="subtle" aria-label="删除设定" disabled={busy || generating || !!shots.length || !!dependents.length} onClick={() => void remove()}><Trash2 size={15} /></ActionIcon></Tooltip>}
        {profile && <Button variant="default" leftSection={<ArrowUpRight size={14} />} disabled={dirty || busy} onClick={() => onOpenCanvas(profile)}>{inCanvas ? '定位节点' : '加入画布'}</Button>}
        <Button variant="default" leftSection={<Save size={14} />} disabled={(!dirty && profile?.definition_status !== 'draft') || busy || generating || !validVisualProfile(draft) || !!relationError} onClick={() => void save()}>{!profile ? '创建设定' : profile.definition_status === 'draft' ? '确认设定' : '保存设定'}</Button></footer>
    </aside>
    {dialog.dialog}
  </>
}
