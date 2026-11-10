import { useMemo } from 'react'
import { Badge, Button, UnstyledButton } from '@mantine/core'
import { ChevronDown, FileText, MessageSquare, PenLine } from 'lucide-react'
import { scriptArtifactLabels, scriptStageArtifacts, type StageArtifactType } from '@video-studio/shared/script/script-stage-content'
import type { ScriptArtifact, ScriptGenerationProgress } from '../../shared/api/api'
import { textDocumentText } from '../../shared/lib/editor/text-document'
import { parseScriptDocument } from '../script/script-rich-document'
import { CanvasTextPreview } from './CanvasTextEditor'

export type CanvasScriptSection = 'outline' | 'characters' | 'locations' | 'props' | 'episodes'
type Props = {
  section: CanvasScriptSection
  artifacts?: ScriptArtifact[]
  outline?: string
  characters?: string
  progress?: ScriptGenerationProgress | null
  onOpenDocument?: (artifact: ScriptArtifact) => void
  onOpenDirector: () => void
}
type DocumentEntry = {
  key: string; type: StageArtifactType; episode: number; title: string; content: string
  draft: boolean; saved?: ScriptArtifact
}

function DocumentBody({ content }: { content: string }) {
  const document = useMemo(() => parseScriptDocument(content), [content])
  return <CanvasTextPreview text={textDocumentText(document)} document={document} />
}

/** A separate reading surface for persisted generation drafts. Accepted script
 * data stays untouched, including when a candidate replaces an existing item. */
export default function CanvasScriptDocuments({ section, artifacts = [], outline, characters, progress, onOpenDocument, onOpenDirector }: Props) {
  const types: readonly StageArtifactType[] = section === 'episodes' ? scriptStageArtifacts.episode : scriptStageArtifacts[section]
  const entries: DocumentEntry[] = []
  for (const type of types) {
    const saved = artifacts.filter(item => item.artifact_type === type && item.content.trim()
      && (section === 'episodes' ? (item.episode_number || 0) > 0 : !item.episode_number))
    const pending = (progress?.documents || []).filter(item => item.artifact_type === type && item.content.trim()
      && (section === 'episodes' ? item.episode_number > 0 : item.episode_number === 0))
    for (const item of pending) {
      // The commit and project refresh can overlap. An identical confirmed
      // document owns the display as soon as it appears in accepted data.
      if (saved.some(original => (original.episode_number || 0) === item.episode_number && original.title === item.title && original.content === item.content)) continue
      entries.push({ key: `${type}:${item.episode_number}:draft`, type, episode: item.episode_number,
        title: item.title, content: item.content, draft: true })
    }
    for (const item of saved) entries.push({ key: `${type}:${item.episode_number || 0}:saved:${item.id}`, type,
      episode: item.episode_number || 0, title: item.title, content: item.content, draft: false, saved: item })
    const legacy = type === 'outline' ? outline : type === 'characters' ? characters : undefined
    if (!saved.length && legacy?.trim()) entries.push({ key: `${type}:legacy`, type, episode: 0,
      title: scriptArtifactLabels[type], content: legacy, draft: false })
  }
  if (section === 'episodes') entries.sort((a, b) => a.episode - b.episode || Number(b.draft) - Number(a.draft))

  if (!entries.length) return section === 'episodes' ? <div className="pc-script-empty-state">
    <strong>还没有分集剧本</strong>
    <p>在对话中创作本集，确认保存后即可制作分镜。</p>
    <Button type="button" className="pc-project-script-edit" aria-label="打开分集创作对话"
      onClick={event => { event.stopPropagation(); onOpenDirector() }} data-workspace-control="" variant="subtle"><MessageSquare size={14} />打开剧本对话</Button>
  </div> : <>暂无{section === 'outline' ? '故事大纲' : section === 'characters' ? '人物小传' : section === 'locations' ? '场景设计' : '道具设计'}，可在导演对话中生成</>

  // Existing episode cards continue opening their accepted screenplay directly.
  if (section === 'episodes' && !entries.some(item => item.draft)) return <div className="pc-script-episodes">{entries.map(item => <UnstyledButton key={item.key} type="button"
    onClick={event => { event.stopPropagation(); if (item.saved) onOpenDocument?.(item.saved) }}>
    <FileText size={16} /><span><strong>{item.title}</strong><small>已保存 · 点击编辑本集</small></span><ChevronDown size={14} />
  </UnstyledButton>)}</div>

  return <div className="pc-script-documents" aria-label="已保存的剧本栏目">
    {entries.map(item => <section className="pc-script-document-reader" aria-label={`${scriptArtifactLabels[item.type]}正文`} key={item.key}>
      <div className="pc-script-document-heading">
        <strong>{item.title}</strong>
        <Badge variant="light" color={item.draft ? 'blue' : 'gray'}>{item.draft ? '已保存草稿 · 待确认' : '已保存文档'}</Badge>
        {item.saved && onOpenDocument && <Button type="button" size="compact-xs" variant="subtle" data-workspace-control=""
          onClick={event => { event.stopPropagation(); onOpenDocument(item.saved!) }}><PenLine size={12} />编辑文档</Button>}
      </div>
      <DocumentBody content={item.content} />
    </section>)}
  </div>
}
