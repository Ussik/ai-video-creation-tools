import { Button, MultiSelect, Select, Textarea, TextInput } from '@mantine/core'
import type { ProjectDetail, VisualKind, VisualProfile, VisualProfileDraft } from '../../shared/api/api'
import { visualProfileDraftRelationError, visualProfileLabel } from './visual-profile-inheritance'
import './visual-profile-inheritance.css'

export const visualKinds = [
  { value: 'character', label: '人物' }, { value: 'location', label: '场景' }, { value: 'prop', label: '道具' },
]
export const visualViews: Record<VisualKind, string> = {
  character: '正面、侧面、背面、四分之三视角；面部、发型、服装细节；身高比例、配色与材质标注。',
  location: '空间平面布局、多个方向的视图；门窗、通道、固定陈设的位置与尺寸；材质、配色及光源。',
  prop: '正面、侧面、背面、俯视；关键局部与使用状态；尺寸、结构、材质、纹样和配色。',
}
export const emptyVisualProfile = (): VisualProfileDraft => ({ kind: 'character', name: '', variant: '默认', definition: '', view_requirements: visualViews.character, scene_ids: [] })
export function validVisualProfile(draft: VisualProfileDraft) {
  return [draft.name, draft.variant, draft.definition, draft.view_requirements].every(value => value.trim())
}
export const visualDropdownProps = { withinPortal: true, zIndex: 450, classNames: { dropdown: 'pc-visual-dropdown' } }

export default function VisualProfileFields({ value, onChange, scenes, profiles = [], drafts = [], profileId, onLocateBase }: {
  value: VisualProfileDraft; onChange: (patch: Partial<VisualProfileDraft>) => void; scenes?: ProjectDetail['script']['scenes'];
  profiles?: VisualProfile[]; drafts?: VisualProfileDraft[]; profileId?: string; onLocateBase?: (profile: VisualProfile) => void;
}) {
  const base = profiles.find(profile => profile.id === value.base_profile_id)
  const draftBase = drafts.find(draft => draft.draft_key && draft.draft_key === value.base_draft_key)
  const relationError = visualProfileDraftRelationError(value, profiles, drafts, profileId)
  const baseValue = value.base_profile_id ? `profile:${value.base_profile_id}` : value.base_draft_key ? `draft:${value.base_draft_key}` : 'none'
  const options = [
    { value: 'none', label: '独立基础设定' },
    ...profiles.filter(profile => profile.kind === value.kind && profile.id !== profileId).map(profile => ({
      value: `profile:${profile.id}`, label: `${visualProfileLabel(profile)}${profile.board_asset_id ? '' : '（待确认基础图）'}`,
      disabled: !!visualProfileDraftRelationError({ ...value, base_profile_id: profile.id, base_draft_key: null }, profiles, drafts, profileId),
    })),
    ...drafts.filter(draft => draft.kind === value.kind && !!draft.draft_key && draft.draft_key !== value.draft_key).map(draft => ({
      value: `draft:${draft.draft_key}`, label: `${visualProfileLabel(draft)}（本批草稿）`,
      disabled: !!visualProfileDraftRelationError({ ...value, base_profile_id: null, base_draft_key: draft.draft_key }, profiles, drafts, profileId),
    })),
  ]
  if (baseValue !== 'none' && !options.some(option => option.value === baseValue)) options.push({ value: baseValue, label: '基础设定已失效，请重新选择' })
  return <>
    <Select label="类型" aria-label="设定类型" allowDeselect={false} value={value.kind} data={visualKinds} comboboxProps={visualDropdownProps}
      onChange={kind => kind && onChange({ kind: kind as VisualKind,
        ...(kind !== value.kind ? { base_profile_id: null, base_draft_key: null, state_delta: '' } : {}),
        ...(value.view_requirements === visualViews[value.kind] ? { view_requirements: visualViews[kind as VisualKind] } : {}) })} />
    <TextInput label="名称" aria-label="设定名称" maxLength={100} value={value.name} onChange={event => onChange({ name: event.currentTarget.value })} />
    <TextInput label="服装 / 状态版本" aria-label="服装或状态版本" maxLength={100} value={value.variant} onChange={event => onChange({ variant: event.currentTarget.value })} />
    <Select label="基础设定" aria-label="基础设定" searchable allowDeselect={false} value={baseValue} data={options} comboboxProps={visualDropdownProps}
      description="状态版本沿用基础设定的身份与固定特征，生成时自动使用已确认的基础图。"
      error={relationError} onChange={selected => selected && onChange(selected === 'none'
        ? { base_profile_id: null, base_draft_key: null, state_delta: '' }
        : selected.startsWith('profile:') ? { base_profile_id: selected.slice(8), base_draft_key: null }
          : { base_profile_id: null, base_draft_key: selected.slice(6) })} />
    {(base || draftBase) && <div className="pc-profile-inheritance" role="status">
      <strong>{visualProfileLabel(base || draftBase!)} → {value.variant || '当前状态'}</strong>
      <span>{draftBase ? '保存后先确认基础图，再生成当前状态。' : base?.board_asset_id && base.board_style_status !== 'needs_review' ? '已关联基础设定，生成时保留身份与固定特征。' : '基础图尚未确认或需要复核，请先完成基础设定。'}</span>
      {base && onLocateBase && <Button size="xs" variant="default" onClick={() => onLocateBase(base)}>定位基础设定</Button>}
    </div>}
    {baseValue !== 'none' && <Textarea label="本状态的差异" aria-label="本状态的差异" autosize minRows={3} maxRows={8} maxLength={12000}
      description="只写服装、年龄阶段、受伤或持物等变化；不必重复基础设定。"
      value={value.state_delta || ''} onChange={event => onChange({ state_delta: event.currentTarget.value })} />}
    <Textarea label="固定视觉设定" aria-label="固定视觉设定" autosize minRows={5} maxRows={12} maxLength={12000} value={value.definition} onChange={event => onChange({ definition: event.currentTarget.value })} />
    <Textarea label="信息图视图与细节" aria-label="信息图视图与细节" autosize minRows={3} maxRows={8} maxLength={3000} value={value.view_requirements} onChange={event => onChange({ view_requirements: event.currentTarget.value })} />
    {scenes && <MultiSelect label="使用场次" aria-label="使用场次" searchable maxValues={100} value={value.scene_ids} comboboxProps={visualDropdownProps}
      data={scenes.map(scene => ({ value: scene.id, label: `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}` }))}
      onChange={scene_ids => onChange({ scene_ids })} />}
  </>
}
