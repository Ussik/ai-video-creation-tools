import { StudioMediaPlayer } from '../../shared/ui/media/StudioMediaPlayer'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { useEffect, useRef, useState } from 'react'
import { Tabs, UnstyledButton, ActionIcon, Button, Checkbox, Modal, NumberInput, PasswordInput, Select, Textarea, TextInput, type ComboboxProps } from '@mantine/core'
import { AudioLines, Check, Maximize2, Minimize2, Mic2, Plus, Settings2, Trash2, Volume2, Clapperboard } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { ScriptScene, Shot } from '../../shared/api/api'
import { isSpeechTakeCurrent, type SpeechVoice as Voice, type SpeechTake as Take, type SpeechLineDraft as LineDraft, type SpeechLine, type SpeechData } from '@video-studio/shared/media/speech-timeline'
import SpeechPlacementEditor from './SpeechPlacementEditor'
import SpeechVoicePicker from './SpeechVoicePicker'
import { useSpeechVoicePreview } from './use-speech-voice-preview'
import { speechStandardVoice, speechStandardVoices } from '@video-studio/shared/media/speech-voices'
import { useAppDialog } from '../../shared/ui/AppDialog'
import './speech-studio.css'
import { finalCutPath } from '../final-cut/final-cut-scope'

type SpeechConfig = { enabled: boolean; has_key: boolean; default_speaker: string; speech_rate: number; endpoint: string; resource_id: string }
type SyncPreview = { sync_token: string; added: number; updated: number; removed: number; preserved: number;
  changes: Array<{ kind: 'added' | 'updated' | 'removed' | 'preserved'; role?: string; scene_id: string; before?: string; after?: string }> }
export type SpeechStudioProps = { projectId: string; projectName?: string; scenes?: ScriptScene[]; shots?: Shot[]; initialLineId?: string | null;
  initialSceneId?: string | null; initialShotId?: string | null; finalCutCanvasId?: string | null; onOpenFinalCut?: () => void; onClose: () => void; onAssetsChanged?: () => Promise<unknown> | void }

const isActive = (take: Take) => take.status === 'queued' || take.status === 'running'
const errorText = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
const editable = (line: LineDraft): LineDraft => ({ voice_id: line.voice_id, scene_id: line.scene_id, text: line.text, instructions: line.instructions, context_text: line.context_text })
const blank = (voiceId: string | null = null): LineDraft => ({ voice_id: voiceId, scene_id: null, text: '', instructions: '', context_text: '' })
const elapsed = (take: Take, now: number) => `${Math.max(0, Math.floor((now - new Date(take.created_at).getTime()) / 1000))} 秒`
const voiceValues = (voice: Voice) => ({ name: voice.name.trim(), speaker: voice.speaker.trim(), instructions: voice.instructions, speech_rate: voice.speech_rate })
const speakerLabel = (speaker: string) => speechStandardVoice(speaker)?.name || (speaker ? '自定义音色' : '尚未选择音色')
// Compact filters can be narrower than the dropdown's shared minimum width.
const filterComboboxProps: ComboboxProps = {
  position: 'bottom-start',
  withinPortal: true,
  offset: 6,
  transitionProps: { transition: 'fade', duration: 120 },
  zIndex: 450,
  middlewares: { flip: true, shift: { mainAxis: true, padding: 12 } },
}

export default function SpeechStudio({ projectId, projectName, scenes = [], shots = [], initialLineId, initialSceneId, initialShotId, finalCutCanvasId, onOpenFinalCut, onClose, onAssetsChanged }: SpeechStudioProps) {
  const [config, setConfig] = useState<SpeechConfig | null>(null), [data, setData] = useState<SpeechData>({ voices: [], lines: [] })
  const [voices, setVoices] = useState<Voice[]>([]), [drafts, setDrafts] = useState<Record<string, LineDraft>>({})
  const [selectedId, setSelectedId] = useState(''), [tab, setTab] = useState<'lines' | 'voices'>('lines')
  const voicePreview = useSpeechVoicePreview(tab === 'voices')
  const [selectedVoiceId, setSelectedVoiceId] = useState('')
  const [sceneIds, setSceneIds] = useState<string[]>([]), [apiKey, setApiKey] = useState(''), [settingsOpen, setSettingsOpen] = useState(false)
  const [configError, setConfigError] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())
  const [expanded, setExpanded] = useState(false), [sceneFilter, setSceneFilter] = useState(initialSceneId || 'all')
  const [roleFilter, setRoleFilter] = useState('all'), [statusFilter, setStatusFilter] = useState('all')
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const { confirm, dialog } = useAppDialog({ zIndex: 500 })
  const alive = useRef(true), dataRef = useRef(data), refreshRef = useRef(onAssetsChanged), pollError = useRef(false), localVoiceId = useRef(0)
  dataRef.current = data; refreshRef.current = onAssetsChanged
  const path = `/projects/${encodeURIComponent(projectId)}/speech`
  const speechPath = finalCutPath(path, finalCutCanvasId)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    setLoading(true); setError(''); setDrafts({}); setSelectedId(''); setSceneIds(initialSceneId ? [initialSceneId] : [])
    void Promise.all([api<SpeechConfig>('/speech/config', { signal: controller.signal }), api<SpeechData>(speechPath, { signal: controller.signal })])
      .then(([configuration, speech]) => {
        if (controller.signal.aborted) return
        setConfig(configuration); setData(speech); setVoices(speech.voices)
        setSelectedVoiceId(speech.voices[0]?.id || '')
        setSelectedId(speech.lines.find(line => line.id === initialLineId)?.id || speech.lines.find(line => initialSceneId && line.scene_id === initialSceneId)?.id || speech.lines[0]?.id || 'new')
        if (!speech.lines.length) setDrafts({ new: blank(speech.voices[0]?.id || null) })
        setSettingsOpen(!configuration.has_key || !configuration.enabled)
      })
      .catch(issue => { if (!controller.signal.aborted) setError(errorText(issue)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { alive.current = false; controller.abort() }
  }, [speechPath])

  const pendingKey = data.lines.flatMap(line => line.takes.filter(isActive).map(take => take.id)).sort().join(',')
  useEffect(() => {
    if (!pendingKey) return
    let stopped = false, timer: number | undefined
    const controller = new AbortController()
    const tick = async () => {
      try {
        const next = await api<SpeechData>(speechPath, { signal: controller.signal })
        if (stopped) return
        const completed = dataRef.current.lines.some(line => line.takes.some(take => isActive(take) &&
          next.lines.some(current => current.takes.some(updated => updated.id === take.id && !isActive(updated)))))
        setData(next); pollError.current = false
        if (completed) await refreshRef.current?.()
      } catch (issue) {
        if (!stopped && !pollError.current) { setError(`配音状态更新失败：${errorText(issue)}`); pollError.current = true }
      } finally { if (!stopped) timer = window.setTimeout(tick, 2500) }
    }
    timer = window.setTimeout(tick, 2500)
    return () => { stopped = true; controller.abort(); if (timer) window.clearTimeout(timer) }
  }, [pendingKey, speechPath])
  useEffect(() => {
    if (!pendingKey) return
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pendingKey])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const selected = data.lines.find(line => line.id === selectedId)
  const candidateTakes = selected?.takes.filter(take => take.asset_id) || []
  const draft = drafts[selectedId] || (selected ? editable(selected) : null)
  const voice = voices.find(item => item.id === draft?.voice_id)
  const activeTake = selected?.takes.find(isActive)
  const latestFailure = selected?.takes[0]?.status === 'failed' ? selected.takes[0] : null
  const voiceDirty = JSON.stringify(voices.map(voiceValues)) !== JSON.stringify(data.voices.map(voiceValues))
  const storedVoice = data.voices.find(item => item.id === voice?.id)
  const selectedVoiceDirty = !!voice && (!storedVoice || JSON.stringify(voiceValues(voice)) !== JSON.stringify(voiceValues(storedVoice)))
  const draftDirty = !!draft && (selected ? JSON.stringify(editable(selected)) !== JSON.stringify(draft) : !!(draft.text.trim() || draft.instructions.trim() || draft.context_text.trim() || draft.voice_id))
  const voiceIssue = voices.some(item => !item.name.trim() || !item.speaker.trim()) ? '请填写每个角色的名称和音色 ID' :
    new Set(voices.map(item => item.name.trim())).size !== voices.length ? '角色名称不能重复' : ''
  const voiceOptions = voices.map(item => ({ value: item.id, label: item.name || '未命名角色' }))
  const roleVoiceIndex = Math.max(0, voices.findIndex(item => item.id === selectedVoiceId))
  const roleVoice = voices[roleVoiceIndex]
  useEffect(() => { voicePreview.stop() }, [roleVoice?.id, roleVoice?.speaker, voicePreview.stop])
  function lineStatus(line: SpeechLine) {
    if (line.source_status === 'changed' || line.source_status === 'removed') return 'source'
    const take = line.takes.find(item => item.asset_id === line.selected_asset_id)
    const current = take && isSpeechTakeCurrent(take, drafts[line.id] || line, voices.find(item => item.id === (drafts[line.id]?.voice_id || line.voice_id)))
    return line.takes.some(isActive) ? 'running' : line.selected_asset_id ? current ? 'selected' : 'stale' : line.takes.some(item => item.asset_id) ? 'candidates' : 'missing'
  }
  const statusLabels: Record<string, string> = { running: '生成中', selected: '已选用', stale: '需更新配音', candidates: '待选用', missing: '待配音', source: '剧本有变化' }
  const visibleLines = data.lines.filter(line => (sceneFilter === 'all' || line.scene_id === sceneFilter) &&
    (roleFilter === 'all' || line.voice_id === roleFilter) && (statusFilter === 'all' || lineStatus(line) === statusFilter))
  const selectedTake = selected?.takes.find(take => take.asset_id === selected.selected_asset_id)
  const selectedStale = !!selected?.selected_is_stale || !!selectedTake && !!draft && !isSpeechTakeCurrent(selectedTake, draft, voice)
  const unsavedLines = Object.entries(drafts).some(([id, value]) => {
    const stored = data.lines.find(item => item.id === id)
    return stored ? JSON.stringify(editable(stored)) !== JSON.stringify(value) : !!(value.text.trim() || value.instructions.trim() || value.context_text.trim())
  })
  async function requestClose() {
    if (busy || settingsOpen || dialog) return
    if ((voiceDirty || unsavedLines || apiKey.trim()) && !await confirm({ title: '关闭配音', message: '有未保存的修改，关闭后将丢弃这些修改。', confirmLabel: '丢弃并关闭', cancelLabel: '继续编辑' })) return
    voicePreview.stop(); onClose()
  }
  async function requestSettingsClose() {
    if (busy || dialog) return
    if (apiKey.trim() && !await confirm({ title: '关闭语音配置', message: '新密钥尚未保存，关闭后将丢弃这次输入。', confirmLabel: '丢弃并关闭', cancelLabel: '继续编辑' })) return
    setApiKey(''); setConfigError(''); setSettingsOpen(false)
  }
  function edit(values: Partial<LineDraft>) { if (draft) setDrafts(current => ({ ...current, [selectedId]: { ...draft, ...values } })) }
  async function action(key: string, run: () => Promise<void>) {
    if (busy) return
    setBusy(key); setError(''); setNotice('')
    if (key === 'config') setConfigError('')
    try { await run() } catch (issue) { if (alive.current) (key === 'config' ? setConfigError : setError)(errorText(issue)) }
    finally { if (alive.current) setBusy('') }
  }
  async function reload() {
    const next = await api<SpeechData>(speechPath)
    if (alive.current) setData(next)
    return next
  }
  async function saveVoiceBindings(onlyId?: string): Promise<Record<string, string>> {
    if (!onlyId && voiceIssue) throw new Error(voiceIssue)
    const ids: Record<string, string> = {}
    for (const item of voices.filter(row => !onlyId || row.id === onlyId)) {
      if (!item.name.trim() || !item.speaker.trim()) throw new Error('请填写角色名称和音色 ID')
      const stored = data.voices.find(row => row.id === item.id)
      if (stored && JSON.stringify(voiceValues(stored)) === JSON.stringify(voiceValues(item))) { ids[item.id] = item.id; continue }
      const saved = await api<Voice>(stored ? `${path}/voices/${encodeURIComponent(item.id)}` : `${path}/voices`, json(stored ? 'PATCH' : 'POST', voiceValues(item)))
      ids[item.id] = saved.id
      if (alive.current) {
        setVoices(current => current.map(row => row.id === item.id ? saved : row))
        setSelectedVoiceId(current => current === item.id ? saved.id : current)
        setData(current => ({ ...current, voices: current.voices.some(row => row.id === saved.id) ? current.voices.map(row => row.id === saved.id ? saved : row) : [...current.voices, saved] }))
        setDrafts(current => Object.fromEntries(Object.entries(current).map(([id, row]) => [id, row.voice_id === item.id ? { ...row, voice_id: saved.id } : row])))
      }
    }
    const next = await reload()
    if (alive.current) {
      setVoices(current => onlyId ? current.map(row => ids[row.id] ? next.voices.find(saved => saved.id === ids[row.id]) || row : row) : next.voices)
      setDrafts(current => Object.fromEntries(Object.entries(current).map(([id, row]) => [id, { ...row, voice_id: row.voice_id ? ids[row.voice_id] || row.voice_id : null }])))
    }
    return ids
  }
  async function saveLine(value = draft): Promise<string> {
    if (!value) throw new Error('请先选择台词')
    if (selected && JSON.stringify(editable(selected)) === JSON.stringify(value)) return selected.id
    const line = await api<SpeechLine>(selected ? `${path}/lines/${encodeURIComponent(selected.id)}` : `${path}/lines`, json(selected ? 'PATCH' : 'POST', value))
    await reload()
    if (alive.current) {
      setSelectedId(line.id); setDrafts(current => { const next = { ...current }; delete next[selectedId]; return next })
    }
    return line.id
  }
  function addVoice() {
    const id = `local-${++localVoiceId.current}`
    setVoices(current => [...current, { id, name: current.some(item => item.name === '旁白') ? '' : '旁白', speaker: config?.default_speaker || '', instructions: '', speech_rate: config?.speech_rate || 0 }]); setSelectedVoiceId(id); setTab('voices')
  }
  async function generate() {
    if (!config?.has_key || !config.enabled || !draft?.text.trim() || !voice?.speaker || voice.name.trim() === '待分配角色' || activeTake) return
    await action('generate', async () => {
      const ids = selectedVoiceDirty ? await saveVoiceBindings(voice.id) : {}
      const id = await saveLine({ ...draft, voice_id: draft.voice_id ? ids[draft.voice_id] || draft.voice_id : null })
      await api(`${path}/lines/${encodeURIComponent(id)}/generate`, json('POST', {})); await reload()
    })
  }
  async function batch(operation: 'generate' | 'select') {
    const ids = checkedIds.filter(id => data.lines.some(line => line.id === id))
    if (!ids.length) return
    if (voiceDirty || ids.some(id => drafts[id] && JSON.stringify(drafts[id]) !== JSON.stringify(editable(data.lines.find(line => line.id === id)!)))) {
      setError('请先保存所选台词与角色声音的修改，再进行批量处理。'); return
    }
    await action(`batch-${operation}`, async () => {
      const results: Array<{ line_id: string; status: string; message?: string }> = []
      try {
        for (let start = 0; start < ids.length; start += 300) {
          const result = await api<{ results: typeof results }>(`${path}/batch/${operation}`, json('POST', { line_ids: ids.slice(start, start + 300) }))
          results.push(...result.results)
        }
      } finally { await reload(); await onAssetsChanged?.() }
      const succeeded = results.filter(item => item.status === 'generated' || item.status === 'selected').length
      const failures = results.filter(item => item.status === 'failed')
      setNotice(`${operation === 'generate' ? '已提交' : '已选用'} ${succeeded} 条，跳过 ${results.length - succeeded - failures.length} 条`)
      if (failures.length) setError(failures.map(item => `台词 ${data.lines.findIndex(line => line.id === item.line_id) + 1}：${item.message}`).join('；'))
    })
  }
  async function syncScenes(ids = sceneIds) {
    if (!ids.length) return
    if (unsavedLines || voiceDirty) { setError('请先保存台词与角色声音的修改，再同步剧本。'); return }
    await action('sync', async () => {
      const preview = await api<SyncPreview>(`${path}/import/preview`, json('POST', { scene_ids: ids }))
      if (!preview.added && !preview.updated && !preview.removed && !preview.preserved) { setNotice('配音台词与剧本一致，无需同步'); return }
      if (!await confirm({ title: '同步剧本台词', size: 'lg', message: `新增 ${preview.added} 条，更新 ${preview.updated} 条，剧本已移除 ${preview.removed} 条，保留手动修改或生成中的台词 ${preview.preserved} 条。已有音频候选会保留；被移除的台词保留为历史，已入片的旧配音需要重新确认。`,
        details: <div className="speech-sync-differences" aria-label="剧本同步差异">{preview.changes?.map((change, index) => <div key={index}>
          <strong>{({ added: '新增', updated: '更新', removed: '保留为历史', preserved: '保留当前修改' })[change.kind]} · {change.role || '台词'}<small>{scenes.find(scene => scene.id === change.scene_id)?.heading}</small></strong>
          {change.before && <p><span>当前</span>{change.before}</p>}{change.after && <p><span>剧本</span>{change.after}</p>}
        </div>)}</div>, confirmLabel: '同步并保留历史', cancelLabel: '暂不同步' })) return
      await api(`${path}/import`, json('POST', { scene_ids: ids, mode: 'sync', sync_token: preview.sync_token }))
      const next = await reload(); setVoices(next.voices); await onAssetsChanged?.(); setNotice('剧本台词已同步，历史配音已保留')
    })
  }
  const sourceLabel = (line: LineDraft) => scenes.find(scene => scene.id === line.scene_id)?.heading || '手动台词'
  function updateVoice(index: number, values: Partial<Voice>) {
    if (values.speaker !== undefined && voicePreview.key === voices[index]?.id) voicePreview.stop()
    setVoices(current => current.map((row, i) => i === index ? { ...row, ...values } : row))
  }

  return <><Modal opened fullScreen={expanded} onClose={() => void requestClose()} trapFocus={!settingsOpen && !dialog} closeOnClickOutside={!busy && !settingsOpen && !dialog} closeOnEscape={!busy && !settingsOpen && !dialog} closeButtonProps={{ disabled: !!busy || settingsOpen || !!dialog }} centered size="min(1080px, 94vw)" radius={expanded ? 0 : 18} title={<span className="speech-title"><Mic2 size={18} />配音{projectName && <small>{projectName}</small>}</span>}
    classNames={{ content: `speech-studio${expanded ? ' speech-studio-expanded' : ''}`, header: 'speech-studio-header', body: 'speech-studio-body' }}>
    <div className="speech-toolbar">
      <Tabs value={tab} onChange={value => { if (value) setTab(value as typeof tab) }} activateTabWithKeyboard={true} className="speech-tabs-root"><Tabs.List className="speech-tabs" aria-label="配音工作区">
        <Tabs.Tab type="button"   onClick={() => setTab('lines')} value={'lines'}>台词与旁白<span className="speech-tab-count">{data.lines.length}</span></Tabs.Tab>
        <Tabs.Tab type="button"   onClick={() => setTab('voices')} value={'voices'}>角色声音<span className="speech-tab-count">{voices.length}</span></Tabs.Tab>
      </Tabs.List></Tabs>
      <div className="speech-toolbar-actions">{onOpenFinalCut && <Button variant="subtle" size="xs" leftSection={<Clapperboard size={14} />} disabled={!!busy} onClick={async () => {
        if ((voiceDirty || unsavedLines || apiKey.trim()) && !await confirm({ title: '前往成片', message: '有未保存的修改，请先保存，或丢弃后继续。', confirmLabel: '丢弃并继续', cancelLabel: '继续编辑' })) return
        onOpenFinalCut()
      }}>查看成片</Button>}
      <Button type="button" variant="subtle" size="xs" className="speech-config-toggle" aria-label="全局语音配置" aria-haspopup="dialog" aria-expanded={settingsOpen} disabled={loading || !!busy} leftSection={<Settings2 size={14} />} rightSection={config?.has_key && config.enabled ? <span className="speech-connected">已配置</span> : undefined} onClick={() => { setConfigError(''); setSettingsOpen(true) }}>全局语音配置</Button>
      <ActionIcon variant="subtle" aria-label={expanded ? '收起配音工作区' : '展开配音工作区'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</ActionIcon></div>
    </div>
    {error && <p className="speech-error" role="alert">{error}</p>}
    {loading ? <div className="speech-empty">正在读取配音资料…</div> : tab === 'voices' ? <section className="speech-voices">
      <header><div><h3>角色声音</h3><p>已收录 {speechStandardVoices.length} 种官方 2.0 音色，支持按名称、语种、场景搜索。试听播放官方样音，不消耗合成额度。</p></div><Button variant="default" size="xs" leftSection={<Plus size={14} />} disabled={!!busy} onClick={addVoice}>新增角色</Button></header>
      {roleVoice ? <div className="speech-voices-layout">
        <nav className="speech-role-list" aria-label="角色声音列表">{voices.map((item, index) => {
          const stored = data.voices.find(row => row.id === item.id)
          const dirty = !stored || JSON.stringify(voiceValues(item)) !== JSON.stringify(voiceValues(stored))
          const count = data.lines.filter(line => (drafts[line.id]?.voice_id || line.voice_id) === item.id).length
          return <UnstyledButton key={item.id} className={`speech-role-item${item.id === roleVoice.id ? ' is-selected' : ''}`} aria-label={`编辑角色声音 ${index + 1}`} aria-pressed={item.id === roleVoice.id} onClick={() => setSelectedVoiceId(item.id)}>
            <span className="speech-role-avatar" aria-hidden="true">{item.name.trim().slice(0, 1) || <Mic2 size={17} />}</span>
            <span className="speech-role-info"><strong>{item.name || '未命名角色'}{dirty && <i title="未保存" aria-label="未保存" />}</strong><span>{speakerLabel(item.speaker)}</span></span><small>{count} 句</small>
          </UnstyledButton>
        })}</nav>
        <div className="speech-voice-detail" key={roleVoice.id}>
          <header className="speech-role-heading"><div><span className="speech-section-label">声音设定</span><h3>{roleVoice.name || '新角色'}</h3><p>用于该角色的全部台词；已有音频会保留原版本。</p></div>
            <ActionIcon type="button" variant="subtle" className="speech-icon-button" aria-label={`移除角色声音 ${roleVoiceIndex + 1}`} disabled={!!busy} onClick={() => {
              if (voicePreview.key === roleVoice.id) voicePreview.stop()
              if (!data.voices.some(row => row.id === roleVoice.id)) { setVoices(current => current.filter(row => row.id !== roleVoice.id)); return }
              void action('delete-voice', async () => { await api(`${path}/voices/${encodeURIComponent(roleVoice.id)}`, { method: 'DELETE' }); await reload(); if (alive.current) setVoices(current => current.filter(row => row.id !== roleVoice.id)) })
            }} data-workspace-control=""><Trash2 size={16} /></ActionIcon>
          </header>
          <div className="speech-voice-identity">
            <TextInput label="角色名称" aria-label={`角色名称 ${roleVoiceIndex + 1}`} placeholder="例如：旁白、林晚" value={roleVoice.name} disabled={!!busy} onChange={event => updateVoice(roleVoiceIndex, { name: event.currentTarget.value })} />
            <SpeechVoicePicker id={roleVoice.id} index={roleVoiceIndex} speaker={roleVoice.speaker} disabled={!!busy} onChange={speaker => updateVoice(roleVoiceIndex, { speaker })} preview={voicePreview} />
          </div>
          <div className="speech-voice-tuning"><div><strong>语速</strong><p>0 为正常语速，负值放慢，正值加快。</p></div><NumberInput aria-label={`角色语速 ${roleVoiceIndex + 1}`} suffix=" %" min={-50} max={100} step={5} value={roleVoice.speech_rate} disabled={!!busy} onChange={value => updateVoice(roleVoiceIndex, { speech_rate: Number(value) || 0 })} /></div>
          <Textarea label="角色默认表演" aria-label={`角色默认表演 ${roleVoiceIndex + 1}`} description="角色的声音基调；每句台词的表演要求可以补充。" placeholder="例如：声音低沉、语气克制，情绪变化时保留适度停顿。" value={roleVoice.instructions} autosize minRows={3} maxRows={6} disabled={!!busy} onChange={event => updateVoice(roleVoiceIndex, { instructions: event.currentTarget.value })} />
          <WorkspaceDisclosure className="speech-custom-voice" label="自定义音色" initiallyOpen={!!roleVoice.speaker && !speechStandardVoice(roleVoice.speaker)}>
            <TextInput label="Speaker ID" aria-label={`Speaker ID ${roleVoiceIndex + 1}`} description="使用其他音色时，从语音控制台复制 ID。" value={roleVoice.speaker} placeholder="输入自定义音色 ID" disabled={!!busy} onChange={event => updateVoice(roleVoiceIndex, { speaker: event.currentTarget.value })} />
          </WorkspaceDisclosure>
        </div>
      </div> : <div className="speech-voice-empty"><Mic2 size={28} /><strong>为角色添加声音</strong><p>先添加旁白或剧中角色，再选择音色与表演基调。</p><Button variant="default" size="xs" leftSection={<Plus size={14} />} onClick={addVoice}>新增角色</Button></div>}
      {voiceIssue && <p className="speech-help">{voiceIssue}</p>}
      <footer><span>{voiceDirty ? '有未保存的声音配置' : voices.length ? '声音配置已保存' : '尚未配置角色声音'}</span><Button size="xs" className="speech-primary" disabled={!!busy || !voiceDirty || !!voiceIssue} loading={busy === 'voices'} onClick={() => void action('voices', async () => { await saveVoiceBindings(); setNotice('角色声音已保存') })}>保存角色声音</Button></footer>
    </section> : <div className="speech-workspace">
      <aside className="speech-sidebar">
        <header><strong>台词列表</strong><ActionIcon type="button" className="speech-icon-button" aria-label="新增台词" disabled={!!busy} onClick={() => { setDrafts(current => ({ ...current, new: current.new || blank(voices[0]?.id || null) })); setSelectedId('new') }} data-workspace-control=""><Plus size={16} /></ActionIcon></header>
        <div className="speech-list-filters"><Select size="xs" aria-label="按场次筛选台词" comboboxProps={filterComboboxProps} value={sceneFilter} allowDeselect={false} searchable data={[{ value: 'all', label: '全部场次' }, ...scenes.map(scene => ({ value: scene.id, label: scene.heading }))]} onChange={value => setSceneFilter(value || 'all')} />
          <Select size="xs" aria-label="按角色筛选台词" comboboxProps={filterComboboxProps} value={roleFilter} allowDeselect={false} searchable data={[{ value: 'all', label: '全部角色' }, ...voiceOptions]} onChange={value => setRoleFilter(value || 'all')} />
          <Select size="xs" aria-label="按状态筛选台词" comboboxProps={filterComboboxProps} value={statusFilter} allowDeselect={false} data={[{ value: 'all', label: '全部状态' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} onChange={value => setStatusFilter(value || 'all')} /></div>
        <WorkspaceDisclosure className="speech-import" label="从剧本导入">
          <p>按场次导入对白和旁白，不会自动生成音频。</p>
          {!scenes.length && <p>暂无场次，请先创作或导入剧本。</p>}
          <div className="speech-import-scenes">{scenes.map(scene => <Checkbox key={scene.id} label={scene.heading} checked={sceneIds.includes(scene.id)} disabled={!!busy} onChange={event => { const checked = event.currentTarget.checked; setSceneIds(current => checked ? [...current, scene.id] : current.filter(id => id !== scene.id)) }} />)}</div>
          <Button size="xs" variant="default" disabled={!sceneIds.length || !!busy} onClick={() => void action('import', async () => {
            const result = await api<{ added: number; skipped: number }>(`${path}/import`, json('POST', { scene_ids: sceneIds })); const next = await reload()
            if (alive.current) { setVoices(current => [...current, ...next.voices.filter(row => !current.some(item => item.id === row.id))]); setSelectedId(next.lines[0]?.id || 'new'); setNotice(`已导入 ${result.added} 条台词${result.skipped ? `，已有 ${result.skipped} 条未重复导入` : ''}`) }
          })}>导入所选场次</Button>
          <Button size="xs" variant="subtle" disabled={!sceneIds.length || !!busy || !data.lines.length} onClick={() => void syncScenes()}>同步所选场次</Button>
        </WorkspaceDisclosure>
        {visibleLines.length > 0 && <div className="speech-batch-tools"><Checkbox size="xs" label={`选择当前列表 ${visibleLines.length} 条`} checked={visibleLines.every(line => checkedIds.includes(line.id))} indeterminate={visibleLines.some(line => checkedIds.includes(line.id)) && !visibleLines.every(line => checkedIds.includes(line.id))} disabled={!!busy} onChange={event => {
          const checked = event.currentTarget.checked; setCheckedIds(current => checked ? [...new Set([...current, ...visibleLines.map(line => line.id)])] : current.filter(id => !visibleLines.some(line => line.id === id)))
        }} />{checkedIds.length > 0 && <><span>已选 {checkedIds.length} 条</span><div><Button variant="default" size="compact-xs" disabled={!!busy || !config?.has_key || !config.enabled} onClick={() => void batch('generate')}>生成缺失配音</Button><Button variant="default" size="compact-xs" disabled={!!busy} onClick={() => void batch('select')}>选用有效候选</Button></div></>}</div>}
        <div className="speech-line-list">
          {drafts.new && <UnstyledButton type="button" className={`speech-line-item${selectedId === 'new' ? ' is-selected' : ''}`} onClick={() => setSelectedId('new')}><span className="speech-line-meta"><strong>新台词</strong><small>未保存</small></span><span>{drafts.new.text || '填写对白或旁白'}</span></UnstyledButton>}
          {visibleLines.map((line) => <div className={`speech-line-row${selectedId === line.id ? ' is-selected' : ''}`} key={line.id}><Checkbox size="xs" aria-label={`选择台词 ${data.lines.indexOf(line) + 1}`} checked={checkedIds.includes(line.id)} disabled={!!busy} onChange={event => { const checked = event.currentTarget.checked; setCheckedIds(current => checked ? [...current, line.id] : current.filter(id => id !== line.id)) }} /><UnstyledButton type="button" className={`speech-line-item${selectedId === line.id ? ' is-selected' : ''}`} aria-pressed={selectedId === line.id} onClick={() => setSelectedId(line.id)}>
            <span className="speech-line-meta"><small>{String(data.lines.indexOf(line) + 1).padStart(2, '0')}</small><strong>{voices.find(item => item.id === (drafts[line.id]?.voice_id || line.voice_id))?.name || '待分配角色'}</strong><small className="speech-line-state" data-state={lineStatus(line)}>{statusLabels[lineStatus(line)]}</small></span>
            <span>{drafts[line.id]?.text || line.text || '空白台词'}</span><small>{sourceLabel(line)}{drafts[line.id] && ' · 未保存'}</small>
            {(line.source_status === 'changed' || line.source_status === 'removed') && <small>{line.source_status === 'removed' ? '剧本已移除 · 音频历史保留' : '剧本已更新 · 待同步'}</small>}
          </UnstyledButton></div>)}
          {!visibleLines.length && !drafts.new && <div className="speech-list-empty"><p>{data.lines.length ? '没有符合筛选条件的台词' : '从剧本导入，或新增一条台词'}</p>{data.lines.length > 0 && <Button variant="subtle" size="compact-xs" onClick={() => { setSceneFilter('all'); setRoleFilter('all'); setStatusFilter('all') }}>清除筛选</Button>}</div>}
        </div>
      </aside>
      {draft ? <main className="speech-editor" aria-label="台词编辑">
          <header className="speech-editor-heading"><div><span className="speech-section-label">{selected ? `台词 ${String(data.lines.indexOf(selected) + 1).padStart(2, '0')}` : '新增台词'}</span><h3>{voice?.name || '对白与旁白'}</h3><p title={sourceLabel(draft)}>{sourceLabel(draft)}</p></div><div className="speech-editor-heading-actions"><span className="speech-editor-state">{draftDirty ? '未保存修改' : selected ? statusLabels[lineStatus(selected)] : '未保存'}</span>{selected && <ActionIcon type="button" className="speech-icon-button" aria-label="删除当前台词" disabled={!!busy || !!activeTake} onClick={() => void action('delete', async () => {
            await api(`${path}/lines/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); const next = await reload()
            if (alive.current) { setSelectedId(next.lines[0]?.id || 'new'); if (!next.lines.length) setDrafts(current => ({ ...current, new: blank(voices[0]?.id || null) })) }
          })} data-workspace-control=""><Trash2 size={15} /></ActionIcon>}</div></header>
        <div className="speech-editor-content">
        <div className="speech-editor-scroll">
          <section className="speech-dialogue-section">
          <Select label="角色声音" aria-label="台词角色" data={voiceOptions} value={draft.voice_id} searchable clearable placeholder="选择角色或旁白" disabled={!!busy || !!activeTake} onChange={value => edit({ voice_id: value })} />
          <div className="speech-bound-voice"><Volume2 size={14} /><span>{voice ? speakerLabel(voice.speaker) : '尚未指定角色声音'}</span><Button type="button" onClick={() => { if (voices.length) { setSelectedVoiceId(voice?.id || voices[0].id); setTab('voices') } else addVoice() }} data-workspace-control="" variant="subtle" size="compact-xs">设置声音</Button></div>
          {voice?.name.trim() === '待分配角色' && <p className="speech-help">请先确认这句台词的角色，再指定对应声音。</p>}
          <Textarea className="speech-spoken-text" label="朗读文本" aria-label="朗读文本" description="只填写需要说出的内容，角色名和表演要求单独设置。" placeholder="输入对白或旁白…" value={draft.text} autosize minRows={6} maxRows={14} disabled={!!busy || !!activeTake} onChange={event => edit({ text: event.currentTarget.value })} />
          {(selected?.source_status === 'changed' || selected?.source_status === 'removed') && <div className="speech-source-notice"><p>{selected.source_status === 'removed' ? '这句台词已从剧本移除，历史音频仍保留。' : '原剧本台词已变化，请同步后再生成或加入成片。'}</p><div>{selected.scene_id && scenes.some(scene => scene.id === selected.scene_id) && <Button size="xs" variant="default" disabled={!!busy || !!activeTake} onClick={() => void syncScenes([selected.scene_id!])}>同步本场剧本</Button>}<Button size="xs" variant="subtle" disabled={!!busy || !!activeTake || draftDirty} onClick={() => void action('detach', async () => { await api(`${path}/lines/${selected.id}/detach-source`, json('POST', {})); await reload(); await onAssetsChanged?.() })}>保留为手动台词</Button></div></div>}
          </section>
          <section className="speech-direction-section"><div className="speech-section-heading"><h4>表演指导</h4><span>仅作声音参考，不会朗读</span></div>
          <Textarea label="表演要求" aria-label="表演要求" placeholder="例如：压低声音，语气克制，最后一句稍作停顿。" value={draft.instructions} autosize minRows={3} maxRows={5} disabled={!!busy || !!activeTake} onChange={event => edit({ instructions: event.currentTarget.value })} />
          <WorkspaceDisclosure className="speech-performance" label="情境参考"><div>
            <Textarea label="情境参考" aria-label="情境参考" description="描述场景和情绪，作为表演参考，不会朗读。" value={draft.context_text} autosize minRows={2} maxRows={5} disabled={!!busy || !!activeTake} onChange={event => edit({ context_text: event.currentTarget.value })} />
          </div></WorkspaceDisclosure>
          </section>
          {latestFailure && <p className="speech-error" role="alert">上次生成失败：{latestFailure.error || '请重试'}</p>}
        </div>
        <aside className="speech-output-panel" aria-label="试听与入片">
          <section className="speech-candidates" aria-label="候选音频"><header><h4>候选音频</h4><span className="speech-tab-count">{candidateTakes.length}</span></header>
            {!candidateTakes.length && <div className="speech-candidates-empty"><span className="speech-empty-icon"><AudioLines size={25} /></span><strong>{activeTake ? '正在生成配音' : '等待第一段配音'}</strong><p>{activeTake ? '完成后会出现在这里，可试听并选择版本。' : '填写朗读文本与表演要求，生成后在这里试听、选用。'}</p></div>}
            {selected && candidateTakes.map((take, index) => {
              const candidateNumber = candidateTakes.length - index
              const stale = !isSpeechTakeCurrent(take, draft, voice)
              return <div className={`speech-take${selected.selected_asset_id === take.asset_id ? ' is-selected' : ''}`} key={take.id}>
                <div className="speech-take-heading"><strong>候选 {candidateNumber}</strong>{typeof take.duration_ms === 'number' && <span>{(take.duration_ms / 1000).toFixed(1)} 秒</span>}{stale && <small>历史版本</small>}<Button variant="subtle" size="compact-xs" leftSection={selected.selected_asset_id === take.asset_id ? <Check size={12} /> : undefined} disabled={!!busy || !!activeTake || selected.selected_asset_id === take.asset_id} onClick={() => void action('select', async () => {
                  await api(`${path}/lines/${encodeURIComponent(selected.id)}/select`, json('POST', { asset_id: take.asset_id })); await reload(); await onAssetsChanged?.()
                })}>{selected.selected_asset_id === take.asset_id ? '已选用' : '选用此版本'}</Button></div>
                <StudioMediaPlayer controls preload="metadata" src={take.url || `/api/assets/${encodeURIComponent(take.asset_id!)}/file`} aria-label={`试听候选 ${candidateNumber}`} kind="audio" />
                {stale && <WorkspaceDisclosure className="speech-take-version" label={<>查看此版本文本与表演</>}><p>{take.text}</p>{take.instructions && <small>{take.instructions}</small>}<small>音色：{take.speaker}</small></WorkspaceDisclosure>}
              </div>
            })}
          </section>
          {selectedTake && selected && <SpeechPlacementEditor projectId={projectId} line={{ ...selected, selected_is_stale: selectedStale || draftDirty || selectedVoiceDirty }} placement={data.placements?.find(item => item.line_id === selected.id)} shots={shots} initialShotId={initialShotId} finalCutCanvasId={finalCutCanvasId} onChanged={async () => { await reload(); await onAssetsChanged?.() }} />}
          {!selectedTake && <section className="speech-placement-placeholder"><h4>配音入片</h4><p>选用候选音频后，设置起始镜头与播放时间，将对白加入成片。</p></section>}
        </aside>
        </div>
        <footer className="speech-editor-actions"><div className="speech-action-status" role="status">{activeTake ? <><span className="speech-generating">生成中<span aria-hidden="true">...</span></span><small>{elapsed(activeTake, now)}</small></> : busy === 'generate' ? <span>正在准备配音…</span> : <span>{draftDirty ? '台词有未保存修改' : selectedStale ? '已选用的配音需要更新' : selected?.selected_asset_id ? data.placements?.some(item => item.line_id === selected.id) ? '已选用配音，已设置入片位置' : '已选用配音，尚未加入成片' : '填写台词并选择声音后生成'}</span>}</div>
          <Button variant="default" size="xs" disabled={!!busy || !!activeTake || !draftDirty} onClick={() => void action('save', async () => {
            const ids = selectedVoiceDirty && voice ? await saveVoiceBindings(voice.id) : {}; await saveLine({ ...draft, voice_id: draft.voice_id ? ids[draft.voice_id] || draft.voice_id : null }); setNotice('台词已保存')
          })}>保存台词</Button>
          <Button className="speech-primary" size="xs" loading={busy === 'generate'} leftSection={<Mic2 size={14} />} disabled={!!busy || !!activeTake || !config?.has_key || !config.enabled || !draft.text.trim() || !voice?.speaker.trim() || !voice.name.trim() || voice.name.trim() === '待分配角色' || selected?.source_status === 'changed' || selected?.source_status === 'removed'} onClick={() => void generate()}>生成配音</Button>
        </footer>
      </main> : <div className="speech-empty">选择台词，或点击加号新增。</div>}
    </div>}
    {notice && <div className="speech-notice" role="status">{notice}</div>}
  </Modal>
  <Modal opened={settingsOpen} onClose={() => void requestSettingsClose()} title={<span className="speech-settings-title"><Settings2 size={18} />全局语音配置</span>} centered size="sm" zIndex={480}
    trapFocus={!dialog} closeOnClickOutside={!busy && !dialog} closeOnEscape={!busy && !dialog} closeButtonProps={{ disabled: !!busy || !!dialog, 'aria-label': '关闭语音配置' }}
    classNames={{ content: 'speech-settings-modal', header: 'speech-settings-header', body: 'speech-settings-body' }}>
    <section className="speech-config" aria-label="语音配置">
      <div><div className="speech-config-provider"><strong>豆包语音合成 2.0</strong><span className={config?.has_key && config.enabled ? 'speech-connected' : 'speech-config-pending'}>{config?.has_key ? config.enabled ? '已配置' : '未启用' : '待配置'}</span></div>
        <p>适用于所有项目。角色音色、语速与表演要求在“角色声音”中设置。</p></div>
      <PasswordInput label="语音 API Key" aria-label="语音 API Key" description={config?.has_key ? '已保存的密钥不会显示；填写新密钥可更换。' : '填写火山引擎语音控制台提供的 API Key。'} placeholder={config?.has_key ? '填写新密钥以更换' : '填写新版语音控制台 API Key'} value={apiKey} onChange={event => setApiKey(event.currentTarget.value)} autoComplete="new-password" data-autofocus disabled={!!busy} />
      <p className="speech-config-scope">密钥保存在本机服务配置中，不随项目保存。</p>
      {configError && <p className="speech-error" role="alert">{configError}</p>}
      <div className="speech-config-actions"><Button size="xs" variant="default" disabled={!!busy} onClick={() => void requestSettingsClose()}>返回配音</Button>
        <Button size="xs" className="speech-primary" loading={busy === 'config'} disabled={!!busy || (!apiKey.trim() && !config?.has_key)} onClick={() => void action('config', async () => {
          const configuration = await api<SpeechConfig>('/speech/config', json('PUT', { ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}), enabled: true }))
          if (alive.current) { setApiKey(''); setConfig(configuration); setSettingsOpen(false); setNotice('语音配置已保存') }
        })}>{config?.enabled ? '保存密钥' : '保存并启用'}</Button></div>
    </section>
  </Modal>{dialog}</>
}
