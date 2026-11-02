// Restarts only the isolated backend (18000). Usage: node scripts/qa/backend.mjs start|stop
// Records its process group in /tmp/script-agent-qa.pids (replacing the previous backend entry).
import { spawn } from 'node:child_process'
import { openSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
const pidFile = '/tmp/script-agent-qa.pids', backendFile = '/tmp/script-agent-qa.backend.pid'
const read = f => existsSync(f) ? readFileSync(f, 'utf8').trim() : ''
const old = Number(read(backendFile))
if (old) { try { process.kill(-old, 'SIGTERM') } catch {} }
if (process.argv[2] === 'stop') process.exit(0)
await new Promise(r => setTimeout(r, 2000))
const out = openSync('/tmp/script-agent-backend-run.log', 'a')
const child = spawn('npx', ['tsx', 'src/server.ts'], { cwd: new URL('../../backend/', import.meta.url).pathname, detached: true, stdio: ['ignore', out, out],
  env: { ...process.env, VIDEO_STUDIO_DATA_DIR: '/tmp/script-agent-qa-data', PORT: '18000',
    // Optional: a smaller earlier-wording budget makes the 'does not fit' state reproducible without a huge history.
    ...(process.env.QA_EARLIER_WORDING_CHARS ? { VIDEO_STUDIO_EARLIER_WORDING_CHARS: process.env.QA_EARLIER_WORDING_CHARS } : {}) } })
child.unref()
writeFileSync(backendFile, String(child.pid))
const pids = JSON.parse(read(pidFile) || '[]').filter(p => p !== old)
writeFileSync(pidFile, JSON.stringify([...pids, child.pid]))
for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:18000/api/projects')).ok) { console.log('backend ready, group', child.pid); process.exit(0) } } catch {} await new Promise(r => setTimeout(r, 500)) }
console.error('backend did not become ready'); process.exit(1)
