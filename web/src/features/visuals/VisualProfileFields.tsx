import { MultiSelect, Select, Textarea, TextInput } from '@mantine/core'
import type { ProjectDetail, VisualKind, VisualProfileDraft } from '../../shared/api/api'

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

export default function VisualProfileFields({ value, onChange, scenes }: {
  value: VisualProfileDraft; onChange: (patch: Partial<VisualProfileDraft>) => void; scenes?: ProjectDetail['script']['scenes'];
}) {
  return <>
    <Select label="类型" aria-label="设定类型" allowDeselect={false} value={value.kind} data={visualKinds} comboboxProps={visualDropdownProps}
      onChange={kind => kind && onChange({ kind: kind as VisualKind,
        ...(value.view_requirements === visualViews[value.kind] ? { view_requirements: visualViews[kind as VisualKind] } : {}) })} />
    <TextInput label="名称" aria-label="设定名称" maxLength={100} value={value.name} onChange={event => onChange({ name: event.currentTarget.value })} />
    <TextInput label="服装 / 状态版本" aria-label="服装或状态版本" maxLength={100} value={value.variant} onChange={event => onChange({ variant: event.currentTarget.value })} />
    <Textarea label="固定视觉设定" aria-label="固定视觉设定" autosize minRows={5} maxRows={12} maxLength={12000} value={value.definition} onChange={event => onChange({ definition: event.currentTarget.value })} />
    <Textarea label="信息图视图与细节" aria-label="信息图视图与细节" autosize minRows={3} maxRows={8} maxLength={3000} value={value.view_requirements} onChange={event => onChange({ view_requirements: event.currentTarget.value })} />
    {scenes && <MultiSelect label="使用场次" aria-label="使用场次" searchable maxValues={100} value={value.scene_ids} comboboxProps={visualDropdownProps}
      data={scenes.map(scene => ({ value: scene.id, label: `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}` }))}
      onChange={scene_ids => onChange({ scene_ids })} />}
  </>
}
