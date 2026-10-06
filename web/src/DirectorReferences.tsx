import { FileText, X } from 'lucide-react'
import type { DirectorReference } from './director-references'

export default function DirectorReferences({ documents, onOpen, onRemove, disabled }: {
  disabled?: boolean
  documents: DirectorReference[]
  onOpen: (document: DirectorReference) => void
  onRemove?: (key: string) => void
}) {
  if (!documents.length) return null
  return <div className={`sd-reference-list${onRemove ? ' is-composing' : ''}`} aria-label={onRemove ? '待发送的引用文档' : '已发送的引用文档'}>
    {documents.map(document => <div className="sd-reference-card" key={document.key}>
      <button type="button" className="sd-reference-open" aria-label={`查看引用文档：${document.title}`} onClick={() => onOpen(document)}>
        <span className="sd-reference-preview" aria-hidden="true">{document.content.slice(0, 280)}</span>
        <span className="sd-reference-title"><FileText size={17} /><strong title={document.title}>{document.title}</strong></span>
        <span className="sd-reference-caption">{document.episode_number ? `第 ${document.episode_number} 集 · ` : ''}引用文档 · {document.content.length.toLocaleString()} 字</span>
      </button>
      {onRemove && <button type="button" className="sd-reference-remove" disabled={disabled} aria-label={`移除引用文档：${document.title}`} onClick={() => onRemove(document.key)}><X size={13} /></button>}
    </div>)}
  </div>
}
