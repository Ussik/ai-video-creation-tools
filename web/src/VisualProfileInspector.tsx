import { useEffect, useState } from 'react'
import { ActionIcon, Button, Textarea, TextInput, Tooltip } from '@mantine/core'
import { Save, X } from 'lucide-react'
import { api, json } from './api'
import type { ProjectDetail, VisualProfile } from './api'

type Props = { profile: VisualProfile; detail: ProjectDetail; generating: boolean; onRefresh: () => Promise<void>; onClose: () => void; onBindings: () => void; onDirtyChange: (dirty: boolean) => void }

export default function VisualProfileInspector({ profile, detail, generating, onRefresh, onClose, onBindings, onDirtyChange }: Props) {
  const [draft, setDraft] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setDraft(profile); setError('') }, [profile.id, profile.revision, profile.board_asset_id])
  const dirty = (['name', 'variant', 'definition', 'view_requirements'] as const).some(key => draft[key] !== profile[key])
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  async function save() {
    setSaving(true); setError('')
    try {
      await api(`/visual-profiles/${profile.id}`, json('PATCH', { name: draft.name, variant: draft.variant,
        definition: draft.definition, view_requirements: draft.view_requirements, expected_revision: profile.revision }))
      await onRefresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setSaving(false) }
  }
  const scenes = (detail.scene_visual_bindings || []).filter(binding => binding.profile_id === profile.id)
  return <aside className="pc-profile-inspector" aria-label="设定档案编辑" data-canvas-overlay>
    <header><strong>{profile.name} · v{profile.revision}</strong><Tooltip label="关闭设定编辑"><ActionIcon variant="subtle" aria-label="关闭设定编辑" onClick={onClose}><X size={16} /></ActionIcon></Tooltip></header>
    <div className="pc-profile-inspector-fields">
      <fieldset disabled={saving || generating}>
        <TextInput label="名称" aria-label="设定名称" maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.currentTarget.value })} />
        <TextInput label="服装 / 状态版本" aria-label="服装或状态版本" maxLength={100} value={draft.variant} onChange={event => setDraft({ ...draft, variant: event.currentTarget.value })} />
        <Textarea label="固定视觉设定" aria-label="固定视觉设定" autosize minRows={6} maxRows={12} maxLength={12000} value={draft.definition} onChange={event => setDraft({ ...draft, definition: event.currentTarget.value })} />
        <Textarea label="信息图视图与细节" aria-label="信息图视图与细节" autosize minRows={4} maxRows={8} maxLength={3000} value={draft.view_requirements} onChange={event => setDraft({ ...draft, view_requirements: event.currentTarget.value })} />
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="pc-profile-usage"><strong>使用场次 · {scenes.length}</strong>{scenes.map(binding => <span key={binding.scene_id}>{detail.script.scenes.find(scene => scene.id === binding.scene_id)?.heading}</span>)}<Button variant="default" size="xs" onClick={onBindings}>管理场次 / 镜头引用</Button></div>
    </div>
    <footer><Button variant="default" leftSection={<Save size={14} />} disabled={!dirty || saving || generating || !draft.name.trim() || !draft.variant.trim() || !draft.definition.trim() || !draft.view_requirements.trim()} onClick={() => void save()}>保存设定</Button></footer>
  </aside>
}
