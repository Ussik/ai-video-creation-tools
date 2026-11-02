import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { probeVideoDurationMs } from '../media/render.js'
import { dataDir } from '../paths.js'
import { upgradeLegacySeedance25Settings } from '../../modules/models/legacy-seedance25-settings.js'
import type { StageArtifactType } from '@video-studio/shared/script/script-stage-content'

export { dataDir } from '../paths.js'
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
  image_prompt: string; video_prompt: string
  storyboard_revision?: number
  deleted_at?: string | null
  design_id?: string | null
  superseded_by?: string | null
}
export interface StoryboardDesign {
  id: string; project_id: string; canvas_id: string | null; name: string;
  scene_ids: string; instructions: string; created_at: string
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
  visual_style_details?: import('@video-studio/shared/visuals/visual-style').VisualStyleDetails
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
  stage_context?: string | null
  activity?: string
  reply_metadata?: string
}
export type ScriptArtifactType = StageArtifactType
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
  settings: string; enabled: number; archived: number; is_default?: number
}
export interface Asset {
  id: string; project_id: string; shot_id: string | null;
  kind: 'text' | 'image' | 'video' | 'audio'; filename: string;
  path: string; source: 'upload' | 'generated' | 'export'; deleted_at?: string | null
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
  id: string; project_id: string; canvas_id?: string | null; position: number;
  type: 'text' | 'image' | 'video' | 'generation' | 'project_script_ref' | 'image_analysis' | 'video_analysis';
  x: number; y: number; width: number; height: number;
  title: string; text: string; asset_id: string | null;
  shot_id: string | null; model_id: string | null; job_id: string | null; prompt: string;
  settings: string
}
export interface CanvasEdge {
  id: string; project_id: string; canvas_id?: string | null; position: number;
  source: string; target: string; reference_asset_id?: string | null
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
  const value = one<T>(`SELECT * FROM ${table} WHERE id=?${table === 'shots' || table === 'assets' ? ' AND deleted_at IS NULL' : ''}`, id)
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
    CREATE TABLE IF NOT EXISTS script_source_documents (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS script_source_analyses (
      project_id TEXT PRIMARY KEY REFERENCES script_source_documents(project_id) ON DELETE CASCADE,
      id TEXT NOT NULL, source_version TEXT NOT NULL, status TEXT NOT NULL,
      snapshot TEXT NOT NULL, updated_at TEXT NOT NULL
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
    -- Append-only copy of every conversation message ever stored. The visible conversation is windowed
    -- (and trimmed) for the interface; this archive keeps the original wording readable by id.
    CREATE TABLE IF NOT EXISTS script_message_archive (
      conversation_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('assistant', 'user')), text TEXT NOT NULL, first_seen_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_script_message_archive_project ON script_message_archive(project_id, first_seen_at);
    CREATE TABLE IF NOT EXISTS script_director_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES script_conversations(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL, message_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_script_director_active_project
      ON script_director_tasks(project_id) WHERE status='running';
    CREATE TABLE IF NOT EXISTS script_text_responses (
      task_id TEXT NOT NULL REFERENCES script_director_tasks(id) ON DELETE CASCADE,
      request_key TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS script_generation_checkpoints (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS script_step_checkpoints (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, namespace)
    );
    CREATE TABLE IF NOT EXISTS script_reply_classifications (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, text_hash TEXT NOT NULL, classification TEXT NOT NULL,
      model_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, message_id, text_hash)
    );
    CREATE TABLE IF NOT EXISTS script_story_decisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      topic TEXT NOT NULL, content TEXT NOT NULL, basis TEXT NOT NULL,
      source_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, topic)
    );
    CREATE TABLE IF NOT EXISTS script_creator_requirements (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('requirement', 'open_question')),
      quote TEXT NOT NULL, source_text TEXT NOT NULL, message_id TEXT, conversation_id TEXT,
      scope TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
      supersedes_id TEXT, superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_script_creator_requirements_project ON script_creator_requirements(project_id, status, created_at);
    CREATE TABLE IF NOT EXISTS script_draft_resolutions (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS script_source_revisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_base_version TEXT NOT NULL, revision INTEGER NOT NULL,
      original_content TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_script_source_revisions ON script_source_revisions(project_id, source_base_version, revision);
    CREATE TABLE IF NOT EXISTS script_tool_drafts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_script_pending_tool_draft ON script_tool_drafts(project_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS script_document_reviews (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL, document_version TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, document_id)
    );
    CREATE TABLE IF NOT EXISTS script_workflow_proposals (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      state_version TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS storyboard_scene_plans (
      scene_id TEXT PRIMARY KEY REFERENCES script_scenes(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_storyboard_scene_plans_project ON storyboard_scene_plans(project_id);
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
    CREATE TABLE IF NOT EXISTS editing_cuts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, source_canvas_id TEXT REFERENCES project_canvases(id) ON DELETE SET NULL,
      revision INTEGER NOT NULL DEFAULT 1, document TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_editing_cuts_project ON editing_cuts(project_id, updated_at);
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
    CREATE TABLE IF NOT EXISTS shot_candidate_archives (
      shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
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
      base_profile_id TEXT REFERENCES visual_profiles(id) ON DELETE SET NULL,
      state_delta TEXT NOT NULL DEFAULT '', board_base_signature TEXT, source_draft_key TEXT,
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
    CREATE TABLE IF NOT EXISTS script_canvas_preparations (
      scene_id TEXT PRIMARY KEY REFERENCES script_scenes(id) ON DELETE CASCADE,
      signature TEXT NOT NULL,
      profile_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS visual_profile_candidates (
      profile_id TEXT NOT NULL REFERENCES visual_profiles(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS visual_profile_reference_assets (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES visual_profiles(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1), style_version TEXT,
      view TEXT NOT NULL CHECK (view IN ('face', 'front', 'three_quarter', 'side', 'back', 'wide', 'reverse', 'layout', 'detail')),
      purpose TEXT NOT NULL CHECK (purpose IN ('identity', 'costume', 'space', 'structure', 'detail')),
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'archived')),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      source_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(profile_id, revision, asset_id)
    );
    CREATE INDEX IF NOT EXISTS idx_visual_reference_profile ON visual_profile_reference_assets(profile_id, revision, status);
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
      type TEXT NOT NULL CHECK (type IN ('text', 'image', 'video', 'generation', 'project_script_ref', 'image_analysis', 'video_analysis')),
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
    CREATE TABLE IF NOT EXISTS job_video_recovery (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      result_url_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_generation_attempts (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      modality TEXT NOT NULL CHECK (modality IN ('image','video')),
      model_signature TEXT NOT NULL, provider_signature TEXT NOT NULL, started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resource_submissions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('generation', 'shot')),
      submission_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      resource_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, scope, submission_key),
      UNIQUE (scope, resource_id)
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

  const bindingForeignKeys = db.pragma('foreign_key_list(shot_visual_bindings)') as Array<{ from: string; on_delete: string }>
  if (bindingForeignKeys.find(key => key.from === 'profile_id')?.on_delete !== 'CASCADE') {
    // Older RESTRICT bindings can block the project cascade before its shots are removed.
    // This child table has no dependents, so rebuild it with foreign keys still enforced.
    const bindingColumns = db.pragma('table_info(shot_visual_bindings)') as Array<{ name: string }>
    const boardStyleColumn = bindingColumns.some(column => column.name === 'board_style_version') ? 'board_style_version' : 'NULL'
    const referenceAssetsColumn = bindingColumns.some(column => column.name === 'reference_assets') ? 'reference_assets' : "'[]'"
    const usageColumn = bindingColumns.some(column => column.name === 'usage') ? 'usage' : "'both'"
    const syncModeColumn = bindingColumns.some(column => column.name === 'sync_mode') ? 'sync_mode' : "'follow'"
    const referenceSelectionColumn = bindingColumns.some(column => column.name === 'reference_selection') ? 'reference_selection'
      : `CASE WHEN ${referenceAssetsColumn} <> '[]' THEN 'manual' ELSE 'auto' END`
    db.transaction(() => db.exec(`
      CREATE TABLE shot_visual_bindings_cascade (
        shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES visual_profiles(id) ON DELETE CASCADE,
        required INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, variant TEXT NOT NULL,
        definition TEXT NOT NULL, view_requirements TEXT NOT NULL,
        board_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        board_style_version TEXT,
        reference_assets TEXT NOT NULL DEFAULT '[]',
        usage TEXT NOT NULL DEFAULT 'both' CHECK (usage IN ('both', 'image', 'video', 'none')),
        sync_mode TEXT NOT NULL DEFAULT 'follow' CHECK (sync_mode IN ('follow', 'locked')),
        reference_selection TEXT NOT NULL DEFAULT 'auto' CHECK (reference_selection IN ('auto', 'manual')),
        PRIMARY KEY (shot_id, profile_id)
      );
      INSERT INTO shot_visual_bindings_cascade
        (shot_id, profile_id, required, revision, kind, name, variant, definition, view_requirements, board_asset_id, board_style_version, reference_assets, usage, sync_mode, reference_selection)
      SELECT shot_id, profile_id, required, revision, kind, name, variant, definition, view_requirements, board_asset_id, ${boardStyleColumn}, ${referenceAssetsColumn}, ${usageColumn}, ${syncModeColumn}, ${referenceSelectionColumn}
      FROM shot_visual_bindings;
      DROP TABLE shot_visual_bindings;
      ALTER TABLE shot_visual_bindings_cascade RENAME TO shot_visual_bindings;
    `))()
  }

  const scriptColumns = db.pragma('table_info(scripts)') as Array<{ name: string }>
  for (const table of ['visual_profiles', 'shot_visual_bindings']) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!columns.some(column => column.name === 'board_style_version')) db.exec(`ALTER TABLE ${table} ADD COLUMN board_style_version TEXT`)
  }
  if (!all<{ name: string }>('PRAGMA table_info(visual_profiles)').some(column => column.name === 'definition_status')) {
    db.exec("ALTER TABLE visual_profiles ADD COLUMN definition_status TEXT NOT NULL DEFAULT 'ready' CHECK (definition_status IN ('draft', 'ready'))")
  }
  const visualProfileColumns = all<{ name: string }>('PRAGMA table_info(visual_profiles)')
  if (!visualProfileColumns.some(column => column.name === 'base_profile_id')) db.exec('ALTER TABLE visual_profiles ADD COLUMN base_profile_id TEXT REFERENCES visual_profiles(id) ON DELETE SET NULL')
  if (!visualProfileColumns.some(column => column.name === 'state_delta')) db.exec("ALTER TABLE visual_profiles ADD COLUMN state_delta TEXT NOT NULL DEFAULT ''")
  if (!visualProfileColumns.some(column => column.name === 'board_base_signature')) db.exec('ALTER TABLE visual_profiles ADD COLUMN board_base_signature TEXT')
  if (!visualProfileColumns.some(column => column.name === 'source_draft_key')) db.exec('ALTER TABLE visual_profiles ADD COLUMN source_draft_key TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS visual_profiles_base ON visual_profiles(base_profile_id)')
  if (!all<{ name: string }>('PRAGMA table_info(shot_visual_bindings)').some(column => column.name === 'reference_assets')) {
    db.exec("ALTER TABLE shot_visual_bindings ADD COLUMN reference_assets TEXT NOT NULL DEFAULT '[]'")
  }
  if (!all<{ name: string }>('PRAGMA table_info(shot_visual_bindings)').some(column => column.name === 'usage')) {
    db.exec("ALTER TABLE shot_visual_bindings ADD COLUMN usage TEXT NOT NULL DEFAULT 'both' CHECK (usage IN ('both', 'image', 'video', 'none'))")
  }
  const visualBindingColumns = all<{ name: string }>('PRAGMA table_info(shot_visual_bindings)')
  if (!visualBindingColumns.some(column => column.name === 'sync_mode')) {
    db.exec("ALTER TABLE shot_visual_bindings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'follow' CHECK (sync_mode IN ('follow', 'locked'))")
  }
  if (!visualBindingColumns.some(column => column.name === 'reference_selection')) {
    db.transaction(() => {
      db.exec("ALTER TABLE shot_visual_bindings ADD COLUMN reference_selection TEXT NOT NULL DEFAULT 'auto' CHECK (reference_selection IN ('auto', 'manual'))")
      // Older records do not say whether individual images were hand picked.
      // Preserve those selections instead of silently recommending replacements.
      db.exec("UPDATE shot_visual_bindings SET reference_selection='manual' WHERE reference_assets <> '[]'")
    })()
  }
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

  if (!messageColumns.some(column => column.name === 'stage_context')) {
    db.exec('ALTER TABLE script_messages ADD COLUMN stage_context TEXT')
  }
  if (!messageColumns.some(column => column.name === 'activity')) {
    db.exec("ALTER TABLE script_messages ADD COLUMN activity TEXT NOT NULL DEFAULT '[]'")
  }
  if (!messageColumns.some(column => column.name === 'reply_metadata')) {
    db.exec("ALTER TABLE script_messages ADD COLUMN reply_metadata TEXT NOT NULL DEFAULT '{}'")
  }

  for (const field of ['request_payload', 'resume_key']) {
    if (!(db.prepare('PRAGMA table_info(script_director_tasks)').all() as Array<{ name: string }>).some(column => column.name === field)) db.exec(`ALTER TABLE script_director_tasks ADD COLUMN ${field} TEXT`)
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
  if (!shotColumns.some(column => column.name === 'storyboard_revision')) {
    db.exec('ALTER TABLE shots ADD COLUMN storyboard_revision INTEGER NOT NULL DEFAULT 0')
  }
  if (!shotColumns.some(column => column.name === 'source_scene_id')) {
    db.exec('ALTER TABLE shots ADD COLUMN source_scene_id TEXT REFERENCES script_scenes(id) ON DELETE SET NULL')
  }
  for (const field of ['start_state', 'end_state', 'cut_note', 'image_prompt', 'video_prompt']) {
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
          type TEXT NOT NULL CHECK (type IN ('text', 'image', 'video', 'generation', 'project_script_ref', 'image_analysis', 'video_analysis')),
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

  const currentCanvasSchema = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='canvas_nodes'")?.sql ?? ''
  if (!currentCanvasSchema.includes("'image_analysis'") || !currentCanvasSchema.includes("'video_analysis'")) {
    // Extend the CHECK while retaining later additions such as canvas_id and
    // every edge snapshot. Reusing the legacy fixed-column migration loses them.
    const indexes = all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='canvas_nodes' AND sql IS NOT NULL")
    const expandedSchema = currentCanvasSchema.replace(/CREATE TABLE\s+(?:"canvas_nodes"|canvas_nodes)/i, 'CREATE TABLE canvas_nodes_vision')
      .replace(/'project_script_ref'/, `'project_script_ref'${currentCanvasSchema.includes("'image_analysis'") ? '' : ", 'image_analysis'"}${currentCanvasSchema.includes("'video_analysis'") ? '' : ", 'video_analysis'"}`)
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(expandedSchema)
        db.exec('INSERT INTO canvas_nodes_vision SELECT * FROM canvas_nodes')
        db.exec('DROP TABLE canvas_nodes')
        db.exec('ALTER TABLE canvas_nodes_vision RENAME TO canvas_nodes')
        for (const index of indexes) db.exec(index.sql)
      })()
    } finally { db.pragma('foreign_keys = ON') }
  }

  const edgeColumns = db.pragma('table_info(canvas_edges)') as Array<{ name: string }>
  if (!edgeColumns.some(column => column.name === 'reference_asset_id')) {
    // Keep a deleted snapshot ID so it never falls back to a newer result.
    db.exec('ALTER TABLE canvas_edges ADD COLUMN reference_asset_id TEXT')
  }
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS project_canvases (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
      viewport TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_canvases ON project_canvases(project_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_canvas_default ON project_canvases(project_id) WHERE is_default=1;
    INSERT OR IGNORE INTO project_canvases (id, project_id, name, position, is_default, created_at, updated_at)
      SELECT id, id, '画布 1', 0, 1, created_at, updated_at FROM projects
      WHERE NOT EXISTS (SELECT 1 FROM project_canvases WHERE project_canvases.project_id=projects.id);`)
    for (const table of ['canvas_nodes', 'canvas_edges']) {
      const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
      if (!columns.some(column => column.name === 'canvas_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN canvas_id TEXT REFERENCES project_canvases(id) ON DELETE CASCADE`)
      // Null also remains compatible with older local importers writing the legacy schema.
      db.exec(`UPDATE ${table} SET canvas_id=(SELECT id FROM project_canvases WHERE project_id=${table}.project_id AND is_default=1) WHERE canvas_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_${table}_canvas ON ${table}(canvas_id, position);`)
    }
  }).immediate()
  db.exec(`CREATE TABLE IF NOT EXISTS canvas_production_ranges (
    canvas_id TEXT PRIMARY KEY REFERENCES project_canvases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    start_shot_id TEXT, end_shot_id TEXT
  );
  CREATE TABLE IF NOT EXISTS canvas_continuity_analyses (
    canvas_id TEXT PRIMARY KEY REFERENCES project_canvases(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL, signature TEXT NOT NULL, issues TEXT NOT NULL, updated_at TEXT NOT NULL
  );`)
  // New storyboard designs preserve the previous shots, media and canvas as
  // history. Legacy projects keep their existing active shots unchanged.
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS storyboard_designs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      canvas_id TEXT REFERENCES project_canvases(id) ON DELETE SET NULL,
      name TEXT NOT NULL, scene_ids TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_storyboard_designs_project ON storyboard_designs(project_id, created_at);`)
    for (const field of ['design_id', 'superseded_by']) {
      if (!shotColumns.some(column => column.name === field)) db.exec(`ALTER TABLE shots ADD COLUMN ${field} TEXT REFERENCES storyboard_designs(id) ON DELETE SET NULL`)
    }
    const profileColumns = db.pragma('table_info(visual_profiles)') as Array<{ name: string }>
    if (!profileColumns.some(column => column.name === 'design_id')) db.exec('ALTER TABLE visual_profiles ADD COLUMN design_id TEXT REFERENCES storyboard_designs(id) ON DELETE SET NULL')
    db.exec(`CREATE INDEX IF NOT EXISTS idx_shots_active_scene ON shots(project_id, source_scene_id) WHERE superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_shots_design ON shots(design_id);
      CREATE INDEX IF NOT EXISTS idx_visual_profiles_design ON visual_profiles(design_id);`)
  }).immediate()
  const clipColumns = db.pragma('table_info(timeline_clips)') as Array<{ name: string }>
  if (!clipColumns.some(column => column.name === 'source_audio_gain')) {
    db.exec('ALTER TABLE timeline_clips ADD COLUMN source_audio_gain REAL NOT NULL DEFAULT 1')
  }
  if (!clipColumns.some(column => column.name === 'source_audio_fade_ms')) {
    db.exec('ALTER TABLE timeline_clips ADD COLUMN source_audio_fade_ms INTEGER NOT NULL DEFAULT 0')
  }

  // Recycling keeps media, task history and foreign-key identities intact.
  for (const table of ['shots', 'assets']) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!columns.some(column => column.name === 'deleted_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`)
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
  if (!modelColumns.some(column => column.name === 'is_default')) {
    db.exec('ALTER TABLE models ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0')
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS models_default_modality ON models(modality) WHERE is_default=1')
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
  if (!one('SELECT 1 FROM studio_migrations WHERE id=?', 'seedance25-default-settings-v1')) {
    db.transaction(() => {
      for (const model of all<Model>("SELECT * FROM models WHERE remote_id='doubao-seedance-2-5-260628' AND modality='video' AND protocol='async_video'")) {
        const settings = upgradeLegacySeedance25Settings(model)
        if (settings !== null) run('UPDATE models SET settings=? WHERE id=?', settings, model.id)
      }
      run('INSERT INTO studio_migrations (id, applied_at) VALUES (?, ?)', 'seedance25-default-settings-v1', now())
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
        AND json_type(CASE WHEN json_valid(request) THEN request ELSE '{}' END, '$.tts')='object'`,
      '语音任务因服务重启中断，厂商可能已计费。请先核对调用记录，再在配音页手动生成新的候选。', timestamp)
    run(`UPDATE jobs SET status='failed', error=?, updated_at=?
      WHERE status='running' AND job_type='generation'
        AND (model_id IN (SELECT id FROM models WHERE modality='image')
          OR id IN (SELECT job_id FROM job_generation_attempts WHERE modality='image'))
        AND NOT EXISTS (SELECT 1 FROM job_image_recovery WHERE job_id=jobs.id)
        AND NOT EXISTS (SELECT 1 FROM job_video_recovery WHERE job_id=jobs.id)
        AND NOT (external_id IS NOT NULL AND external_id<>'' AND model_id IN (
          SELECT id FROM models WHERE json_extract(CASE WHEN json_valid(settings) THEN settings ELSE '{}' END, '$.async_image')=1
        ))`,
      '图片任务中断，未找到可恢复图片链接。厂商可能已计费，请先核对厂商记录，再手动创建新的生成任务。', timestamp)
    run(`UPDATE jobs SET status='failed', error=?, updated_at=?
      WHERE status='running' AND job_type='generation'
        AND (model_id IN (SELECT id FROM models WHERE modality='video')
          OR id IN (SELECT job_id FROM job_generation_attempts WHERE modality='video'))
        AND NOT EXISTS (SELECT 1 FROM job_image_recovery WHERE job_id=jobs.id)
        AND NOT EXISTS (SELECT 1 FROM job_video_recovery WHERE job_id=jobs.id)
        AND (external_id IS NULL OR TRIM(external_id) IN ('','undefined','null'))`,
      '视频任务因服务重启中断，未找到可确认的厂商任务编号或结果链接。厂商可能已计费，请先核对厂商记录；不会自动重新提交生成。', timestamp)
    run("UPDATE jobs SET status='queued', updated_at=? WHERE status='running'", timestamp)
  })()
}
