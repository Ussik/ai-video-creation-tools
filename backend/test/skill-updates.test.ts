import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import Fastify from 'fastify'
import type { SkillSyncResult } from '@video-studio/shared/skills/skill-updates'

const testData = await mkdtemp(join(tmpdir(), 'studio-skill-sync-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, all, run } = await import('../src/infrastructure/database/db.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const { configureSkill, installedSkillDetail, installedSkills, installSkillBundle, loadSkillBundle,
  removeInstalledSkill, setSkillDefault, skillContext, syncInstalledSkills } = await import('../src/modules/skills/skills.js')
db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')

const revisionA = 'a'.repeat(40), revisionB = 'b'.repeat(40), revisionC = 'c'.repeat(40)
type Files = Record<string, string>
type Source = { revision: string; snapshots: Record<string, Files>; error?: number }
const sources = new Map<string, Source>(), requests: string[] = []
let nextRepo = 0, beforeRaw: ((repo: string, revision: string, path: string) => Promise<void> | void) | undefined
let activeRequests = 0, maxActiveRequests = 0
const fetcher: typeof fetch = async input => {
  const url = new URL(String(input)); requests.push(url.toString())
  activeRequests++; maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
  try {
    if (url.host === 'raw.githubusercontent.com') {
      const [, owner, name, revision, ...segments] = url.pathname.split('/')
      const repo = `${owner}/${name}`, path = segments.map(decodeURIComponent).join('/')
      assert.match(revision!, /^[a-f0-9]{40}$/, 'downloads must pin a commit SHA')
      await beforeRaw?.(repo, revision!, path)
      const content = sources.get(repo)?.snapshots[revision!]?.[path]
      return content === undefined ? new Response('', { status: 404 }) : new Response(content)
    }
    assert.equal(url.host, 'api.github.com')
    const match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(.*)$/)!
    assert.ok(match, `unexpected source URL ${url}`)
    const source = sources.get(match[1]!)!
    assert.ok(source, `unknown fixture repo ${match[1]}`)
    if (source.error) return new Response('', { status: source.error })
    const suffix = match[2]
    let payload: unknown
    if (!suffix) payload = { default_branch: 'main', license: { spdx_id: 'MIT' } }
    else if (suffix === '/commits/main') payload = { sha: source.revision }
    else {
      const revision = suffix!.slice('/git/trees/'.length), files = source.snapshots[revision]
      assert.ok(files, `unknown fixture revision ${revision}`)
      payload = { tree: Object.entries(files).map(([path, content]) => ({ path, type: 'blob', size: Buffer.byteLength(content) })) }
    }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  } finally { activeRequests-- }
}
const app = Fastify()
app.setErrorHandler((issue, _request, reply) => reply.code((issue as { statusCode?: number }).statusCode || 422).send({ detail: issue instanceof Error ? issue.message : String(issue) }))
registerSkillRoutes(app, { fetcher, generateText: async () => { throw new Error('sync must not call a model') } })
beforeEach(() => {
  db.exec('DELETE FROM project_skill_defaults; DELETE FROM skill_stage_defaults; DELETE FROM installed_skills; DELETE FROM projects;')
  requests.length = 0; sources.clear(); beforeRaw = undefined; activeRequests = 0; maxActiveRequests = 0
})
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

function document(name: string, body = '旧版正文'): string { return `---\nname: ${name}\ndescription: ${name} 规则\n---\n${body}` }
function source(files: Files, revision = revisionB): string {
  const repo = `sync-fixture/case-${++nextRepo}`
  sources.set(repo, { revision, snapshots: { [revision]: files } })
  return repo
}
function install(repo: string, path: string, enabled = true, revision = revisionA) {
  const name = path.split('/').at(-1) || 'root'
  const skill = installSkillBundle({ repo, path, name, description: `${name} 旧描述`, license: null, revision,
    tool_requirements: [], suggested_stages: ['script'], url: '', files: [{ path: `${path}/SKILL.md`, content: document(name) }] })
  configureSkill(skill.id, enabled, ['script'])
  return installedSkillDetail(skill.id)
}
function metadataRequests(repo: string) { return requests.filter(url => url === `https://api.github.com/repos/${repo}`) }
async function callSync(): Promise<SkillSyncResult> {
  const result = await app.inject({ method: 'POST', url: '/api/skills/sync' })
  assert.equal(result.statusCode, 200, result.body)
  return result.json() as SkillSyncResult
}

test('one-click sync accepts no body and handles an empty installation without contacting sources', async () => {
  assert.deepEqual(await callSync(), { total: 0, updated: 0, unchanged: 0, failed: 0, results: [] })
  assert.deepEqual(requests, [])
})

test('sync updates every installed skill including disabled entries and immediately applies fresh rules while preserving all defaults', async () => {
  const repo = source({
    'skills/main/SKILL.md': document('main', '新版主技能正文\n[契约](../../shared/stage-contract.md)'),
    'skills/helper/SKILL.md': document('helper', '新版辅助技能正文\n[契约](../../shared/stage-contract.md)'),
    'skills/disabled/SKILL.md': document('disabled', '停用技能的新正文'),
    'shared/stage-contract.md': '新版共享契约',
  })
  const main = install(repo, 'skills/main'), helper = install(repo, 'skills/helper'), disabled = install(repo, 'skills/disabled', false)
  run('INSERT INTO projects VALUES (?)', 'project-sync')
  setSkillDefault('script', { primary_id: main.id, auxiliary_ids: [helper.id] })
  setSkillDefault('script', { primary_id: helper.id, auxiliary_ids: [main.id] }, 'project-sync')
  setSkillDefault('image_prompt', { primary_id: null, auxiliary_ids: [] })
  const defaults = [all('SELECT * FROM skill_stage_defaults'), all('SELECT * FROM project_skill_defaults')]
  const result = await callSync()
  assert.deepEqual([result.total, result.updated, result.unchanged, result.failed], [3, 3, 0, 0])
  assert.ok(result.results.every(item => item.status === 'updated' && item.revision === revisionB))
  for (const original of [main, helper, disabled]) {
    const updated = installedSkillDetail(original.id)
    for (const key of ['id', 'repo', 'path', 'enabled', 'stages', 'installed_at'] as const) assert.deepEqual(updated[key], original[key], key)
  }
  assert.deepEqual([all('SELECT * FROM skill_stage_defaults'), all('SELECT * FROM project_skill_defaults')], defaults)
  const context = skillContext('script', '正文', undefined, 'project-sync')
  assert.deepEqual(context.skills.map(item => [item.id, item.role, item.revision]), [[helper.id, 'primary', revisionB], [main.id, 'auxiliary', revisionB]])
  assert.match(context.text, /新版主技能正文/); assert.match(context.text, /新版辅助技能正文/); assert.match(context.text, /新版共享契约/)
  assert.doesNotMatch(context.text, /旧版正文|停用技能的新正文/)
  assert.equal(metadataRequests(repo).length, 1, 'one repository refresh serves all skills')
  assert.equal(requests.filter(url => url.endsWith(`/${revisionB}/shared/stage-contract.md`)).length, 1, 'shared immutable resources download once')
})

test('sync refreshes cached sources without requiring a separate check, and skips bundles already on the latest version', async () => {
  const repo = source({ 'skills/main/SKILL.md': document('main', '缓存旧内容') }, revisionA)
  const skill = install(repo, 'skills/main')
  await loadSkillBundle(repo, skill.path, fetcher)
  sources.get(repo)!.snapshots[revisionB] = { 'skills/main/SKILL.md': document('main', '新内容') }
  sources.get(repo)!.revision = revisionB
  requests.length = 0
  assert.equal((await callSync()).updated, 1)
  assert.equal(installedSkillDetail(skill.id).revision, revisionB)
  assert.equal(metadataRequests(repo).length, 1)
  requests.length = 0
  const repeated = await callSync()
  assert.deepEqual([repeated.updated, repeated.unchanged, repeated.failed], [0, 1, 0])
  assert.equal(requests.filter(url => url.startsWith('https://raw.githubusercontent.com/')).length, 0)
  assert.equal(metadataRequests(repo).length, 1, 'each invocation checks the latest source')
})

test('individual malformed or deleted skills preserve their entire old bundle without blocking valid siblings', async () => {
  const repo = source({ 'skills/good/SKILL.md': document('good', '有效新版本'), 'skills/broken/SKILL.md': 'invalid YAML document' })
  const good = install(repo, 'skills/good'), broken = install(repo, 'skills/broken'), removed = install(repo, 'skills/removed')
  const before = [installedSkillDetail(broken.id), installedSkillDetail(removed.id)]
  const result = await callSync()
  assert.deepEqual([result.total, result.updated, result.unchanged, result.failed], [3, 1, 0, 2])
  assert.equal(result.results.find(item => item.id === good.id)?.status, 'updated')
  assert.ok(result.results.filter(item => item.status === 'failed').every(item => item.error))
  assert.deepEqual([installedSkillDetail(broken.id), installedSkillDetail(removed.id)], before)
  assert.equal(metadataRequests(repo).length, 1)
})

test('repository failures are isolated and an unaffected source still updates', async () => {
  const badRepo = source({}), goodRepo = source({ 'skills/good/SKILL.md': document('good', '可用来源') })
  const bad = install(badRepo, 'skills/bad'), good = install(goodRepo, 'skills/good')
  sources.get(badRepo)!.error = 503
  const result = await callSync()
  assert.deepEqual([result.updated, result.failed], [1, 1])
  assert.equal(installedSkillDetail(bad.id).revision, revisionA)
  assert.equal(installedSkillDetail(good.id).revision, revisionB)
})

test('all skills in a repository use one immutable revision even when its default branch advances during download', async () => {
  const repo = source({ 'skills/first/SKILL.md': document('first', '版本 B'), 'skills/second/SKILL.md': document('second', '版本 B') })
  sources.get(repo)!.snapshots[revisionC] = { 'skills/first/SKILL.md': document('first', '版本 C'), 'skills/second/SKILL.md': document('second', '版本 C') }
  install(repo, 'skills/first'); install(repo, 'skills/second')
  beforeRaw = () => { sources.get(repo)!.revision = revisionC }
  const result = await callSync()
  assert.equal(result.updated, 2)
  assert.ok(result.results.every(item => item.revision === revisionB))
  assert.ok(installedSkills().every(skill => skill.revision === revisionB))
  assert.equal(metadataRequests(repo).length, 1)
  assert.ok(requests.filter(url => url.startsWith('https://raw.githubusercontent.com/')).every(url => url.includes(`/${revisionB}/`)))
})

test('uninstall during download never resurrects the removed skill and does not block another update', async () => {
  const repo = source({ 'skills/removed/SKILL.md': document('removed'), 'skills/kept/SKILL.md': document('kept') })
  const removed = install(repo, 'skills/removed'), kept = install(repo, 'skills/kept')
  beforeRaw = (_repo, _revision, path) => { if (path === removed.path + '/SKILL.md') removeInstalledSkill(removed.id) }
  const result = await callSync()
  assert.deepEqual([result.updated, result.failed], [1, 1])
  assert.equal(result.results.find(item => item.id === removed.id)?.status, 'failed')
  assert.throws(() => installedSkillDetail(removed.id), /尚未安装/)
  assert.equal(installedSkillDetail(kept.id).revision, revisionB)
})

test('uninstall and reinstall during download preserve the replacement installation', async () => {
  const repo = source({ 'skills/main/SKILL.md': document('main', '下载中的新版本') })
  const skill = install(repo, 'skills/main')
  let replacement: ReturnType<typeof install>
  beforeRaw = () => { removeInstalledSkill(skill.id); replacement = install(repo, 'skills/main', false, revisionC) }
  const result = await callSync()
  assert.equal(result.failed, 1)
  assert.deepEqual(installedSkillDetail(skill.id), replacement!)
})

test('configuration changes made during downloads are retained', async () => {
  const repo = source({ 'skills/main/SKILL.md': document('main', '新版本') }), skill = install(repo, 'skills/main')
  beforeRaw = () => { configureSkill(skill.id, false, ['storyboard']) }
  assert.equal((await callSync()).updated, 1)
  const updated = installedSkillDetail(skill.id)
  assert.equal(updated.enabled, false); assert.deepEqual(updated.stages, ['storyboard'])
})

test('source refresh and skill downloads use bounded concurrency', async () => {
  for (let index = 0; index < 9; index++) {
    const repo = source({ [`skills/item-${index}/SKILL.md`]: document(`item-${index}`) })
    install(repo, `skills/item-${index}`)
  }
  beforeRaw = async () => { await new Promise(resolve => setTimeout(resolve, 5)) }
  const result = await syncInstalledSkills(fetcher)
  assert.equal(result.updated, 9)
  assert.ok(maxActiveRequests <= 3, `observed ${maxActiveRequests} concurrent requests`)
})
