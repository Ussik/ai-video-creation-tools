import { useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, Textarea } from '@mantine/core'
import { handoffCountChoice, type HandoffConflict, type HandoffSourceEdit } from '@video-studio/shared/media/video-handoff-conflict'

import './canvas-decision-dialogs.css'

export default function CanvasVideoConflictDialog({ conflict, onClose, onApply, busy }: {
  conflict: HandoffConflict; onClose: () => void; onApply: (edit: HandoffSourceEdit) => Promise<void>; busy: boolean
}) {
  const [edit, setEdit] = useState<HandoffSourceEdit>({ video_prompt: conflict.sources.video_prompt, audio_plan: conflict.sources.audio_plan })
  const [preview, setPreview] = useState(false), [confirmed, setConfirmed] = useState(false), [error, setError] = useState('')
  const choices = useMemo(() => (['一', '两'] as const).flatMap(count => {
    const value = handoffCountChoice(conflict, count)
    return value ? [{ count, value }] : []
  }), [conflict])
  const changed = JSON.stringify(edit) !== JSON.stringify({ video_prompt: conflict.sources.video_prompt, audio_plan: conflict.sources.audio_plan })
  const update = (value: HandoffSourceEdit) => { setEdit(value); setPreview(false); setConfirmed(false) }
  return <Modal opened onClose={() => { if (!busy) onClose() }} title="确认动作与声音冲突" size="xl" closeOnClickOutside={!busy} closeOnEscape={!busy} closeButtonProps={{ disabled: busy }} className="pc-video-conflict-modal">
    <div className="pc-decision-dialog-scroll"><Stack gap="sm">
      <Alert color="orange">这份候选已保留。先统一本镜的动作与音效，再预览采用；不会再次调用模型。</Alert>
      {conflict.conflicts.map((issue, index) => <div key={index}>
        <Text fw={600}>{issue.message}</Text><Text size="sm">{issue.suggestion}</Text>
        {issue.evidence.map((quote, i) => <Text size="sm" key={i}>{issue.locations.filter(location => location.quote === quote).map(location => location.field_path).join("、") || "来源组合文本（未定位到可编辑字段）"}：{quote}</Text>)}
      </div>)}
      {!!choices.length && <Group>{choices.map(choice => <Button key={choice.count} variant="light" disabled={busy} onClick={() => update(choice.value)}>统一为{choice.count}次（预览）</Button>)}</Group>}
      <Textarea label="本镜动作、运镜与时序" value={edit.video_prompt} onChange={event => update({ ...edit, video_prompt: event.currentTarget.value })} autosize minRows={6} maxRows={16} readOnly={preview || busy} />
      {edit.audio_plan?.sound_effects.map((effect, index) => <Textarea key={index} label={`事件音效 ${index + 1}`} value={effect} readOnly={preview || busy} autosize minRows={2}
        onChange={event => { const audio_plan = structuredClone(edit.audio_plan!); audio_plan.sound_effects[index] = event.currentTarget.value; update({ ...edit, audio_plan }) }} />)}
      {preview && <><Alert color="blue">将同时保存以上动作与事件音效，并继续承接视频。台词、共同声场、图片、引用和当前视频草稿均保留。请核对次数、持续时间与先后关系。</Alert>
        <Checkbox checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} label="我已确认动作次数、时序和音效一致，并采用此修正" /></>}
      {error && <Alert color="red">{error}</Alert>}
    </Stack></div>
      <footer className="pc-decision-dialog-actions"><Group justify="flex-end"><Button variant="subtle" onClick={onClose} disabled={busy}>保留待确认</Button>
        {preview ? <Button disabled={!confirmed || busy} loading={busy} onClick={() => { setError(''); void onApply(edit).catch(error => setError(error instanceof Error ? error.message : String(error))) }}>采用修正并继续</Button>
          : <Button disabled={!changed || !edit.video_prompt.trim() || busy || edit.audio_plan?.sound_effects.some(effect => !effect.trim())} onClick={() => setPreview(true)}>预览修正</Button>}
      </Group> </footer>
  </Modal>
}
