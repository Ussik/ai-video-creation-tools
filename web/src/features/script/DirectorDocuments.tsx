import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { useId, useMemo, useState } from 'react'
import { Progress, TextInput, NumberInput, Textarea, Button, ActionIcon, UnstyledButton, Select } from '@mantine/core'
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, FileText, LoaderCircle, PenLine, X } from 'lucide-react'
import type { ScriptGenerationOptions } from '../../shared/api/api'
import { CanvasTextPreview } from '../canvas/CanvasTextEditor'
import { omitRepeatedScriptTitle, parseScriptDocument } from './script-rich-document'
import { textDocumentText } from '../../shared/lib/editor/text-document'
import { artifactKey, workflowLabels } from './script-workflow'
import type { WorkflowArtifact, WorkflowRequest, WorkflowScene } from './script-workflow'
import type { ScriptToolDraft } from './script-tools'
import { documentChangePreview, editedToolDraft } from './script-tools'
import type { RevisionTask } from '@video-studio/shared/script/script-revision-types'
import type { ResourceChange } from '@video-studio/shared/script/script-resource-types'
import type { ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import DirectorResourceDraft from './DirectorResourceDraft'

type DirectorDraft = {
  source_update?: ScriptSourceUpdate
  workflow?: WorkflowRequest; generation_options?: ScriptGenerationOptions
  tool_draft?: ScriptToolDraft
  resource_changes?: ResourceChange[]
  outline: string; characters: string; scenes: WorkflowScene[]; artifacts: WorkflowArtifact[]
}

export function DirectorDocumentBody({ text, title }: { text: string; title?: string }) {
  const document = useMemo(() => omitRepeatedScriptTitle(parseScriptDocument(text), title), [text, title])
  return <CanvasTextPreview text={textDocumentText(document)} document={document} />
}

export function DirectorSceneList({ scenes, onChange, disabled = false }: {
  scenes: WorkflowScene[]; onChange?: (index: number, scene: WorkflowScene) => void; disabled?: boolean
}) {
  return <div className="sd-scene-list">{scenes.map((scene, index) => <WorkspaceDisclosure className="sd-scene" key={index} initiallyOpen={index === 0 ? true : undefined} label={<><span className="sd-scene-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{scene.heading || scene.location || '未命名场次'}</strong><small>{[scene.location, scene.time_of_day, scene.characters].filter(Boolean).join(' · ')}</small></span><em>{scene.duration} 秒</em><ChevronDown size={14} /></>}>

    <div className="sd-scene-content">{onChange ? <>
      <div className="sd-scene-fields">{(['heading', 'location', 'time_of_day', 'characters'] as const).map((key, fieldIndex) => <label key={key}>{['场次标题', '地点', '时间', '人物'][fieldIndex]}<TextInput aria-label={`第${index + 1}场${['标题', '地点', '时间', '人物'][fieldIndex]}`} value={scene[key]} disabled={disabled} onChange={event => onChange(index, { ...scene, [key]: event.currentTarget.value })} /></label>)}
      <label>时长（秒）<NumberInput  min={1} max={30} value={scene.duration} disabled={disabled} aria-label={`第${index + 1}场时长`} onChange={value => onChange(index, { ...scene, duration: Math.max(1, Math.min(30, Number(value) || 1)) })} clampBehavior="none" /></label></div>
      {(['action', 'dialogue', 'narration'] as const).map((key, fieldIndex) => <label key={key}>{['画面与动作', '对白', '旁白'][fieldIndex]}<Textarea value={scene[key]} disabled={disabled} aria-label={`第${index + 1}场${['动作', '对白', '旁白'][fieldIndex]}`} onChange={event => onChange(index, { ...scene, [key]: event.currentTarget.value })} /></label>)}
    </> : <>{(['action', 'dialogue', 'narration'] as const).filter(key => scene[key]?.trim()).map(key => <div className={`sd-scene-passage is-${key}`} key={key}><small>{{ action: '画面与动作', dialogue: '对白', narration: '旁白' }[key]}</small><DirectorDocumentBody text={scene[key]} /></div>)}</>}</div>
  </WorkspaceDisclosure>)}</div>
}

export function RevisionProgress({ task, working = false }: { task: RevisionTask; working?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const complete = task.documents.filter(doc => ['verified', 'unchanged'].includes(doc.status)).length
  const blocked = [...task.documents, ...task.references].filter(item => item.status === 'blocked').length
  const needsAttention = task.status === 'needs_attention' || blocked > 0
  const status = needsAttention ? '需要处理' : working ? '进行中' : task.status === 'ready' ? '已核对' : '未完成'
  const labels = { pending: '待处理', revised: '已修订，待核对', verified: '核对通过', unchanged: '无需修改', blocked: '需要处理' }
  return <div className={`sd-revision-progress${needsAttention ? ' needs-attention' : ''}`} aria-label="统一修订进度">
    <div className="sd-revision-summary">
      <Button type="button" className="sd-revision-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)} data-workspace-control="" variant="subtle">
        {expanded ? '收起修订进度' : '查看修订进度'}{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </Button>
      <span className="sd-revision-meta" role="status"><span>文档 {complete}/{task.documents.length}</span><span className="sd-revision-state">{needsAttention && <CircleAlert size={12} aria-hidden="true" />}{status}</span></span>
    </div>
    {needsAttention && <p className="sd-revision-attention">{blocked ? `${blocked} 项内容需要处理` : '统一修订需要进一步处理'}，展开可查看原因。</p>}
    {expanded && <div id={detailsId} className="sd-revision-details">
      <div className="sd-revision-detail-head"><strong>{needsAttention ? '统一修订需要处理' : working ? '正在统一修订' : task.status === 'ready' ? '统一核对完成' : '统一修订未完成'}</strong><span>已提交 {task.batches} 批</span></div>
      <Progress value={complete / Math.max(1, task.documents.length) * 100} aria-label="已核对文档" />
      <WorkspaceDisclosure label={<>处理范围与待办 · {task.documents.length} 份文档{task.references.length ? ` · ${task.references.length} 项关联内容` : ''}</>}><ul>{task.documents.map(doc => <li key={doc.id}><span>{doc.title}</span><em>{labels[doc.status]}</em>{doc.note && <p>{doc.note}</p>}</li>)}{task.references.map(ref => <li key={`${ref.kind}:${ref.id}`}><span>{ref.title} · 关联核对</span><em>{labels[ref.status]}</em>{ref.note && <p>{ref.note}</p>}</li>)}</ul></WorkspaceDisclosure>
      {!!task.decisions.length && <WorkspaceDisclosure label={<>拟定的统一设定 · {task.decisions.length} 项</>}><p>这些决定随草稿保存后才正式采用。</p><ul>{task.decisions.map(choice => <li key={choice.topic}><strong>{choice.topic}</strong><p>{choice.choice}</p><small>{choice.reason}</small></li>)}</ul></WorkspaceDisclosure>}
    </div>}
  </div>
}

export default function DirectorDraftReview({ draft, busy, saving, saved, onChange, onClose, onSave, onDiscard, onContinue, profileNames = {}, sceneNames = {} }: {
  draft: DirectorDraft; busy: boolean; saving: boolean; saved: boolean
  onChange: (draft: DirectorDraft) => void; onClose: () => void; onSave: () => void
  onDiscard?: () => void
  onContinue?: () => void
  profileNames?: Record<string, string>; sceneNames?: Record<string, string>
}) {
  const [selection, setSelection] = useState('')
  const [editing, setEditing] = useState(false)
  const stageDocuments = draft.workflow || draft.tool_draft ? draft.artifacts.map(artifact => ({ key: artifactKey(artifact), title: artifact.title, content: artifact.content })) : [
    { key: 'legacy-outline', title: '故事大纲', content: draft.outline },
    { key: 'legacy-characters', title: '人物设定', content: draft.characters },
    ...draft.artifacts.filter(artifact => !['outline', 'characters', 'structure'].includes(artifact.artifact_type)).map(artifact => ({ key: artifactKey(artifact), title: artifact.title, content: artifact.content })),
  ]
  const documents = [...(draft.source_update ? [{ key: 'source-revision', title: '文稿修订 · 当前有效稿', content: draft.source_update.content }] : []), ...stageDocuments]
  const resources = draft.resource_changes || draft.tool_draft?.resource_changes || []
  const entries = [...documents.map(document => ({ value: document.key, label: document.title })), ...resources.map((change, index) => ({ value: `resource:${index}`, label: change.title })), ...(draft.scenes.length ? [{ value: 'scene-list', label: `分场信息 · ${draft.scenes.length} 场` }] : [])]
  const activeKey = entries.some(entry => entry.value === selection) ? selection : entries[0]?.value || ''
  const activeDocument = documents.find(document => document.key === activeKey)
  const title = draft.tool_draft?.kind === 'resource' ? '视觉设定与分镜草稿' : draft.tool_draft?.kind === 'patch' ? '文档修订草稿' : draft.workflow ? draft.workflow.stage === 'episode' ? `第 ${draft.workflow.episode_number} 集草稿` : workflowLabels[draft.workflow.stage] : '创作草稿'
  const resourceIndex = activeKey.startsWith('resource:') ? Number(activeKey.slice(9)) : -1
  const activeResource = resources[resourceIndex]
  const original = activeKey === 'source-revision' ? draft.source_update : draft.tool_draft?.documents.find(document => artifactKey(document) === activeKey)
  const task = draft.tool_draft?.revision_task
  const dirty = !!task && editedToolDraft(draft.tool_draft!, draft.artifacts, draft.scenes, draft.resource_changes, draft.source_update).changed
  const incomplete = !!task && (task.status !== 'ready' || dirty)
  const progressTask: RevisionTask | undefined = dirty && task ? { ...task, status: 'in_progress',
    documents: task.documents.map(doc => ({ ...doc, status: draft.tool_draft!.documents.some(proposed => proposed.id === doc.id) ? 'revised' : 'pending', note: '手动调整后，需重新核对整组一致性' })),
    references: task.references.map(ref => ({ ...ref, status: 'pending', note: '手动调整后，需重新核对关联内容' })) } : task
  const diff = original && activeDocument ? documentChangePreview(original.original_content, activeDocument.content) : undefined
  const updateContent = (content: string) => onChange(activeKey === 'source-revision' && draft.source_update ? { ...draft, source_update: { ...draft.source_update, content } } : activeKey === 'legacy-outline' ? { ...draft, outline: content } : activeKey === 'legacy-characters' ? { ...draft, characters: content } : { ...draft, artifacts: draft.artifacts.map(artifact => artifactKey(artifact) === activeKey ? { ...artifact, content } : artifact) })
  return <section className="script-director-preview sd-draft-review" aria-label="剧本草稿预览">
    <div className="script-director-preview-head"><div><FileText size={17} /><strong>{task ? '统一修订草稿' : title}</strong><span className="sd-document-status">{saved ? '已保存' : incomplete ? '尚未完成' : '待确认'}</span></div><ActionIcon type="button" onClick={onClose} aria-label="收起预览" title="收起后可从创作成果重新打开" data-workspace-control=""><X size={17} /></ActionIcon></div>
    <div className="sd-document-toolbar"><Select className="sd-document-select" aria-label="选择草稿文档" value={activeKey || null} data={entries} allowDeselect={false} rightSection={<ChevronDown size={14} />} comboboxProps={{ withinPortal: true, zIndex: 400 }} onChange={value => value && setSelection(value)} />
      <div className="sd-view-switch" role="group" aria-label="草稿展示方式"><UnstyledButton type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>阅读</UnstyledButton><UnstyledButton type="button" aria-pressed={editing} disabled={busy || saved} onClick={() => setEditing(true)}><PenLine size={12} />编辑</UnstyledButton></div>
    </div>
    <div className="sd-document-meta"><span>{resources.length ? `${resources.length} 项视觉设定或分镜修改` : `${documents.length} 份文档`}{draft.scenes.length ? ` · ${draft.scenes.length} 场 · ${draft.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒` : ''}</span><span>{editing ? '修改将随确认一起保存' : '确认后写入项目'}</span></div>
    {draft.tool_draft && <p className="sd-draft-summary">{draft.tool_draft.summary}</p>}
    {draft.source_update && <p className="sd-draft-summary">{saved ? '文稿修订已保存，后续创作读取当前有效稿。' : '确认保存将同时更新当前有效稿和本阶段文档；后续创作使用修订后的文稿。'}上传原稿保留，可在文稿预览中查看。</p>}
    {progressTask && <RevisionProgress task={progressTask} working={busy && !saving} />}
    {dirty && <p className="sd-revision-note">正文或分场已手动调整，请继续任务核对当前版本后再保存。</p>}
    {!!draft.tool_draft?.impacts?.length && <WorkspaceDisclosure className="sd-draft-impacts" label={<>关联内容需核对 · {draft.tool_draft.impacts.length} 项</>}><p>以下是依赖关系或文本匹配线索。本次只保存草稿中的修改，其他内容需进一步核对。</p>{draft.tool_draft.impacts.map(item => <div key={`${item.kind}:${item.id}`}><strong>{item.title}</strong><span>{item.explanation}</span></div>)}</WorkspaceDisclosure>}
    <div className="script-director-preview-scroll" key={`${activeKey}:${editing}`}>
      {activeResource ? <DirectorResourceDraft change={activeResource} editing={editing} disabled={busy || saved} profileNames={profileNames} sceneNames={sceneNames}
        onChange={change => onChange({ ...draft, resource_changes: resources.map((item, index) => index === resourceIndex ? change : item) })} /> : activeKey === 'scene-list' ? <DirectorSceneList scenes={draft.scenes} disabled={busy || saved} onChange={editing ? (index, scene) => onChange({ ...draft, scenes: draft.scenes.map((item, itemIndex) => itemIndex === index ? scene : item) }) : undefined} />
        : activeDocument && <div className="sd-document-page"><h2>{activeDocument.title}</h2>{diff?.changed && <WorkspaceDisclosure className="sd-change-preview" label={<>查看当前修改前后对比</>}><div className="sd-change-columns"><section><strong>修改前</strong><pre>{diff.before || '（新增内容）'}</pre></section><section><strong>修改后</strong><pre>{diff.after || '（删除内容）'}</pre></section></div></WorkspaceDisclosure>}{original?.original_content && <WorkspaceDisclosure className="sd-original-document" label={<>查看修改前原文</>}><DirectorDocumentBody text={original.original_content} /></WorkspaceDisclosure>}{editing ? <label className="sd-document-edit-label"><span>文档正文</span><Textarea className="sd-document-editor" maxLength={100000} aria-label={`编辑草稿：${activeDocument.title}`} value={activeDocument.content} disabled={busy || saved} onChange={event => updateContent(event.currentTarget.value)} /></label> : <DirectorDocumentBody text={activeDocument.content} title={activeDocument.title} />}{!!original?.replacements.length && <WorkspaceDisclosure className="sd-patch-reasons" label={<>模型修改依据 · {original.replacements.length} 项</>}>{original.replacements.map((edit, index) => <p key={index}>{edit.reason}</p>)}<small>依据对应模型最初提出的修改；上方正文为当前将保存的完整版本。</small></WorkspaceDisclosure>}</div>}
    </div>
    <div className="script-director-preview-actions">{onDiscard && !saved && <Button type="button" className="sd-document-secondary" disabled={busy} onClick={onDiscard} data-workspace-control="" variant="subtle">放弃草稿</Button>}<Button type="button" className="sd-document-secondary" onClick={onClose} data-workspace-control="" variant="subtle">稍后处理</Button>{onContinue && incomplete && !saved && <Button type="button" className="sd-document-primary" disabled={busy} onClick={onContinue} data-workspace-control="" variant="subtle">继续统一修订<ChevronRight size={14} /></Button>}<Button type="button" className="sd-document-primary" onClick={onSave} disabled={busy || saved || incomplete} data-workspace-control="" variant="subtle">{saving ? <LoaderCircle size={14} className="script-director-spinner" /> : <CheckCircle2 size={14} />}{saved ? '已保存' : '确认保存'}{!saving && !saved && <ChevronRight size={14} />}</Button></div>
  </section>
}
