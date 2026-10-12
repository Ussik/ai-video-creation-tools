import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const web = path.join(root, 'web/src')
const backend = path.join(root, 'backend/src')
const shared = path.join(root, 'packages/shared/src')
const errors = []
const sourceExtensions = ['.ts', '.tsx', '.css']
const relative = file => path.relative(root, file)
const within = (file, directory) => file === directory || file.startsWith(directory + path.sep)

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? files(file) : sourceExtensions.includes(path.extname(file)) ? [file] : []
  })
}

function resolveImport(file, specifier) {
  const target = path.resolve(path.dirname(file), specifier)
  const candidates = [target]
  if (target.endsWith('.js')) candidates.push(target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx')
  if (!path.extname(target)) candidates.push(...sourceExtensions.map(extension => target + extension), path.join(target, 'index.ts'), path.join(target, 'index.tsx'))
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

for (const [directory, allowed] of [[web, ['main.tsx']], [backend, ['app.ts', 'server.ts']], [shared, []]]) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && sourceExtensions.includes(path.extname(entry.name)) && !allowed.includes(entry.name)) {
      errors.push(`${relative(path.join(directory, entry.name))}: place source in its feature, shared or infrastructure directory`)
    }
  }
}

for (const file of [...files(web), ...files(backend), ...files(shared)]) {
  if (file.endsWith('.css')) continue
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  function check(specifier, node) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const report = message => errors.push(`${relative(file)}:${line}: ${message}`)
    if (specifier.startsWith('.')) {
      const target = resolveImport(file, specifier)
      if (!target) return report(`unresolved import ${specifier}`)
      if (within(file, web) && !within(target, web)) report('frontend source must use @video-studio/shared instead of another workspace source')
      if (within(file, backend) && !within(target, backend)) report('backend source must use @video-studio/shared instead of another workspace source')
      if (within(file, shared) && !within(target, shared)) report('shared source must stay independent of application workspaces')
      if (within(file, path.join(web, 'shared')) && within(target, web) && !within(target, path.join(web, 'shared'))) report('shared frontend modules must not depend on app or features')
    } else if (specifier.startsWith('@video-studio/shared/')) {
      const subpath = specifier.slice('@video-studio/shared/'.length)
      const target = path.resolve(shared, subpath + '.ts')
      if (!within(target, shared) || !fs.existsSync(target)) report(`unknown shared module ${specifier}`)
    } else if (within(file, shared)) {
      report('shared rules must be platform independent and use only local shared imports')
    } else if (within(file, web) && specifier.startsWith('node:')) {
      report('frontend source cannot import Node.js APIs')
    }
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text, node)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text, node)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text, node)
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log('Architecture check passed: feature directories, workspace boundaries and shared imports.')
