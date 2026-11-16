import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sourceProductionDirectory, type SourceProductionState } from '@video-studio/shared/script/script-source-production'
import { all, db, newId, now, required, run, type Project, type ScriptScene } from '../../infrastructure/database/db.js'
import { idParams, parse } from '../../infrastructure/http/request.js'
import { scriptSourceIndex } from './script-source-documents.js'
import { effectiveScriptSource, scriptDocumentVersion } from './script-source-versions.js'

type Origin = { scene_id: string; source_version: string; source_offset: number; source_length: number; source_text: string; scene_hash: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const sceneHash = (scene: Pick<ScriptScene, 'heading' | 'location' | 'time_of_day' | 'characters' | 'action' | 'dialogue' | 'narration' | 'duration'>) =>
  hash(JSON.stringify([scene.heading, scene.location, scene.time_of_day, scene.characters, scene.action, scene.dialogue, scene.narration, scene.duration]))
function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode, delivery: 'not_sent' }) }
function sourceFor(projectId: string) {
  required<Project>('projects', projectId)
  return effectiveScriptSource(projectId) || fail('请先上传原稿')
}
export function sourceProductionState(projectId: string): SourceProductionState {
  const source = sourceFor(projectId), version = scriptDocumentVersion(source)
  const saved = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', projectId)
  const origins = all<Origin>('SELECT o.* FROM script_source_scene_origins o JOIN script_scenes s ON s.id=o.scene_id WHERE s.project_id=?', projectId)
  const episodes = sourceProductionDirectory(source.content)
  // Existing saved episodes remain usable even if absent from the latest source.
  for (const number of [...new Set(saved.map(item => item.episode_number))].filter(n => n > 0)) if (!episodes.some(ep => ep.episode_number === number)) {
    episodes.push({ episode_number: number, title: `第 ${number} 集（已保存）`, offset: 0, length: 0, scenes: [], ambiguous: false })
  }
  return { source_version: version, filename: source.filename, episodes: episodes.map(episode => {
    const current = saved.filter(item => item.episode_number === episode.episode_number)
    const imported = episode.scenes.filter(candidate => current.some(item => {
      const origin = origins.find(o => o.scene_id === item.id)
      return origin?.source_text === candidate.text && (origin.source_offset === candidate.offset || episode.scenes.filter(scene => scene.text === candidate.text).length === 1)
    }))
    const changed = current.filter(item => {
      const origin = origins.find(o => o.scene_id === item.id)
      return origin && (sceneHash(item) !== origin.scene_hash || !episode.scenes.some(candidate => candidate.text === origin.source_text))
    }).map(item => item.id)
    const blocked = episode.scenes.filter(candidate => current.some(item => {
      const origin = origins.find(o => o.scene_id === item.id)
      return origin && !episode.scenes.some(scene => scene.text === origin.source_text) &&
        (origin.source_offset === candidate.offset || origin.source_text.includes(candidate.heading))
    })).map(scene => scene.offset)
    const status: SourceProductionState['episodes'][number]['status'] = current.length && (current.some(item => !origins.some(origin => origin.scene_id === item.id)) || !episode.scenes.length || imported.length === episode.scenes.length) ? 'ready'
      : episode.ambiguous ? 'needs_selection' : episode.scenes.length ? 'available' : 'needs_adaptation'
    return { ...episode, status, saved_scene_ids: current.map(item => item.id), imported_offsets: imported.map(item => item.offset), changed_scene_ids: changed, blocked_scene_offsets: blocked }
  }).sort((a, b) => a.episode_number - b.episode_number || a.offset - b.offset) }
}
const prepareInput = z.object({ source_version: z.string().length(64), episode_number: z.number().int().min(1).max(200),
  episode_offset: z.number().int().min(0), scene_offsets: z.array(z.number().int().min(0)).min(1).max(100), duration: z.number().int().min(1).max(600) }).strict()
export function prepareSourceProduction(projectId: string, input: z.infer<typeof prepareInput>) {
  return db.transaction(() => {
    const source = sourceFor(projectId)
    if (scriptDocumentVersion(source) !== input.source_version) fail('原稿已变化，请重新读取目标集；已保存场次未修改', 409)
    const episode = sourceProductionDirectory(source.content).find(ep => ep.episode_number === input.episode_number && ep.offset === input.episode_offset)
    if (!episode || new Set(input.scene_offsets).size !== input.scene_offsets.length) fail('目标集或场次选择无效')
    const scenes = input.scene_offsets.map(offset => episode.scenes.find(item => item.offset === offset) || fail('场次不属于当前集原文'))
    const existing = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', projectId)
    const origins = all<Origin>('SELECT o.* FROM script_source_scene_origins o JOIN script_scenes s ON s.id=o.scene_id WHERE s.project_id=?', projectId)
    const own = existing.filter(item => item.episode_number === input.episode_number)
    if (own.some(item => !origins.some(origin => origin.scene_id === item.id))) fail('本集已有正式场次，可直接制作分镜；原稿导入不会覆盖它们', 409)
    const imported: string[] = [], reused: string[] = [], timestamp = now()
    // A changed original needs a local creator decision, never an implicit append
    // of a second version beside the confirmed scene.
    for (const item of own) {
      const origin = origins.find(origin => origin.scene_id === item.id)!
      if (!episode.scenes.some(candidate => candidate.text === origin.source_text) &&
        (episode.ambiguous || scenes.some(candidate => origin.source_offset === candidate.offset || origin.source_text.includes(candidate.heading)))) fail('本集已有场次的原文已变化，请核对相关场次；其他集仍可制作', 409)
    }
    let position = Math.max(-1, ...existing.map(item => item.position)) + 1
    for (const candidate of scenes.sort((a, b) => a.offset - b.offset)) {
      const previous = own.find(item => origins.some(origin => origin.scene_id === item.id && origin.source_text === candidate.text && (origin.source_offset === candidate.offset || episode.scenes.filter(scene => scene.text === candidate.text).length === 1)))
      if (previous) { reused.push(previous.id); continue }
      if (candidate.action.length > 10000 || candidate.dialogue.length > 10000 || candidate.characters.length > 2000) fail('此场超过分镜输入长度，请仅对相关场次重新划分')
      const id = newId()
      const values = { heading: candidate.heading, location: '', time_of_day: '', characters: candidate.characters,
        action: candidate.action, dialogue: candidate.dialogue, narration: '', duration: input.duration }
      run(`INSERT INTO script_scenes (id,project_id,episode_number,position,heading,location,time_of_day,characters,action,dialogue,narration,duration,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, projectId, input.episode_number, position++, values.heading, '', '', values.characters, values.action, values.dialogue, '', values.duration, timestamp, timestamp)
      run(`INSERT INTO script_source_scene_origins (scene_id,source_version,source_offset,source_length,source_text,scene_hash) VALUES (?,?,?,?,?,?)`,
        id, input.source_version, candidate.offset, candidate.length, candidate.text, sceneHash(values))
      imported.push(id)
    }
    if (imported.length) {
      const rows = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? AND episode_number=? ORDER BY position', projectId, input.episode_number)
      const coordinates = all<Origin>('SELECT o.* FROM script_source_scene_origins o JOIN script_scenes s ON s.id=o.scene_id WHERE s.project_id=? AND s.episode_number=?', projectId, input.episode_number)
      const slots = rows.map(row => row.position).sort((a, b) => a - b)
      rows.sort((a, b) => (coordinates.find(o => o.scene_id === a.id)?.source_offset || 0) - (coordinates.find(o => o.scene_id === b.id)?.source_offset || 0))
        .forEach((row, index) => { if (row.position !== slots[index]) run('UPDATE script_scenes SET position=? WHERE id=?', slots[index], row.id) })
    }
    if (imported.length) run('UPDATE projects SET updated_at=? WHERE id=?', timestamp, projectId)
    return { imported_scene_ids: imported, reused_scene_ids: reused, production: sourceProductionState(projectId) }
  })()
}
/** Only this explicit creation task consumes the manuscript; no quality gate or
 * implicit review is run. Target text comes first, full source is retained once
 * for global identities/rules, rather than sent to a chain of reviewers. */
export function sourceEpisodeProductionContext(projectId: string, episodeNumber: number): string {
  const source = sourceFor(projectId), matches = sourceProductionDirectory(source.content).filter(ep => ep.episode_number === episodeNumber)
  if (matches.length !== 1) fail('目标集在原稿中不唯一或不存在，请先核对集数')
  const episode = matches[0] || fail('目标集不存在')
  const materials = scriptSourceIndex(projectId, true)
  return `\n【明确授权的单集改编】仅第${episodeNumber}集；原稿只读。复用已保存的原稿资料，不重复分析，不进行质量审核循环，直接交付本次明确要求的成果。不得要求生成整套设计包，不得补写其他集，不擅自改变原稿已明确身份、剧情结果和对白含义。未知和开放结局如实保留。\n` +
    JSON.stringify({ source_version: scriptDocumentVersion(source), target: { offset: episode.offset, length: episode.length, text: source.content.slice(episode.offset, episode.offset + episode.length) },
      ...(materials?.story ? { saved_story: materials.story, saved_episode_index: materials.position_index, saved_knowledge: materials.knowledge } : {}),
      full_source_for_global_facts: source.content }) + '\n'
}
export function registerSourceProductionRoutes(app: FastifyInstance) {
  app.get('/api/projects/:id/script/source/production', request => sourceProductionState(parse(idParams, request.params).id))
  app.post('/api/projects/:id/script/source/production/prepare', request => prepareSourceProduction(parse(idParams, request.params).id, parse(prepareInput, request.body)))
}
