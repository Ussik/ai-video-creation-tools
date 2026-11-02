// Stops only the process groups recorded by up.mjs (never pattern-matches other workspaces).
import { readFileSync, rmSync } from 'node:fs'
const file = '/tmp/script-agent-qa.pids'
for (const pid of JSON.parse(readFileSync(file, 'utf8'))) { try { process.kill(-pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') console.error(pid, e.message) } }
rmSync(file)
