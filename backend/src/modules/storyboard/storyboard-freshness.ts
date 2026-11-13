import { createHash } from 'node:crypto'
import { all, now, one, run, type Project, type ScriptScene } from '../../infrastructure/database/db.js'
import type { ToolDocument } from '../script/script-document-tools.js'
import { storyboardCreativeContext, storyboardCreativeContextVersion } from './storyboard-creative-context.js'

/** Compare creative inputs, never save timestamps, canvas presence or media selections. */
export function storyboardSourceFingerprint(project: Project, scene: ScriptScene, documents: ToolDocument[], styleVersion: string): string {
  const sources = documents.filter(document => !document.episode_number || document.episode_number === scene.episode_number)
    .map(({ artifact_type, episode_number, content }) => ({ artifact_type, episode_number, content }))
    .sort((left, right) => left.artifact_type.localeCompare(right.artifact_type) || left.episode_number - right.episode_number)
  return createHash('sha256').update(JSON.stringify({ version: 1,
    project: { name: project.name, brief: project.brief, ratio: project.ratio },
    scene: { episode_number: scene.episode_number, position: scene.position, heading: scene.heading,
      location: scene.location, time_of_day: scene.time_of_day, characters: scene.characters,
      action: scene.action, dialogue: scene.dialogue, narration: scene.narration, duration: scene.duration },
    documents: sources, style: styleVersion,
    ...storyboardCreativeContextVersion(storyboardCreativeContext(project.id, { kind: 'scenes', scenes: [scene] })),
  })).digest('hex')
}

export function savedStoryboardSources(projectId: string): Map<string, string> {
  return new Map(all<{ scene_id: string; source_fingerprint: string }>(
    'SELECT scene_id, source_fingerprint FROM storyboard_scene_plans WHERE project_id=?', projectId)
    .map(row => [row.scene_id, row.source_fingerprint]))
}

export function saveStoryboardSource(projectId: string, sceneId: string, fingerprint: string): void {
  run(`INSERT INTO storyboard_scene_plans (scene_id, project_id, source_fingerprint, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scene_id) DO UPDATE SET source_fingerprint=excluded.source_fingerprint, updated_at=excluded.updated_at`,
  sceneId, projectId, fingerprint, now())
}

/** Historical alternatives retain the creative source they actually accepted. */
export function savedDesignStoryboardSources(projectId: string, designId: string): Map<string, string> {
  const design = one<{ source_fingerprints: string }>('SELECT source_fingerprints FROM storyboard_designs WHERE id=? AND project_id=?', designId, projectId)
  try {
    const saved: unknown = JSON.parse(design?.source_fingerprints || '{}')
    return new Map(Object.entries(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch { return new Map() }
}

export function saveDesignStoryboardSource(projectId: string, designId: string, sceneId: string, fingerprint: string): void {
  const saved = savedDesignStoryboardSources(projectId, designId)
  saved.set(sceneId, fingerprint)
  run('UPDATE storyboard_designs SET source_fingerprints=? WHERE id=? AND project_id=?', JSON.stringify(Object.fromEntries(saved)), designId, projectId)
}
