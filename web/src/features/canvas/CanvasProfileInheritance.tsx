import { Badge, Button, UnstyledButton } from '@mantine/core'
import { Check, ImageIcon, LocateFixed, TriangleAlert } from 'lucide-react'
import type { Asset, VisualProfile } from '../../shared/api/api'
import './canvas-profile-inheritance.css'

export type CanvasProfileInheritanceProps = {
  profile: VisualProfile
  baseProfile?: VisualProfile
  asset?: Asset
  waitingProfile?: VisualProfile
  error?: string
  baseReady: boolean
  baseGenerating?: boolean
  busy?: boolean
  onLocateBase: () => void
}

const profileLabel = (profile: VisualProfile) => `${profile.name} · ${profile.variant}`

/** Keep a resolved foundation visible after the missing-reference actions finish. */
export default function CanvasProfileInheritance({ profile, baseProfile, asset, waitingProfile, error, baseReady,
  baseGenerating = false, busy = false, onLocateBase }: CanvasProfileInheritanceProps) {
  const ready = baseReady && !!baseProfile && asset?.kind === 'image' && asset.id === baseProfile.board_asset_id && !waitingProfile && !error
  const waiting = waitingProfile || baseProfile
  const needsReview = !!waiting?.board_asset_id && !ready && !baseGenerating
  const baseStatus = error ? '基础关系需检查' : ready ? '基础参考已就绪'
    : baseGenerating ? '基础图生成中' : needsReview ? '基础参考需复核' : '等待基础图'
  const explanation = error || (ready ? '已自动引用基础图，生成时仅调整本次状态差异。'
    : baseGenerating ? '基础图生成并确认后，可继续生成当前状态。'
      : waiting ? `请先${needsReview ? '核对并确认' : '生成并确认'}「${profileLabel(waiting)}」的基础图。`
        : '请先检查并保存基础设定关系。')
  const stateDelta = profile.display_state_delta ?? profile.state_delta
  return <section className="pc-profile-inheritance" aria-label="当前状态的基础参考">
    <div className="pc-profile-inheritance-source">
      <UnstyledButton className="pc-profile-inheritance-thumb" aria-label={`定位基础设定：${baseProfile ? profileLabel(baseProfile) : '待检查'}`}
        disabled={busy || !baseProfile} onClick={onLocateBase}>
        {asset ? <img src={asset.url} alt={`${baseProfile?.name || '基础设定'} · 基础参考图`} loading="lazy" /> : <ImageIcon size={22} />}
      </UnstyledButton>
      <div className="pc-profile-inheritance-copy">
        <div className="pc-profile-inheritance-heading"><strong>继承基础造型</strong>
          <Badge size="sm" variant="light" color="gray">自动引用 · 必需</Badge>
          <Badge size="sm" variant="light" color={ready ? 'teal' : 'gray'} leftSection={ready ? <Check size={11} /> : error || needsReview ? <TriangleAlert size={11} /> : undefined}>{baseStatus}</Badge>
        </div>
        <span className="pc-profile-inheritance-name">{baseProfile ? profileLabel(baseProfile) : '基础设定待检查'}</span>
        <p role={error ? 'alert' : undefined}>{explanation}</p>
      </div>
      <Button variant="subtle" size="compact-xs" leftSection={<LocateFixed size={13} />} disabled={busy || !baseProfile}
        onClick={onLocateBase}>{needsReview ? '核对基础图' : '定位基础'}</Button>
    </div>
    {!!stateDelta?.trim() && <p className="pc-profile-inheritance-delta"><strong>本次状态变化</strong><span>{stateDelta}</span></p>}
  </section>
}
