import { useEffect, useState } from 'react'
import { Button, NumberInput, Select } from '@mantine/core'
import { Check, Link2, Unlink } from 'lucide-react'
import type { SpeechLine, SpeechPlacement } from '@video-studio/shared/media/speech-timeline'
import type { Shot } from '../../shared/api/api'
import { api, json } from '../../shared/api/api'

export default function SpeechPlacementEditor({ projectId, line, placement, shots, initialShotId, onChanged }: {
  projectId: string; line: SpeechLine; placement?: SpeechPlacement; shots: Shot[]; initialShotId?: string | null; onChanged: () => Promise<unknown> | void
}) {
  const take = line.takes.find(item => item.asset_id === line.selected_asset_id)
  const [shotId, setShotId] = useState<string | null>(null)
  const [offset, setOffset] = useState<number | string>(0), [inPoint, setInPoint] = useState<number | string>(0)
  const [outPoint, setOutPoint] = useState<number | string>(0), [volume, setVolume] = useState<number | string>(100)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    setShotId(placement?.shot_id || initialShotId || shots.find(shot => shot.source_scene_id === line.scene_id)?.id || null)
    setOffset((placement?.offset_ms || 0) / 1000); setInPoint((placement?.in_ms || 0) / 1000)
    const end = placement && placement.asset_id === line.selected_asset_id ? placement.out_ms : take?.duration_ms
    setOutPoint(end ? end / 1000 : '')
    setVolume((placement?.gain ?? 1) * 100); setError('')
  }, [line.id, line.selected_asset_id, placement?.id, placement?.asset_id, placement?.offset_ms, placement?.in_ms, placement?.out_ms, placement?.gain, initialShotId])
  const stale = !!line.selected_is_stale
  const valid = !!shotId && !stale && !!take && [offset, inPoint, volume].every(value => value !== '' && Number.isFinite(Number(value))) &&
    Number(inPoint) >= 0 && (outPoint === '' || Number.isFinite(Number(outPoint)) && Number(outPoint) > Number(inPoint) && (!take.duration_ms || Number(outPoint) * 1000 <= take.duration_ms)) && Number(volume) >= 0 && Number(volume) <= 200
  const input = { shot_id: shotId, offset_ms: Math.round(Number(offset) * 1000), in_ms: Math.round(Number(inPoint) * 1000),
    ...(outPoint === '' ? {} : { out_ms: Math.round(Number(outPoint) * 1000) }), gain: Number(volume) / 100 }
  const changed = !placement || placement.asset_id !== line.selected_asset_id || placement.shot_id !== shotId ||
    placement.offset_ms !== input.offset_ms || placement.in_ms !== input.in_ms || placement.out_ms !== input.out_ms || placement.gain !== input.gain
  async function save(remove = false) {
    if (busy || !remove && !valid) return
    setBusy(true); setError('')
    try {
      await api(`/projects/${projectId}/speech/lines/${line.id}/placement`, remove ? { method: 'DELETE' } : json('PUT', input))
      await onChanged()
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setBusy(false) }
  }
  return <section className="speech-placement-editor" aria-label="配音播放位置">
    <div className="speech-placement-heading"><strong>配音入片</strong><span>{placement ? placement.stale ? '入片版本需更新' : '已入片' : '待设置播放位置'}</span></div>
    {stale && <p className="speech-help">选用的音频属于历史版本，请先确认当前台词与声音，再选用对应候选。</p>}
    {!shots.length && <p className="speech-help">创建分镜后，可以设置配音的播放位置。</p>}
    <Select label="起始镜头" placeholder="选择播放起点" searchable clearable value={shotId} disabled={busy}
      data={shots.map((shot, index) => ({ value: shot.id, label: `${String(index + 1).padStart(2, '0')} · ${shot.title}` }))} onChange={setShotId} />
    <div className="speech-placement-fields">
      <NumberInput label="相对镜头起点" description="可跨镜头播放；负值提前开始" suffix=" 秒" value={offset} onChange={setOffset} min={-600} max={600} step={0.1} decimalScale={3} disabled={busy} />
      <NumberInput label="配音音量" suffix=" %" value={volume} onChange={setVolume} min={0} max={200} step={10} disabled={busy} />
      <NumberInput label="音频入点" suffix=" 秒" value={inPoint} onChange={setInPoint} min={0} max={take?.duration_ms ? take.duration_ms / 1000 : undefined} step={0.1} decimalScale={3} disabled={busy} />
      <NumberInput label="音频出点" placeholder="完整音频" description="留空使用音频结尾" suffix=" 秒" value={outPoint} onChange={setOutPoint} min={0.001} max={take?.duration_ms ? take.duration_ms / 1000 : undefined} step={0.1} decimalScale={3} disabled={busy} />
    </div>
    {error && <p className="speech-help" role="alert">{error}</p>}
    <div className="speech-placement-actions">
      {placement && <Button variant="subtle" size="xs" disabled={busy} leftSection={<Unlink size={13} />} onClick={() => void save(true)}>移出成片</Button>}
      <Button variant="default" size="xs" loading={busy} disabled={!valid || !changed} leftSection={placement && !changed ? <Check size={13} /> : <Link2 size={13} />} onClick={() => void save()}>{placement ? '更新入片配音' : '加入成片'}</Button>
    </div>
  </section>
}
