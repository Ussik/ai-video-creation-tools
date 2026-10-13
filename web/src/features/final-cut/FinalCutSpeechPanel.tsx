import { useEffect, useState } from 'react'
import { Button, Select } from '@mantine/core'
import { Mic2 } from 'lucide-react'
import type { ProjectDetail, Shot } from '../../shared/api/api'
import SpeechPlacementEditor from '../speech/SpeechPlacementEditor'

export default function FinalCutSpeechPanel({ detail, shot, onRefresh, onOpenSpeech }: {
  detail: ProjectDetail; shot: Shot; onRefresh: () => Promise<unknown>; onOpenSpeech: (lineId?: string) => void
}) {
  const placements = detail.speech?.placements || []
  const lines = (detail.speech?.lines || []).filter(line => !line.scene_id || line.scene_id === shot.source_scene_id || placements.some(item => item.line_id === line.id && item.shot_id === shot.id))
  const [lineId, setLineId] = useState<string | null>(null)
  useEffect(() => { setLineId(placements.find(item => item.shot_id === shot.id)?.line_id || lines[0]?.id || null) }, [shot.id])
  const selected = lines.find(line => line.id === lineId) || lines[0]
  return <section className="final-cut-speech-panel" aria-label="当前镜头配音">
    <div className="speech-placement-heading"><strong>对白与旁白</strong><Button variant="subtle" size="compact-xs" leftSection={<Mic2 size={13} />} onClick={() => onOpenSpeech(selected?.id)}>管理台词</Button></div>
    {lines.length ? <>
      <Select label="本场台词" placeholder="选择需要入片的配音" value={selected?.id || null} searchable allowDeselect={false} onChange={setLineId}
        data={lines.map(line => ({ value: line.id, label: `${detail.speech?.voices.find(voice => voice.id === line.voice_id)?.name || '待分配角色'} · ${line.text.slice(0, 32) || '空白台词'}` }))} />
      {selected && <p className="final-cut-speech-text">{selected.text}</p>}
      {selected?.selected_asset_id ? <SpeechPlacementEditor key={selected.id} projectId={detail.id} line={selected} placement={placements.find(item => item.line_id === selected.id)} shots={detail.shots} initialShotId={shot.id} onChanged={onRefresh} />
        : <Button variant="default" size="xs" leftSection={<Mic2 size={14} />} onClick={() => onOpenSpeech(selected?.id)}>生成并选用配音</Button>}
    </> : <div className="final-cut-speech-empty"><p>先从剧本导入本场对白，或添加旁白，再设置播放位置。</p><Button variant="default" size="xs" leftSection={<Mic2 size={14} />} onClick={() => onOpenSpeech()}>准备本场配音</Button></div>}
  </section>
}
