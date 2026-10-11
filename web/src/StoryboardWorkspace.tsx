import { StudioMediaPlayer } from './StudioMediaPlayer'
import { supportsVideoMultiReference } from '../../backend/src/video-reference-config'
import { useEffect, useMemo, useState } from 'react'
import { UnstyledButton, TextInput, Button, ActionIcon, Modal } from '@mantine/core'
import type { JSONContent } from '@tiptap/core'
import { ArrowLeft, ArrowRight, FileText, Film, Image as ImageIcon, Maximize2, Plus, ScrollText, Search, Settings2, X } from 'lucide-react'
import type { Asset, Model, ProjectDetail, ScriptArtifact } from './api'
import type { CanvasGraph } from './ProjectCanvas'
import CanvasTextEditor, { CanvasTextPreview } from './CanvasTextEditor'
import { parseScriptDocument } from './script-rich-document'
import { textDocumentText } from './text-document'
import { storyboardContext, storyboardItems, storyboardPrompt, storyboardStatus, type StoryboardItem, type StoryboardKind } from './storyboard'
import './storyboard.css'

type Props = {
  detail: ProjectDetail
  graph: CanvasGraph
  models: Model[]
  selectedId: string | null
  saveState: 'saved' | 'pending' | 'saving' | 'error' | 'conflict'
  onSelect: (id: string | null) => void
  onOpenDirector: (context?: string) => void
  onOpenScript: (artifact?: ScriptArtifact) => void
  onOpenSettings: (id: string) => void
  onCreateVideo?: (id: string, mode: 'first_frame' | 'reference') => void
  onTextChange: (id: string, text: string, document: JSONContent) => void
}

const labels: Record<StoryboardKind, string> = { text: '文本', image: '图片', video: '视频' }
const icons = { text: FileText, image: ImageIcon, video: Film }

function Media({ asset, controls = false }: { asset?: Asset; controls?: boolean }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [asset?.url])
  if (!asset || failed) return <div className="sb-media-placeholder">{failed ? '素材加载失败，请检查本地文件' : '暂无生成素材'}</div>
  if (asset.kind === 'image') return <img src={asset.url} alt={asset.filename} loading="lazy" onError={() => setFailed(true)} />
  if (asset.kind === 'video') return <StudioMediaPlayer src={asset.url} controls={controls} muted={!controls} playsInline preload="metadata" onError={() => setFailed(true)} />
  return null
}

function DocumentPreview({ content }: { content: string }) {
  const document = parseScriptDocument(content)
  return <CanvasTextPreview text={textDocumentText(document)} document={document} />
}

export default function StoryboardWorkspace({ detail, graph, models, selectedId, saveState, onSelect, onOpenDirector, onOpenScript, onOpenSettings, onCreateVideo, onTextChange }: Props) {
  const items = useMemo(() => storyboardItems(detail, graph, models), [detail, graph, models])
  const selected = items.find(item => item.id === selectedId)
  const [query, setQuery] = useState('')
  const [gallery, setGallery] = useState<'image' | 'video' | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const visibleItems = items.filter(item => !query.trim() || `${item.title}\n${item.content}\n${item.shot?.prompt || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const previewItems = items.filter(item => item.kind === gallery && item.asset)
  const previewIndex = previewItems.findIndex(item => item.id === previewId)
  const preview = previewItems[previewIndex]

  useEffect(() => {
    if (selectedId && !items.some(item => item.id === selectedId)) onSelect(null)
  }, [items, selectedId, onSelect])
  useEffect(() => {
    if (previewId && !previewItems.some(item => item.id === previewId)) setPreviewId(null)
  }, [previewId, previewItems])

  function openGallery(kind: 'image' | 'video', item?: StoryboardItem) {
    setGallery(kind)
    setPreviewId(item?.asset ? item.id : null)
  }
  const sceneDuration = detail.script.scenes.reduce((sum, scene) => sum + scene.duration, 0)
  const selectedScenes = selected?.artifact?.episode_number
    ? detail.script.scenes.filter(scene => scene.episode_number === selected.artifact!.episode_number) : []
  const metadata = selected?.overview ? `${detail.script.scenes.length} 场 · ${sceneDuration} 秒`
    : selected?.artifact ? `${selected.artifact.episode_number ? `第 ${selected.artifact.episode_number} 集 · ` : ''}${selectedScenes.length ? `${selectedScenes.length} 场 · ${selectedScenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒 · ` : ''}已保存文档`
      : selected?.shot ? `镜头 ${String(selected.shot.position + 1).padStart(2, '0')} · ${selected.shot.duration} 秒`
        : selected ? storyboardStatus(selected) : ''

  function itemButton(item: StoryboardItem) {
    const Icon = item.overview || item.artifact ? ScrollText : icons[item.kind]
    return <UnstyledButton key={item.id} type="button" className={`sb-item ${item.kind !== 'text' ? 'sb-media-card' : ''} ${selected?.id === item.id ? 'is-selected' : ''}`}
      aria-label={`打开${labels[item.kind]}：${item.title}`} aria-pressed={selected?.id === item.id} onClick={() => onSelect(item.id)}>
      {item.kind !== 'text' && <div className="sb-thumbnail"><Media asset={item.asset} /></div>}
      <span className="sb-item-caption"><Icon size={15} /><span><strong>{item.title}</strong><small>{item.artifact?.episode_number ? `第 ${item.artifact.episode_number} 集 · ` : ''}{item.shot ? `镜头 ${item.shot.position + 1} · ` : ''}{storyboardStatus(item)}</small></span></span>
    </UnstyledButton>
  }

  return <section className={`sb-workspace ${selected ? 'is-reading' : ''}`} aria-label="故事板工作区" data-canvas-overlay onKeyDown={event => {
    if (event.key === 'Escape' && selected && !(event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(event.target.tagName)))) {
      event.stopPropagation(); onSelect(null)
    }
  }}>
    <header className="sb-toolbar"><label><Search size={15} /><TextInput aria-label="搜索故事板内容" placeholder="搜索文本、镜头或素材" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <Button type="button" onClick={() => onOpenDirector()} data-workspace-control="" variant="subtle"><ScrollText size={15} />导演对话</Button>
    </header>
    <div className="sb-content">
      <div className="sb-library" aria-label="故事板内容列表">
        {(['text', 'image', 'video'] as const).map(kind => {
          const group = visibleItems.filter(item => item.kind === kind)
          const total = items.filter(item => item.kind === kind)
          return <section key={kind} className={`sb-column sb-column-${kind}`} aria-label={`${labels[kind]}列表`}>
            <header><h2>{labels[kind]}</h2><span>{group.length}</span>{kind !== 'text' && <ActionIcon type="button" aria-label={`放大${labels[kind]}`} disabled={!total.some(item => item.asset)} onClick={() => openGallery(kind)} data-workspace-control=""><Maximize2 size={15} /></ActionIcon>}</header>
            <div className="sb-column-scroll"><div className={kind === 'text' ? 'sb-text-list' : 'sb-media-list'}>{group.map(itemButton)}</div>
              {!group.length && <div className="sb-empty"><p>{query.trim() ? '没有匹配的内容' : `暂无${labels[kind]}`}</p><small>{kind === 'text' ? '剧本文档和画布文本会显示在这里' : '画布中的素材和生成结果会显示在这里'}</small></div>}
            </div>
          </section>
        })}
      </div>
      {selected && <section className="sb-reader" aria-label="故事板阅读器" key={selected.id}>
        <header><ActionIcon type="button" aria-label="返回故事板列表" onClick={() => onSelect(null)} data-workspace-control=""><ArrowLeft size={18} /></ActionIcon><h1>{selected.title}</h1>
          <div><ActionIcon type="button" aria-label="添加到导演对话" onClick={() => onOpenDirector(storyboardContext(selected, detail))} data-workspace-control=""><Plus size={17} /></ActionIcon><ActionIcon type="button" aria-label="关闭阅读器" onClick={() => onSelect(null)} data-workspace-control=""><X size={18} /></ActionIcon></div>
        </header>
        <div className="sb-reader-scroll">
          <div className="sb-reader-meta"><span>{metadata}</span>{selected.node?.type === 'text' && <span role="status">{saveState === 'saved' ? '已保存' : saveState === 'pending' || saveState === 'saving' ? '保存中' : saveState === 'conflict' ? '版本冲突，请合并' : '保存失败，请重试'}</span>}</div>
          {selected.overview ? <article className="sb-document">
            <div className="sb-document-actions"><Button type="button" onClick={() => onOpenScript()} data-workspace-control="" variant="subtle">编辑项目剧本 <ArrowRight size={14} /></Button></div>
            {detail.script.outline && <section><h2>故事大纲</h2><DocumentPreview content={detail.script.outline} /></section>}
            {detail.script.characters && <section><h2>人物设定</h2><DocumentPreview content={detail.script.characters} /></section>}
            {detail.script.scenes.map((scene, index) => <section key={scene.id}><h2>{scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}场景 {index + 1}：{scene.heading}</h2><small>{[scene.location, scene.time_of_day, scene.characters, `${scene.duration} 秒`].filter(Boolean).join(' · ')}</small>
              {scene.action && <div><h3>动作</h3><p>{scene.action}</p></div>}{scene.dialogue && <div><h3>对白</h3><p>{scene.dialogue}</p></div>}{scene.narration && <div><h3>旁白</h3><p>{scene.narration}</p></div>}
            </section>)}
            {!detail.script.outline && !detail.script.characters && !detail.script.scenes.length && <p className="sb-empty">暂无已保存剧本，先在导演对话中创作并确认。</p>}
          </article> : selected.artifact ? <article className="sb-document"><div className="sb-document-actions"><Button type="button" onClick={() => onOpenScript(selected.artifact)} data-workspace-control="" variant="subtle">编辑剧本文档 <ArrowRight size={14} /></Button></div><DocumentPreview content={selected.content} /></article>
            : selected.node?.type === 'text' ? <div className="sb-text-editor"><CanvasTextEditor text={selected.node.text} document={selected.node.settings.text_document} selected inline label={`故事板文本：${selected.title}`} onChange={(text, document) => onTextChange(selected.node!.id, text, document)} /></div>
              : selected.kind === 'text' ? <article className="sb-document"><DocumentPreview content={selected.content || '暂无生成的文本'} />{selected.node && <Button type="button" onClick={() => onOpenSettings(selected.node!.id)} data-workspace-control="" variant="subtle">配置文本生成</Button>}</article>
                : <article className="sb-media-detail"><div className="sb-media-preview"><Media key={selected.asset?.id} asset={selected.asset} controls /></div>
                  <div className="sb-detail-actions">{selected.asset && <Button type="button" onClick={() => openGallery(selected.kind as 'image' | 'video', selected)} data-workspace-control="" variant="subtle"><Maximize2 size={15} />放大预览</Button>}{selected.node && <Button type="button" onClick={() => onOpenSettings(selected.node!.id)} data-workspace-control="" variant="subtle"><Settings2 size={15} />{selected.node.type === 'generation' ? '配置生成参数' : '定位画布节点'}</Button>}{selected.kind === 'image' && selected.asset && selected.node && onCreateVideo && <>
                    <Button type="button" onClick={() => onCreateVideo(selected.node!.id, 'first_frame')} data-workspace-control="" variant="subtle"><Film size={15} />首帧生成</Button>
                    {models.some(model => model.modality === 'video' && model.enabled && supportsVideoMultiReference(model.settings)) && <Button type="button" onClick={() => onCreateVideo(selected.node!.id, 'reference')} data-workspace-control="" variant="subtle"><Film size={15} />多图参考</Button>}
                  </>}</div>
                  {selected.job?.error && <p className="sb-error" role="alert">{selected.job.error}</p>}
                  <h2>提示词</h2><p>{storyboardPrompt(selected) || '暂无提示词'}</p>
                </article>}
        </div>
      </section>}
    </div>
    <Modal opened={gallery !== null} onClose={() => { setGallery(null); setPreviewId(null) }} closeButtonProps={{ 'aria-label': '关闭媒体预览' }} title={`${gallery === 'video' ? '视频' : '图片'}预览`} size="90%" centered classNames={{ content: 'sb-gallery-modal', body: 'sb-gallery-body' }}>
      <div data-canvas-overlay onKeyDown={event => {
        event.stopPropagation()
        if (preview && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault()
          const next = previewIndex + (event.key === 'ArrowLeft' ? -1 : 1)
          if (next >= 0 && next < previewItems.length) setPreviewId(previewItems[next].id)
        }
      }}>
        {preview ? <><div className="sb-gallery-controls"><Button type="button" onClick={() => setPreviewId(null)} data-workspace-control="" variant="subtle">返回素材列表</Button><strong>{preview.title}</strong><span>{previewIndex + 1} / {previewItems.length}</span><ActionIcon type="button" aria-label="上一个素材" disabled={previewIndex <= 0} onClick={() => setPreviewId(previewItems[previewIndex - 1].id)} data-workspace-control=""><ArrowLeft size={17} /></ActionIcon><ActionIcon type="button" aria-label="下一个素材" disabled={previewIndex >= previewItems.length - 1} onClick={() => setPreviewId(previewItems[previewIndex + 1].id)} data-workspace-control=""><ArrowRight size={17} /></ActionIcon></div><div className="sb-gallery-preview"><Media key={preview.asset!.id} asset={preview.asset} controls /></div></>
          : <div className="sb-gallery-grid">{previewItems.map(item => <UnstyledButton type="button" key={item.id} aria-label={`预览：${item.title}`} onClick={() => setPreviewId(item.id)}><div><Media asset={item.asset} /></div><span>{item.title}</span></UnstyledButton>)}{!previewItems.length && <p>暂无可预览素材</p>}</div>}
      </div>
    </Modal>
  </section>
}
