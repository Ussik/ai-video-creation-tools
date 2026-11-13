import { createHash } from 'node:crypto'
import { all, db, one, required, run } from '../../infrastructure/database/db.js'
import type { Shot } from '../../infrastructure/database/db.js'
import type { VisualBinding, VisualProfile } from './visual-profiles.js'
import { assetStyleNeedsReview, projectVisualStyle } from './project-visual-style.js'
import { normalizeVisualBinding, referenceSnapshot, visualReferenceAssets } from './visual-reference-assets.js'
import { recommendVisualReferences } from '@video-studio/shared/visuals/visual-reference-selection'

export type VisualBindingSyncMode = 'follow' | 'locked'
export type VisualBindingReferenceSelection = 'auto' | 'manual'
export type VisualBindingSyncStatus = 'current' | 'waiting_confirmation' | 'manual_review'
export type ResolvedVisualBinding = VisualBinding & {
  sync_mode: VisualBindingSyncMode
  reference_selection: VisualBindingReferenceSelection
  sync_status: VisualBindingSyncStatus
  reference_assets: ReturnType<typeof normalizeVisualBinding>['reference_assets']
}

function hasImage(projectId: string, assetId: string | null | undefined) {
  return !!assetId && !!one('SELECT 1 FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL AND kind=\'image\'', assetId, projectId)
}

/** A board is usable only after confirmation against this style and base chain. */
export function currentVisualProfileBoard(profile: VisualProfile, styleVersion: string): string | null {
  if (!hasImage(profile.project_id, profile.board_asset_id) || profile.board_style_version !== styleVersion
    || assetStyleNeedsReview(profile.project_id, profile.board_asset_id!, styleVersion, profile.id)) return null
  const ancestors: VisualProfile[] = [], seen = new Set([profile.id])
  let current = profile
  while (current.base_profile_id) {
    if (seen.has(current.base_profile_id)) return null
    seen.add(current.base_profile_id)
    const base = one<VisualProfile>('SELECT * FROM visual_profiles WHERE id=?', current.base_profile_id)
    if (!base || base.project_id !== profile.project_id || base.kind !== profile.kind
      || (base.design_id || null) !== (profile.design_id || null)
      || !hasImage(base.project_id, base.board_asset_id) || base.board_style_version !== styleVersion
      || assetStyleNeedsReview(base.project_id, base.board_asset_id!, styleVersion, base.id)) return null
    ancestors.push(base)
    current = base
  }
  for (let index = 0; index < ancestors.length; index++) {
    const child = index ? ancestors[index - 1]! : profile
    const signature = createHash('sha256').update(JSON.stringify(ancestors.slice(index).map(base =>
      [base.id, base.revision, base.board_asset_id, base.board_style_version || null, base.base_profile_id || null]))).digest('hex')
    if (child.board_base_signature !== signature) return null
  }
  return profile.board_asset_id
}

/** Resolve without writes so previewing generation never changes business data. */
export function resolveVisualBinding(shot: Shot, value: VisualBinding): ResolvedVisualBinding {
  const normalized = normalizeVisualBinding(value)
  const binding: ResolvedVisualBinding = { ...normalized, sync_mode: value.sync_mode || 'follow',
    reference_selection: value.reference_selection || (normalized.reference_assets.length ? 'manual' : 'auto'), sync_status: 'current' }
  if (shot.superseded_by || binding.sync_mode === 'locked') return binding
  const profile = one<VisualProfile>('SELECT * FROM visual_profiles WHERE id=?', binding.profile_id)
  if (!profile || profile.project_id !== shot.project_id || (profile.design_id || null) !== (shot.design_id || null)) return binding
  const style = projectVisualStyle(profile.project_id)
  const board = currentVisualProfileBoard(profile, style.version)
  const recommended = recommendVisualReferences(profile, visualReferenceAssets(profile.id),
    binding.reference_view ? { view: binding.reference_view } : undefined, style.version)
    .filter(reference => hasImage(profile.project_id, reference.asset_id)
      && !assetStyleNeedsReview(profile.project_id, reference.asset_id, style.version, profile.id)).map(referenceSnapshot)
  if (profile.definition_status !== 'ready' || (!board && !recommended.length) || profile.base_profile_id && !board) {
    return { ...binding, sync_status: 'waiting_confirmation' }
  }
  if (binding.reference_selection === 'manual' && binding.reference_assets.length) {
    // Keep the complete approved snapshot if newer text cannot describe the
    // creator's explicitly selected images. Never mix revisions in one binding.
    if (binding.reference_assets.some(reference => reference.revision !== profile.revision
      || reference.style_version !== style.version || !hasImage(profile.project_id, reference.asset_id)
      || assetStyleNeedsReview(profile.project_id, reference.asset_id, style.version, profile.id))) {
      return { ...binding, sync_status: 'manual_review' }
    }
  } else if (binding.reference_selection === 'manual' && !board) {
    // An explicit empty selection means use the board, not a new recommendation.
    return { ...binding, sync_status: 'waiting_confirmation' }
  }
  return { ...binding, revision: profile.revision, kind: profile.kind, name: profile.name, variant: profile.variant,
    definition: profile.definition, view_requirements: profile.view_requirements,
    board_asset_id: board, board_style_version: board ? profile.board_style_version || null : null,
    reference_assets: binding.reference_selection === 'manual' ? binding.reference_assets : recommended }
}

const snapshot = (binding: VisualBinding) => JSON.stringify([binding.revision, binding.kind, binding.name, binding.variant,
  binding.definition, binding.view_requirements, binding.board_asset_id, binding.board_style_version || null, binding.reference_assets])

export function persistResolvedVisualBindings(previous: VisualBinding[], bindings: ResolvedVisualBinding[]) {
  for (const binding of bindings) {
    const old = previous.find(item => item.profile_id === binding.profile_id)
    if (!old || snapshot(normalizeVisualBinding(old)) === snapshot(binding)) continue
    run(`UPDATE shot_visual_bindings SET revision=?, kind=?, name=?, variant=?, definition=?, view_requirements=?,
      board_asset_id=?, board_style_version=?, reference_assets=? WHERE shot_id=? AND profile_id=?`, binding.revision,
    binding.kind, binding.name, binding.variant, binding.definition, binding.view_requirements, binding.board_asset_id,
    binding.board_style_version || null, JSON.stringify(binding.reference_assets), binding.shot_id, binding.profile_id)
  }
}

export function resolveShotVisualBindings(shotId: string, options: { persist?: boolean } = {}) {
  const shot = required<Shot>('shots', shotId)
  const previous = all<VisualBinding>('SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY kind, name, profile_id', shotId)
  const bindings = previous.map(binding => resolveVisualBinding(shot, binding))
  if (options.persist && !shot.superseded_by) persistResolvedVisualBindings(previous, bindings)
  return bindings
}

export function synchronizeVisualProfileBindings(profileId: string) {
  db.transaction(() => {
    const shots = all<Shot>(`SELECT s.* FROM shots s JOIN shot_visual_bindings b ON b.shot_id=s.id
      WHERE b.profile_id=? AND s.deleted_at IS NULL AND s.superseded_by IS NULL`, profileId)
    for (const shot of shots) resolveShotVisualBindings(shot.id, { persist: true })
  })()
}

export function synchronizeProjectVisualBindings(projectId: string) {
  db.transaction(() => {
    const shots = all<{ shot_id: string }>(`SELECT DISTINCT b.shot_id FROM shot_visual_bindings b JOIN shots s ON s.id=b.shot_id
      WHERE s.project_id=? AND s.deleted_at IS NULL AND s.superseded_by IS NULL`, projectId)
    for (const shot of shots) resolveShotVisualBindings(shot.shot_id, { persist: true })
  })()
}
