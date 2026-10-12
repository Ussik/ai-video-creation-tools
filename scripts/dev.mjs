import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = new Set()
let stopping = false

function stop(code) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM')
      else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(error)
    }
  }
}

function run(args, onExit) {
  const child = spawn(npm, args, { cwd: root, stdio: 'inherit', detached: process.platform !== 'win32', shell: process.platform === 'win32' })
  children.add(child)
  child.once('error', error => {
    console.error(error)
    children.delete(child)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) onExit(code ?? (signal ? 1 : 0))
  })
  return child
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal === 'SIGINT' ? 130 : 143))

run(['run', 'build:shared'], code => {
  if (code) return stop(code)
  for (const workspace of ['@video-studio/shared', 'backend', 'web']) {
    run(['run', 'dev', `--workspace=${workspace}`], stop)
  }
})
