// Isolated acceptance process: the real app (real routes, SQLite, director) with ONLY the external
// GitHub HTTP boundary replaced by a controllable two-version fixture. Nothing in production code changes.
//   node scripts/qa/skill-fixture-server.mjs        (env: PORT=18200 CONTROL_PORT=18201 DATA=/tmp/script-agent-skill-data)
// Fixture repo: qa-fixture/min-skills, skills "qa-min-skill" (script) and "qa-min-storyboard" (storyboard).  Control (127.0.0.1:$CONTROL_PORT):
//   GET  /state                       -> {version, revision}
//   POST /version {"version":"v1"|"v2"} -> switches what GitHub "serves"; revision changes with it
//   GET  /log                         -> every intercepted GitHub request
const port = Number(process.env.PORT || 18200), controlPort = Number(process.env.CONTROL_PORT || 18201)
process.env.VIDEO_STUDIO_DATA_DIR = process.env.DATA || '/tmp/script-agent-skill-data'
const { mkdirSync } = await import('node:fs'); mkdirSync(process.env.VIDEO_STUDIO_DATA_DIR, { recursive: true })
const { createServer } = await import('node:http')

const repo = 'qa-fixture/min-skills', skillPath = 'qa-min-skill', storyboardPath = 'qa-min-storyboard'
const revisions = { v1: '1'.repeat(40), v2: '2'.repeat(40) }
const skillDoc = version => `---\nname: qa-min-skill\ndescription: 最小验收技能，用于演示版本变化（${version}）\nlicense: MIT\n---\n【QA技能规则 ${version.toUpperCase()}】保持叙述简洁，先给结论再展开。MARKER_${version.toUpperCase()}\n`
const storyboardDoc = version => `---\nname: qa-min-storyboard\ndescription: 最小分镜验收技能，用于演示分镜预览（${version}）\nlicense: MIT\n---\n【QA分镜规则 ${version.toUpperCase()}】每镜先写机位再写动作。SB_MARKER_${version.toUpperCase()}\n`
let version = 'v1'
const intercepted = []

const real = globalThis.fetch
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname !== 'api.github.com' && url.hostname !== 'raw.githubusercontent.com') return real(input, init)
  intercepted.push({ at: new Date().toISOString(), version, url: url.href })
  const revision = revisions[version], path = decodeURIComponent(url.pathname)
  if (url.hostname === 'api.github.com') {
    if (path === `/repos/${repo}`) return json({ default_branch: 'main', license: { spdx_id: 'MIT' } })
    if (path === `/repos/${repo}/commits/main`) return json({ sha: revision })
    if (path === `/repos/${repo}/git/trees/${revision}`) return json({ truncated: false, tree: [{ path: `${skillPath}/SKILL.md`, type: 'blob', size: skillDoc(version).length }, { path: `${storyboardPath}/SKILL.md`, type: 'blob', size: storyboardDoc(version).length }] })
    return json({ message: 'Not Found' }, 404)
  }
  const prefix = `/${repo}/${revision}/`
  if (path.startsWith(prefix) && path.slice(prefix.length) === `${skillPath}/SKILL.md`) return new Response(skillDoc(version), { status: 200 })
  if (path.startsWith(prefix) && path.slice(prefix.length) === `${storyboardPath}/SKILL.md`) return new Response(storyboardDoc(version), { status: 200 })
  return new Response('not found', { status: 404 })
}

const { buildApp, startWorker } = await import('../../backend/src/app.ts')
const app = buildApp()
const stopWorker = startWorker()
await app.listen({ host: '127.0.0.1', port })
createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const path = new URL(req.url, 'http://x').pathname
    if (path === '/state') return send(200, { version, revision: revisions[version], repo, path: skillPath })
    if (path === '/log') return send(200, intercepted)
    if (path === '/version' && req.method === 'POST') {
      const next = JSON.parse(Buffer.concat(chunks).toString() || '{}').version
      if (!(next in revisions)) return send(400, { error: 'version must be v1 or v2' })
      version = next; return send(200, { version, revision: revisions[version] })
    }
    send(404, { error: 'unknown' })
  })
}).listen(controlPort, '127.0.0.1', () => console.log(`skill fixture app http://127.0.0.1:${port} control http://127.0.0.1:${controlPort} data=${process.env.VIDEO_STUDIO_DATA_DIR}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void Promise.allSettled([stopWorker(), app.close()]).then(() => process.exit()) })
