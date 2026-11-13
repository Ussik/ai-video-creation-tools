import { Accordion } from '@mantine/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import './director-source-context.css'

export default function DirectorSourceContext({ source, starting = false, pollError = false, children }: {
  source: ScriptSourceDocument
  starting?: boolean
  pollError?: boolean
  children: ReactNode
}) {
  const status = source.analysis?.status
  const needsAttention = pollError || !status || status === 'failed' || status === 'paused'
  const [open, setOpen] = useState(needsAttention)
  const manualChoice = useRef(false)
  const identity = `${source.project_id}:${source.filename}:${source.updated_at}:${source.revision || 0}`
  const previousIdentity = useRef(identity)
  useEffect(() => {
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity
      manualChoice.current = false
      setOpen(needsAttention)
    } else if (needsAttention) setOpen(true)
    else if (status === 'ready' && !manualChoice.current) setOpen(false)
  }, [identity, needsAttention, status])
  const statusLabel = pollError ? '状态获取失败'
    : starting ? '分析中'
      : status === 'ready' ? '地图已就绪'
        : status === 'queued' ? '等待分析'
          : status === 'running' ? '分析中'
            : status === 'paused' ? '已暂停'
              : status === 'failed' ? '需重试' : '待分析'
  return <Accordion className="sd-source-context" value={open ? 'source' : null}
    onChange={value => { manualChoice.current = true; setOpen(value === 'source') }}
    keepMounted keepMountedMode="display-none" transitionDuration={120}>
    <Accordion.Item value="source">
      <Accordion.Control className="sd-source-context-toggle">
        <span className="sd-source-context-label"><Paperclip size={14} aria-hidden="true" /><span>创作依据 · {source.revision ? '有效稿' : '原稿'} 1 份</span></span>
        <span className={`sd-source-context-status${needsAttention ? ' needs-attention' : ''}`} role="status">{statusLabel}</span>
      </Accordion.Control>
      <Accordion.Panel className="sd-source-context-panel"><div className="sd-source-context-content">{children}</div></Accordion.Panel>
    </Accordion.Item>
  </Accordion>
}
