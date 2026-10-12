import type { VisualReferencePurpose, VisualReferenceSnapshot, VisualReferenceView } from '../visuals/visual-reference-types.js'
import { visualBindingApplies, type VisualBindingUsage } from '../visuals/visual-binding-usage.js'
import type { VideoReferenceUsage, VideoReferenceUsageSelection } from './video-reference-usage.js'

export type VideoReferencePurpose = 'storyboard' | 'character' | 'location' | 'prop' | 'manual' | 'first_frame' | 'last_frame'

/** A shared image may describe different objects or uses; retain every selected use. */
export interface VideoReferenceDetail {
  profile_id: string
  name: string
  variant: string
  view: VisualReferenceView
  purpose: VisualReferencePurpose
  label: string
}

export interface VideoReferenceEntry {
  asset_id: string
  /** One-based image number, shared by the prompt and provider request. */
  index: number
  purpose: VideoReferencePurpose
  name: string
  variant?: string
  profile_ids: string[]
  required: boolean
  view?: VisualReferenceView
  reference_purpose?: VisualReferencePurpose
  reference_label?: string
  reference_details?: VideoReferenceDetail[]
  usage?: VideoReferenceUsage
}

export interface VideoReferenceBinding {
  profile_id: string
  kind: 'character' | 'location' | 'prop'
  name: string
  variant: string
  board_asset_id: string | null
  required: boolean
  reference_assets?: VisualReferenceSnapshot[]
  usage?: VisualBindingUsage
}

export interface VideoReferenceManifestOptions {
  mode: string
  visual_reference_mode: string
  storyboard_reference_asset_id?: string | null
  excluded_visual_profile_ids?: string[]
  /** False when annotating an already prepared request: never append unsubmitted images. */
  append_profile_assets?: boolean
  video_reference_usages?: VideoReferenceUsageSelection[]
}

const kindOrder = { character: 0, location: 1, prop: 2 }
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

/** Selected snapshots keep their frozen order; legacy bindings fall back to their board. */
export function visualBindingReferenceAssetIds(binding: Pick<VideoReferenceBinding, 'board_asset_id' | 'reference_assets'>): string[] {
  const ids = binding.reference_assets?.length
    ? binding.reference_assets.map(reference => reference.asset_id)
    : binding.board_asset_id ? [binding.board_asset_id] : []
  return [...new Set(ids.filter(Boolean))]
}

/** Drop known inputs that are outside this output's scope; keep shared images and unrelated manual inputs. */
export function scopedVisualReferenceAssetIds(ids: string[], saved: VideoReferenceBinding[], active: VideoReferenceBinding[]): string[] {
  const known = new Set(saved.flatMap(visualBindingReferenceAssetIds))
  const used = new Set(active.flatMap(visualBindingReferenceAssetIds))
  return ids.filter(id => !known.has(id) || used.has(id))
}

/** Stable image order for previews, prompt numbering, and provider content. No images are silently truncated. */
export function videoReferenceManifest(
  manualIds: string[],
  bindings: VideoReferenceBinding[],
  options: VideoReferenceManifestOptions,
): VideoReferenceEntry[] {
  const entries: VideoReferenceEntry[] = []
  const byAsset = new Map<string, VideoReferenceEntry>()
  const namesByAsset = new Map<string, string[]>()
  const variantsByAsset = new Map<string, string[]>()
  const usages = new Map(options.mode === 'reference' ? options.video_reference_usages?.map(item => [item.asset_id, item.usage]) : [])

  for (const id of manualIds) {
    if (!id || byAsset.has(id)) continue
    const position = entries.length
    const purpose: VideoReferencePurpose = options.mode === 'first_frame' && position === 0
      ? 'first_frame'
      : options.mode === 'first_last_frame' && position < 2
        ? position === 0 ? 'first_frame' : 'last_frame'
        : id === options.storyboard_reference_asset_id ? 'storyboard' : 'manual'
    const entry: VideoReferenceEntry = {
      asset_id: id, index: position + 1, purpose,
      name: purpose === 'storyboard' ? '分镜构图' : purpose === 'first_frame' ? '分镜首帧' : purpose === 'last_frame' ? '收镜尾帧' : '手动参考',
      profile_ids: [], required: false, ...(usages.has(id) ? { usage: usages.get(id) } : {}),
    }
    entries.push(entry)
    byAsset.set(id, entry)
  }

  if (options.mode !== 'reference' || options.visual_reference_mode !== 'profiles') return entries
  const excluded = new Set(options.excluded_visual_profile_ids || [])
  const ordered = [...bindings].sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]
    || compareText(left.name, right.name) || compareText(left.profile_id, right.profile_id))
  for (const binding of ordered) {
    if (!visualBindingApplies(binding, 'video')) continue
    if (excluded.has(binding.profile_id) && !binding.required) continue
    for (const assetId of visualBindingReferenceAssetIds(binding)) {
      let entry = byAsset.get(assetId)
      if (!entry) {
        if (options.append_profile_assets === false) continue
        entry = {
          asset_id: assetId, index: entries.length + 1,
          purpose: assetId === options.storyboard_reference_asset_id ? 'storyboard' : binding.kind,
          name: '', profile_ids: [], required: false, ...(usages.has(assetId) ? { usage: usages.get(assetId) } : {}),
        }
        entries.push(entry)
        byAsset.set(entry.asset_id, entry)
      } else if (entry.purpose === 'manual') entry.purpose = binding.kind

      if (!entry.profile_ids.includes(binding.profile_id)) entry.profile_ids.push(binding.profile_id)
      entry.required ||= binding.required
      const names = namesByAsset.get(entry.asset_id) || []
      const name = binding.name.trim() || binding.profile_id
      if (!names.includes(name)) names.push(name)
      namesByAsset.set(entry.asset_id, names)
      entry.name = entry.purpose === 'storyboard' ? `分镜构图 / ${names.join(' / ')}` : names.join(' / ')
      const variants = variantsByAsset.get(entry.asset_id) || []
      const variant = binding.variant.trim()
      if (variant && !variants.includes(variant)) variants.push(variant)
      variantsByAsset.set(entry.asset_id, variants)
      if (variants.length) entry.variant = variants.join(' / ')

      for (const reference of binding.reference_assets || []) {
        if (reference.asset_id !== assetId) continue
        const detail: VideoReferenceDetail = { profile_id: binding.profile_id, name, variant,
          view: reference.view, purpose: reference.purpose, label: reference.label.trim() }
        const details = entry.reference_details ||= []
        if (!details.some(value => value.profile_id === detail.profile_id && value.view === detail.view
          && value.purpose === detail.purpose && value.label === detail.label)) details.push(detail)
        entry.view ??= detail.view
        entry.reference_purpose ??= detail.purpose
        entry.reference_label ??= detail.label
      }
    }
  }
  return entries
}
