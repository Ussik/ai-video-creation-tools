import type { ProjectDetail, VisualProfile, VisualProfileDraft } from '../../shared/api/api'

export const visualProfileLabel = (profile: Pick<VisualProfileDraft, 'name' | 'variant'>) => `${profile.name} · ${profile.variant}`
export const visualProfileDraftIdentity = (profile: Pick<VisualProfileDraft, 'kind' | 'name' | 'variant'>) => JSON.stringify([profile.kind, profile.name.trim(), profile.variant.trim()])

/** Names never establish identity: only the reviewed, explicit base relation does. */
export function visualProfileBaseChain(profile: VisualProfile, profiles: VisualProfile[]): { ancestors: VisualProfile[]; error?: string } {
  const seen = new Set([profile.id]), ancestors: VisualProfile[] = []
  let current = profile
  while (current.base_profile_id) {
    if (seen.has(current.base_profile_id)) return { ancestors: [], error: '基础设定存在循环引用，请先调整继承关系。' }
    seen.add(current.base_profile_id)
    const base = profiles.find(item => item.id === current.base_profile_id)
    if (!base || base.project_id && profile.project_id && base.project_id !== profile.project_id) return { ancestors: [], error: '基础设定不存在或不属于当前项目，请重新选择。' }
    if (base.kind !== profile.kind) return { ancestors: [], error: '基础设定必须与当前设定类型相同。' }
    ancestors.unshift(base); current = base
  }
  return { ancestors }
}

export function visualProfileBoardReady(profile: VisualProfile, detail: Pick<ProjectDetail, 'assets' | 'project_visual_style'>) {
  if (!profile.board_asset_id || profile.board_style_status === 'needs_review' || profile.board_style_status === 'missing' ||
    profile.base_reference_status === 'waiting' || profile.base_reference_status === 'needs_review') return false
  if (!detail.assets.some(asset => asset.id === profile.board_asset_id && asset.kind === 'image')) return false
  return !detail.project_visual_style || !profile.board_style_version || profile.board_style_version === detail.project_visual_style.version
}

export function visualProfileBaseReadiness(profile: VisualProfile, detail: Pick<ProjectDetail, 'visual_profiles' | 'assets' | 'project_visual_style'>) {
  const chain = visualProfileBaseChain(profile, detail.visual_profiles || [])
  return { ...chain, baseProfile: chain.ancestors.at(-1),
    waitingProfile: chain.ancestors.find(base => !visualProfileBoardReady(base, detail)) }
}

export function orderedVisualProfiles(profiles: VisualProfile[]): VisualProfile[] {
  const ordered = new Map<string, VisualProfile>()
  for (const profile of profiles) {
    const chain = visualProfileBaseChain(profile, profiles)
    if (chain.error) throw new Error(chain.error)
    for (const base of chain.ancestors) ordered.set(base.id, base)
    ordered.set(profile.id, profile)
  }
  return [...ordered.values()]
}

/** Removing an already saved item must preserve references from the new states
 * that still point to its temporary key. The link comes from the analyzed batch,
 * never from guessing a base for another same-name profile. */
export function newVisualProfileDrafts(drafts: VisualProfileDraft[], profiles: VisualProfile[]): VisualProfileDraft[] {
  const known = new Map(profiles.map(profile => [visualProfileDraftIdentity(profile), profile]))
  const savedKeys = new Map(drafts.flatMap(draft => {
    const saved = known.get(visualProfileDraftIdentity(draft))
    return draft.draft_key && saved ? [[draft.draft_key, saved.id] as const] : []
  }))
  return drafts.filter(draft => !known.has(visualProfileDraftIdentity(draft))).map(draft => {
    const baseId = draft.base_draft_key && savedKeys.get(draft.base_draft_key)
    return baseId ? { ...draft, base_profile_id: baseId, base_draft_key: null } : draft
  })
}

export function visualProfileDraftRelationError(draft: VisualProfileDraft, profiles: VisualProfile[], drafts: VisualProfileDraft[] = [], profileId?: string): string | undefined {
  if (draft.base_profile_id && draft.base_draft_key) return '只能选择一份基础设定。'
  if (draft.state_delta?.trim() && !draft.base_profile_id && !draft.base_draft_key) return '请先选择基础设定，再填写状态差异。'
  const currentKey = profileId ? `profile:${profileId}` : draft.draft_key ? `draft:${draft.draft_key}` : undefined
  const seen = new Set(currentKey ? [currentKey] : [])
  let current: VisualProfileDraft | VisualProfile = draft
  while (current.base_profile_id || 'base_draft_key' in current && current.base_draft_key) {
    const baseDraft: string | null | undefined = 'base_draft_key' in current ? current.base_draft_key : undefined
    const baseProfileId: string | null | undefined = current.base_profile_id
    const key = baseProfileId ? `profile:${baseProfileId}` : `draft:${baseDraft}`
    if (seen.has(key)) return '基础设定存在循环引用，请重新选择。'
    seen.add(key)
    const base: VisualProfileDraft | VisualProfile | undefined = baseProfileId ? profiles.find(item => item.id === baseProfileId)
      : drafts.find(item => item.draft_key === baseDraft)
    if (!base) return '基础设定已移除或不存在，请重新选择后保存。'
    if (base.kind !== draft.kind) return '基础设定必须与当前设定类型相同。'
    current = base
  }
  return undefined
}
