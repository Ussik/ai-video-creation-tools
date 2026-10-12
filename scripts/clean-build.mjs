import { rmSync } from 'node:fs'

const outputs = {
  backend: new URL('../backend/dist/', import.meta.url),
  shared: new URL('../packages/shared/dist/', import.meta.url),
}
const workspace = process.argv[2]
if (process.argv.length !== 3 || !Object.hasOwn(outputs, workspace)) {
  console.error('Usage: node scripts/clean-build.mjs backend|shared')
  process.exitCode = 2
} else rmSync(outputs[workspace], { recursive: true, force: true })
