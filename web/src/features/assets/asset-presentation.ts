import type { Asset, Job, ProjectDetail, VisualProfile } from '../../shared/api/api'
import { visualReferenceViewLabels } from '@video-studio/shared/visuals/visual-reference-types'

export type AssetPresentation = { title: string; context: string; specs: string }
export type AssetNameNode = { title: string; asset_id: string | null; job_id: string | null; settings?: Record<string, unknown> }

const kindLabels: Record<Asset['kind'], string> = { image: '图片', video: '视频', audio: '音频', text: '文本' }
const profileLabels = { character: '人物设定', location: '场景设定', prop: '道具设定' }

function requestOf(job?: Job): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(job?.request || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

function opaqueName(value: string): boolean {
  const stem = value.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/^(reference|tail-frame|first-frame|last-frame|export)[-_]/i, '')
  return /^[a-f0-9]{32}$/i.test(stem) || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(stem)
}

function usableNodeTitle(value: string): boolean {
  return !!value.trim() && !opaqueName(value.trim()) && !/^(生成节点|图片节点|视频节点|文本节点|图片生成|视频生成|文本生成)$/.test(value.trim())
}

function profileTitle(profile: Pick<VisualProfile, 'name' | 'variant'>): string {
  return [profile.name.trim(), profile.variant.trim()].filter(Boolean).join(' · ')
}

/** Presentation metadata only: IDs, storage filenames and media URLs stay intact. */
export function assetPresentations(detail: ProjectDetail | null, nodes: AssetNameNode[] = []): Map<string, AssetPresentation> {
  if (!detail) return new Map()
  const profiles = new Map(detail.visual_profiles?.map(profile => [profile.id, profile]))
  const profileAssets = new Map<string, VisualProfile>()
  const references = new Map<string, { profile: VisualProfile; label: string; revision: number }>()
  for (const profile of detail.visual_profiles || []) {
    for (const id of [profile.board_asset_id, ...(profile.candidate_asset_ids || [])]) if (id) profileAssets.set(id, profile)
    for (const reference of profile.reference_assets || []) references.set(reference.asset_id, {
      profile, label: reference.label || visualReferenceViewLabels[reference.view], revision: reference.revision,
    })
  }
  const jobs = new Map<string, Job>()
  for (const job of detail.jobs) if (job.result_asset_id && !jobs.has(job.result_asset_id)) jobs.set(job.result_asset_id, job)
  const nodeAssets = new Map(nodes.filter(node => node.asset_id && usableNodeTitle(node.title)).map(node => [node.asset_id!, node]))
  const nodeJobs = new Map(nodes.filter(node => node.job_id && usableNodeTitle(node.title)).map(node => [node.job_id!, node]))
  const shots = new Map(detail.shots.map(shot => [shot.id, shot]))

  return new Map(detail.assets.map(asset => {
    const job = jobs.get(asset.id)
    const request = requestOf(job)
    const ratio = text(request.ratio)
    const specs = [text(request.clarity) || text(request.resolution), ratio === 'adaptive' ? '自适应' : ratio].filter(Boolean).join(' · ')
    let title = asset.filename
    let context = ''
    if (asset.source !== 'upload') {
      const reference = references.get(asset.id)
      const profile = reference?.profile || profiles.get(text(request.visual_profile_id)) || profileAssets.get(asset.id)
      const binding = !profile && detail.shot_visual_bindings?.find(item => item.board_asset_id === asset.id || item.reference_assets?.some(ref => ref.asset_id === asset.id))
      const node = nodeAssets.get(asset.id) || (job && nodeJobs.get(job.id))
      const shot = shots.get(asset.shot_id || job?.shot_id || text(request.shot_id))
      if (profile) {
        const referenceLabel = reference?.label || text(request.visual_reference_label)
        title = [profileTitle(profile), referenceLabel].filter(Boolean).join(' · ')
        const revision = reference?.revision || (typeof request.visual_profile_revision === 'number' ? request.visual_profile_revision : profile.revision)
        context = [profileLabels[profile.kind], revision ? `v${revision}` : '', referenceLabel ? '参考图' : '设定图'].filter(Boolean).join(' · ')
      } else if (binding) {
        title = profileTitle(binding)
        context = `${profileLabels[binding.kind]} · v${binding.revision}`
      } else if (node) {
        title = node.title.trim()
      } else if (shot) {
        title = `${shot.title} · ${asset.kind === 'image' ? '分镜图' : kindLabels[asset.kind]}`
      } else if (asset.source === 'export') {
        title = `${detail.name} · 成片`
      } else if (opaqueName(asset.filename)) {
        title = `生成${kindLabels[asset.kind]} · ${new Date(asset.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      }
    }
    return [asset.id, { title, context, specs }]
  }))
}
