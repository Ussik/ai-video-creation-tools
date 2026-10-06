import { useMemo, useState } from 'react'
import { Select } from '@mantine/core'
import { CheckCircle2, ChevronDown, ChevronRight, FileText, LoaderCircle, PenLine, X } from 'lucide-react'
import type { ScriptGenerationOptions } from './api'
import { CanvasTextPreview } from './CanvasTextEditor'
import { parseScriptDocument } from './script-rich-document'
import { textDocumentText } from './text-document'
import { artifactKey, workflowLabels } from './script-workflow'
import type { WorkflowArtifact, WorkflowRequest, WorkflowScene } from './script-workflow'

type DirectorDraft = {
  workflow?: WorkflowRequest; generation_options?: ScriptGenerationOptions
  outline: string; characters: string; scenes: WorkflowScene[]; artifacts: WorkflowArtifact[]
}

export function DirectorDocumentBody({ text }: { text: string }) {
  const document = useMemo(() => parseScriptDocument(text), [text])
  return <CanvasTextPreview text={textDocumentText(document)} document={document} />
}

export function DirectorSceneList({ scenes, onChange, disabled = false }: {
  scenes: WorkflowScene[]; onChange?: (index: number, scene: WorkflowScene) => void; disabled?: boolean
}) {
  return <div className="sd-scene-list">{scenes.map((scene, index) => <details className="sd-scene" key={index} open={index === 0 ? true : undefined}>
    <summary><span className="sd-scene-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{scene.heading || scene.location || '未命名场次'}</strong><small>{[scene.location, scene.time_of_day, scene.characters].filter(Boolean).join(' · ')}</small></span><em>{scene.duration} 秒</em><ChevronDown size={14} /></summary>
    <div className="sd-scene-content">{onChange ? <>
      <div className="sd-scene-fields">{(['heading', 'location', 'time_of_day', 'characters'] as const).map((key, fieldIndex) => <label key={key}>{['场次标题', '地点', '时间', '人物'][fieldIndex]}<input aria-label={`第${index + 1}场${['标题', '地点', '时间', '人物'][fieldIndex]}`} value={scene[key]} disabled={disabled} onChange={event => onChange(index, { ...scene, [key]: event.currentTarget.value })} /></label>)}
      <label>时长（秒）<input type="number" min={1} max={30} value={scene.duration} disabled={disabled} aria-label={`第${index + 1}场时长`} onChange={event => onChange(index, { ...scene, duration: Math.max(1, Math.min(30, Number(event.currentTarget.value) || 1)) })} /></label></div>
      {(['action', 'dialogue', 'narration'] as const).map((key, fieldIndex) => <label key={key}>{['画面与动作', '对白', '旁白'][fieldIndex]}<textarea value={scene[key]} disabled={disabled} aria-label={`第${index + 1}场${['动作', '对白', '旁白'][fieldIndex]}`} onChange={event => onChange(index, { ...scene, [key]: event.currentTarget.value })} /></label>)}
    </> : <>{(['action', 'dialogue', 'narration'] as const).filter(key => scene[key]?.trim()).map(key => <div className={`sd-scene-passage is-${key}`} key={key}><small>{{ action: '画面与动作', dialogue: '对白', narration: '旁白' }[key]}</small><DirectorDocumentBody text={scene[key]} /></div>)}</>}</div>
  </details>)}</div>
}

export default function DirectorDraftReview({ draft, busy, saving, saved, onChange, onClose, onSave }: {
  draft: DirectorDraft; busy: boolean; saving: boolean; saved: boolean
  onChange: (draft: DirectorDraft) => void; onClose: () => void; onSave: () => void
}) {
  const [selection, setSelection] = useState('')
  const [editing, setEditing] = useState(false)
  const documents = draft.workflow ? draft.artifacts.map(artifact => ({ key: artifactKey(artifact), title: artifact.title, content: artifact.content })) : [
    { key: 'legacy-outline', title: '故事大纲', content: draft.outline },
    { key: 'legacy-characters', title: '人物设定', content: draft.characters },
    ...draft.artifacts.filter(artifact => !['outline', 'characters', 'structure'].includes(artifact.artifact_type)).map(artifact => ({ key: artifactKey(artifact), title: artifact.title, content: artifact.content })),
  ]
  const entries = [...documents.map(document => ({ value: document.key, label: document.title })), ...(draft.scenes.length ? [{ value: 'scene-list', label: `分场信息 · ${draft.scenes.length} 场` }] : [])]
  const activeKey = entries.some(entry => entry.value === selection) ? selection : entries[0]?.value || ''
  const activeDocument = documents.find(document => document.key === activeKey)
  const title = draft.workflow ? draft.workflow.stage === 'episode' ? `第 ${draft.workflow.episode_number} 集草稿` : workflowLabels[draft.workflow.stage] : '创作草稿'
  const updateContent = (content: string) => onChange(activeKey === 'legacy-outline' ? { ...draft, outline: content } : activeKey === 'legacy-characters' ? { ...draft, characters: content } : { ...draft, artifacts: draft.artifacts.map(artifact => artifactKey(artifact) === activeKey ? { ...artifact, content } : artifact) })
  return <section className="script-director-preview sd-draft-review" aria-label="剧本草稿预览">
    <div className="script-director-preview-head"><div><FileText size={17} /><strong>{title}</strong><span className="sd-document-status">{saved ? '已保存' : '待确认'}</span></div><button type="button" onClick={onClose} aria-label="收起预览" title="收起后可从创作成果重新打开"><X size={17} /></button></div>
    <div className="sd-document-toolbar"><Select className="sd-document-select" aria-label="选择草稿文档" value={activeKey || null} data={entries} allowDeselect={false} rightSection={<ChevronDown size={14} />} comboboxProps={{ withinPortal: true, zIndex: 400 }} onChange={value => value && setSelection(value)} />
      <div className="sd-view-switch" role="group" aria-label="草稿展示方式"><button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>阅读</button><button type="button" aria-pressed={editing} disabled={busy || saved} onClick={() => setEditing(true)}><PenLine size={12} />编辑</button></div>
    </div>
    <div className="sd-document-meta"><span>{documents.length} 份文档{draft.scenes.length ? ` · ${draft.scenes.length} 场 · ${draft.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒` : ''}</span><span>{editing ? '修改将随确认一起保存' : '确认后写入项目'}</span></div>
    <div className="script-director-preview-scroll" key={`${activeKey}:${editing}`}>
      {activeKey === 'scene-list' ? <DirectorSceneList scenes={draft.scenes} disabled={busy || saved} onChange={editing ? (index, scene) => onChange({ ...draft, scenes: draft.scenes.map((item, itemIndex) => itemIndex === index ? scene : item) }) : undefined} />
        : activeDocument && <div className="sd-document-page"><h2>{activeDocument.title}</h2>{editing ? <label className="sd-document-edit-label"><span>文档正文</span><textarea className="sd-document-editor" maxLength={20000} aria-label={`编辑草稿：${activeDocument.title}`} value={activeDocument.content} disabled={busy || saved} onChange={event => updateContent(event.currentTarget.value)} /></label> : <DirectorDocumentBody text={activeDocument.content} />}</div>}
    </div>
    <div className="script-director-preview-actions"><button type="button" className="sd-document-secondary" onClick={onClose}>稍后处理</button><button type="button" className="sd-document-primary" onClick={onSave} disabled={busy || saved}>{saving ? <LoaderCircle size={14} className="script-director-spinner" /> : <CheckCircle2 size={14} />}{saved ? '已保存' : '确认保存'}{!saving && !saved && <ChevronRight size={14} />}</button></div>
  </section>
}
