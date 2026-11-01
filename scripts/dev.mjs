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
  // npm can exit before its watchers, so retain these groups until cleanup ends.
  const targets = new Set(children)
  function signalTargets(signal) {
    for (const child of targets) {
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code === 'ESRCH') targets.delete(child)
        else console.error(error)
      }
    }
  }
  signalTargets('SIGTERM')
  if (process.platform === 'win32' || !targets.size) return

  const deadline = Date.now() + 5000
  const timer = setInterval(() => {
    signalTargets(0)
    if (!targets.size) clearInterval(timer)
    else if (Date.now() >= deadline) {
      signalTargets('SIGKILL')
      clearInterval(timer)
    }
  }, 100)
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
    if (!stopping) onExit(code ?? (signal ? 1 : 0))
    children.delete(child)
  })
  return child
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal === 'SIGINT' ? 130 : 143))

run(['run', 'build:shared'], code => {
  if (code) return stop(code)
  for (const workspace of ['@video-studio/shared', 'backend', 'web']) {
    run(['run', 'dev', `--workspace=${workspace}`], stop)
  }
})
