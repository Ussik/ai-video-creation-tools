import { Button, List, Tabs, ThemeIcon } from '@mantine/core'
import { useEffect, useState } from 'react'
import { Check, CheckCircle2, Clock3, LoaderCircle, Pause, RotateCcw } from 'lucide-react'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { api } from '../../shared/api/api'
import { formatProcessingDuration } from './DirectorMessageTiming'
import ScriptMessageContent from './ScriptMessageContent'
import { scriptDiagnosticDisplayText } from './script-display-text'

function SourceAnalysisElapsed({ startedAt }: { startedAt?: string }) {
  const started = Date.parse(startedAt || '')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!Number.isFinite(started)) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [started])
  if (!Number.isFinite(started)) return null
  return <small className="sd-source-analysis-elapsed" role="timer" aria-live="off" aria-label="本次分析已用时" title="不含排队等待时间，继续分析后重新计时">
    <Clock3 size={11} aria-hidden="true" />本次已用时 {formatProcessingDuration(Math.max(0, now - started))}
  </small>
}

export function ScriptSourceAnalysisStatus({ source, starting, unavailable, pollError, hasPreviousFailure, onStart, onPause }: {
  source: ScriptSourceDocument; starting: boolean; unavailable: boolean; pollError: boolean; hasPreviousFailure?: boolean; onStart: () => void; onPause?: () => void
}) {
  const analysis = source.analysis
  const revised = (source.revision || 0) > 0
  const pending = analysis?.status === 'queued' || analysis?.status === 'running'
  const interrupted = analysis?.status === 'failed' || analysis?.status === 'paused'
  const mapReady = analysis?.phase === 'synthesis' || !!analysis?.story
  const step = analysis?.story ? 2 : analysis?.phase === 'synthesis' ? 1 : 0
  const resume = analysis?.resume ?? {
    available: !!analysis?.story || !!analysis?.sections.length || (analysis?.completed_chunks || 0) > 0,
    message: analysis?.story ? '全文分析和全剧整合已完成，可继续质量核对。'
      : mapReady && !!analysis?.sections.length ? '全文分析已完成，可继续全剧整合和质量核对。'
        : analysis?.sections.length || (analysis?.completed_chunks || 0) > 0 ? '已完成的分析步骤已保留，可继续处理未完成部分。'
          : '当前尚无可复用的分析结果，重试将重新进行全文分析。',
  }
  const pendingLabel = pollError ? '暂时无法获取分析状态'
    : analysis?.status === 'queued' ? `等待分析剧本${analysis.queue_position ? ` · 队列第 ${analysis.queue_position} 项` : ''}`
    : analysis?.progress?.stage === 'repairing' && !!analysis.story ? '正在修补分析问题'
    : step === 2 ? '正在独立核对分析结果'
    : analysis?.progress?.stage === 'repairing' || analysis?.progress?.stage === 'validating' ? '正在校验全文分析'
      : analysis?.phase === 'synthesis' ? '正在整理全剧信息' : 'AI 正在阅读全文分析'
  const sourceLabel = revised ? '当前有效稿' : '原剧本'
  return <div className="sd-source-analysis" aria-label="剧本分析状态">
    <div className="sd-source-analysis-status" role="status" aria-live="polite">
      {pending ? <LoaderCircle size={13} className="script-director-spinner" /> : analysis?.status === 'ready' ? <CheckCircle2 size={13} /> : null}
      <span>{pending ? pendingLabel
        : analysis?.status === 'ready' ? `${revised ? '当前有效稿的' : ''}剧本地图已准备 · ${analysis.sections.length} 段剧情`
          : analysis?.status === 'paused' ? `分析已暂停，${sourceLabel}已保留`
          : analysis?.status === 'failed' ? `分析未完成，${sourceLabel}已保留` : revised ? '当前有效稿已修订，可更新剧本地图' : '原剧本已保存，可开始 AI 分析'}</span>
      {!pending && analysis?.status !== 'ready' && <Button variant="subtle" size="compact-xs" loading={starting} disabled={unavailable}
        leftSection={analysis?.status === 'failed' ? <RotateCcw size={12} /> : undefined} onClick={onStart}>{interrupted ? resume.available ? '继续未完成步骤' : '重试分析' : '开始分析'}</Button>}
      {pending && onPause && <Button variant="subtle" size="compact-xs" loading={starting} onClick={onPause} leftSection={<Pause size={12} />}>暂停分析</Button>}
    </div>
    {pending && revised && <small>{pollError ? '当前显示修订后有效稿的分析状态，剧本地图供后续阶段使用。'
      : analysis.status === 'queued' ? '有效稿已修订，等待更新剧本地图，供后续阶段使用。'
        : '有效稿已修订，正在更新剧本地图，供后续阶段使用。'}</small>}
    {(pending || interrupted) && <List type="ordered" listStyleType="none" className="sd-source-analysis-steps" aria-label="剧本分析步骤" role="list">
      {['全文分析', '全剧整合', '质量核对'].map((label, index) => {
        const completed = index === 0 ? mapReady : index === 1 && !!analysis.story
        const active = !completed && !pollError && analysis.status === 'running' && index === step
        const stopped = !completed && interrupted && index === step
        const state = completed ? 'completed' : active ? 'active' : stopped ? analysis.status : 'pending'
        return <List.Item key={label} data-state={state} aria-current={active ? 'step' : undefined}
          icon={<ThemeIcon size={16} radius="xl" variant="default" className="sd-source-analysis-step-icon" aria-hidden="true">{completed ? <Check size={10} /> : index + 1}</ThemeIcon>}>
          <span>{label}</span><span className="sd-source-analysis-step-state">{completed ? '已完成' : active ? '进行中' : stopped ? analysis.status === 'paused' ? '已暂停' : '未完成' : '待处理'}</span>
        </List.Item>
      })}
    </List>}
    {(pending || interrupted) && mapReady && <small>剧情目录已完成；全剧整合与质量核对仍以各步骤状态为准。</small>}
    {analysis?.status === 'running' && !pollError && <SourceAnalysisElapsed key={analysis.id} startedAt={analysis.started_at} />}
    {pending && !pollError && analysis.progress && <small>{analysis.progress.stage === 'splitting' ? '将完整读取当前文稿，重新进行全文分析。' : scriptDiagnosticDisplayText(analysis.progress.message).replace(/；全文一次提交$/, '')}</small>}
    {pending && !pollError && <small>按实际处理步骤更新，单步耗时不代表剩余时间。</small>}
    {interrupted && analysis.progress && <small>上次处理项：{analysis.progress.stage === 'splitting' ? '重新进行全文分析' : scriptDiagnosticDisplayText(analysis.progress.message).replace(/；全文一次提交$/, '')}</small>}
    {(interrupted || pending && resume.available) && <small>{scriptDiagnosticDisplayText(resume.message)}</small>}
    {hasPreviousFailure && (pending || analysis?.status === 'ready') && <small>这里显示当前文稿的分析状态；对话中的“未完成”是对应轮次的历史结果。</small>}
    {(!pending || pollError) && <small>{pollError && pending ? '暂时无法读取进度，正在重试…保留上次确认的步骤。'
      : analysis?.status === 'paused' ? '创作要求仍可填写，完成分析后再发送。'
        : analysis?.status === 'failed' ? analysis.error && scriptDiagnosticDisplayText(analysis.error).slice(0, 300) || `请重试分析，${sourceLabel}已保留。`
        : !analysis && unavailable ? '请先选择可用文本模型。' : analysis?.status === 'ready' ? '目录、人物、事件与全剧信息已整理，后续创作共用当前版本。' : '分析只整理剧本资料，阶段文档仍需生成并确认保存。'}</small>}
  </div>
}

function SourcePreviewContent({ source }: { source: ScriptSourceDocument }) {
  return <div className="sd-source-preview-body">{/\.(?:md|markdown)$/i.test(source.filename)
    ? <ScriptMessageContent text={source.content} tableLabel="剧本表格" />
    : source.content}</div>
}

export function ScriptSourcePreview({ source }: { source: ScriptSourceDocument }) {
  const analysis = source.analysis
  const [original, setOriginal] = useState<ScriptSourceDocument | null>(null)
  const [originalError, setOriginalError] = useState(false)
  useEffect(() => {
    let active = true
    setOriginal(null); setOriginalError(false)
    if (source.revision) void api<ScriptSourceDocument | null>(`/projects/${source.project_id}/script/source/original`)
      .then(value => { if (active) { setOriginal(value); setOriginalError(!value) } })
      .catch(() => { if (active) setOriginalError(true) })
    return () => { active = false }
  }, [source.project_id, source.updated_at, source.revision])
  return <Tabs defaultValue="current" className="sd-source-preview-tabs">
    <Tabs.List><Tabs.Tab value="current">{source.revision ? '当前有效稿' : '原剧本'}</Tabs.Tab>{!!source.revision && <Tabs.Tab value="original">上传原稿</Tabs.Tab>}<Tabs.Tab value="map" disabled={!analysis?.sections.length}>剧本地图</Tabs.Tab><Tabs.Tab value="story" disabled={!analysis?.story}>全剧信息</Tabs.Tab></Tabs.List>
    <Tabs.Panel value="current"><SourcePreviewContent source={source} /></Tabs.Panel>
    {!!source.revision && <Tabs.Panel value="original"><p className="sd-source-preview-hint">上传时的原稿保留供追溯，后续创作使用当前有效稿。</p>{originalError
      ? <div className="sd-source-preview-body">读取上传原稿失败，请重新打开文稿预览。</div>
      : original ? <SourcePreviewContent source={original} /> : <div className="sd-source-preview-body">正在读取上传原稿…</div>}</Tabs.Panel>}
    <Tabs.Panel value="map"><div className="sd-source-map">
      <p className="sd-source-preview-hint">{analysis?.status === 'ready' ? '以下是 AI 整理的检索资料，可展开原文核对。' : '分析仍在进行，以下只显示已完成部分。'}正式创作以原文和你的要求为准。</p>
      {analysis?.sections.map((section, index) => <section className="sd-source-map-section" key={`${section.offset}:${index}`}>
        <h3>{section.title}{section.continues_previous ? ' · 承接上一段剧情' : ''}</h3><p>{section.summary}</p>
        {!!section.characters.length && <div className="sd-source-map-characters"><strong>人物</strong>{section.characters.map((character, characterIndex) => <p key={characterIndex}><b>{character.name}</b> · {character.description}<small>原文：“{character.evidence.quote}”</small></p>)}</div>}
        {!!section.events.length && <div className="sd-source-map-events"><strong>主要事件</strong>{section.events.map((event, eventIndex) => <p key={eventIndex}>{event.summary}<small>原文：“{event.evidence.quote}”</small></p>)}</div>}
        <WorkspaceDisclosure label="查看这段原文"><div className="sd-source-map-original">{source.content.slice(section.offset, section.offset + section.length)}</div></WorkspaceDisclosure>
      </section>)}
    </div></Tabs.Panel>
    <Tabs.Panel value="story"><div className="sd-source-map">
      {analysis?.story && <>
        <p className="sd-source-preview-hint">以下信息来自当前有效稿的全剧整合，可按所列剧情段落回查原文；不代表新创作决定。</p>
        <section className="sd-source-map-section"><h3>全剧主线</h3><p>{analysis.story.summary}</p></section>
        <section className="sd-source-map-section"><h3>人物与身份</h3>{analysis.story.characters.map((item, index) => <p key={index}><b>{item.name}</b>{item.aliases.length ? `（${item.aliases.join('、')}）` : ''} · {item.description}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>)}</section>
        <section className="sd-source-map-section"><h3>事件与因果</h3>{analysis.story.timeline.map((item, index) => <p key={index}>{item.summary}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>)}</section>
        <section className="sd-source-map-section"><h3>伏笔与回收</h3>{analysis.story.threads.length ? analysis.story.threads.map((item, index) => <p key={index}>{item.setup}<small>{item.payoff || '原稿未明确回收'} · 剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>) : <p>原稿未识别到明确的伏笔与回收。</p>}</section>
        <section className="sd-source-map-section"><h3>结局与最终状态</h3><p>{analysis.story.ending.summary}</p></section>
        {!!analysis.story.uncertainties.length && <section className="sd-source-map-section"><h3>需核对的信息</h3>{analysis.story.uncertainties.map((item, index) => <p key={index}>{item.description}<small>来源：剧情段落 {item.section_ids.map(id => id + 1).join('、')}</small></p>)}<p>生成时会结合本次要求核对，实际影响创作的缺口再由你填写或交给 AI 处理。</p></section>}
      </>}
    </div></Tabs.Panel>
  </Tabs>
}
