import { useEffect, useState } from 'react'
import { Badge, Button, Checkbox, Modal, NumberInput, Select } from '@mantine/core'
import { Check, RotateCcw, Scissors } from 'lucide-react'
import type { EditingCut } from '@video-studio/shared/media/editing-cut'
import type { Asset } from '../../shared/api/api'
import TimelinePreview from './TimelinePreview'
import { basicCutReviewCandidate, basicCutReviewSignature } from './basic-cut-review'
import './basic-cut-review.css'

interface Props {
  cut: EditingCut
  assets: Asset[]
  durations: ReadonlyMap<string, number>
  disabled: boolean
  onOpenChange: (opened: boolean) => void
  onApply: (fromId: string, toId: string, fromOut: number, toIn: number, signature: string) => void
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} 秒`
const frameUrl = (asset: Asset | undefined, timeMs: number) => asset?.kind === 'video'
  ? `/api/assets/${encodeURIComponent(asset.id)}/frame?time_ms=${timeMs}` : asset?.url || ''

/** Manual review of disposable candidates: opening or playing never changes the cut. */
export default function BasicCutReviewPanel({ cut, assets, durations, disabled, onOpenChange, onApply }: Props) {
  const [opened, setOpened] = useState(false), [pairId, setPairId] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<Record<string, string>>({})
  const selected = cut.clips.findIndex(clip => clip.id === pairId)
  const index = selected >= 0 && selected < cut.clips.length - 1 ? selected : 0
  const from = cut.clips[index], to = cut.clips[index + 1]
  const fromAsset = assets.find(asset => asset.id === from?.asset_id), toAsset = assets.find(asset => asset.id === to?.asset_id)
  const signature = basicCutReviewSignature(cut, from?.id || '', to?.id || '', assets)
  const [fromOut, setFromOut] = useState(from?.out_ms ?? 0), [toIn, setToIn] = useState(to?.in_ms ?? 0)
  const [ready, setReady] = useState<Record<string, boolean>>({}), [failed, setFailed] = useState<Record<string, boolean>>({})
  const [confirmed, setConfirmed] = useState('')
  useEffect(() => {
    setFromOut(from?.out_ms ?? 0); setToIn(to?.in_ms ?? 0); setConfirmed(''); setReady({}); setFailed({})
  }, [signature])
  const candidate = basicCutReviewCandidate(cut, index, fromOut, toIn, assets, durations)
  const candidateKey = `${signature}:${fromOut}:${toIn}`
  const fromFrame = frameUrl(fromAsset, candidate?.fromFrameMs ?? 0), toFrame = frameUrl(toAsset, candidate?.toFrameMs ?? 0)
  const framesReady = !!ready[fromFrame] && !!ready[toFrame] && !failed[fromFrame] && !failed[toFrame]
  const changed = !!from && !!to && (fromOut !== from.out_ms || toIn !== to.in_ms)
  const checked = confirmed === candidateKey
  const pairKey = `${from?.id}:${to?.id}`
  const status = reviewed[pairKey] === signature ? '人工已复核' : reviewed[pairKey] ? '内容已变化，待复查' : '待人工复核'
  const reviewCount = cut.clips.slice(0, -1).filter((clip, i) => reviewed[`${clip.id}:${cut.clips[i + 1].id}`]
    === basicCutReviewSignature(cut, clip.id, cut.clips[i + 1].id, assets)).length
  function open(value: boolean) { setOpened(value); onOpenChange(value) }
  return <>
    <Button variant="default" size="xs" leftSection={<Scissors size={14} />} disabled={disabled || cut.clips.length < 2}
      onClick={() => open(true)}>接镜复核 {reviewCount}/{Math.max(0, cut.clips.length - 1)}</Button>
    <Modal opened={opened} onClose={() => open(false)} title="相邻片段接镜复核" size="xl" centered>
      <div className="basic-cut-review" aria-label="基础剪辑接镜复核">
        <Select label="选择相邻接点" allowDeselect={false} value={from?.id || null}
          data={cut.clips.slice(0, -1).map((clip, i) => ({ value: clip.id, label: `${i + 1}. ${clip.title} → ${cut.clips[i + 1].title}` }))}
          onChange={setPairId} />
        <div className="basic-cut-review-status"><Badge color={status === '人工已复核' ? 'teal' : 'yellow'} variant="light">{status}</Badge>
          <span>复核标记仅保留在本次页面，素材、顺序、取段或混音改变后需复查。</span></div>
        <p className="basic-cut-help">新增片段默认全长，按实际动作与完整对白确认切点。下方预演保留当前原声、配音和配乐混音；短预演不能代替完整台词检查。</p>
        {from && to && <>
          <div className="basic-cut-review-controls">
            <NumberInput label="接镜上一片段出点" suffix=" 秒" value={fromOut / 1000} min={(from.in_ms + 200) / 1000}
              max={(durations.get(from.asset_id) ?? from.out_ms) / 1000} decimalScale={3} step={.05}
              disabled={disabled || fromAsset?.kind !== 'video'} onChange={value => setFromOut(Math.round(Number(value) * 1000))} />
            <NumberInput label="接镜下一片段入点" suffix=" 秒" value={toIn / 1000} min={0} max={(to.out_ms - 200) / 1000}
              decimalScale={3} step={.05} disabled={disabled || toAsset?.kind !== 'video'} onChange={value => setToIn(Math.round(Number(value) * 1000))} />
          </div>
          {candidate ? <>
            <div className="basic-cut-review-frames">{[{ label: '上一片段出点画面', url: fromFrame, time: candidate.fromFrameMs },
              { label: '下一片段入点画面', url: toFrame, time: candidate.toFrameMs }].map(item => <figure key={item.label}>
              {failed[item.url] ? <div className="basic-cut-review-frame-error">无法读取切点画面</div> : <img src={item.url} alt={item.label}
                onLoad={() => setReady(current => ({ ...current, [item.url]: true }))}
                onError={() => setFailed(current => ({ ...current, [item.url]: true }))} />}
              <figcaption>{item.label} · {seconds(item.time)}</figcaption>
            </figure>)}</div>
            <div className="basic-cut-review-preview"><strong>切点前后约 1.2 秒 · 当前混音</strong>
              <TimelinePreview key={candidateKey} clips={candidate.clips} shots={candidate.shots} assets={assets} ratio={cut.ratio}
                speechAudio={candidate.speechAudio} musicAsset={assets.find(asset => asset.id === cut.music_asset_id)}
                audioSettings={cut.audio_settings} musicOffsetMs={candidate.musicOffsetMs} captions={candidate.captions} active={opened} />
            </div>
            <p className="basic-cut-help">应用后成片时长 {candidate.deltaMs >= 0 ? '+' : ''}{seconds(candidate.deltaMs)}。独立配音和字幕保持各自时间位置，请一并检查。</p>
          </> : <p className="basic-cut-error" role="alert">切点超出素材范围，或片段不足 0.2 秒。请恢复或调整切点。</p>}
          {(failed[fromFrame] || failed[toFrame]) && <Button variant="default" size="xs" onClick={() => { setReady({}); setFailed({}) }}>重新读取切点画面</Button>}
          <Checkbox label="已试听切点并确认未截断原对白，已检查口型与动作交接" checked={checked}
            disabled={!candidate || !framesReady || disabled} onChange={event => setConfirmed(event.currentTarget.checked ? candidateKey : '')} />
          <div className="basic-cut-review-actions">
            <Button variant="default" size="xs" disabled={!changed || disabled} leftSection={<RotateCcw size={14} />}
              onClick={() => { setFromOut(from.out_ms); setToIn(to.in_ms); setConfirmed('') }}>恢复原切点</Button>
            <Button variant="light" size="xs" disabled={changed || !candidate || !framesReady || !checked || disabled} leftSection={<Check size={14} />}
              onClick={() => setReviewed(current => ({ ...current, [pairKey]: signature }))}>标记本接点人工已复核</Button>
            <Button size="xs" disabled={!changed || !candidate || !framesReady || !checked || disabled}
              onClick={() => onApply(from.id, to.id, fromOut, toIn, signature)}>应用候选切点到草稿</Button>
          </div>
        </>}
      </div>
    </Modal>
  </>
}
