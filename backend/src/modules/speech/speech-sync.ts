import { createHash } from 'node:crypto'
import { all, db, newId, now, one, run } from '../../infrastructure/database/db.js'
import type { ScriptScene } from '../../infrastructure/database/db.js'
import { parseSpeechSceneEntries, type SpeechSceneEntry } from './speech-import.js'

interface SourceLine {
  id: string; project_id: string; scene_id: string | null; voice_id: string | null; text: string; instructions: string
  source_key: string | null; source_entry_key: string | null; source_snapshot: string | null; archived: number; updated_at: string
}
const signature = (entry: Pick<SpeechSceneEntry, 'name' | 'text' | 'instructions'>) => JSON.stringify({ name: entry.name, text: entry.text, instructions: entry.instructions })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const speechSourceKey = (entry: SpeechSceneEntry) => hash([entry.key, entry.name, entry.text, entry.instructions])
function busy(lineId: string) { return !!one("SELECT 1 FROM speech_takes t JOIN jobs j ON j.id=t.job_id WHERE t.line_id=? AND j.status IN ('queued','running')", lineId) }

export function initSpeechSources(): void {
  const columns = db.pragma('table_info(speech_lines)') as Array<{ name: string }>
  for (const [name, declaration] of [['source_entry_key', 'TEXT'], ['source_snapshot', 'TEXT'], ['archived', 'INTEGER NOT NULL DEFAULT 0']] as const) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE speech_lines ADD COLUMN ${name} ${declaration}`)
  }
  for (const scene of all<ScriptScene>('SELECT * FROM script_scenes')) {
    for (const entry of parseSpeechSceneEntries(scene)) {
      run('UPDATE speech_lines SET source_entry_key=?,source_snapshot=? WHERE project_id=? AND source_key=? AND source_entry_key IS NULL', entry.key, signature(entry), scene.project_id, speechSourceKey(entry))
    }
  }
}

export function speechSourceStatus(line: Pick<SourceLine, 'source_key' | 'source_snapshot' | 'scene_id' | 'archived'>) {
  if (line.archived) return 'removed' as const
  if (!line.source_key) return 'manual' as const
  const scene = line.scene_id ? one<ScriptScene>('SELECT * FROM script_scenes WHERE id=?', line.scene_id) : undefined
  if (!scene) return 'removed' as const
  return parseSpeechSceneEntries(scene).some(entry => signature(entry) === line.source_snapshot) ? 'current' as const : 'changed' as const
}

interface SyncChange { kind: 'added' | 'updated' | 'removed' | 'preserved'; line_id?: string; scene_id: string; entry?: SpeechSceneEntry; before?: string; after?: string; role?: string }
export function previewSpeechSync(projectId: string, sceneIds?: string[]) {
  const scenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY episode_number,position,rowid', projectId).filter(scene => !sceneIds || sceneIds.includes(scene.id))
  if (sceneIds?.some(id => !scenes.some(scene => scene.id === id))) throw Object.assign(new Error('场次不属于当前项目'), { statusCode: 404 })
  const lines = all<SourceLine>('SELECT * FROM speech_lines WHERE project_id=? AND source_key IS NOT NULL ORDER BY position,rowid', projectId).filter(line => scenes.some(scene => scene.id === line.scene_id))
  const voices = new Map(all<{ id: string; name: string }>('SELECT id,name FROM speech_voices WHERE project_id=?', projectId).map(voice => [voice.id, voice.name]))
  const baseline = (line: SourceLine) => line.source_snapshot || signature({ name: voices.get(line.voice_id || '') || '待分配角色', text: line.text, instructions: line.instructions })
  const changes: SyncChange[] = []
  const matches: Array<{ line_id: string; entry: SpeechSceneEntry }> = []
  for (const scene of scenes) {
    const entries = parseSpeechSceneEntries(scene), previous = lines.filter(line => line.scene_id === scene.id)
    const used = new Set<string>(), matched = new Set<string>()
    for (const entry of entries) {
      const exact = previous.find(line => !used.has(line.id) && baseline(line) === signature(entry))
      if (exact) {
        used.add(exact.id); matched.add(entry.key)
        matches.push({ line_id: exact.id, entry })
        if (exact.archived) changes.push({ kind: 'updated', line_id: exact.id, scene_id: scene.id, entry, before: exact.text, after: entry.text, role: entry.name })
      }
    }
    const remainingEntries = entries.filter(entry => !matched.has(entry.key))
    for (const entry of remainingEntries) {
      const sameRole = previous.filter(line => !used.has(line.id) && JSON.parse(baseline(line)).name === entry.name)
      const roleEntries = remainingEntries.filter(item => item.name === entry.name)
      const remainingLines = previous.filter(line => !used.has(line.id) && !line.archived)
      const line = sameRole.length === 1 && roleEntries.length === 1 ? sameRole[0] : remainingEntries.length === 1 && remainingLines.length === 1 ? remainingLines[0] : undefined
      if (line) {
        used.add(line.id)
        const original = JSON.parse(baseline(line)) as SpeechSceneEntry
        const localEdit = line.text !== original.text || line.instructions !== original.instructions || voices.get(line.voice_id || '') !== original.name
        changes.push({ kind: localEdit || busy(line.id) ? 'preserved' : 'updated', line_id: line.id, scene_id: scene.id, entry, before: line.text, after: entry.text, role: entry.name })
      } else changes.push({ kind: 'added', scene_id: scene.id, entry, after: entry.text, role: entry.name })
    }
    for (const line of previous.filter(line => !used.has(line.id) && !line.archived)) {
      changes.push({ kind: busy(line.id) ? 'preserved' : 'removed', line_id: line.id, scene_id: scene.id, before: line.text, role: voices.get(line.voice_id || '') })
    }
  }
  return { sync_token: hash({ scenes, lines, voices: [...voices], busy: lines.map(line => [line.id, busy(line.id)]) }), changes, matches,
    added: changes.filter(change => change.kind === 'added').length, updated: changes.filter(change => change.kind === 'updated').length,
    removed: changes.filter(change => change.kind === 'removed').length, preserved: changes.filter(change => change.kind === 'preserved').length }
}

export function applySpeechSync(projectId: string, sceneIds: string[] | undefined, token: string) {
  const preview = previewSpeechSync(projectId, sceneIds)
  if (preview.sync_token !== token) throw Object.assign(new Error('剧本或配音已变化，请重新查看同步差异'), { statusCode: 409 })
  db.transaction(() => {
    for (const match of preview.matches) {
      if (!busy(match.line_id)) run('UPDATE speech_lines SET source_entry_key=?,updated_at=? WHERE id=? AND source_entry_key IS NOT ?', match.entry.key, now(), match.line_id, match.entry.key)
    }
    let position = one<{ value: number }>('SELECT COALESCE(MAX(position),-1)+1 AS value FROM speech_lines WHERE project_id=?', projectId)!.value
    for (const change of preview.changes) {
      if (change.kind === 'removed') { run('UPDATE speech_lines SET archived=1,updated_at=? WHERE id=?', now(), change.line_id); continue }
      if (!change.entry || change.line_id && busy(change.line_id)) continue
      const entry = change.entry
      if (change.kind === 'preserved') {
        run('UPDATE speech_lines SET source_entry_key=?,source_snapshot=?,updated_at=? WHERE id=?', entry.key, signature(entry), now(), change.line_id)
        continue // Keep the user's edited spoken text and selected audio.
      }
      let voiceId = one<{ id: string }>('SELECT id FROM speech_voices WHERE project_id=? AND name=?', projectId, entry.name)?.id
      if (!voiceId) {
        voiceId = newId()
        const config = one<{ default_speaker: string; speech_rate: number }>("SELECT default_speaker,speech_rate FROM speech_config WHERE id='default'")!
        run('INSERT INTO speech_voices (id,project_id,name,speaker,instructions,speech_rate,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', voiceId, projectId, entry.name, config.default_speaker, '', config.speech_rate, now(), now())
      }
      if (change.line_id) run('UPDATE speech_lines SET text=?,instructions=?,voice_id=?,source_entry_key=?,source_snapshot=?,archived=0,updated_at=? WHERE id=?', entry.text, entry.instructions, voiceId, entry.key, signature(entry), now(), change.line_id)
      else {
        const sourceKey = speechSourceKey(entry)
        const uniqueKey = one('SELECT 1 FROM speech_lines WHERE project_id=? AND source_key=?', projectId, sourceKey) ? `${sourceKey}:${newId()}` : sourceKey
        run(`INSERT INTO speech_lines (id,project_id,scene_id,voice_id,position,text,instructions,context_text,source_key,source_entry_key,source_snapshot,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?)`, newId(), projectId, change.scene_id, voiceId, position++, entry.text, entry.instructions, uniqueKey, entry.key, signature(entry), now(), now())
      }
    }
  })()
  return preview
}

export function recordImportedSpeechSource(lineId: string, entry: SpeechSceneEntry): void {
  run('UPDATE speech_lines SET source_entry_key=?,source_snapshot=? WHERE id=?', entry.key, signature(entry), lineId)
}
