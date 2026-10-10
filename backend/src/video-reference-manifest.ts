export type VideoReferencePurpose = 'storyboard' | 'character' | 'location' | 'prop' | 'manual' | 'first_frame' | 'last_frame'

export interface VideoReferenceEntry {
  asset_id: string
  /** One-based image number, shared by the prompt and provider request. */
  index: number
  purpose: VideoReferencePurpose
  name: string
  variant?: string
  profile_ids: string[]
  required: boolean
}

export interface VideoReferenceBinding {
  profile_id: string
  kind: 'character' | 'location' | 'prop'
  name: string
  variant: string
  board_asset_id: string | null
  required: boolean
}

export interface VideoReferenceManifestOptions {
  mode: string
  visual_reference_mode: string
  storyboard_reference_asset_id?: string | null
  excluded_visual_profile_ids?: string[]
}

const kindOrder = { character: 0, location: 1, prop: 2 }
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

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
      profile_ids: [], required: false,
    }
    entries.push(entry)
    byAsset.set(id, entry)
  }

  if (options.mode !== 'reference' || options.visual_reference_mode !== 'profiles') return entries
  const excluded = new Set(options.excluded_visual_profile_ids || [])
  const ordered = [...bindings].sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind]
    || compareText(left.name, right.name) || compareText(left.profile_id, right.profile_id))
  for (const binding of ordered) {
    if (!binding.board_asset_id || excluded.has(binding.profile_id) && !binding.required) continue
    let entry = byAsset.get(binding.board_asset_id)
    if (!entry) {
      entry = {
        asset_id: binding.board_asset_id, index: entries.length + 1,
        purpose: binding.board_asset_id === options.storyboard_reference_asset_id ? 'storyboard' : binding.kind,
        name: '', profile_ids: [], required: false,
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
  }
  return entries
}
