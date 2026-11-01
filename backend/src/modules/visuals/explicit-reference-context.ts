import { all } from '../../infrastructure/database/db.js'
import type { VisualReferenceAsset } from '@video-studio/shared/visuals/visual-reference-types'
import type { VisualProfile } from './visual-profiles.js'

/** Ownership metadata annotates already selected images; it never selects inputs. */
export function explicitReferenceProfiles(projectId: string): Array<VisualProfile & { reference_assets: VisualReferenceAsset[] }> {
  const profiles = all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=? ORDER BY kind, name, variant, id', projectId)
  const references = all<Omit<VisualReferenceAsset, 'is_default'> & { is_default: number }>(`SELECT r.* FROM visual_profile_reference_assets r
    JOIN visual_profiles p ON p.id=r.profile_id WHERE p.project_id=? AND r.status='confirmed' AND r.revision=p.revision
    ORDER BY r.created_at, r.id`, projectId)
  return profiles.map(profile => ({ ...profile, reference_assets: references.filter(reference => reference.profile_id === profile.id)
    .map(reference => ({ ...reference, is_default: !!reference.is_default })) }))
}
