import type { ProjectDetail, Shot } from '../../shared/api/api'

/** Historical canvases keep their own shot metadata after a new design becomes active. */
export function allProjectShots(detail: Pick<ProjectDetail, 'shots' | 'historical_shots'>): Shot[] {
  return [...new Map([...(detail.historical_shots || []), ...detail.shots].map(shot => [shot.id, shot])).values()]
}

/** Default imports belong to this canvas's design; a legacy canvas owns legacy shots. */
export function canvasDesignShots(detail: Pick<ProjectDetail, 'shots' | 'historical_shots'>, designId?: string | null): Shot[] {
  return allProjectShots(detail).filter(shot => (shot.design_id || null) === (designId || null))
}
