import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeVideoDurationMs } from './render.js'

export const dataDir = process.env.VIDEO_STUDIO_DATA_DIR || fileURLToPath(new URL('../../data/', import.meta.url))
export const mediaDir = resolve(dataDir, 'media')
mkdirSync(mediaDir, { recursive: true })

export const db = new Database(resolve(dataDir, 'studio.db'))
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')

export const now = () => new Date().toISOString()
export const newId = () => randomUUID().replaceAll('-', '')

export interface Project {
  id: string; name: string; brief: string; ratio: '16:9' | '9:16';
  music_asset_id: string | null; created_at: string; updated_at: string
}
export interface Shot {
  id: string; project_id: string; position: number; title: string; prompt: string;
  duration: number; selected_asset_id: string | null; created_at: string;
  source_scene_id: string | null; start_state: string; end_state: string; cut_note: string
}
export interface TimelineClip {
  id: string; project_id: string; shot_id: string; asset_id: string;
  in_ms: number; out_ms: number; source_duration_ms: number | null;
  source_audio_gain: number; source_audio_fade_ms: number
}
export interface ScriptScene {
  id: string; project_id: string; position: number; heading: string;
  episode_number: number;
  location: string; time_of_day: string; characters: string; action: string;
  dialogue: string; narration: string; duration: number;
  created_at: string; updated_at: string
}
export interface ScriptGenerationOptions {
  genre?: string
  genre_fusion?: string
  audience?: string
  era?: string
  core_hook?: string
  visual_style?: string
  story_structure?: string
  character_notes?: string
  /** Target number of episodes for a generated series. */
  episode_count?: number
  episode_duration?: number
}
export interface ScriptConversation {
  id: string; project_id: string; label: string;
  created_at: string; updated_at: string
}
export interface ScriptMessage {
  id: string; conversation_id: string; position: number;
  role: 'assistant' | 'user'; text: string; reference_documents?: string; created_at: string
  processing_duration_ms?: number | null
}
export type ScriptArtifactType =
  | 'outline' | 'synopsis' | 'world' | 'characters' | 'relationships' | 'locations'
  | 'props' | 'structure' | 'hooks' | 'foreshadowing' | 'reversals' | 'constraints'
  | 'episode_outline' | 'episode_script'
export interface ScriptArtifact {
  id: string; project_id: string; artifact_type: ScriptArtifactType; title: string;
  episode_number: number;
  content: string; position: number; status: 'draft' | 'ready' | 'edited';
  created_at: string; updated_at: string
}
export interface Provider {
  id: string; name: string; adapter: 'http' | 'demo';
  base_url: string; auth_header: string; auth_prefix: string;
  key_ciphertext: string | null; model_catalog: string;
  created_at: string; enabled: number; archived: number
}
export interface Model {
  id: string; provider_id: string; name: string; remote_id: string;
  modality: 'text' | 'image' | 'video';
  protocol: 'responses' | 'chat_completions' | 'image_generations' | 'async_video';
  settings: string; enabled: number; archived: number
}
export interface Asset {
  id: string; project_id: string; shot_id: string | null;
  kind: 'text' | 'image' | 'video' | 'audio'; filename: string;
  path: string; source: 'upload' | 'generated' | 'export';
  model_id: string | null; prompt: string | null; remote_url: string | null; created_at: string
}
export type AssetTaskFocus = 'character' | 'location' | 'prop'
export type AssetTaskStatus = 'awaiting_confirmation' | 'generating' | 'ready' | 'failed'
export interface AssetTask {
  id: string; project_id: string; focus_artifact: AssetTaskFocus;
  status: AssetTaskStatus; source_artifact_ids: string; source_scene_ids: string;
  prompt: string; generation_job_id: string | null; result_asset_id: string | null;
  error: string | null; created_at: string; updated_at: string
}
export interface AssetTaskEvent {
  id: string; task_id: string; stage: string; message: string; created_at: string
}
export interface AssetReview {
  shot_id: string; asset_id: string; status: 'pending' | 'approved' | 'rejected';
  note: string; updated_at: string
}
export interface CutReview {
  project_id: string; from_shot_id: string; to_shot_id: string;
  status: 'pending' | 'approved' | 'needs_work'; note: string;
  signature: string; from_selected_asset_id: string | null; to_selected_asset_id: string | null;
  from_clip_id: string | null; to_clip_id: string | null;
  from_clip_asset_id: string | null; to_clip_asset_id: string | null;
  from_in_ms: number | null; from_out_ms: number | null;
  to_in_ms: number | null; to_out_ms: number | null;
  updated_at: string
}
export interface Job {
  id: string; project_id: string; shot_id: string | null; model_id: string | null;
  job_type: 'generation' | 'export'; request: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  external_id: string | null; result_asset_id: string | null; error: string | null;
  created_at: string; updated_at: string
}
export interface CanvasNode {
  id: string; project_id: string; position: number;
  type: 'text' | 'image' | 'video' | 'generation' | 'project_script_ref';
  x: number; y: number; width: number; height: number;
  title: string; text: string; asset_id: string | null;
  shot_id: string | null; model_id: string | null; job_id: string | null; prompt: string;
  settings: string
}
export interface CanvasEdge {
  id: string; project_id: string; position: number;
  source: string; target: string
}

export function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function run(sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...params)
}

export function required<T>(table: 'projects' | 'shots' | 'timeline_clips' | 'script_scenes' | 'script_conversations' | 'script_artifacts' | 'providers' | 'models' | 'assets' | 'jobs' | 'asset_tasks' | 'visual_profiles', id: string): T {
  const value = one<T>(`SELECT * FROM ${table} WHERE id=?`, id)
  if (!value) throw Object.assign(new Error('记录不存在'), { statusCode: 404 })
  return value
}

const legacyBuiltInModels = [
  { id: 'ark-text', name: 'Doubao Seed 2.1 Pro', remoteId: 'doubao-seed-2-1-pro-260628', modality: 'text', protocol: 'responses', settingsHashes: ['72cbf7c3981bc591f28a571450c4b86730b9468d4f37abb92702c12aa47c8636'] },
  { id: 'ark-image', name: 'Seedream 5.0 Pro', remoteId: 'doubao-seedream-5-0-pro-260628', modality: 'image', protocol: 'image_generations', settingsHashes: ['0bcd892ca53c6775bd2de8415c1536c3cc141495e1066889bcf105eabe28daaf'] },
  { id: 'ark-video', name: 'Seedance 2.5', remoteId: 'doubao-seedance-2-5-260628', modality: 'video', protocol: 'async_video', settingsHashes: [
    '9495445d3af171a865c83f30a7b159282ebd35a87eb2eaa1f57bed4c927ab0bb',
    'bb80df5d5beb958e46eb3d4dc76b1b49193d205b0db0eefd97ad2825d70c5e26',
    '990eb48f7ec5baac86ad86a60b62e6fd719eb142e3670c0e914a1527624b5809',
  ] },
] as const

function archiveUnchangedBuiltIns(): void {
  const provider = one<Provider>('SELECT * FROM providers WHERE id=?', 'ark')
  if (!provider) return

  for (const legacy of legacyBuiltInModels) {
    const model = one<Model>('SELECT * FROM models WHERE id=?', legacy.id)
    if (!model || model.provider_id !== provider.id || model.name !== legacy.name ||
      model.remote_id !== legacy.remoteId || model.modality !== legacy.modality ||
      model.protocol !== legacy.protocol || model.enabled !== 1) continue
    const hash = createHash('sha256').update(model.settings).digest('hex')
    if (legacy.settingsHashes.some(candidate => candidate === hash)) run('UPDATE models SET archived=1 WHERE id=?', model.id)
  }
  const providerIsUnchanged = provider.name === '火山方舟（预设）' && provider.adapter === 'http' &&
    provider.base_url === 'https://ark.cn-beijing.volces.com/api/v3' &&
    provider.auth_header === 'Authorization' && provider.auth_prefix === 'Bearer ' &&
    provider.key_ciphertext === null && provider.enabled === 1
  if (providerIsUnchanged && !one<Model>('SELECT * FROM models WHERE provider_id=? AND archived=0 LIMIT 1', provider.id)) {
    run('UPDATE providers SET archived=1 WHERE id=?', provider.id)
  }
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
      ratio TEXT NOT NULL DEFAULT '16:9', music_asset_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scripts (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      outline TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '',
      generation_options TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS script_scenes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, heading TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '', time_of_day TEXT NOT NULL DEFAULT '',
      characters TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
      dialogue TEXT NOT NULL DEFAULT '', narration TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS script_conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '未命名对话', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS script_messages (
      id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES script_conversations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('assistant', 'user')),
      text TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, id)
    );
    CREATE TABLE IF NOT EXISTS script_reply_classifications (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, text_hash TEXT NOT NULL, classification TEXT NOT NULL,
      model_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, message_id, text_hash)
    );
    CREATE TABLE IF NOT EXISTS script_artifacts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'edited')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, artifact_type)
    );
    CREATE TABLE IF NOT EXISTS shot_plan_requests (
      request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL,
      shot_ids TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
      duration INTEGER NOT NULL DEFAULT 5, selected_asset_id TEXT,
      created_at TEXT NOT NULL,
      source_scene_id TEXT REFERENCES script_scenes(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS production_ranges (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      start_shot_id TEXT, end_shot_id TEXT
    );
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL,
      base_url TEXT NOT NULL, auth_header TEXT NOT NULL DEFAULT 'Authorization',
      auth_prefix TEXT NOT NULL DEFAULT 'Bearer ', key_ciphertext TEXT,
      model_catalog TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL, remote_id TEXT NOT NULL, modality TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'responses',
      settings TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
      kind TEXT NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL,
      source TEXT NOT NULL, model_id TEXT, prompt TEXT,
      remote_url TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_assets (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_reviews (
      shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      PRIMARY KEY (shot_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS cut_reviews (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      to_shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'needs_work')),
      note TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL,
      from_selected_asset_id TEXT, to_selected_asset_id TEXT,
      from_clip_id TEXT, to_clip_id TEXT,
      from_clip_asset_id TEXT, to_clip_asset_id TEXT,
      from_in_ms INTEGER, from_out_ms INTEGER,
      to_in_ms INTEGER, to_out_ms INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, from_shot_id, to_shot_id)
    );
    CREATE TABLE IF NOT EXISTS continuity_analyses (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL, signature TEXT NOT NULL,
      issues TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline_clips (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shot_id TEXT NOT NULL UNIQUE REFERENCES shots(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      in_ms INTEGER NOT NULL DEFAULT 0, out_ms INTEGER NOT NULL,
      source_duration_ms INTEGER,
      source_audio_gain REAL NOT NULL DEFAULT 1,
      source_audio_fade_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
      model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
      job_type TEXT NOT NULL, request TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL, external_id TEXT, result_asset_id TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      focus_artifact TEXT NOT NULL CHECK (focus_artifact IN ('character', 'location', 'prop')),
      status TEXT NOT NULL CHECK (status IN ('awaiting_confirmation', 'generating', 'ready', 'failed')),
      source_artifact_ids TEXT NOT NULL DEFAULT '[]',
      source_scene_ids TEXT NOT NULL DEFAULT '[]',
      prompt TEXT NOT NULL DEFAULT '',
      generation_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      result_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES asset_tasks(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visual_profiles (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('character', 'location', 'prop')),
      name TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '默认',
      definition TEXT NOT NULL, view_requirements TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      board_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      asset_task_id TEXT REFERENCES asset_tasks(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, kind, name, variant)
    );
    CREATE TABLE IF NOT EXISTS scene_visual_bindings (
      scene_id TEXT NOT NULL REFERENCES script_scenes(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES visual_profiles(id) ON DELETE CASCADE,
      required INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (scene_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS shot_visual_bindings (
      shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES visual_profiles(id) ON DELETE CASCADE,
      required INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, variant TEXT NOT NULL,
      definition TEXT NOT NULL, view_requirements TEXT NOT NULL,
      board_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      PRIMARY KEY (shot_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS canvas_nodes (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text', 'image', 'video', 'generation', 'project_script_ref')),
      x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
      title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
      asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
      model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS canvas_edges (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      source TEXT NOT NULL, target TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id, source) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, target) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS job_image_recovery (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      result_url_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_timeline_clips_project ON timeline_clips(project_id);
    CREATE INDEX IF NOT EXISTS idx_script_scenes_project ON script_scenes(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_script_conversations_project ON script_conversations(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_script_messages_conversation ON script_messages(conversation_id, position);
    CREATE INDEX IF NOT EXISTS idx_script_artifacts_project ON script_artifacts(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_saved_assets_project ON saved_assets(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_asset_tasks_project ON asset_tasks(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_asset_task_events_task ON asset_task_events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_canvas_nodes_project ON canvas_nodes(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_canvas_edges_project ON canvas_edges(project_id, position);
  `)

  const scriptColumns = db.pragma('table_info(scripts)') as Array<{ name: string }>
  if (!scriptColumns.some(column => column.name === 'generation_options')) {
    db.exec("ALTER TABLE scripts ADD COLUMN generation_options TEXT NOT NULL DEFAULT '{}'")
  }

  const messageColumns = db.pragma('table_info(script_messages)') as Array<{ name: string }>
  if (!messageColumns.some(column => column.name === 'reference_documents')) {
    db.exec("ALTER TABLE script_messages ADD COLUMN reference_documents TEXT NOT NULL DEFAULT '[]'")
  }
  if (!messageColumns.some(column => column.name === 'processing_duration_ms')) {
    db.exec('ALTER TABLE script_messages ADD COLUMN processing_duration_ms INTEGER')
  }

  const sceneColumns = db.pragma('table_info(script_scenes)') as Array<{ name: string }>
  if (!sceneColumns.some(column => column.name === 'episode_number')) {
    db.exec('ALTER TABLE script_scenes ADD COLUMN episode_number INTEGER NOT NULL DEFAULT 0')
  }
  const artifactColumns = db.pragma('table_info(script_artifacts)') as Array<{ name: string }>
  if (!artifactColumns.some(column => column.name === 'episode_number')) {
    // Preserve document IDs: asset tasks keep bindings to these documents.
    db.transaction(() => db.exec(`
      CREATE TABLE script_artifacts_by_episode (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'edited')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        episode_number INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, artifact_type, episode_number)
      );
      INSERT INTO script_artifacts_by_episode
        SELECT *, 0 FROM script_artifacts;
      DROP TABLE script_artifacts;
      ALTER TABLE script_artifacts_by_episode RENAME TO script_artifacts;
      CREATE INDEX idx_script_artifacts_project ON script_artifacts(project_id, position);
    `))()
  }

  const shotColumns = db.pragma('table_info(shots)') as Array<{ name: string }>
  if (!shotColumns.some(column => column.name === 'source_scene_id')) {
    db.exec('ALTER TABLE shots ADD COLUMN source_scene_id TEXT REFERENCES script_scenes(id) ON DELETE SET NULL')
  }
  for (const field of ['start_state', 'end_state', 'cut_note']) {
    if (!shotColumns.some(column => column.name === field)) {
      db.exec(`ALTER TABLE shots ADD COLUMN ${field} TEXT NOT NULL DEFAULT ''`)
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_shots_source_scene ON shots(source_scene_id)')

  const canvasNodeColumns = db.pragma('table_info(canvas_nodes)') as Array<{ name: string }>
  if (!canvasNodeColumns.some(column => column.name === 'job_id')) {
    db.exec('ALTER TABLE canvas_nodes ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL')
  }

  const canvasNodeSchema = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='canvas_nodes'")?.sql ?? ''
  if (!canvasNodeSchema.includes("'project_script_ref'")) {
    db.pragma('foreign_keys = OFF')
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE canvas_nodes_new (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('text', 'image', 'video', 'generation', 'project_script_ref')),
          x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
          title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
          asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
          shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
          model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          prompt TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (project_id, id)
        );
        INSERT INTO canvas_nodes_new
          (id, project_id, position, type, x, y, width, height, title, text, asset_id, shot_id, model_id, job_id, prompt, settings)
        SELECT id, project_id, position, type, x, y, width, height, title, text, asset_id, shot_id, model_id, job_id, prompt, settings
        FROM canvas_nodes;
        CREATE TABLE canvas_edges_new (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          source TEXT NOT NULL, target TEXT NOT NULL,
          PRIMARY KEY (project_id, id),
          FOREIGN KEY (project_id, source) REFERENCES canvas_nodes_new(project_id, id) ON DELETE CASCADE,
          FOREIGN KEY (project_id, target) REFERENCES canvas_nodes_new(project_id, id) ON DELETE CASCADE
        );
        INSERT INTO canvas_edges_new (id, project_id, position, source, target)
        SELECT id, project_id, position, source, target FROM canvas_edges;
        DROP TABLE canvas_edges;
        DROP TABLE canvas_nodes;
        ALTER TABLE canvas_nodes_new RENAME TO canvas_nodes;
        ALTER TABLE canvas_edges_new RENAME TO canvas_edges;
        CREATE INDEX IF NOT EXISTS idx_canvas_nodes_project ON canvas_nodes(project_id, position);
        CREATE INDEX IF NOT EXISTS idx_canvas_edges_project ON canvas_edges(project_id, position);
        COMMIT;
      `)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  const clipColumns = db.pragma('table_info(timeline_clips)') as Array<{ name: string }>
  if (!clipColumns.some(column => column.name === 'source_audio_gain')) {
    db.exec('ALTER TABLE timeline_clips ADD COLUMN source_audio_gain REAL NOT NULL DEFAULT 1')
  }
  if (!clipColumns.some(column => column.name === 'source_audio_fade_ms')) {
    db.exec('ALTER TABLE timeline_clips ADD COLUMN source_audio_fade_ms INTEGER NOT NULL DEFAULT 0')
  }

  const previousSelections = all<Shot>(`SELECT shots.* FROM shots
    LEFT JOIN timeline_clips ON timeline_clips.shot_id=shots.id
    WHERE shots.selected_asset_id IS NOT NULL AND timeline_clips.id IS NULL`)
  for (const shot of previousSelections) {
    const asset = one<Asset>('SELECT * FROM assets WHERE id=? AND project_id=?', shot.selected_asset_id, shot.project_id)
    if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) continue
    let sourceDuration: number | null = null
    if (asset.kind === 'video') {
      try { sourceDuration = probeVideoDurationMs(asset.path) } catch { /* Preserve the selection even if a legacy file is unavailable. */ }
    }
    run(`INSERT INTO timeline_clips (id, project_id, shot_id, asset_id, in_ms, out_ms, source_duration_ms)
      VALUES (?, ?, ?, ?, 0, ?, ?)`, newId(), shot.project_id, shot.id, asset.id,
      sourceDuration === null ? shot.duration * 1000 : Math.min(sourceDuration, shot.duration * 1000), sourceDuration)
  }

  const providerColumns = db.pragma('table_info(providers)') as Array<{ name: string }>
  if (!providerColumns.some(column => column.name === 'auth_header')) {
    db.exec("ALTER TABLE providers ADD COLUMN auth_header TEXT NOT NULL DEFAULT 'Authorization'")
  }
  if (!providerColumns.some(column => column.name === 'auth_prefix')) {
    db.exec("ALTER TABLE providers ADD COLUMN auth_prefix TEXT NOT NULL DEFAULT 'Bearer '")
  }
  if (!providerColumns.some(column => column.name === 'enabled')) {
    db.exec('ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
  }
  if (!providerColumns.some(column => column.name === 'archived')) {
    db.exec('ALTER TABLE providers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  if (!providerColumns.some(column => column.name === 'model_catalog')) {
    db.exec("ALTER TABLE providers ADD COLUMN model_catalog TEXT NOT NULL DEFAULT '{}'")
  }
  const modelColumns = db.pragma('table_info(models)') as Array<{ name: string }>
  if (!modelColumns.some(column => column.name === 'protocol')) {
    db.exec("ALTER TABLE models ADD COLUMN protocol TEXT NOT NULL DEFAULT 'responses'")
  }
  if (!modelColumns.some(column => column.name === 'archived')) {
    db.exec('ALTER TABLE models ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  if (!one('SELECT 1 FROM studio_migrations WHERE id=?', 'image-ratio-parameters-v1')) {
    const imageRatios = ['1:1', '1:2', '2:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21']
    db.transaction(() => {
      for (const model of all<Model>("SELECT * FROM models WHERE modality='image'")) {
        let settings: Record<string, unknown>
        try { settings = JSON.parse(model.settings) as Record<string, unknown> } catch { continue }
        const template = settings.request_template
        const oldSizes = settings.resolutions
        if (!template || typeof template !== 'object' || Array.isArray(template) ||
          (template as Record<string, unknown>).size !== '{{size}}' || !Array.isArray(oldSizes)) continue
        const nextTemplate = { ...(template as Record<string, unknown>) }
        delete nextTemplate.size
        nextTemplate.ratio = '{{ratio}}'
        delete settings.resolutions
        delete settings.default_resolution
        settings.request_template = nextTemplate
        settings.ratios = imageRatios
        settings.default_ratio = '1:1'
        run('UPDATE models SET settings=? WHERE id=?', JSON.stringify(settings), model.id)
      }
      run('INSERT INTO studio_migrations (id, applied_at) VALUES (?, ?)', 'image-ratio-parameters-v1', now())
    })()
  }
  if (Number(db.pragma('user_version', { simple: true })) < 3) {
    db.transaction(() => {
      archiveUnchangedBuiltIns()
      db.pragma('user_version = 3')
    })()
  }
  if (!one('SELECT 1 FROM studio_migrations WHERE id=?', 'saved-assets-v1')) {
    db.transaction(() => {
      // Existing assets predate the explicit save action, so keep them visible
      // in the library when upgrading. New generated results stay unsaved.
      run(`INSERT OR IGNORE INTO saved_assets (asset_id, project_id, created_at)
        SELECT id, project_id, created_at FROM assets`)
      run('INSERT INTO studio_migrations (id, applied_at) VALUES (?, ?)', 'saved-assets-v1', now())
    })()
  }
  db.transaction(() => {
    const timestamp = now()
    run(`UPDATE jobs SET status='failed', error=?, updated_at=?
      WHERE status='running' AND job_type='generation'
        AND model_id IN (SELECT id FROM models WHERE modality='image')
        AND NOT EXISTS (SELECT 1 FROM job_image_recovery WHERE job_id=jobs.id)`,
      '图片任务中断，未找到可恢复图片链接。厂商可能已计费，请先核对厂商记录，再手动创建新的生成任务。', timestamp)
    run("UPDATE jobs SET status='queued', updated_at=? WHERE status='running'", timestamp)
  })()
}
