import { useEffect, useMemo, useRef, useState } from 'react'
import { UnstyledButton, Badge, Button, Modal, Textarea } from '@mantine/core'
import { ArrowRight, Check, Eye, RefreshCcw, TriangleAlert, X } from 'lucide-react'
import { api, json } from './api'
import type { CutReview, CutReviewReport, CutReviewStatus, ProjectDetail } from './api'
import CutPointTrial from './CutPointTrial'
import './cut-review.css'

function pairKey(cut: CutReview) {
  return `${cut.from_shot_id}:${cut.to_shot_id}`
}

function seconds(ms: number | null) {
  return ms === null ? '—' : `${(ms / 1000).toFixed(3).replace(/\.?0+$/, '')} 秒`
}

function statusLabel(cut: CutReview) {
  if (cut.stale) return '待重审'
  if (cut.status === 'approved') return '已通过'
  if (cut.status === 'needs_work') return '需修改'
  return '待审核'
}

function statusColor(cut: CutReview) {
  return cut.stale ? 'yellow' : cut.status === 'approved' ? 'teal' : cut.status === 'needs_work' ? 'red' : 'gray'
}

function ReviewFrame({ url, label, title, time, onFailed }: {
  url: string | null; label: string; title: string; time: number | null; onFailed: (url: string) => void
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return <div className="cut-review-frame">
    <div className="cut-review-frame-heading"><span>{label}</span><strong title={title}>{title}</strong></div>
    <div className="cut-review-frame-image">
      {url && !failed ? <img src={url} alt={`${title}的${label}`} onError={() => { setFailed(true); onFailed(url) }} />
        : <div className="cut-review-frame-empty">{failed ? '画面读取失败，请刷新检查' : '尚无可审画面'}</div>}
    </div>
    <span className="cut-review-frame-time">素材位置 {seconds(time)}</span>
  </div>
}

export default function CutReviewPanel({ detail, onChanged }: { detail: ProjectDetail; onChanged: () => Promise<void> }) {
  const [opened, setOpened] = useState(false)
  const [report, setReport] = useState<CutReviewReport | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [failedFrames, setFailedFrames] = useState<Set<string>>(() => new Set())
  const [frameRevision, setFrameRevision] = useState(0)
  const requestId = useRef(0)
  const revision = useMemo(() => JSON.stringify({
    range: detail.production_range,
    shots: detail.shots.map((shot) => {
      const clip = detail.timeline_clips.find((item) => item.shot_id === shot.id)
      return [shot.id, shot.position, shot.selected_asset_id, clip?.id, clip?.asset_id, clip?.in_ms, clip?.out_ms]
    }),
  }), [detail])

  async function refresh() {
    const id = ++requestId.current
    setLoading(true)
    try {
      const next = await api<CutReviewReport>(`/projects/${detail.id}/cut-reviews`)
      if (id !== requestId.current) return
      setReport(next)
      setFailedFrames(new Set())
      setFrameRevision((current) => current + 1)
      setSelectedKey((current) => current && next.cuts.some((cut) => pairKey(cut) === current)
        ? current : next.cuts[0] ? pairKey(next.cuts[0]) : null)
      setError(null)
    } catch (caught) {
      if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    return () => { requestId.current += 1 }
  }, [detail.id, revision])

  const cuts = report?.cuts || []
  const selected = cuts.find((cut) => pairKey(cut) === selectedKey) || cuts[0]
  const activeKey = selected ? pairKey(selected) : null
  const approvedCount = cuts.filter((cut) => cut.status === 'approved').length
  const needsWorkCount = cuts.filter((cut) => cut.status === 'needs_work').length
  const staleCount = cuts.filter((cut) => cut.stale).length
  const fromShot = detail.shots.find((shot) => shot.id === selected?.from_shot_id)
  const toShot = detail.shots.find((shot) => shot.id === selected?.to_shot_id)
  const selectedFrameFailed = !!selected && [selected.from.frame_url, selected.to.frame_url]
    .some((url) => !!url && failedFrames.has(url))

  useEffect(() => {
    setNote(selected?.note || '')
  }, [selectedKey, selected?.signature, selected?.reviewed_at])

  async function save(status: CutReviewStatus) {
    if (!selected || saving) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      await api<CutReview>(`/projects/${detail.id}/cut-reviews`, json('PUT', {
        from_shot_id: selected.from_shot_id,
        to_shot_id: selected.to_shot_id,
        signature: selected.signature,
        status,
        note: note.trim(),
      }))
      await refresh()
      setSuccess(status === 'approved' ? '这处接镜已通过' : status === 'needs_work' ? '问题已记录，待修改后重审' : '审核备注已保存')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      await refresh()
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  return <>
    <Button variant="default" size="xs" onClick={() => setOpened(true)}
      leftSection={<Eye size={15} />}>
      接镜审核{report && cuts.length > 0 ? ` ${approvedCount}/${cuts.length}` : ''}
    </Button>
    <Modal className="cut-review-modal" opened={opened} onClose={() => setOpened(false)}
      title="接镜审核" size="xl" centered>
      <div className="cut-review-overview">
        <p>对照当前入片区间的实际尾帧和首帧，逐处确认角色、动作、空间和画风是否接得上。</p>
        <div className="cut-review-totals">
          <Badge variant="light" color="teal">{approvedCount} 处通过</Badge>
          <Badge variant="light" color={needsWorkCount ? 'red' : 'gray'}>{needsWorkCount} 处需修改</Badge>
          {staleCount > 0 && <Badge variant="light" color="yellow">{staleCount} 处待重审</Badge>}
          <Button variant="subtle" size="xs" loading={loading} onClick={() => void refresh()} leftSection={<RefreshCcw size={14} />}>刷新</Button>
        </div>
      </div>
      {error && <div className="cut-review-alert" role="alert"><TriangleAlert size={16} />{error}</div>}
      {loading && !report ? <div className="cut-review-empty">正在读取接镜画面…</div>
        : !loading && cuts.length === 0 ? <div className="cut-review-empty">本次制作范围内还没有相邻镜头可审核。</div>
        : <div className="cut-review-layout">
          <div className="cut-review-list" aria-label="接镜列表">
            {cuts.map((cut, index) => <UnstyledButton type="button" key={pairKey(cut)}
              className={`cut-review-item ${pairKey(cut) === activeKey ? 'is-selected' : ''}`}
              onClick={() => { setSelectedKey(pairKey(cut)); setError(null); setSuccess(null) }}
              aria-current={pairKey(cut) === activeKey ? 'true' : undefined}>
              <span className="cut-review-item-index">接点 {String(index + 1).padStart(2, '0')}</span>
              <span className="cut-review-item-titles"><strong>{cut.from.title}</strong><ArrowRight size={13} /><strong>{cut.to.title}</strong></span>
              <Badge size="xs" variant="light" color={statusColor(cut)}>{statusLabel(cut)}</Badge>
            </UnstyledButton>)}
          </div>
          {selected && <div className="cut-review-detail">
            <div className="cut-review-detail-head">
              <div><span>当前接点</span><h3>{selected.from.title} <ArrowRight size={17} /> {selected.to.title}</h3></div>
              <Badge variant="light" color={statusColor(selected)}>{statusLabel(selected)}</Badge>
            </div>
            {selected.stale && <div className="cut-review-stale" role="status"><TriangleAlert size={16} />选片或切点已变化，上次“{selected.saved_status === 'approved' ? '通过' : selected.saved_status === 'needs_work' ? '需修改' : '待审核'}”的结论已失效，请按当前画面重新确认。</div>}
            {!selected.ready && <div className="cut-review-stale" role="status"><TriangleAlert size={16} />两侧片段尚未准备好；选定有效素材与入出点后才能通过审核。</div>}
            {selectedFrameFailed && <div className="cut-review-stale" role="status"><TriangleAlert size={16} />实际画面读取失败，请刷新检查后再决定是否通过。</div>}
            <div className="cut-review-frames">
              <ReviewFrame key={`from:${selected.from.frame_url}:${frameRevision}`} url={selected.from.frame_url} label="上一镜实际尾帧" title={selected.from.title} time={selected.from.out_ms}
                onFailed={(url) => setFailedFrames((current) => new Set(current).add(url))} />
              <ReviewFrame key={`to:${selected.to.frame_url}:${frameRevision}`} url={selected.to.frame_url} label="下一镜实际首帧" title={selected.to.title} time={selected.to.in_ms}
                onFailed={(url) => setFailedFrames((current) => new Set(current).add(url))} />
            </div>
            <CutPointTrial cut={selected} detail={detail} noteDirty={note.trim() !== selected.note}
              onSaved={async () => {
                await onChanged()
                await refresh()
                setSuccess('切点已应用，请按新的画面重新审核')
              }} />
            <div className="cut-review-script-context">
              <div><span>上一镜收镜状态</span><p>{fromShot?.end_state || '尚未填写'}</p></div>
              <div><span>下一镜开镜状态</span><p>{toShot?.start_state || '尚未填写'}</p></div>
              {toShot?.cut_note && <div className="cut-review-cut-note"><span>接镜要求</span><p>{toShot.cut_note}</p></div>}
            </div>
            <Textarea label="审核备注" placeholder="例如：桥体轴线改变；角色站位反转；兵器动作接不上" minRows={3} maxRows={6} autosize maxLength={2000}
              value={note} onChange={(event) => setNote(event.currentTarget.value)} />
            {success && <div className="cut-review-success" role="status"><Check size={15} />{success}</div>}
            <div className="cut-review-actions">
              <span>静帧用于核对画面，动作节奏可在连续预览中检查。</span>
              <Button variant="default" onClick={() => void save('pending')} loading={saving}
                disabled={saving || selected.status === 'pending' && !selected.stale && note.trim() === selected.note}>保存备注</Button>
              <Button variant="light" color="red" onClick={() => void save('needs_work')} loading={saving}
                disabled={saving || !note.trim() || selected.status === 'needs_work' && note.trim() === selected.note}
                leftSection={<X size={15} />}>标记需修改</Button>
              <Button color="teal" onClick={() => void save('approved')} loading={saving}
                disabled={saving || !selected.ready || selectedFrameFailed || selected.status === 'approved' && note.trim() === selected.note}
                leftSection={<Check size={15} />}>通过接镜</Button>
            </div>
          </div>}
        </div>}
    </Modal>
  </>
}
