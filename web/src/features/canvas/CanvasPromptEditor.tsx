import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ActionIcon, Badge, HoverCard, Popover, Portal, ScrollArea, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from '@tiptap/react'
import { Node as TiptapNode, Extension, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history'
import { ArrowLeft, Check, ChevronDown, ImageIcon, Plus, Search, TriangleAlert, X } from 'lucide-react'
import { tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { parsePromptSectionDocument, type PromptSectionBlock, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { promptPresentationPlugin } from './canvas-prompt-presentation'
import './canvas-prompt-editor.css'

export type CanvasPromptReference = {
  assetId: string
  label: string
  url: string
  nodeId?: string
  description?: string
  provenance?: string
  required?: boolean
  invalid?: boolean
}
export type CanvasPromptEditorProps = {
  value: string
  onChange: (value: string, document?: PromptSectionDocument) => void
  sectionDocument?: PromptSectionDocument
  references: CanvasPromptReference[]
  choices: CanvasPromptReference[]
  additionalChoices?: CanvasPromptReference[]
  onReferenceAdd?: (reference: CanvasPromptReference) => boolean | void
  onReferenceChange?: (sourceId: string, replacementId: string | null) => boolean | void
  placeholder?: string
  'aria-label'?: string
  disabled?: boolean
  readOnly?: boolean
  expanded?: boolean
  compact?: boolean
  minRows?: number
  maxLength?: number
}
type Picker = { from: number; to: number; query: string; index: number; manual?: boolean; scope?: 'active' | 'additional' }
type Runtime = {
  references: CanvasPromptReference[]; choices: CanvasPromptReference[]; additionalChoices: CanvasPromptReference[]; disabled: boolean
  readOnly: boolean
  maxLength: number
  placeholder: string
  change: (assetId: string, replacementId: string | null) => boolean
  removeSection: (sectionId: string) => void
  keydown: (event: KeyboardEvent) => boolean
}
const referenceToken = (assetId: string) => `[[ref:${assetId}]]`
const referenceProvenance = (provenance?: string) => ({ connection: '连线参考', binding: '镜头绑定', base: '基础设定', explicit: '项目素材' }[provenance || ''] || provenance || '')
const referenceAttributes = (assetId: string, references: CanvasPromptReference[]) => {
  const reference = references.find(item => item.assetId === assetId)
  return { assetId, label: reference?.label || '引用图片', url: reference?.url || '', required: !!reference?.required,
    nodeId: reference?.nodeId || '', description: reference?.description || '', provenance: referenceProvenance(reference?.provenance), invalid: reference?.invalid ?? !reference }
}
const referenceMatches = (reference: CanvasPromptReference, query: string) =>
  !reference.invalid && [reference.label, reference.description, referenceProvenance(reference.provenance)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())
const uniqueReferences = (references: CanvasPromptReference[]) => {
  const seen = new Set<string>()
  return references.filter(reference => { if (seen.has(reference.assetId)) return false; seen.add(reference.assetId); return true })
}
function ReferenceDetails({ reference }: { reference: CanvasPromptReference }) {
  return <span className="pc-prompt-reference-option-text"><span>{reference.label}</span>{reference.description && <small>{reference.description}</small>}{reference.provenance && <small className="pc-prompt-reference-provenance">{referenceProvenance(reference.provenance)}</small>}</span>
}

/** Legacy image numbers are resolved once against the current ordered inputs.
 * Persisted edits use stable asset IDs, so later reference reordering is safe. */
function promptParagraphs(value: string, references: CanvasPromptReference[], choices: CanvasPromptReference[], segmentId?: string): JSONContent[] {
  return value.split(/\r\n?|\n/).map(line => {
    const content: JSONContent[] = []
    const pattern = /\[\[ref:([^\]\s]+)\]\]/g
    let offset = 0
    for (const match of line.matchAll(pattern)) {
      if (match.index! > offset) content.push({ type: 'text', text: line.slice(offset, match.index) })
      content.push({ type: 'promptReference', attrs: referenceAttributes(match[1], [...references, ...choices]) })
      offset = match.index! + match[0].length
    }
    if (offset < line.length) content.push({ type: 'text', text: line.slice(offset) })
    return { type: 'paragraph', ...(segmentId ? { attrs: { promptBodySegment: segmentId } } : {}), ...(content.length ? { content } : {}) }
  })
}
export function promptEditorDocument(value: string, references: CanvasPromptReference[], choices: CanvasPromptReference[] = [], sectionDocument?: PromptSectionDocument): JSONContent {
  const tokenized = tokenizePromptReferenceNumbers(value, references.map(reference => reference.assetId))
  const parsed = parsePromptSectionDocument(tokenized, { previousDocument: sectionDocument })
  const content = parsed.blocks.flatMap(block => {
    if (block.kind === 'body') return promptParagraphs(block.text, references, choices, block.id)
    if (block.deleted) return []
    let inner = block.text.slice(`【${block.name}】`.length, -`【${block.name}结束】`.length)
    const leading = inner.startsWith('\n') ? '\n' : '', trailing = inner.endsWith('\n') && inner.length > leading.length ? '\n' : ''
    inner = inner.slice(leading.length, trailing ? -trailing.length : undefined)
    return [{ type: 'promptManagedSection', attrs: { section: block, leading, trailing }, content: promptParagraphs(inner, references, choices) }]
  })
  // A generated-only prompt still needs a visible place for the creator to
  // write. This empty entry has no serialized text until they start typing.
  if (content[0]?.type === 'promptManagedSection') content.unshift({ type: 'paragraph',
    attrs: { promptBodySegment: 'prompt-body-entry', promptBodyEntry: true } })
  return { type: 'doc', content }
}

export function promptEditorText(document: JSONContent): string {
  const text = (node: JSONContent): string => node.type === 'promptReference' ? referenceToken(node.attrs?.assetId || '')
    : node.type === 'hardBreak' ? '\n' : node.type === 'text' ? node.text || '' : node.type === 'promptManagedSection'
      ? `【${node.attrs!.section.name}】${node.attrs!.leading || ''}${(node.content || []).map(text).join('\n')}${node.attrs!.trailing || ''}【${node.attrs!.section.name}结束】`
      : (node.content || []).map(text).join('')
  const nodes = document.content || []
  let result = ''
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.type === 'paragraph' && node.attrs?.promptBodyEntry) {
      const entry = [text(node)]
      while (nodes[index + 1]?.type === 'paragraph' && nodes[index + 1]?.attrs?.promptBodyEntry) entry.push(text(nodes[++index]))
      // The entry itself contributes no blank lines. Existing prose after a
      // removed section keeps its own original separators and segment identity.
      if (entry.some(part => part.length > 0)) result += entry.join('\n') + (nodes[index + 1]?.type === 'promptManagedSection' ? '\n\n' : '')
      continue
    }
    const previous = nodes[index - 1]
    const separateSegments = node.attrs?.promptBodySegment && previous?.attrs?.promptBodySegment
      && node.attrs.promptBodySegment !== previous.attrs.promptBodySegment
    result += `${index && node.type === 'paragraph' && previous.type === 'paragraph' && !previous.attrs?.promptBodyEntry && !separateSegments ? '\n' : ''}${text(node)}`
  }
  return result
}
export function promptEditorSectionDocument(document: JSONContent, previousDocument?: PromptSectionDocument): PromptSectionDocument {
  const parsed = parsePromptSectionDocument(promptEditorText(document), { previousDocument })
  const sections = (document.content || []).filter(node => node.type === 'promptManagedSection')
  let index = 0
  return { ...parsed, blocks: parsed.blocks.map(block => {
    if (block.kind !== 'managed' || block.deleted) return block
    const section = sections[index++]?.attrs?.section
    return section ? { ...block, ...section, text: block.text } : block
  }) }
}
function referenceCounts(document: JSONContent): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: JSONContent) => {
    if (node.type === 'promptReference') counts.set(node.attrs!.assetId, (counts.get(node.attrs!.assetId) || 0) + 1)
    node.content?.forEach(visit)
  }
  visit(document)
  return counts
}
function managedSections(document: JSONContent) {
  return (document.content || []).filter(node => node.type === 'promptManagedSection')
}
type ReferenceChange = { sourceId: string; replacementId: string | null }
function rewriteSectionReference(section: PromptSectionBlock, { sourceId, replacementId }: ReferenceChange): PromptSectionBlock {
  const rewrite = (text: string) => text.replace(/\[\[ref:([^\]]+)\]\]/g, (token, id: string) =>
    id === sourceId ? replacementId ? referenceToken(replacementId) : '' : token)
  return { ...section, text: rewrite(section.text),
    ...(section.sourceText !== undefined ? { sourceText: rewrite(section.sourceText) } : {}),
    ...(section.pendingSourceText !== undefined ? { pendingSourceText: rewrite(section.pendingSourceText) } : {}),
  }
}
function changedReferences(before: JSONContent, after: JSONContent, explicit?: ReferenceChange): ReferenceChange[] {
  const changes = explicit ? [explicit] : []
  if (managedSections(before).map(node => node.attrs?.section.id).join('\0')
    !== managedSections(after).map(node => node.attrs?.section.id).join('\0')) return changes
  const afterCounts = referenceCounts(after)
  for (const assetId of referenceCounts(before).keys()) {
    if (!afterCounts.has(assetId) && assetId !== explicit?.sourceId) changes.push({ sourceId: assetId, replacementId: null })
  }
  return changes
}
function promptClipboardText(slice: Slice): string {
  const content = (slice.content.toJSON() || []) as JSONContent[]
  return promptEditorText({ type: 'doc', content: content.flatMap((node, index) => node.type === 'promptManagedSection'
    && (index === 0 && slice.openStart > 0 || index === content.length - 1 && slice.openEnd > 0) ? node.content || [] : [node]) })
}
let sectionCopySequence = 0
function freshSectionIds(node: ProseMirrorNode): ProseMirrorNode {
  const content = Fragment.fromArray(Array.from({ length: node.childCount }, (_, index) => freshSectionIds(node.child(index))))
  return node.type.name === 'promptManagedSection'
    ? node.type.create({ ...node.attrs, section: { ...node.attrs.section, id: `pasted-section-${Date.now()}-${++sectionCopySequence}` } }, content)
    : node.copy(content)
}

function PromptManagedSectionView({ node, extension, editor, getPos }: NodeViewProps) {
  const [opened, setOpened] = useState(false)
  const contentId = useId()
  const runtime = extension.options.runtime() as Runtime
  const { id, name } = node.attrs.section
  const changed = node.attrs.section.sourceStatus === 'source_changed'
  // Arrow keys, search and programmatic selection must never leave the caret
  // inside an invisible section. Folding itself stays outside document history.
  useEffect(() => {
    const revealSelection = () => {
      const position = getPos()
      if (!editor.isFocused || typeof position !== 'number') return
      if (editor.state.selection.from > position && editor.state.selection.from < position + node.nodeSize) setOpened(true)
    }
    editor.on('selectionUpdate', revealSelection)
    editor.on('focus', revealSelection)
    return () => { editor.off('selectionUpdate', revealSelection); editor.off('focus', revealSelection) }
  }, [editor, getPos, node.nodeSize])
  function toggle() {
    const position = getPos()
    if (opened && typeof position === 'number' && editor.state.selection.from > position
      && editor.state.selection.from < position + node.nodeSize) editor.commands.setTextSelection(1)
    setOpened(value => !value)
  }
  return <NodeViewWrapper className={`pc-prompt-managed-section${opened ? ' is-open' : ''}`} data-prompt-section-id={id} data-prompt-section-name={name}>
    <div className="pc-prompt-managed-section-head" contentEditable={false}>
      <UnstyledButton type="button" className="pc-prompt-managed-toggle" aria-label={`${opened ? '收起设定' : '展开编辑'}：${name}`}
        aria-expanded={opened} aria-controls={contentId} onMouseDown={event => event.preventDefault()} onClick={toggle}>
        <ChevronDown size={14} className="pc-prompt-managed-chevron" />
        <span className="pc-prompt-managed-section-title">{name}</span>
        {changed && <span className="pc-prompt-managed-changed">来源有更新</span>}
        <span className="pc-prompt-managed-edit-label">{opened ? '收起' : '展开编辑'}</span>
      </UnstyledButton>
      <Tooltip label="移除此段内容，保留参考图片连接"><ActionIcon type="button" size="sm" variant="subtle" color="gray"
        aria-label={`移除区块：${name}`} disabled={runtime.disabled || runtime.readOnly}
        onMouseDown={event => event.preventDefault()} onClick={() => runtime.removeSection(id)}><X size={13} /></ActionIcon></Tooltip>
    </div>
    <div id={contentId} className="pc-prompt-managed-panel" hidden={!opened}><NodeViewContent className="pc-prompt-managed-section-content" /></div>
    <div className="pc-prompt-managed-section-end" contentEditable={false} aria-hidden="true">【{name}结束】</div>
  </NodeViewWrapper>
}

function PromptReferenceView({ node, extension }: NodeViewProps) {
  const [opened, setOpened] = useState(false)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'active' | 'additional'>('active')
  const runtime = extension.options.runtime() as Runtime
  const { assetId, label, url, required, invalid, description, provenance } = node.attrs as ReturnType<typeof referenceAttributes>
  const activeIds = new Set(runtime.choices.filter(item => !item.invalid).map(item => item.assetId))
  const additionalChoices = runtime.additionalChoices.filter(item => !activeIds.has(item.assetId))
  const choices = uniqueReferences(scope === 'additional' ? additionalChoices : runtime.choices).filter(item => (item.assetId !== assetId || invalid) && referenceMatches(item, query))
  return <NodeViewWrapper as="span" className="pc-prompt-reference-wrap" contentEditable={false}>
    <Popover opened={opened} onChange={setOpened} position="top-start" width={300} withinPortal zIndex={280}>
      <HoverCard openDelay={300} closeDelay={100} width={240} withinPortal zIndex={290}>
        <HoverCard.Target><span><Popover.Target><UnstyledButton type="button" className={`pc-prompt-reference${invalid ? ' is-invalid' : ''}`} disabled={runtime.disabled}
          aria-label={`${required ? '查看' : '编辑'}图片引用：${label}`} aria-haspopup="dialog" aria-expanded={opened}
          onClick={() => { setQuery(''); setScope('active'); setOpened(value => !value) }}>
          {url ? <img src={url} alt="" /> : <ImageIcon size={15} />}<span>{label}</span>{invalid && <TriangleAlert size={13} aria-label="引用已失效" />}{required && <span className="pc-prompt-reference-required" aria-label="必需引用">*</span>}
        </UnstyledButton></Popover.Target></span></HoverCard.Target>
        <HoverCard.Dropdown className="pc-prompt-reference-preview">{url && <img src={url} alt={label} />}<strong>{label}</strong>{description && <small>{description}</small>}{provenance && <small>{provenance}</small>}{invalid && <small className="pc-prompt-reference-invalid-note">引用已失效，请重新关联或移除</small>}{required && <small>必需参考图</small>}</HoverCard.Dropdown>
      </HoverCard>
      <Popover.Dropdown className="pc-prompt-reference-menu" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <div className="pc-prompt-reference-menu-heading"><strong>{label}</strong>{required && <Badge size="xs" variant="light">必需引用</Badge>}</div>
        {url && <img className="pc-prompt-reference-menu-preview" src={url} alt={label} />}
        {invalid && <><p className="pc-prompt-reference-invalid-note">引用已失效，请重新连接或选择新的参考。</p><UnstyledButton type="button" className="pc-prompt-reference-reconnect" onClick={() => { if (runtime.change(assetId, assetId)) setOpened(false) }}><Plus size={14} />重新连接此参考</UnstyledButton></>}
        {required ? <p>此参考图用于保证画面一致性，可查看图片。</p> : <>
          {scope === 'additional' ? <UnstyledButton type="button" className="pc-prompt-reference-scope" onClick={() => { setScope('active'); setQuery('') }}><ArrowLeft size={13} />返回当前节点引用</UnstyledButton> : <div className="pc-prompt-reference-scope-label">当前节点引用</div>}
          <TextInput aria-label="搜索替换图片" placeholder="搜索替换图片" value={query} onChange={event => setQuery(event.currentTarget.value)} leftSection={<Search size={14} />} size="xs" />
          <ScrollArea.Autosize mah={210}><div className="pc-prompt-reference-options">{choices.map(item => <UnstyledButton type="button" key={item.assetId} className="pc-prompt-reference-option"
            onClick={() => { if (runtime.change(assetId, item.assetId)) setOpened(false) }}>
            {item.url ? <img src={item.url} alt="" /> : <ImageIcon size={18} />}<ReferenceDetails reference={item} />
          </UnstyledButton>)}{!choices.length && <p>{scope === 'additional' ? '没有匹配的其他参考' : '没有可替换的节点参考'}</p>}</div></ScrollArea.Autosize>
          {scope === 'active' && additionalChoices.some(item => !item.invalid && (item.assetId !== assetId || invalid)) && <UnstyledButton type="button" className="pc-prompt-reference-add" onClick={() => { setScope('additional'); setQuery('') }}><Plus size={14} />添加其他参考</UnstyledButton>}
          <UnstyledButton type="button" className="pc-prompt-reference-remove" onClick={() => { if (runtime.change(assetId, null)) setOpened(false) }}><X size={14} />移除此引用</UnstyledButton>
        </>}
      </Popover.Dropdown>
    </Popover>
  </NodeViewWrapper>
}

function promptExtensions(runtime: () => Runtime) {
  return [
    StarterKit.configure({ blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, heading: false,
      horizontalRule: false, italic: false, link: false, listItem: false, orderedList: false, strike: false, underline: false, trailingNode: false }),
    TiptapNode.create({
      name: 'promptManagedSection', group: 'block', content: 'paragraph+', defining: true, isolating: true, selectable: false,
      addOptions: () => ({ runtime }),
      addAttributes: () => ({ section: { default: null, renderHTML: () => ({}) }, leading: { default: '\n', renderHTML: () => ({}) }, trailing: { default: '\n', renderHTML: () => ({}) } }),
      parseHTML: () => [{ tag: 'section[data-prompt-section]', getAttrs: element => {
        try {
          const parsed = parsePromptSectionDocument(element.getAttribute('data-prompt-section') || '')
          const section = parsed.blocks.find(block => block.kind === 'managed')
          return section ? { section, leading: element.getAttribute('data-leading') || '', trailing: element.getAttribute('data-trailing') || '' } : false
        } catch { return false }
      } }],
      renderHTML: ({ node }) => ['section', { 'data-prompt-section': promptEditorText({ type: 'doc', content: [node.toJSON()] }),
        'data-leading': node.attrs.leading, 'data-trailing': node.attrs.trailing }, 0],
      renderText: ({ node }) => promptEditorText({ type: 'doc', content: [node.toJSON()] }),
      addNodeView: () => ReactNodeViewRenderer(PromptManagedSectionView),
    }),
    TiptapNode.create({
      name: 'promptReference', group: 'inline', inline: true, atom: true, selectable: false,
      addOptions: () => ({ runtime }),
      addAttributes: () => ({ assetId: { default: '' }, label: { default: '引用图片' }, url: { default: '' }, required: { default: false },
        nodeId: { default: '' }, description: { default: '' }, provenance: { default: '' }, invalid: { default: false } }),
      parseHTML: () => [{ tag: 'span[data-prompt-reference]' }],
      renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-prompt-reference': node.attrs.assetId }), referenceToken(node.attrs.assetId)],
      renderText: ({ node }) => referenceToken(node.attrs.assetId),
      addNodeView: () => ReactNodeViewRenderer(PromptReferenceView),
    }),
    Extension.create({
      name: 'promptReferenceProtection',
      addGlobalAttributes: () => [{ types: ['paragraph'], attributes: { promptBodyEntry: { default: false, keepOnSplit: true,
        parseHTML: element => element.hasAttribute('data-prompt-body-entry'),
        renderHTML: attributes => attributes.promptBodyEntry ? { 'data-prompt-body-entry': '' } : {} }, promptBodySegment: { default: null, keepOnSplit: true,
        parseHTML: element => element.getAttribute('data-prompt-body-segment'),
        renderHTML: attributes => attributes.promptBodySegment ? { 'data-prompt-body-segment': attributes.promptBodySegment } : {} } } }],
      addProseMirrorPlugins: () => [promptPresentationPlugin(() => runtime().placeholder), new Plugin({
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged || transaction.getMeta('promptReferenceSync') || transaction.getMeta('preventUpdate')) return true
          if (promptEditorText(transaction.doc.toJSON()).length > runtime().maxLength) return false
          if (isHistoryTransaction(transaction) || transaction.getMeta('promptSectionRemove') || transaction.getMeta('promptDocumentReplace')) return true
          const oldSections = managedSections(state.doc.toJSON()), newSections = managedSections(transaction.doc.toJSON())
          if (oldSections.some(section => !newSections.some(next => next.attrs?.section.id === section.attrs?.section.id
            && next.attrs?.section.name === section.attrs?.section.name))) return false
          const required = new Set(runtime().references.filter(item => item.required).map(item => item.assetId))
          if (!required.size) return true
          const before = referenceCounts(state.doc.toJSON()), after = referenceCounts(transaction.doc.toJSON())
          return [...required].every(id => (after.get(id) || 0) >= (before.get(id) || 0))
        },
        appendTransaction: (transactions, before, after) => {
          // Keep source snapshots in the same history event as a chip edit.
          // Otherwise onChange can replay stale node metadata over the parent's
          // rewritten source and manufacture a source-conflict notification.
          if (transactions.every(transaction => !transaction.docChanged || transaction.getMeta('promptReferenceMetadata')
            || transaction.getMeta('promptReferenceSync') || transaction.getMeta('preventUpdate'))
            || transactions.some(transaction => isHistoryTransaction(transaction) || transaction.getMeta('promptSectionRemove')
              || transaction.getMeta('promptDocumentReplace'))) return null
          const explicit = transactions.map(transaction => transaction.getMeta('promptReferenceChange') as ReferenceChange | undefined).find(Boolean)
          const changes = changedReferences(before.doc.toJSON(), after.doc.toJSON(), explicit)
          if (!changes.length) return null
          let transaction = after.tr
          after.doc.descendants((node, position) => {
            if (node.type.name !== 'promptManagedSection') return
            const section = changes.reduce(rewriteSectionReference, node.attrs.section as PromptSectionBlock)
            if (JSON.stringify(section) !== JSON.stringify(node.attrs.section)) transaction = transaction.setNodeMarkup(position, undefined, { ...node.attrs, section })
          })
          return transaction.docChanged ? transaction.setMeta('promptReferenceMetadata', true) : null
        },
        props: {
          handleKeyDown: (view, event) => {
            if (runtime().keydown(event)) return true
            if (event.isComposing || !['Backspace', 'Delete'].includes(event.key) || !view.state.selection.empty) return false
            const { $from } = view.state.selection
            if ($from.depth < 2 || $from.node($from.depth - 1).type.name !== 'promptManagedSection') return false
            const atStart = $from.index($from.depth - 1) === 0 && $from.parentOffset === 0
            const atEnd = $from.index($from.depth - 1) === $from.node($from.depth - 1).childCount - 1 && $from.parentOffset === $from.parent.content.size
            if (event.key === 'Backspace' && atStart || event.key === 'Delete' && atEnd) { event.preventDefault(); return true }
            return false
          },
          clipboardTextSerializer: promptClipboardText,
          clipboardTextParser: (text, $context, _plain, view) => {
            const input = promptEditorDocument(text, runtime().references, [...runtime().choices, ...runtime().additionalChoices])
            if ($context.depth > 1 && $context.node($context.depth - 1).type.name === 'promptManagedSection') {
              input.content = (input.content || []).flatMap(node => node.type === 'promptManagedSection' ? node.content || [] : [node])
            }
            const content = view.state.schema.nodeFromJSON(input).content
            return Slice.maxOpen(content, false)
          },
          transformPasted: (slice, view) => {
            let nodes = Array.from({ length: slice.content.childCount }, (_, index) => freshSectionIds(slice.content.child(index)))
            const target = view.state.selection.$from.parent
            // Pasted prose belongs to the current body segment. Copying entry
            // attributes into an unrelated body (or dropping them inside the
            // entry) would otherwise merge paragraphs during serialization.
            if (target.type.name === 'paragraph' && nodes.every(node => node.type.name === 'paragraph')) {
              nodes = nodes.map(node => node.type.create({ ...node.attrs,
                promptBodyEntry: target.attrs.promptBodyEntry, promptBodySegment: target.attrs.promptBodySegment }, node.content, node.marks))
            } else {
              const materialized: ProseMirrorNode[] = []
              for (let index = 0; index < nodes.length; index++) {
                const node = nodes[index]
                if (node.type.name !== 'paragraph' || !node.attrs.promptBodyEntry) { materialized.push(node); continue }
                const entry = [node]
                while (nodes[index + 1]?.type.name === 'paragraph' && nodes[index + 1]?.attrs.promptBodyEntry) entry.push(nodes[++index])
                const hasContent = entry.some(paragraph => paragraph.content.size > 0)
                // A whole-prompt HTML paste can merge its opening paragraph
                // into ordinary prose and lose entry attributes. Materialize
                // the virtual body/setting separation before that merge.
                materialized.push(...(hasContent ? entry : entry.slice(0, 1)).map(paragraph => paragraph.type.create({ ...paragraph.attrs,
                  promptBodyEntry: false, promptBodySegment: null }, paragraph.content, paragraph.marks)))
                if (hasContent && nodes[index + 1]?.type.name === 'promptManagedSection') {
                  materialized.push(node.type.create(), node.type.create())
                }
              }
              nodes = materialized
            }
            return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd)
          },
        },
      })],
    }),
  ]
}

export default function CanvasPromptEditor(props: CanvasPromptEditorProps) {
  const latest = useRef(props); latest.current = props
  const sectionDocumentRef = useRef(parsePromptSectionDocument(props.value, { previousDocument: props.sectionDocument }))
  const previousPropValue = useRef(props.value)
  const localChangeDepth = useRef(0), deferredValueSync = useRef(false)
  const [valueSyncVersion, setValueSyncVersion] = useState(0)
  const [picker, setPicker] = useState<Picker | null>(null)
  const [mentionAnchor, setMentionAnchor] = useState<{ left: number; top: number; height: number } | null>(null)
  const pickerRef = useRef(picker); pickerRef.current = picker
  const editorRef = useRef<Editor | null>(null)
  const previous = useRef<Map<string, number>>(new Map())
  const removedReferences = useRef(new Set<string>())
  const runtimeRef = useRef<Runtime>(null!)
  function runLocalChange<T>(operation: () => T): T {
    localChangeDepth.current++
    try { return operation() }
    finally {
      localChangeDepth.current--
      if (!localChangeDepth.current && deferredValueSync.current) {
        deferredValueSync.current = false
        setValueSyncVersion(version => version + 1)
      }
    }
  }
  const allReferences = () => uniqueReferences([...latest.current.references, ...latest.current.choices, ...(latest.current.additionalChoices || [])])
  const additionalChoices = () => {
    const activeIds = new Set(latest.current.choices.filter(item => !item.invalid).map(item => item.assetId))
    return uniqueReferences(latest.current.additionalChoices || []).filter(item => !activeIds.has(item.assetId))
  }
  const filteredChoices = (query: string, scope: Picker['scope'] = 'active') =>
    (scope === 'additional' ? additionalChoices() : uniqueReferences(latest.current.choices)).filter(item => referenceMatches(item, query))
  function closePicker() { pickerRef.current = null; setPicker(null) }
  function insertReference(reference: CanvasPromptReference) {
    const current = editorRef.current, range = pickerRef.current
    if (!current || !range || latest.current.disabled || latest.current.readOnly || reference.invalid) return
    const repair = latest.current.references.some(item => item.assetId === reference.assetId && item.invalid)
    const newReference = !referenceCounts(current.getJSON()).has(reference.assetId)
      && ![...latest.current.references, ...latest.current.choices].some(item => item.assetId === reference.assetId && !item.invalid)
    runLocalChange(() => {
      if (repair && latest.current.onReferenceChange?.(reference.assetId, reference.assetId) === false) return
      if (!repair && newReference && latest.current.onReferenceAdd?.(reference) === false) return
      closePicker()
      current.chain().focus().insertContentAt({ from: range.from, to: range.to }, [
        { type: 'promptReference', attrs: referenceAttributes(reference.assetId, allReferences()) },
        { type: 'text', text: ' ' },
      ]).setMeta('promptReferenceInsert', { assetId: reference.assetId, notified: true }).run()
    })
  }
  function pickerKeydown(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'preventDefault' | 'stopPropagation'>): boolean {
    const current = pickerRef.current
    if (!current || event.isComposing || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return false
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { closePicker(); return true }
    const choices = filteredChoices(current.query, current.scope)
    if (event.key === 'Enter') { if (choices.length) insertReference(choices[Math.min(current.index, choices.length - 1)]); return true }
    const index = choices.length ? (current.index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0
    pickerRef.current = { ...current, index }; setPicker(pickerRef.current)
    return true
  }
  function syncMention(current: Editor) {
    if (current.view.composing || latest.current.disabled || latest.current.readOnly) return
    const { $from, empty, from } = current.state.selection
    const match = empty && $from.parent.textBetween(0, $from.parentOffset, '\n', '\uFFFC').match(/@([^\s@]*)$/)
    if (!match) { if (!pickerRef.current?.manual) closePicker(); return }
    const query = match[1], range = { from: from - query.length - 1, to: from, query, index: pickerRef.current?.query === query ? pickerRef.current.index : 0, scope: pickerRef.current?.scope }
    pickerRef.current = range; setPicker(range)
  }
  runtimeRef.current = {
    references: props.references, choices: props.choices, additionalChoices: props.additionalChoices || [], disabled: !!props.disabled, readOnly: !!props.readOnly,
    maxLength: props.maxLength ?? 80_000,
    placeholder: props.placeholder || '描述主体、场景与构图，输入 @ 引用图片',
    keydown: event => event.isComposing ? false : pickerKeydown(event),
    removeSection: sectionId => {
      const current = editorRef.current
      if (!current || latest.current.disabled || latest.current.readOnly) return
      current.state.doc.forEach((node, offset) => {
        if (node.type.name !== 'promptManagedSection' || node.attrs.section.id !== sectionId) return
        runLocalChange(() => current.view.dispatch(closeHistory(current.state.tr.delete(offset, offset + node.nodeSize)
          .setMeta('promptSectionRemove', sectionId))))
      })
    },
    change: (sourceId, replacementId) => runLocalChange(() => {
      const current = editorRef.current
      if (!current || latest.current.disabled) return false
      if (sourceId === replacementId) return latest.current.onReferenceChange?.(sourceId, replacementId) !== false
      if (latest.current.references.some(item => item.assetId === sourceId && item.required)
        || (replacementId && allReferences().find(item => item.assetId === replacementId)?.invalid)) return false
      // System text stays read-only; reference actions update the bound inputs,
      // then the parent rebuilds this preview from those inputs.
      if (latest.current.readOnly) return latest.current.onReferenceChange?.(sourceId, replacementId) !== false
      const positions: number[] = []
      current.state.doc.descendants((node, position) => { if (node.type.name === 'promptReference' && node.attrs.assetId === sourceId) positions.push(position) })
      if (!positions.length || latest.current.onReferenceChange?.(sourceId, replacementId) === false) return false
      let transaction = current.state.tr
      for (const position of positions.reverse()) {
        if (replacementId) transaction = transaction.setNodeMarkup(position, undefined, referenceAttributes(replacementId, allReferences()))
        else transaction = transaction.delete(position, position + 1)
      }
      current.view.dispatch(transaction.setMeta('promptReferenceChange', { sourceId, replacementId, notified: true }))
      current.commands.focus()
      return true
    }),
  }
  const editor = useEditor({
    extensions: promptExtensions(() => runtimeRef.current),
    content: promptEditorDocument(props.value, props.references, [...props.choices, ...(props.additionalChoices || [])], sectionDocumentRef.current),
    editable: !props.disabled && !props.readOnly,
    editorProps: { handleDOMEvents: { keydown: (_view, event) => event.isComposing }, attributes: { class: 'pc-prompt-editor-content nodrag nowheel', role: 'textbox', 'aria-multiline': 'true', 'aria-label': props['aria-label'] || '创作提示词', 'data-placeholder': props.placeholder || '描述画面，输入 @ 引用图片' } },
    onCreate: ({ editor: current }) => { previous.current = referenceCounts(current.getJSON()) },
    onUpdate: ({ editor: current, transaction }) => {
      if (transaction.getMeta('promptReferenceSync') || latest.current.readOnly) return
      const document = current.getJSON(), counts = referenceCounts(document)
      const explicit = transaction.getMeta('promptReferenceChange') as { sourceId: string; replacementId: string | null; notified?: boolean } | undefined
      const insertion = transaction.getMeta('promptReferenceInsert') as { assetId: string; notified: boolean } | undefined
      const next = promptEditorText(document)
      if (next === promptEditorText(transaction.before.toJSON())) return
      const sectionsBefore = managedSections(transaction.before.toJSON()).map(node => node.attrs?.section.id).join('\0')
      const sectionsAfter = managedSections(document).map(node => node.attrs?.section.id).join('\0')
      const sectionChange = sectionsBefore !== sectionsAfter
      runLocalChange(() => {
        if (!isHistoryTransaction(transaction)) {
          const changes = changedReferences(transaction.before.toJSON(), document, explicit)
          if (changes.length) sectionDocumentRef.current = { ...sectionDocumentRef.current,
            blocks: sectionDocumentRef.current.blocks.map(block => changes.reduce(rewriteSectionReference, block)) }
        }
        const sections = promptEditorSectionDocument(document, sectionDocumentRef.current)
        // Reference callbacks may synchronously flush parent effects. Expose
        // this document first so such effects cannot replay its old metadata.
        sectionDocumentRef.current = sections
        previous.current.forEach((_count, assetId) => {
          if (!counts.has(assetId) && !sectionChange) {
            removedReferences.current.add(assetId)
            if (assetId !== explicit?.sourceId) latest.current.onReferenceChange?.(assetId, null)
          }
        })
        counts.forEach((_count, assetId) => {
          if (sectionChange) return
          if (previous.current.has(assetId) || assetId === explicit?.replacementId || (insertion?.notified && insertion.assetId === assetId)) return
          if (removedReferences.current.has(assetId)) {
            removedReferences.current.delete(assetId)
            latest.current.onReferenceChange?.(assetId, assetId)
          } else if (![...latest.current.references, ...latest.current.choices].some(item => item.assetId === assetId && !item.invalid)) {
            const added = latest.current.additionalChoices?.find(item => item.assetId === assetId && !item.invalid)
            if (added) latest.current.onReferenceAdd?.(added)
          }
        })
        previous.current = counts
        if (explicit && !explicit.notified) latest.current.onReferenceChange?.(explicit.sourceId, explicit.replacementId)
        latest.current.onChange(next, sections)
        syncMention(current)
      })
    },
    onSelectionUpdate: ({ editor: current }) => syncMention(current),
  }, [])
  editorRef.current = editor
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!props.disabled && !props.readOnly)
    editor.view.dom.setAttribute('aria-label', props['aria-label'] || '创作提示词')
    editor.view.dom.setAttribute('aria-disabled', String(!!props.disabled))
    editor.view.dom.setAttribute('aria-readonly', String(!!props.readOnly))
    editor.view.dom.setAttribute('data-placeholder', props.placeholder || '描述画面，输入 @ 引用图片')
    if (props.disabled || props.readOnly) closePicker()
  }, [editor, props.disabled, props.readOnly, props.placeholder, props['aria-label']])
  useEffect(() => {
    if (!editor) return
    const references = [...props.references, ...props.choices, ...(props.additionalChoices || [])]
    // New chip views can synchronously flush a parent's rebuilt system blocks
    // before onChange echoes the inserted token. Wait for the local operation
    // to finish before applying a different parent value.
    if (previousPropValue.current !== props.value && localChangeDepth.current) deferredValueSync.current = true
    else if (previousPropValue.current !== props.value) {
      previousPropValue.current = props.value
      sectionDocumentRef.current = parsePromptSectionDocument(props.value, { previousDocument: props.sectionDocument || sectionDocumentRef.current })
      const document = promptEditorDocument(props.value, props.references, [...props.choices, ...(props.additionalChoices || [])], sectionDocumentRef.current)
      // Parent echoes must keep the editor's selection, composition and history.
      if (promptEditorText(editor.getJSON()) !== promptEditorText(document)
        || managedSections(editor.getJSON()).map(node => node.attrs?.section.id).join('\0') !== managedSections(document).map(node => node.attrs?.section.id).join('\0')) {
        editor.commands.setContent(document, { emitUpdate: false })
        previous.current = referenceCounts(document)
      }
    }
    let transaction = editor.state.tr
    if (!localChangeDepth.current && props.sectionDocument) sectionDocumentRef.current = props.sectionDocument
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'promptManagedSection') {
        const section = sectionDocumentRef.current.blocks.find(block => block.kind === 'managed' && !block.deleted && block.id === node.attrs.section.id)
        if (section && JSON.stringify(section) !== JSON.stringify(node.attrs.section)) transaction = transaction.setNodeMarkup(position, undefined, { ...node.attrs, section })
        return
      }
      if (node.type.name !== 'promptReference') return
      const attrs = referenceAttributes(node.attrs.assetId, references)
      if (JSON.stringify(node.attrs) !== JSON.stringify(attrs)) transaction = transaction.setNodeMarkup(position, undefined, attrs)
    })
    if (transaction.docChanged) editor.view.dispatch(transaction.setMeta('promptReferenceSync', true).setMeta('addToHistory', false))
  }, [editor, props.value, props.sectionDocument, props.references, props.choices, props.additionalChoices, valueSyncVersion])
  useLayoutEffect(() => {
    if (!editor || !picker) { setMentionAnchor(null); return }
    const view = editor.view, element = view.dom, viewport = element.ownerDocument.defaultView!
    let frame = 0
    const update = () => {
      frame = 0
      if (editor.isDestroyed || picker.from > editor.state.doc.content.size) { setMentionAnchor(null); return }
      const caret = view.coordsAtPos(picker.from)
      // A portaled anchor avoids canvas transforms and modal clipping. Hide the
      // picker when the @ itself scrolls out of the editor or its scroll parents.
      let top = 0, left = 0, bottom = viewport.innerHeight, right = viewport.innerWidth
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        const style = viewport.getComputedStyle(parent), bounds = parent.getBoundingClientRect()
        if (parent === element || /(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom)
        }
        if (parent === element || /(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left); right = Math.min(right, bounds.right)
        }
      }
      const next = caret.bottom > top && caret.top < bottom && caret.left >= left && caret.left <= right
        ? { left: caret.left, top: caret.top, height: Math.max(1, caret.bottom - caret.top) } : null
      setMentionAnchor(previous => previous?.left === next?.left && previous?.top === next?.top && previous?.height === next?.height ? previous : next)
    }
    const schedule = () => { if (!frame) frame = viewport.requestAnimationFrame(update) }
    update()
    viewport.addEventListener('scroll', schedule, true)
    viewport.addEventListener('resize', schedule)
    viewport.visualViewport?.addEventListener('resize', schedule)
    viewport.visualViewport?.addEventListener('scroll', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)
    return () => {
      viewport.cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', schedule, true)
      viewport.removeEventListener('resize', schedule)
      viewport.visualViewport?.removeEventListener('resize', schedule)
      viewport.visualViewport?.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [editor, picker?.from, picker?.to, props.expanded])
  const choices = picker ? filteredChoices(picker.query, picker.scope) : []
  const showAdditional = picker?.scope === 'additional'
  function changeScope(scope: Picker['scope']) {
    if (!pickerRef.current) return
    pickerRef.current = { ...pickerRef.current, scope, query: '', index: 0, manual: true }
    setPicker(pickerRef.current)
  }
  return <div className={`pc-prompt-editor${props.expanded ? ' is-expanded' : ''}${props.compact ? ' is-compact' : ''}${props.disabled ? ' is-disabled' : ''}${props.readOnly ? ' is-readonly' : ''}`} style={{ '--pc-prompt-min-rows': props.minRows || 6 } as React.CSSProperties}>
    <div className="pc-prompt-editor-surface">
      {!props.compact && <div className="pc-prompt-editor-heading"><span>提示词正文</span><span>输入 <kbd>@</kbd> 引用图片</span></div>}
      <EditorContent editor={editor} />
    </div>
    <Popover opened={!!picker && !!mentionAnchor} onDismiss={closePicker} position="bottom-start" offset={5} width="min(320px, calc(100vw - 16px))"
      floatingStrategy="fixed" preventPositionChangeWhenVisible={false} middlewares={{ flip: { padding: 8 }, shift: { padding: 8 } }}
      withinPortal zIndex={270} returnFocus={false} withRoles={false}>
      <Portal><Popover.Target><span className="pc-prompt-mention-anchor" aria-hidden="true" style={mentionAnchor || undefined} /></Popover.Target></Portal>
      <Popover.Dropdown className="pc-prompt-mention-menu" onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        if (!(event.target instanceof HTMLElement && event.target.closest('button'))) pickerKeydown(event.nativeEvent)
        event.stopPropagation()
      }}>
        <div className="pc-prompt-reference-picker-heading">{showAdditional
          ? <UnstyledButton type="button" className="pc-prompt-reference-scope" onClick={() => changeScope('active')}><ArrowLeft size={13} />返回当前节点引用</UnstyledButton>
          : <><strong>当前节点引用</strong><span>选择参考并补充使用方式</span></>}</div>
        <TextInput aria-label="搜索可引用图片" placeholder="搜索图片" value={picker?.query || ''} size="xs" leftSection={<Search size={14} />}
          onChange={event => { if (pickerRef.current) { pickerRef.current = { ...pickerRef.current, query: event.currentTarget.value, index: 0 }; setPicker(pickerRef.current) } }} />
        <ScrollArea.Autosize mah={260}><div className="pc-prompt-reference-options" role="listbox" aria-label="可引用图片">{choices.map((reference, index) => <UnstyledButton type="button" key={reference.assetId}
          role="option" aria-selected={index === Math.min(picker?.index || 0, choices.length - 1)} className={`pc-prompt-reference-option${index === Math.min(picker?.index || 0, choices.length - 1) ? ' is-highlighted' : ''}`}
          onMouseDown={event => event.preventDefault()} onClick={() => insertReference(reference)}>
          {reference.url ? <img src={reference.url} alt="" /> : <ImageIcon size={18} />}<ReferenceDetails reference={reference} />{reference.required && <Check size={13} />}
        </UnstyledButton>)}{!choices.length && <p>{showAdditional ? '没有匹配的其他参考' : '暂无匹配的节点参考，可先连接参考节点'}</p>}</div></ScrollArea.Autosize>
        {!showAdditional && additionalChoices().some(item => !item.invalid) && <UnstyledButton type="button" className="pc-prompt-reference-add" onClick={() => changeScope('additional')}><Plus size={14} />添加其他参考</UnstyledButton>}
      </Popover.Dropdown>
    </Popover>
  </div>
}
