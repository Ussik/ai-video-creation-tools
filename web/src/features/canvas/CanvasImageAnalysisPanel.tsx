import { useEffect, useRef, useState, type ClipboardEvent, type SyntheticEvent } from 'react'
import { Alert, Button, FileButton, Loader, Textarea } from '@mantine/core'
import { Check, Copy, ImageIcon, ScanSearch, Sparkles, TriangleAlert, Upload, X } from 'lucide-react'
import CanvasSelect from './CanvasSelect'
import './canvas-image-analysis-panel.css'

export type CanvasImageAnalysisPanelProps = {
  asset?: { id: string; url: string; label?: string }
  /** Models with an explicitly configured image-to-text capability. */
  models: { id: string; label: string }[]
  modelId: string
  instructions: string
  prompt: string
  pending?: boolean
  uploading?: boolean
  otherPending?: boolean
  error?: string
  elapsedSeconds?: number
  onUpload: (file: File) => void
  onClearSource?: () => void
  onModelChange: (modelId: string) => void
  onInstructionsChange: (value: string) => void
  onPromptChange: (value: string) => void
  onAnalyze: () => void
  onCancel?: () => void
  onCreateGeneration: () => void
}

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation()

export default function CanvasImageAnalysisPanel({ asset, models, modelId, instructions, prompt,
  pending = false, uploading = false, otherPending = false, error, elapsedSeconds = 0,
  onUpload, onClearSource, onModelChange, onInstructionsChange, onPromptChange, onAnalyze, onCancel, onCreateGeneration,
}: CanvasImageAnalysisPanelProps) {
  const resetUpload = useRef<() => void>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const processing = pending || uploading
  const busy = processing || otherPending
  const hasPrompt = !!prompt.trim()
  const selectedModel = models.some(model => model.id === modelId)
  const seconds = Math.max(0, Math.floor(elapsedSeconds))
  useEffect(() => { setCopied(false); setCopyError('') }, [prompt])
  const pasteImage = (event: ClipboardEvent<HTMLElement>) => {
    const file = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile()).find(file => file !== null)
      || Array.from(event.clipboardData.files).find(file => file.type.startsWith('image/'))
    if (!file) return
    event.preventDefault()
    event.stopPropagation()
    if (!busy) onUpload(file)
  }
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setCopyError('')
    } catch {
      setCopyError('复制失败，请在下方选中提示词后复制。')
    }
  }
  return <section className="pc-image-analysis-panel nodrag nowheel" aria-label="图片反推提示词" data-canvas-overlay
    onPointerDown={stopPropagation} onClick={stopPropagation} onKeyDown={stopPropagation} onWheel={stopPropagation} onPaste={pasteImage}>
    <header className="pc-image-analysis-heading">
      <ScanSearch size={18} /><div><h2>图片反推提示词</h2><p>上传图片，或连接画布中的图片节点，提取可用于生成的专业描述。</p></div>
    </header>
    <div className={`pc-image-analysis-source${asset ? ' has-image' : ''}`} tabIndex={0} data-autofocus aria-label="待分析图片，可粘贴剪贴板图片">
      {asset ? <><img src={asset.url} alt={asset.label || '待反推图片'} /><span className="pc-image-analysis-source-label">{asset.label || '待反推图片'}</span></>
        : <div className="pc-image-analysis-placeholder"><ImageIcon size={30} /><strong>添加待分析图片</strong><span>支持 JPG、PNG、WebP</span></div>}
      <div className="pc-image-analysis-source-actions"><FileButton resetRef={resetUpload} accept="image/png,image/jpeg,image/webp" disabled={busy}
        onChange={file => { if (file) onUpload(file); resetUpload.current?.() }}>
        {props => <Button {...props} type="button" size="xs" variant="default" disabled={busy} loading={uploading} leftSection={<Upload size={14} />}>
          {uploading ? '正在上传' : asset ? '替换图片' : '上传图片'}
        </Button>}
      </FileButton>
        {asset && onClearSource && <Button type="button" size="xs" variant="subtle" color="gray" disabled={busy}
          leftSection={<X size={14} />} onClick={onClearSource}>清空来源图片</Button>}
      </div>
      <span className="pc-image-analysis-paste-hint">在此处按 ⌘V / Ctrl+V 粘贴图片</span>
    </div>
    <CanvasSelect label="看图模型" placeholder="选择支持图片理解的模型" data={models.map(model => ({ value: model.id, label: model.label }))}
      value={selectedModel ? modelId : null} onChange={value => { if (value) onModelChange(value) }} disabled={busy || !models.length}
      searchable size="sm" />
    {!models.length && <Alert color="yellow" icon={<TriangleAlert size={16} />} title="暂无可用的看图模型">
      请在模型设置中启用文本模型的“支持图片理解”，或为支持 Gemini 文字输出的图片模型启用“Gemini 图片反推”。
    </Alert>}
    {otherPending && <Alert color="blue" icon={<ScanSearch size={16} />}>另一个图片反推节点正在处理，请完成或取消后再操作。</Alert>}
    <Textarea label="反推要求" description="选填，说明要重点还原的内容" placeholder="例如：重点分析人物服装、镜头构图与灯光，输出中文电影感提示词"
      value={instructions} onChange={event => onInstructionsChange(event.currentTarget.value)} disabled={busy}
      maxLength={4000} autosize minRows={3} maxRows={6} size="sm" />
    <div className="pc-image-analysis-run">
      <Button type="button" size="sm" leftSection={<ScanSearch size={15} />} loading={pending}
        disabled={busy || !asset || !selectedModel} onClick={onAnalyze}>{hasPrompt ? '重新反推' : '开始反推'}</Button>
      {processing && onCancel && <Button type="button" size="sm" variant="subtle" onClick={onCancel}>{uploading ? '取消上传' : '取消反推'}</Button>}
    </div>
    {pending && <div className="pc-image-analysis-status" role="status" aria-live="polite"><Loader size={14} /><span>
      正在分析图片{seconds > 0 ? `，已等待 ${seconds} 秒` : '…'}{seconds >= 60 ? '，可取消后重试' : ''}
    </span></div>}
    {error && <Alert color="red" icon={<TriangleAlert size={16} />} title="反推未完成" className="pc-image-analysis-error">{error}</Alert>}
    <div className="pc-image-analysis-result">
      <Textarea label="专业提示词" description="可直接编辑后复制，或创建图片生成节点继续使用" value={prompt}
        onChange={event => onPromptChange(event.currentTarget.value)} disabled={busy}
        placeholder="完成图片分析后，提示词会显示在这里" maxLength={20000} autosize minRows={7} maxRows={18} size="sm" />
      <div className="pc-image-analysis-result-actions">
        <Button type="button" size="xs" variant="default" disabled={!hasPrompt || pending} onClick={() => { void copyPrompt() }}
          leftSection={copied ? <Check size={14} /> : <Copy size={14} />}>{copied ? '已复制' : '复制提示词'}</Button>
        <Button type="button" size="xs" variant="light" disabled={!hasPrompt || busy} onClick={onCreateGeneration}
          leftSection={<Sparkles size={14} />}>创建图片生成节点</Button>
      </div>
      {copyError && <Alert color="red" icon={<TriangleAlert size={16} />}>{copyError}</Alert>}
    </div>
  </section>
}
