import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { all, db, now, one, run, required } from '../../infrastructure/database/db.js'
import { videoPromptDialect } from '../generation/seedance-prompt.js'
import { MAX_AUXILIARY_SKILLS, MAX_CREATIVE_SKILLS } from '@video-studio/shared/skills/skill-limits'
import type { SkillSyncItem, SkillSyncResult } from '@video-studio/shared/skills/skill-updates'
import { fixedSkillTask, skillTaskDefinitions, type SkillCatalogEntry, type SkillIntegrationScope, type SkillTaskContext, type SkillTaskKind, type VideoPromptDialect } from '@video-studio/shared/skills/skill-recommendation'

export const skillStages = ['script', 'visual_assets', 'image_prompt', 'storyboard', 'video_prompt'] as const
export type SkillStage = typeof skillStages[number]
export const skillIdsInput = z.array(z.string().min(1).max(100)).max(MAX_CREATIVE_SKILLS).refine(ids => new Set(ids).size === ids.length, '技能不可重复')
export const skillSelectionsInput = z.partialRecord(z.enum(skillStages), skillIdsInput)
export type SkillSelections = z.infer<typeof skillSelectionsInput>
export type SkillSelection = { primary_id: string | null; auxiliary_ids: string[] }
const preferredPrimary: Record<SkillStage, string> = { script: 'short-drama-write', visual_assets: 'short-drama-assets', image_prompt: 'short-drama-image-prompts', storyboard: 'short-drama-storyboard', video_prompt: 'short-drama-video-prompts' }
export const skillStageLabels: Record<SkillStage, string> = {
  script: '剧本创作', visual_assets: '视觉设定', image_prompt: '图片提示词', storyboard: '分镜规划', video_prompt: '视频提示词',
}
type Fetcher = typeof fetch
export type SkillFile = { path: string; content: string }
export type SkillBundle = {
  repo: string; path: string; name: string; description: string; license: string | null;
  revision: string; files: SkillFile[]; tool_requirements: string[]; suggested_stages: SkillStage[]; url: string;
}
export type InstalledSkill = Omit<SkillBundle, 'files'> & {
  id: string; enabled: boolean; stages: SkillStage[]; installed_at: string; updated_at: string;
}
type SkillRow = {
  id: string; repo: string; path: string; name: string; description: string; license: string | null;
  revision: string; files: string; tool_requirements: string; suggested_stages: string;
  enabled: number; stages: string; installed_at: string; updated_at: string;
}
type TreeFile = { path: string; type: string; size?: number }
type RepositorySnapshot = { repo: string; revision: string; license: string | null; tree: TreeFile[] }
type SourceFileCache = Map<string, Promise<string>>
const maxFileBytes = 150_000, maxBundleBytes = 1_000_000
const requestCache = new Map<string, { at: number; value: unknown }>()
const pendingRequests = new Map<string, Promise<unknown>>()
const installationVersions = new Map<string, number>()

export function initSkills(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS installed_skills (
    id TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
    license TEXT, revision TEXT NOT NULL, files TEXT NOT NULL, tool_requirements TEXT NOT NULL, suggested_stages TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, stages TEXT NOT NULL DEFAULT '[]', installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(repo, path)
  ); CREATE TABLE IF NOT EXISTS skill_repositories (repo TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS skill_stage_defaults (stage TEXT PRIMARY KEY, primary_id TEXT, auxiliary_ids TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS project_skill_defaults (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, primary_id TEXT, auxiliary_ids TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(project_id,stage));
  CREATE TABLE IF NOT EXISTS skill_task_defaults (task TEXT PRIMARY KEY, primary_id TEXT, auxiliary_ids TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS project_skill_task_defaults (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task TEXT NOT NULL, primary_id TEXT, auxiliary_ids TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(project_id,task));`)
  for (const stage of skillStages) ensureSkillDefault(stage)
}
function invalid(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
export function normalizeSkillRepo(value: string): string {
  const repo = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.endsWith('/..') || repo.endsWith('/.')) {
    invalid('请输入公开 GitHub 仓库，格式为 owner/repo 或 https://github.com/owner/repo')
  }
  return repo.toLowerCase()
}
function safePath(path: string): boolean {
  return path.length < 500 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..')
}
function bytes(text: string): number { return Buffer.byteLength(text, 'utf8') }
async function remoteText(url: string, fetcher: Fetcher, limit = 2_000_000): Promise<string> {
  let response: Response
  try { response = await fetcher(url, { signal: AbortSignal.timeout(25_000), headers: { 'User-Agent': 'ai-video-studio-skills', Accept: 'application/json' } }) }
  catch { invalid('技能来源连接超时或网络不可用，请重试', 502) }
  if (!response.ok) {
    if (response.status === 404) invalid('未找到公开仓库、技能文件或对应版本', 404)
    if (response.status === 403 || response.status === 429) invalid('技能来源请求额度暂时受限，请稍后重试', 503)
    invalid(`技能来源返回 HTTP ${response.status}，请重试`, 502)
  }
  const chunks: Buffer[] = [], reader = response.body?.getReader()
  if (!reader) invalid('技能来源返回空内容', 502)
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); invalid('技能来源内容过大，请选择更小的技能') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}
async function remoteJson<T>(url: string, fetcher: Fetcher): Promise<T> {
  const body = await remoteText(url, fetcher, 8_000_000)
  try { return JSON.parse(body) as T } catch { invalid('技能来源未返回有效数据', 502) }
}
async function cached<T>(key: string, factory: () => Promise<T>, refresh = false): Promise<T> {
  const item = requestCache.get(key)
  if (!refresh && item && Date.now() - item.at < 5 * 60_000) return item.value as T
  const pending = pendingRequests.get(key)
  if (pending) return pending as Promise<T>
  const request = factory().then(value => {
    if (requestCache.size > 100) requestCache.delete(requestCache.keys().next().value!)
    requestCache.set(key, { at: Date.now(), value })
    return value
  }).finally(() => pendingRequests.delete(key))
  pendingRequests.set(key, request)
  return request
}
export function parseSkillDocument(content: string): { name: string; description: string; license: string | null; body: string; tools: string[] } {
  const match = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) invalid('SKILL.md 缺少有效的 YAML 元数据')
  let meta: Record<string, unknown>
  try { meta = parseYaml(match[1]!, { maxAliasCount: 20 }) as Record<string, unknown> } catch { invalid('SKILL.md 的 YAML 元数据无法解析') }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.name !== 'string' || !meta.name.trim()
    || typeof meta.description !== 'string' || !meta.description.trim()) invalid('技能必须包含 name 和 description')
  if (meta.name.length > 160 || meta.description.length > 8000 || !match[2]?.trim()) invalid('技能名称、描述或正文不符合要求')
  const tools = meta['allowed-tools']
  return { name: meta.name.trim(), description: meta.description.trim(), license: typeof meta.license === 'string' ? meta.license : null,
    body: match[2].trim(), tools: Array.isArray(tools) ? tools.map(String) : typeof tools === 'string' ? tools.split(/[,\s]+/).filter(Boolean) : [] }
}
export function suggestedSkillStages(name: string): SkillStage[] {
  if (/video.*prompt|motion.*prompt/.test(name)) return ['video_prompt']
  if (/image.*prompt|character-design-sheet/.test(name)) return ['image_prompt']
  if (/storyboard/.test(name)) return ['storyboard']
  if (/short-drama-assets/.test(name)) return ['visual_assets']
  if (/short-drama-(write|develop)|sw-(dialogue|story-structure|character-conflict|scene-craft)/.test(name)) return ['script']
  return []
}
async function repositorySnapshot(repo: string, fetcher: Fetcher, refresh = false): Promise<RepositorySnapshot> {
  return cached(`repo:${repo}`, async () => {
    const metadata = await remoteJson<{ default_branch?: string; license?: { spdx_id?: string }; message?: string }>(`https://api.github.com/repos/${repo}`, fetcher)
    if (!metadata.default_branch) invalid('仓库没有可读取的默认分支', 502)
    const commit = await remoteJson<{ sha?: string }>(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`, fetcher)
    if (!commit.sha || !/^[a-f0-9]{40}$/.test(commit.sha)) invalid('无法确认仓库版本', 502)
    const result = await remoteJson<{ tree?: TreeFile[]; truncated?: boolean }>(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}?recursive=1`, fetcher)
    if (!Array.isArray(result.tree) || result.truncated || result.tree.length > 30_000) invalid('仓库文件过多，无法完整扫描，请使用独立的技能仓库')
    return { repo, revision: commit.sha, license: metadata.license?.spdx_id || null,
      tree: result.tree.filter(item => item.type === 'blob' && safePath(item.path) && !item.path.split('/').some(part => part.startsWith('.'))) }
  }, refresh)
}
async function sourceFile(snapshot: RepositorySnapshot, path: string, fetcher: Fetcher, files?: SourceFileCache): Promise<string> {
  if (!safePath(path) || !snapshot.tree.some(item => item.path === path)) invalid('技能文件路径不属于当前仓库')
  const url = `https://raw.githubusercontent.com/${snapshot.repo}/${snapshot.revision}/${path.split('/').map(encodeURIComponent).join('/')}`
  if (!files) return remoteText(url, fetcher, maxFileBytes)
  let request = files.get(url)
  if (!request) { request = remoteText(url, fetcher, maxFileBytes); files.set(url, request) }
  return request
}
export async function discoverRepository(input: string, fetcher: Fetcher = fetch): Promise<Array<{ repo: string; path: string; name: string; description: string; url: string; installs: number | null }>> {
  const repo = normalizeSkillRepo(input), snapshot = await repositorySnapshot(repo, fetcher)
  return discoverSnapshot(snapshot, fetcher)
}
async function discoverSnapshot(snapshot: RepositorySnapshot, fetcher: Fetcher, files?: SourceFileCache) {
  const { repo } = snapshot
  const paths = snapshot.tree.filter(item => /(^|\/)SKILL\.md$/.test(item.path))
  if (paths.length > 120) invalid('仓库包含过多技能，请通过技能目录搜索具体名称')
  const results = []
  for (let i = 0; i < paths.length; i += 6) {
    const batch = await Promise.all(paths.slice(i, i + 6).map(async item => {
      const content = await sourceFile(snapshot, item.path, fetcher, files)
      const meta = parseSkillDocument(content)
      return { repo, path: posix.dirname(item.path) === '.' ? '' : posix.dirname(item.path), name: meta.name,
        description: meta.description, url: `https://github.com/${repo}/blob/${snapshot.revision}/${item.path}`, installs: null }
    }))
    results.push(...batch)
  }
  return results
}
export async function searchSkillCatalog(query: string, offset: number, fetcher: Fetcher = fetch) {
  return cached(`search:${query}:${offset}`, async () => {
    const url = new URL('https://skills.sh/api/search')
    url.search = new URLSearchParams({ q: query, limit: '24', offset: String(offset) }).toString()
    const result = await remoteJson<{ skills?: Array<{ name: string; skillId: string; source: string; installs: number }>; count?: number }>(url.toString(), fetcher)
    if (!Array.isArray(result.skills)) invalid('技能目录返回格式发生变化，请使用 GitHub 仓库搜索', 502)
    const skills = result.skills.flatMap(item => {
      try {
        const repo = normalizeSkillRepo(item.source)
        if (!item.name || !item.skillId || !safePath(item.skillId)) return []
        return [{ repo, path: item.skillId, name: item.name, description: '', installs: Number(item.installs) || 0,
          url: `https://skills.sh/${repo}/${encodeURIComponent(item.skillId)}` }]
      } catch { return [] }
    })
    return { skills, total: typeof result.count === 'number' ? result.count : skills.length, offset }
  })
}
export async function loadSkillBundle(inputRepo: string, requestedPath: string, fetcher: Fetcher = fetch, refresh = false): Promise<SkillBundle> {
  const repo = normalizeSkillRepo(inputRepo)
  if (requestedPath && !safePath(requestedPath)) invalid('技能目录路径无效')
  const snapshot = await repositorySnapshot(repo, fetcher, refresh)
  return loadSnapshotBundle(snapshot, requestedPath, fetcher)
}
async function loadSnapshotBundle(snapshot: RepositorySnapshot, requestedPath: string, fetcher: Fetcher, sourceFiles?: SourceFileCache): Promise<SkillBundle> {
  const { repo } = snapshot
  return cached(`bundle:${repo}:${snapshot.revision}:${requestedPath}`, async () => {
    const documents = snapshot.tree.filter(item => /(^|\/)SKILL\.md$/.test(item.path))
    let candidates = documents.filter(item => item.path === (requestedPath ? `${requestedPath}/SKILL.md` : 'SKILL.md'))
    if (!candidates.length) candidates = documents.filter(item => posix.basename(posix.dirname(item.path)) === requestedPath)
    if (!candidates.length) {
      const scanned = await discoverSnapshot(snapshot, fetcher, sourceFiles)
      candidates = scanned.filter(item => item.name === requestedPath).map(item => ({ path: item.path ? `${item.path}/SKILL.md` : 'SKILL.md', type: 'blob' }))
    }
    if (candidates.length !== 1) invalid(candidates.length ? '仓库包含同名技能，请通过仓库搜索选择准确目录' : '仓库中未找到对应的 SKILL.md', 404)
    const documentPath = candidates[0]!.path, path = posix.dirname(documentPath) === '.' ? '' : posix.dirname(documentPath)
    const content = await sourceFile(snapshot, documentPath, fetcher, sourceFiles), meta = parseSkillDocument(content)
    const selected = new Set([documentPath])
    const prefix = path ? `${path}/` : ''
    // Keep the skill's text resources, plus explicitly linked Markdown shared outside its directory.
    for (const item of snapshot.tree) if (item.path.startsWith(prefix) && /\.(md|txt|json|ya?ml)$/i.test(item.path)
      && !/(^|\/)(node_modules|scripts|tests|\.git)\//.test(item.path)
      && !/(^|\/)SKILL\.md$/.test(item.path.slice(prefix.length)) && (item.size || 0) <= maxFileBytes) selected.add(item.path)
    for (const match of content.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
      const linked = posix.normalize(posix.join(path, match[1]!))
      if (safePath(linked) && snapshot.tree.some(item => item.path === linked)) selected.add(linked)
    }
    if (selected.size > 48) invalid('技能附带的参考文件过多，当前版本支持最多 48 份文本文件')
    const files: SkillFile[] = [{ path: documentPath, content }]
    const paths = [...selected].filter(item => item !== documentPath)
    let total = bytes(content)
    for (let i = 0; i < paths.length; i += 6) {
      const batch = await Promise.all(paths.slice(i, i + 6).map(async filePath => ({ path: filePath, content: await sourceFile(snapshot, filePath, fetcher, sourceFiles) })))
      total += batch.reduce((size, file) => size + bytes(file.content), 0)
      if (total > maxBundleBytes) invalid('技能文本资源总量超过 1 MB，无法安装')
      files.push(...batch)
    }
    const scripts = snapshot.tree.filter(item => item.path.startsWith(prefix) && /\.(py|sh|js|ts)$/i.test(item.path)).map(item => item.path)
    const requirements = [...new Set([...meta.tools, ...scripts.map(item => `脚本：${item}`),
      ...(/\bpython3?\s+\S+\.py/.test(content) ? ['Python 脚本'] : []), ...(/\b(?:belt|infsh)\s/.test(content) ? ['外部生成 CLI'] : [])])]
    return { repo, path, name: meta.name, description: meta.description, license: meta.license || snapshot.license,
      revision: snapshot.revision, files, tool_requirements: requirements, suggested_stages: suggestedSkillStages(meta.name),
      url: `https://github.com/${repo}/blob/${snapshot.revision}/${documentPath}` }
  })
}
function publicSkill(row: SkillRow): InstalledSkill {
  const { files: _files, ...rest } = row
  return { ...rest, enabled: !!row.enabled, stages: JSON.parse(row.stages), suggested_stages: JSON.parse(row.suggested_stages),
    tool_requirements: JSON.parse(row.tool_requirements), url: `https://github.com/${row.repo}/blob/${row.revision}/${row.path ? `${row.path}/` : ''}SKILL.md` }
}
export function installedSkills(): InstalledSkill[] { return all<SkillRow>('SELECT * FROM installed_skills ORDER BY installed_at DESC, id').map(publicSkill) }
function skillRow(id: string): SkillRow {
  const row = one<SkillRow>('SELECT * FROM installed_skills WHERE id=?', id)
  if (!row) invalid('技能尚未安装', 404)
  return row
}
export function installedSkillDetail(id: string) { const row = skillRow(id); return { ...publicSkill(row), files: JSON.parse(row.files) as SkillFile[] } }
export function installSkillBundle(bundle: SkillBundle, updatingId?: string): InstalledSkill {
  const existing = one<SkillRow>('SELECT * FROM installed_skills WHERE repo=? AND path=?', bundle.repo, bundle.path)
  if (updatingId && (!existing || existing.id !== updatingId)) invalid('技能来源发生变化，请重新搜索安装')
  if (existing && !updatingId) return publicSkill(existing)
  const id = existing?.id || createHash('sha256').update(`${bundle.repo}:${bundle.path}`).digest('hex').slice(0, 32), timestamp = now()
  run(`INSERT INTO installed_skills (id, repo, path, name, description, license, revision, files, tool_requirements, suggested_stages, enabled, stages, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, license=excluded.license, revision=excluded.revision,
      files=excluded.files, tool_requirements=excluded.tool_requirements, suggested_stages=excluded.suggested_stages, updated_at=excluded.updated_at`,
    id, bundle.repo, bundle.path, bundle.name, bundle.description, bundle.license, bundle.revision, JSON.stringify(bundle.files),
    JSON.stringify(bundle.tool_requirements), JSON.stringify(bundle.suggested_stages), 0, '[]', timestamp, timestamp)
  return publicSkill(skillRow(id))
}
export function configureSkill(id: string, enabled: boolean, stages: SkillStage[]): InstalledSkill {
  skillRow(id)
  if (enabled && !stages.length) invalid('请至少选择一个适用创作环节')
  const unique = [...new Set(stages)]
  run('UPDATE installed_skills SET enabled=?, stages=?, updated_at=? WHERE id=?', Number(enabled), JSON.stringify(unique), now(), id)
  for (const stage of skillStages) ensureSkillDefault(stage)
  return publicSkill(skillRow(id))
}
export function removeInstalledSkill(id: string): void {
  skillRow(id)
  run('DELETE FROM installed_skills WHERE id=?', id)
  installationVersions.set(id, (installationVersions.get(id) || 0) + 1)
  for (const stage of skillStages) ensureSkillDefault(stage)
}
export async function skillUpdateStatus(id: string, fetcher: Fetcher = fetch) {
  const row = skillRow(id), snapshot = await repositorySnapshot(row.repo, fetcher, true)
  return { id, available: snapshot.revision !== row.revision, revision: snapshot.revision, current_revision: row.revision }
}
async function boundedMap<T, R>(items: T[], concurrency: number, action: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await action(items[index]!)
    }
  }))
  return results
}
/** Refresh each source once, then atomically replace each complete installed bundle. */
export async function syncInstalledSkills(fetcher: Fetcher = fetch): Promise<SkillSyncResult> {
  const installed = installedSkills().map(skill => ({ skill, version: installationVersions.get(skill.id) || 0 }))
  const repos = [...new Set(installed.map(({ skill }) => skill.repo))]
  const snapshots = new Map<string, RepositorySnapshot | Error>()
  await boundedMap(repos, 3, async repo => {
    try { snapshots.set(repo, await repositorySnapshot(repo, fetcher, true)) }
    catch (issue) { snapshots.set(repo, issue instanceof Error ? issue : new Error('技能来源检查失败，请重试')) }
  })
  const files: SourceFileCache = new Map()
  const results = await boundedMap(installed, 3, async ({ skill, version }): Promise<SkillSyncItem> => {
    try {
      const snapshot = snapshots.get(skill.repo)!
      if (snapshot instanceof Error) throw snapshot
      const current = () => {
        const row = skillRow(skill.id)
        if ((installationVersions.get(skill.id) || 0) !== version || row.installed_at !== skill.installed_at
          || row.repo !== skill.repo || row.path !== skill.path) invalid('技能已卸载或重新安装，请刷新后重试', 409)
        if (row.revision !== skill.revision && row.revision !== snapshot.revision) invalid('技能版本在同步期间发生变化，请重试', 409)
        return row
      }
      if (current().revision === snapshot.revision) return { id: skill.id, name: skill.name, status: 'unchanged', revision: snapshot.revision }
      const bundle = await loadSnapshotBundle(snapshot, skill.path, fetcher, files)
      // No await between this guard and the write: uninstall/configuration changes
      // made during downloads cannot recreate a deleted skill or reset its settings.
      if (current().revision === snapshot.revision) return { id: skill.id, name: skill.name, status: 'unchanged', revision: snapshot.revision }
      const updated = installSkillBundle(bundle, skill.id)
      return { id: skill.id, name: updated.name, status: 'updated', revision: updated.revision }
    } catch (issue) {
      return { id: skill.id, name: skill.name, status: 'failed', error: issue instanceof Error ? issue.message : '技能更新失败，请重试' }
    }
  })
  return { total: results.length, updated: results.filter(item => item.status === 'updated').length,
    unchanged: results.filter(item => item.status === 'unchanged').length, failed: results.filter(item => item.status === 'failed').length, results }
}
function eligibleSkills(stage: SkillStage) { return installedSkills().filter(skill => skill.enabled && skill.stages.includes(stage)) }
function skillIntegrationScope(skill: Pick<InstalledSkill, 'tool_requirements'>): SkillIntegrationScope {
  return { mode: 'rules_only', tool_requirements: [...skill.tool_requirements],
    note: skill.tool_requirements.length ? '当前仅使用创作规则与文本参考资料，技能要求的外部工具、脚本及其产物未接入。' : '当前使用创作规则与文本参考资料。' }
}
function skillCatalogEntry(skill: InstalledSkill): SkillCatalogEntry {
  return { id: skill.id, name: skill.name, description: skill.description, revision: skill.revision, integration: skillIntegrationScope(skill) }
}
function ensureSkillDefault(stage: SkillStage) {
  const eligible = eligibleSkills(stage), current = one<{ primary_id: string | null; auxiliary_ids: string }>('SELECT * FROM skill_stage_defaults WHERE stage=?', stage)
  // Existing bindings stay visible when their skills become unavailable. Only
  // an absent row may acquire its first primary; never silently replace one.
  if (current) return
  const primary = eligible.find(skill => skill.name === preferredPrimary[stage]) || eligible.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
  if (!primary) { if (current) run('DELETE FROM skill_stage_defaults WHERE stage=?', stage); return }
  run('INSERT INTO skill_stage_defaults (stage,primary_id,auxiliary_ids) VALUES (?,?,?) ON CONFLICT(stage) DO UPDATE SET primary_id=excluded.primary_id, auxiliary_ids=excluded.auxiliary_ids', stage, primary?.id || null, '[]')
}
export function skillPolicy(projectId?: string) {
  if (projectId) required('projects', projectId)
  return skillStages.map(stage => {
    const eligible = eligibleSkills(stage), global = one<{ primary_id: string | null; auxiliary_ids: string }>('SELECT * FROM skill_stage_defaults WHERE stage=?', stage)
    const local = projectId ? one<{ primary_id: string | null; auxiliary_ids: string }>('SELECT * FROM project_skill_defaults WHERE project_id=? AND stage=?', projectId, stage) : null
    const validLocal = local && (local.primary_id === null || eligible.some(skill => skill.id === local.primary_id))
    const source = validLocal ? local : global
    const primary = source?.primary_id && eligible.some(skill => skill.id === source.primary_id) ? source.primary_id : null
    const auxiliary = primary ? (JSON.parse(source?.auxiliary_ids || '[]') as string[]).filter(id => id !== primary && eligible.some(skill => skill.id === id)).slice(0, MAX_AUXILIARY_SKILLS) : []
    return { stage, label: skillStageLabels[stage], primary_id: primary, auxiliary_ids: auxiliary,
      source: validLocal ? 'project' as const : 'global' as const,
      warning: local && !validLocal ? '项目主技能已停用或卸载，当前沿用全局默认，请重新选择。' : '',
      skills: eligible.map(skillCatalogEntry) }
  })
}
export function setSkillDefault(stage: SkillStage, selection: SkillSelection, projectId?: string) {
  const ids = selection.primary_id ? [selection.primary_id, ...selection.auxiliary_ids] : []
  if (!selection.primary_id && selection.auxiliary_ids.length) invalid('基础规则模式不能单独配置辅助技能')
  const eligible = eligibleSkills(stage)
  skillIdsInput.parse(ids)
  if (ids.some(id => !eligible.some(skill => skill.id === id))) invalid('所选技能未启用或不适用于此创作环节')
  const task = stage === 'script' ? 'script_write' : stage
  db.transaction(() => {
    if (projectId) {
      required('projects', projectId)
      run('INSERT INTO project_skill_defaults VALUES (?,?,?,?) ON CONFLICT(project_id,stage) DO UPDATE SET primary_id=excluded.primary_id, auxiliary_ids=excluded.auxiliary_ids', projectId, stage, selection.primary_id, JSON.stringify(selection.auxiliary_ids))
      run('INSERT INTO project_skill_task_defaults VALUES (?,?,?,?) ON CONFLICT(project_id,task) DO UPDATE SET primary_id=excluded.primary_id, auxiliary_ids=excluded.auxiliary_ids', projectId, task, selection.primary_id, JSON.stringify(selection.auxiliary_ids))
    } else {
      run('INSERT INTO skill_stage_defaults VALUES (?,?,?) ON CONFLICT(stage) DO UPDATE SET primary_id=excluded.primary_id, auxiliary_ids=excluded.auxiliary_ids', stage, selection.primary_id, JSON.stringify(selection.auxiliary_ids))
      run('INSERT INTO skill_task_defaults VALUES (?,?,?) ON CONFLICT(task) DO UPDATE SET primary_id=excluded.primary_id, auxiliary_ids=excluded.auxiliary_ids', task, selection.primary_id, JSON.stringify(selection.auxiliary_ids))
    }
  })()
  return skillPolicy(projectId)
}
export function resetProjectSkillDefault(projectId: string, stage: SkillStage) {
  required('projects', projectId)
  db.transaction(() => {
    run('DELETE FROM project_skill_defaults WHERE project_id=? AND stage=?', projectId, stage)
    run('DELETE FROM project_skill_task_defaults WHERE project_id=? AND task=?', projectId, stage === 'script' ? 'script_write' : stage)
  })()
  return skillPolicy(projectId)
}
const stageDefaultTasks: Partial<Record<SkillTaskKind, SkillStage>> = {
  script_write: 'script', visual_assets: 'visual_assets', image_prompt: 'image_prompt', storyboard: 'storyboard', video_prompt: 'video_prompt',
}
export type SkillTaskPolicy = {
  task: SkillTaskKind; stage: SkillStage; label: string; primary_id: string | null; auxiliary_ids: string[];
  source: 'builtin' | 'global' | 'project'; warning: string;
  skills: SkillCatalogEntry[];
}
type SavedSkillSelection = { primary_id: string | null; auxiliary_ids: string }
export function skillTaskPolicies(projectId?: string): SkillTaskPolicy[] {
  if (projectId) required('projects', projectId)
  return skillTaskDefinitions.map(task => {
    const eligible = eligibleSkills(task.stage)
    const local = projectId ? one<SavedSkillSelection>('SELECT primary_id,auxiliary_ids FROM project_skill_task_defaults WHERE project_id=? AND task=?', projectId, task.kind) : null
    const global = one<SavedSkillSelection>('SELECT primary_id,auxiliary_ids FROM skill_task_defaults WHERE task=?', task.kind)
    const localStage = stageDefaultTasks[task.kind] && projectId ? one<SavedSkillSelection>('SELECT primary_id,auxiliary_ids FROM project_skill_defaults WHERE project_id=? AND stage=?', projectId, task.stage) : null
    const globalStage = stageDefaultTasks[task.kind] ? one<SavedSkillSelection>('SELECT primary_id,auxiliary_ids FROM skill_stage_defaults WHERE stage=?', task.stage) : null
    const selected = local || localStage || global || globalStage
    let primary: string | null, auxiliary: string[], source: SkillTaskPolicy['source'], warning = ''
    if (selected) {
      primary = selected.primary_id; auxiliary = JSON.parse(selected.auxiliary_ids) as string[]
      source = local || localStage ? 'project' : 'global'
      const ids = primary ? [primary, ...auxiliary] : auxiliary
      if (ids.some(id => !eligible.some(skill => skill.id === id))) warning = '绑定的主技能或辅助技能已停用、卸载或不适用于此环节，请重新选择。'
    } else {
      primary = eligible.find(skill => skill.name === task.primary_name)?.id || null
      auxiliary = []; source = 'builtin'
      if (!primary && eligible.length) warning = `尚未启用推荐技能 ${task.primary_name}，本任务将使用基础创作规则；可在默认技能中配置。`
    }
    return { task: task.kind, stage: task.stage, label: task.label, primary_id: primary, auxiliary_ids: auxiliary,
      source, warning, skills: eligible.map(skillCatalogEntry) }
  })
}
export function setSkillTaskDefault(task: SkillTaskKind, selection: SkillSelection, projectId?: string) {
  const definition = skillTaskDefinitions.find(item => item.kind === task)
  if (!definition) invalid('未知的创作任务')
  if (projectId) required('projects', projectId)
  const ids = selection.primary_id ? [selection.primary_id, ...selection.auxiliary_ids] : []
  if (!selection.primary_id && selection.auxiliary_ids.length) invalid('基础规则模式不能单独配置辅助技能')
  skillIdsInput.parse(ids)
  const eligible = eligibleSkills(definition.stage)
  if (ids.some(id => !eligible.some(skill => skill.id === id))) invalid('所选技能未启用或不适用于当前任务')
  db.transaction(() => {
    if (stageDefaultTasks[task]) setSkillDefault(definition.stage, selection, projectId)
    if (projectId) run('INSERT INTO project_skill_task_defaults VALUES (?,?,?,?) ON CONFLICT(project_id,task) DO UPDATE SET primary_id=excluded.primary_id,auxiliary_ids=excluded.auxiliary_ids',
      projectId, task, selection.primary_id, JSON.stringify(selection.auxiliary_ids))
    else run('INSERT INTO skill_task_defaults VALUES (?,?,?) ON CONFLICT(task) DO UPDATE SET primary_id=excluded.primary_id,auxiliary_ids=excluded.auxiliary_ids',
      task, selection.primary_id, JSON.stringify(selection.auxiliary_ids))
  })()
  return skillTaskPolicies(projectId)
}
export function resetProjectSkillTaskDefault(projectId: string, task: SkillTaskKind) {
  required('projects', projectId)
  const definition = skillTaskDefinitions.find(item => item.kind === task)
  if (!definition) invalid('未知的创作任务')
  db.transaction(() => {
    run('DELETE FROM project_skill_task_defaults WHERE project_id=? AND task=?', projectId, task)
    if (stageDefaultTasks[task]) resetProjectSkillDefault(projectId, definition.stage)
  })()
  return skillTaskPolicies(projectId)
}
export function resetSkillTaskDefault(task: SkillTaskKind) {
  const definition = skillTaskDefinitions.find(item => item.kind === task)
  if (!definition) invalid('未知的创作任务')
  db.transaction(() => {
    run('DELETE FROM skill_task_defaults WHERE task=?', task)
    if (stageDefaultTasks[task]) {
      const primary = eligibleSkills(definition.stage).find(skill => skill.name === definition.primary_name)
      run('INSERT INTO skill_stage_defaults VALUES (?,?,?) ON CONFLICT(stage) DO UPDATE SET primary_id=excluded.primary_id,auxiliary_ids=excluded.auxiliary_ids', definition.stage, primary?.id || null, '[]')
    }
  })()
  return skillTaskPolicies()
}
export function fixedSkillContext(stage: SkillStage, task: string, projectId?: string, taskContext?: SkillTaskContext) {
  if (taskContext?.task_kind && !skillTaskDefinitions.some(item => item.kind === taskContext.task_kind && item.stage === stage)) invalid('技能任务与创作环节不匹配')
  const kind = fixedSkillTask(stage, taskContext)
  if (!kind) return undefined
  const policy = skillTaskPolicies(projectId).find(item => item.task === kind)!
  const ids = policy.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : []
  if (policy.warning && ids.length) invalid(policy.warning)
  const context = skillContext(stage, task, ids, projectId, taskContext)
  return { ...context, assignment: { ids, source: 'fixed' as const, task: kind,
    reason: `按${policy.label}使用${policy.source === 'project' ? '项目' : policy.source === 'global' ? '全局' : '推荐'}绑定。${policy.warning}` } }
}
export function resolveSkillSelections(projectId?: string, overrides: SkillSelections = {}): SkillSelections {
  return Object.fromEntries(skillPolicy(projectId).map(policy => [policy.stage, overrides[policy.stage] ?? (policy.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : [])]))
}
export type SkillReferenceDescriptor = {
  id: string; skill_id: string; skill_name: string; revision: string; path: string; title: string; summary: string; characters: number; signature: string
}
const referenceId = (skillId: string, path: string) => `${skillId}:${path}`
const referenceDocument = (path: string) => /\.(md|txt|json|ya?ml)$/i.test(path)
/** An explicit index of installed optional documents; metadata never decides relevance. */
export function optionalSkillReferenceCatalog(stage: SkillStage, selectedIds: string[], assignmentTask?: SkillTaskContext): SkillReferenceDescriptor[] {
  const ids = skillIdsInput.parse(selectedIds), eligible = installedSkills().filter(skill => skill.enabled && skill.stages.includes(stage))
  if (ids.some(id => !eligible.some(skill => skill.id === id))) invalid('所选技能未启用或不适用于此创作环节，请重新选择')
  return ids.flatMap(id => {
    const skill = eligible.find(skill => skill.id === id)!, detail = installedSkillDetail(id)
    return detail.files.filter(file => typeof file.path === 'string' && safePath(file.path) && typeof file.content === 'string'
      && !/(^|\/)SKILL\.md$/.test(file.path) && referenceDocument(file.path)
      && compatibleSkillReference(file.path, skill.name, assignmentTask)
      && !requiredSkillReference(file.path, stage, skill.name, assignmentTask)).map(file => ({
      id: referenceId(id, file.path), skill_id: id, skill_name: skill.name, revision: skill.revision, path: file.path,
      title: file.content.split('\n').find(line => /^#{1,6}\s+/.test(line))?.replace(/^#{1,6}\s+/, '').slice(0, 160) || posix.basename(file.path),
      summary: file.content.slice(0, 240), characters: file.content.length,
      signature: createHash('sha256').update(file.content).digest('hex'),
    }))
  })
}
/** Read a catalogued installed file by exact identity, never an arbitrary path. */
export function readOptionalSkillReference(stage: SkillStage, selectedIds: string[], descriptor: SkillReferenceDescriptor,
  assignmentTask?: SkillTaskContext): SkillFile {
  const current = optionalSkillReferenceCatalog(stage, selectedIds, assignmentTask).find(file => file.id === descriptor.id)
  if (!current || current.signature !== descriptor.signature || current.revision !== descriptor.revision) invalid('技能参考资料已更新或不属于本次锁定技能，请重新加载', 409)
  return installedSkillDetail(current.skill_id).files.find(file => file.path === current.path)!
}
export function skillContext(stage: SkillStage, task: string, selectedIds?: string[], projectId?: string, assignmentTask?: SkillTaskContext,
  selectedReferenceIds: string[] = []): { text: string; skills: Array<{ id: string; name: string; revision: string; files: string[]; role: 'primary' | 'auxiliary' }>; files: string[] } {
  const eligible = installedSkills().filter(skill => skill.enabled && skill.stages.includes(stage))
  // Synchronous loading never infers intent. Execution paths resolve automatic
  // choices through the model before calling this loader with explicit IDs.
  const ids = skillIdsInput.parse(selectedIds ?? resolveSkillSelections(projectId)[stage] ?? [])
  if (ids.some(id => !eligible.some(skill => skill.id === id))) {
    invalid('所选技能未启用或不适用于此创作环节，请重新选择')
  }
  const active = ids.map(id => eligible.find(skill => skill.id === id)!)
  const optional = optionalSkillReferenceCatalog(stage, ids, assignmentTask)
  if (new Set(selectedReferenceIds).size !== selectedReferenceIds.length || selectedReferenceIds.some(id => !optional.some(file => file.id === id))) invalid('所选参考资料不属于本次技能的可用目录')
  const sections: string[] = [], loadedFiles: string[] = []
  const skills: Array<{ id: string; name: string; revision: string; files: string[]; role: 'primary' | 'auxiliary' }> = []
  for (const [index, skill] of active.entries()) {
    const detail = installedSkillDetail(skill.id), main = detail.files.find(file => /(^|\/)SKILL\.md$/.test(file.path))!
    const body = parseSkillDocument(main.content).body
    const selected = detail.files.filter(file => file !== main && safePath(file.path) && referenceDocument(file.path)
      && compatibleSkillReference(file.path, skill.name, assignmentTask)
      && (requiredSkillReference(file.path, stage, skill.name, assignmentTask) || selectedReferenceIds.includes(referenceId(skill.id, file.path))))
    const scope = skillIntegrationScope(skill)
    const text = [scope.tool_requirements.length ? `【接入范围 rules_only】${scope.note}仅采纳方法，不宣称已执行工具或得到其产物。\n所需但未接入的工具：${scope.tool_requirements.join('、')}` : '',
      body, ...selected.map(file => `参考资料 ${file.path}：\n${file.content}`)].filter(Boolean).join('\n\n')
    if (text.length > 100_000) invalid(`技能 ${skill.name} 的规则资料过长，请调整技能后重试`)
    const role = index === 0 ? 'primary' : 'auxiliary'
    sections.push(`【${role === 'primary' ? '主技能' : '辅助技能'} ${skill.name}；版本 ${skill.revision.slice(0, 8)}】\n${text}`)
    loadedFiles.push(main.path, ...selected.map(file => file.path))
    skills.push({ id: skill.id, name: skill.name, revision: skill.revision, files: [main.path, ...selected.map(file => file.path)], role })
  }
  const text = sections.length ? `\n\n【已启用的${skillStageLabels[stage]}技能规则】\n` +
    '以下外部技能仅用于专业创作规则。项目事实、创作者明确要求和本次输出格式优先。主技能控制创作方法，辅助技能仅补充细节，冲突时沿用主技能，不覆盖主流程。文件式工作流映射到本次提供的数据，不要求创建文件、执行脚本、安装工具或再次确认；不宣称已看过未提供的图片。\n' + sections.join('\n\n') +
    '\n【应用契约】沿用本次提供的模型能力、比例、时长、参考图顺序和已确认设定。技能中的 Markdown 模板不能替换本次要求的 JSON 格式；不得调用外部服务或提出工具安装操作。\n' : ''
  if (text.length > 100_000) invalid('本次技能规则与参考资料合计超过 100000 字符，请减少辅助技能或参考资料后重试')
  return { text, skills, files: loadedFiles }
}
// Mandatory dependencies are part of the integration contract. Optional files
// remain in the installed bundle for explicit model/tool retrieval; free-form
// task wording must not silently determine which professional rules exist.
const commonSkillReferences = new Set(['stage-contract.md', 'common-recipe.md', 'target-model-profile.md',
  'review-and-fixtures.md', 'continuity-lock.md', 'continuity-delta.md', 'performance-action-timing.md'])
const skillStageReferences: Record<string, Partial<Record<SkillStage, string[]>>> = {
  'short-drama-write': { script: ['dialogue-craft.md', 'screenplay.md', 'screenplay-format.md', 'script-craft.md',
    'scene-handoff-capsule.md', 'scene-sound-dramaturgy.md', 'production-format-dialect.md', 'substitutable-realization.md'] },
  'sw-dialogue': { script: ['reference.md'] },
  'short-drama-develop': { script: ['creative-brief.md', 'story-engine.md', 'story-craft.md', 'adaptation-craft.md',
    'episode-design.md', 'mechanism-loop.md', 'multi-episode-intake.md', 'reveal-reversal-payoff.md', 'serial-character-and-memory.md'] },
  'short-drama-novel-analyze': { script: ['adaptation-triage.md', 'adaptation-value.md', 'aggregation-and-entities.md', 'chapter-extraction.md'] },
  'short-drama-storyboard': { storyboard: ['production-shot-grammar.md', 'scene-visual-plan.md', 'shot-craft.md',
    'keyframe-craft.md', 'shot-revision-identity.md'] },
  'short-drama-video-prompts': { video_prompt: ['motion-recipe.md', 'generability.md', 'production-prompt-grammar.md',
    'camera-audio-continuity.md', 'delivery-profile.md'] },
  'short-drama-review': {
    script: ['anti-template-repair.md', 'rubric-story-script.md', 'rubric-source-analysis.md'],
    visual_assets: ['rubric-assets-prompts.md'], image_prompt: ['rubric-assets-prompts.md'],
    storyboard: ['rubric-visual-motion.md'], video_prompt: ['rubric-visual-motion.md'],
  },
}
const subjectSkillReferences = {
  character: ['character-and-look.md', 'look-and-state-variant.md', 'look-and-revision.md', 'production-sheet-recipes.md'],
  location: ['location-plate.md', 'location-and-view.md', 'geography.md'],
  prop: ['prop-plate.md', 'prop-and-state.md'],
} as const
// Explicit identities of bundled dialect documents; ordinary reference documents remain available.
const skillReferenceDialects: Record<string, VideoPromptDialect> = {
  'seedance-2.0.md': 'seedance-2.0', 'seedance-2.5.md': 'seedance-2.5',
  'minimax-h3.md': 'minimax-h3', 'wan-3.0.md': 'wan-3.0',
  'h3-prompt.md': 'minimax-h3',
}
function skillReferenceDialect(path: string, skillName: string): VideoPromptDialect | undefined {
  const name = posix.basename(path).toLowerCase()
  // The unversioned Shuohao document explicitly targets 2.0; other skills may use this name differently.
  return name === 'seedance-prompt.md' && skillName === 'novel-storyboard' ? 'seedance-2.0' : skillReferenceDialects[name]
}
function configuredTaskDialect(context: SkillTaskContext = {}): VideoPromptDialect | undefined {
  return context.target_dialect || videoPromptDialect(context.target_model || '')
}
function compatibleSkillReference(path: string, skillName: string, context?: SkillTaskContext): boolean {
  const target = configuredTaskDialect(context), reference = skillReferenceDialect(path, skillName)
  return !target || !reference || target === reference
}
function requiredSkillReference(path: string, stage: SkillStage, skillName: string, context: SkillTaskContext = {}): boolean {
  const name = posix.basename(path).toLowerCase()
  if (commonSkillReferences.has(name) || skillStageReferences[skillName]?.[stage]?.includes(name)) return true
  if (skillName === 'short-drama-review' && ['review-method.md', 'production-quality-gates.md', 'project-calibration.md', 'generated-media.md'].includes(name)) return true
  if (stage === 'video_prompt' && ['motion-recipe.md', 'generability.md', 'production-prompt-grammar.md',
    'rubric-visual-motion.md', 'production-quality-gates.md', 'qa-rubric.md', 'provider-capabilities.md'].includes(name)) return true
  if (stage === 'image_prompt' || stage === 'visual_assets') {
    const subject = context.profile_kind || context.focus
    const applicable = subject ? subjectSkillReferences[subject] : Object.values(subjectSkillReferences).flat()
    if ((applicable as readonly string[]).includes(name)) return true
  }
  // These strings describe a configured target model, never arbitrary task prose.
  const target = configuredTaskDialect(context)
  if (stage === 'video_prompt' && target) {
    return skillReferenceDialect(path, skillName) === target
  }
  return false
}
export function withSkillRules(stage: SkillStage, prompt: string, onContext?: (context: ReturnType<typeof skillContext>) => void, options: { projectId?: string; selections?: SkillSelections; task?: SkillTaskContext } = {}): string {
  const explicit = options.selections?.[stage]
  const context = explicit === undefined ? fixedSkillContext(stage, skillTaskPrompt(prompt), options.projectId, options.task)
    || skillContext(stage, skillTaskPrompt(prompt), explicit, options.projectId, options.task)
    : skillContext(stage, skillTaskPrompt(prompt), explicit, options.projectId, options.task)
  onContext?.(context)
  return applySkillRules(prompt, context)
}
// Prompt previews include a generated rules prefix. Reapply the current selection once,
// retaining edits to the actual task when a creator switches skills after previewing.
export function applySkillRules(prompt: string, context: ReturnType<typeof skillContext>): string {
  const task = skillTaskPrompt(prompt)
  return context.text ? context.text + '\n【本次任务、项目事实与输出格式】\n' + task : task
}
function skillTaskPrompt(prompt: string) {
  // A creator may prepend their own instruction to an editable preview. Remove
  // the old managed rules wherever they appear, retaining those instructions.
  return prompt.replace(/(?:^\s*)?【已启用的(?:剧本创作|视觉设定|图片提示词|分镜规划|视频提示词)技能规则】[\s\S]*?\r?\n【本次任务、项目事实与输出格式】\r?\n/g, '')
}
