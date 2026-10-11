import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const sourceRoot = new URL('../src/', import.meta.url)
const forbidden = new Set(['button', 'input', 'select', 'textarea', 'details', 'summary', 'progress', 'meter', 'table', 'dialog'])
const errors = []
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { scan(file); continue }
    if (!entry.name.endsWith('.tsx')) continue
    const text = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source)
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
        const nativeMediaControls = ['audio', 'video'].includes(tag) && attrs.some(attr => attr.name.getText(source) === 'controls')
        const handWrittenInteraction = tag === tag.toLowerCase() && attrs.some(attr => attr.name.getText(source) === 'role' && ['button', 'menu', 'dialog', 'tablist'].includes(attr.initializer?.text))
        if (forbidden.has(tag) || nativeMediaControls || handWrittenInteraction) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          errors.push(`${path.relative(sourceRoot.pathname, file)}:${line}: use the Mantine interaction component for <${tag}>`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}
scan(sourceRoot.pathname)
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
else console.log('UI component guard passed: no hand-written basic controls, overlays or native media toolbars.')
