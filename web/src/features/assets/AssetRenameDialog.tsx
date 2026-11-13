import { useRef, useState } from 'react'
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core'
import type { Asset } from '../../shared/api/api'

type Props = {
  asset: Asset
  currentName: string
  onSave: (name: string) => Promise<void>
  onClose: () => void
}

export default function AssetRenameDialog({ currentName, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(currentName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const name = draft.trim()
  const issue = !name ? '请输入素材名称'
    : name.length > 120 ? '素材名称不能超过 120 个字符'
      : /[\u0000-\u001f\u007f-\u009f]/.test(draft) ? '素材名称不能包含控制字符' : null

  async function save() {
    if (pending.current || issue) return
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave(name)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名失败，请重试')
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return <Modal opened title="重命名素材" centered size="sm" zIndex={260}
    onClose={() => { if (!pending.current) onClose() }}
    closeOnEscape={!saving} closeOnClickOutside={!saving} withCloseButton={!saving}>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <Stack gap="md">
        <TextInput label="素材名称" placeholder="输入素材名称" autoFocus data-autofocus maxLength={120}
          value={draft} disabled={saving} error={error || (draft ? issue : null)}
          onFocus={event => event.currentTarget.select()}
          onChange={event => { setDraft(event.currentTarget.value); setError(null) }} />
        <Group justify="flex-end" gap="sm">
          <Button type="button" variant="default" disabled={saving} onClick={onClose}>取消</Button>
          <Button type="submit" loading={saving} disabled={!!issue}>保存</Button>
        </Group>
      </Stack>
    </form>
  </Modal>
}
