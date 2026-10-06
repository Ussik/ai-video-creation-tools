import { useEffect, useState } from 'react'
import { Modal } from '@mantine/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import { NodeToolbar, Position, useViewport } from '@xyflow/react'
import { Bold, Check, Copy, Italic, List, ListOrdered, Maximize2, Minus, Pilcrow, RemoveFormatting } from 'lucide-react'
import { applyTextFormat, textEditorExtensions, type TextFormat } from './text-editor'
import { normalizeTextDocument, resolveTextDocument, textDocumentText } from './text-document'
import './canvas-text-editor.css'

type Props = {
  text: string
  document?: JSONContent | null
  selected: boolean
  inline?: boolean
  label: string
  onChange: (text: string, document: JSONContent) => void
}

function TextEditingSurface({ text, document, selected, inline, label, onChange, onExpand, expanded = false }: Props & {
  onExpand?: () => void
  expanded?: boolean
}) {
  const { zoom } = useViewport()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const editor = useEditor({
    extensions: textEditorExtensions(),
    content: resolveTextDocument(text, document),
    editorProps: {
      attributes: { class: 'pc-rich-text-content nodrag nowheel', role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'data-placeholder': '输入内容…' },
    },
    onUpdate({ editor: current }) {
      const next = normalizeTextDocument(current.getJSON())
      if (JSON.stringify(next) === JSON.stringify(normalizeTextDocument(resolveTextDocument(text, document)))) return
      onChange(textDocumentText(next), next)
    },
  }, [])
  const format = useEditorState({ editor, selector: ({ editor: current }) => ({
    h1: current?.isActive('heading', { level: 1 }),
    h2: current?.isActive('heading', { level: 2 }),
    h3: current?.isActive('heading', { level: 3 }),
    paragraph: current?.isActive('paragraph') && !current.isActive('bulletList') && !current.isActive('orderedList'),
    bold: current?.isActive('bold'), italic: current?.isActive('italic'),
    bulletList: current?.isActive('bulletList'), orderedList: current?.isActive('orderedList'),
  }) })

  useEffect(() => {
    if (!editor) return
    const next = resolveTextDocument(text, document)
    if (JSON.stringify(normalizeTextDocument(editor.getJSON())) !== JSON.stringify(next)) {
      editor.commands.setContent(next, { emitUpdate: false })
    }
  }, [text, document, editor])
  useEffect(() => {
    // Selecting a canvas card only reveals its toolbar. Focus is owned by a
    // click in the writing surface, except when opening the dedicated modal.
    if (!editor || !expanded) return
    editor.commands.focus()
  }, [editor, expanded])
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [copyState])

  const button = (command: TextFormat, title: string, icon: React.ReactNode, active?: boolean) => <button
    type="button" title={title} aria-label={title} aria-pressed={active} disabled={!editor}
    onMouseDown={event => event.preventDefault()}
    onClick={() => editor && applyTextFormat(editor, command)}>{icon}</button>
  const toolbar = <div className="pc-text-format-bar nodrag nowheel" role="toolbar" aria-label="文本格式"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    {button('clear', '清除格式', <RemoveFormatting size={18} />)}
    <span className="pc-text-format-divider" />
    {button('h1', '一级标题', 'H1', format?.h1)}
    {button('h2', '二级标题', 'H2', format?.h2)}
    {button('h3', '三级标题', 'H3', format?.h3)}
    {button('paragraph', '正文段落', <Pilcrow size={18} />, format?.paragraph)}
    <span className="pc-text-format-divider" />
    {button('bold', '粗体', <Bold size={18} />, format?.bold)}
    {button('italic', '斜体', <Italic size={18} />, format?.italic)}
    <span className="pc-text-format-divider" />
    {button('bulletList', '项目符号', <List size={18} />, format?.bulletList)}
    {button('orderedList', '编号列表', <ListOrdered size={18} />, format?.orderedList)}
    <span className="pc-text-format-divider" />
    {button('rule', '分隔线', <Minus size={18} />)}
    <button type="button" title={copyState === 'failed' ? '复制失败，请使用快捷键复制' : copyState === 'copied' ? '已复制' : '复制文本'}
      aria-label={copyState === 'copied' ? '已复制文本' : '复制文本'} onMouseDown={event => event.preventDefault()}
      onClick={async () => {
        if (!editor) return
        try { await navigator.clipboard.writeText(textDocumentText(editor.getJSON())); setCopyState('copied') }
        catch { setCopyState('failed') }
      }}>{copyState === 'copied' ? <Check size={18} /> : <Copy size={18} />}</button>
    {onExpand && <button type="button" aria-label="展开文本节点" title="展开文本节点" onMouseDown={event => event.preventDefault()} onClick={onExpand}><Maximize2 size={18} /></button>}
    <span className="pc-text-editor-announcement" role="status">{copyState === 'copied' ? '已复制文本' : copyState === 'failed' ? '复制失败，请使用快捷键复制' : ''}</span>
  </div>

  return <>
    {expanded || inline ? toolbar : <NodeToolbar isVisible={selected} position={Position.Top} offset={Math.max(44, 36 * zoom + 10)} align="center" className="pc-text-node-toolbar">{toolbar}</NodeToolbar>}
    <EditorContent editor={editor} className="pc-rich-text-editor nodrag nowheel" onDoubleClick={event => event.stopPropagation()} />
  </>
}

export default function CanvasTextEditor(props: Props) {
  const [expanded, setExpanded] = useState(false)
  return <>
    <TextEditingSurface {...props} selected={props.selected && !expanded} onExpand={() => setExpanded(true)} />
    <Modal opened={expanded} onClose={() => setExpanded(false)} title={props.label} size="xl" centered
      classNames={{ root: 'pc-text-editor-modal-root', content: 'pc-text-editor-modal', body: 'pc-text-editor-modal-body' }}
      closeOnClickOutside={false}>
      <div className="pc-expanded-text-editor" onKeyDown={event => { if (event.key === 'Escape') setExpanded(false); event.stopPropagation() }}>
        {expanded && <TextEditingSurface {...props} selected expanded />}
      </div>
    </Modal>
  </>
}

function renderDocumentNode(node: JSONContent, key: number): React.ReactNode {
  const children = node.content?.map(renderDocumentNode)
  if (node.type === 'text') {
    let text: React.ReactNode = node.text || ''
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') text = <strong>{text}</strong>
      if (mark.type === 'italic') text = <em>{text}</em>
    }
    return <span key={key}>{text}</span>
  }
  if (node.type === 'hardBreak') return <br key={key} />
  if (node.type === 'heading') {
    if (node.attrs?.level === 1) return <h1 key={key}>{children}</h1>
    if (node.attrs?.level === 2) return <h2 key={key}>{children}</h2>
    return <h3 key={key}>{children}</h3>
  }
  if (node.type === 'bulletList') return <ul key={key}>{children}</ul>
  if (node.type === 'orderedList') return <ol key={key} start={node.attrs?.start || 1}>{children}</ol>
  if (node.type === 'listItem') return <li key={key}>{children}</li>
  if (node.type === 'horizontalRule') return <hr key={key} />
  return <p key={key}>{children?.length ? children : <br />}</p>
}

export function CanvasTextPreview({ text, document }: Pick<Props, 'text' | 'document'>) {
  const content = resolveTextDocument(text, document)
  return <div className="pc-rich-text-preview pc-rich-text-content">{content.content?.map(renderDocumentNode)}</div>
}
