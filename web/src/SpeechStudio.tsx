import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Modal, NumberInput, PasswordInput, Select, Textarea, TextInput } from '@mantine/core'
import { Check, ChevronDown, Mic2, Plus, Settings2, Trash2, Volume2 } from 'lucide-react'
import { api, json } from './api'
import type { ScriptScene } from './api'
import { useAppDialog } from './AppDialog'
import './speech-studio.css'

type SpeechConfig = { enabled: boolean; has_key: boolean; default_speaker: string; speech_rate: number; endpoint: string; resource_id: string }
type Voice = { id: string; project_id?: string; name: string; speaker: string; instructions: string; speech_rate: number }
type Take = { id: string; line_id: string; job_id: string; asset_id: string | null; status: 'queued' | 'running' | 'succeeded' | 'failed'; error: string | null;
  text: string; speaker: string; instructions: string; context_text: string; speech_rate: number; created_at: string; url: string | null; filename: string | null; duration_ms?: number | null }
type LineDraft = { voice_id: string | null; scene_id: string | null; text: string; instructions: string; context_text: string }
type SpeechLine = LineDraft & { id: string; project_id: string; position: number; selected_asset_id: string | null; created_at: string; updated_at: string; takes: Take[] }
type SpeechData = { voices: Voice[]; lines: SpeechLine[] }
export type SpeechStudioProps = { projectId: string; projectName?: string; scenes?: ScriptScene[]; onClose: () => void; onAssetsChanged?: () => Promise<unknown> | void }

const isActive = (take: Take) => take.status === 'queued' || take.status === 'running'
const errorText = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
const editable = (line: LineDraft): LineDraft => ({ voice_id: line.voice_id, scene_id: line.scene_id, text: line.text, instructions: line.instructions, context_text: line.context_text })
const blank = (voiceId: string | null = null): LineDraft => ({ voice_id: voiceId, scene_id: null, text: '', instructions: '', context_text: '' })
const elapsed = (take: Take, now: number) => `${Math.max(0, Math.floor((now - new Date(take.created_at).getTime()) / 1000))} 秒`
const voiceValues = (voice: Voice) => ({ name: voice.name.trim(), speaker: voice.speaker.trim(), instructions: voice.instructions, speech_rate: voice.speech_rate })
const standardVoices = [
  { value: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0' },
  { value: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0' },
  { value: 'zh_male_m191_uranus_bigtts', label: '云舟 2.0' },
  { value: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0' },
  { value: 'zh_male_liufei_uranus_bigtts', label: '刘飞 2.0' },
  { value: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年梓辛 2.0' },
]

export default function SpeechStudio({ projectId, projectName, scenes = [], onClose, onAssetsChanged }: SpeechStudioProps) {
  const [config, setConfig] = useState<SpeechConfig | null>(null), [data, setData] = useState<SpeechData>({ voices: [], lines: [] })
  const [voices, setVoices] = useState<Voice[]>([]), [drafts, setDrafts] = useState<Record<string, LineDraft>>({})
  const [selectedId, setSelectedId] = useState(''), [tab, setTab] = useState<'lines' | 'voices'>('lines')
  const [sceneIds, setSceneIds] = useState<string[]>([]), [apiKey, setApiKey] = useState(''), [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())
  const { confirm, dialog } = useAppDialog({ zIndex: 500 })
  const alive = useRef(true), dataRef = useRef(data), refreshRef = useRef(onAssetsChanged), pollError = useRef(false), localVoiceId = useRef(0)
  dataRef.current = data; refreshRef.current = onAssetsChanged
  const path = `/projects/${encodeURIComponent(projectId)}/speech`
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    setLoading(true); setError(''); setDrafts({}); setSelectedId(''); setSceneIds([])
    void Promise.all([api<SpeechConfig>('/speech/config', { signal: controller.signal }), api<SpeechData>(path, { signal: controller.signal })])
      .then(([configuration, speech]) => {
        if (controller.signal.aborted) return
        setConfig(configuration); setData(speech); setVoices(speech.voices)
        setSelectedId(speech.lines[0]?.id || 'new')
        if (!speech.lines.length) setDrafts({ new: blank(speech.voices[0]?.id || null) })
        setSettingsOpen(!configuration.has_key || !configuration.enabled)
      })
      .catch(issue => { if (!controller.signal.aborted) setError(errorText(issue)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { alive.current = false; controller.abort() }
  }, [path])

  const pendingKey = data.lines.flatMap(line => line.takes.filter(isActive).map(take => take.id)).sort().join(',')
  useEffect(() => {
    if (!pendingKey) return
    let stopped = false, timer: number | undefined
    const controller = new AbortController()
    const tick = async () => {
      try {
        const next = await api<SpeechData>(path, { signal: controller.signal })
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
  }, [pendingKey, path])
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
  const draft = drafts[selectedId] || (selected ? editable(selected) : null)
  const voice = voices.find(item => item.id === draft?.voice_id)
  const activeTake = selected?.takes.find(isActive)
  const latestFailure = selected?.takes[0]?.status === 'failed' ? selected.takes[0] : null
  const voiceDirty = JSON.stringify(voices.map(voiceValues)) !== JSON.stringify(data.voices.map(voiceValues))
  const storedVoice = data.voices.find(item => item.id === voice?.id)
  const selectedVoiceDirty = !!voice && (!storedVoice || JSON.stringify(voiceValues(voice)) !== JSON.stringify(voiceValues(storedVoice)))
  const draftDirty = !!draft && (!selected || JSON.stringify(editable(selected)) !== JSON.stringify(draft))
  const voiceIssue = voices.some(item => !item.name.trim() || !item.speaker.trim()) ? '请填写每个角色的名称和音色 ID' :
    new Set(voices.map(item => item.name.trim())).size !== voices.length ? '角色名称不能重复' : ''
  const voiceOptions = voices.map(item => ({ value: item.id, label: item.name || '未命名角色' }))
  const unsavedLines = Object.entries(drafts).some(([id, value]) => {
    const stored = data.lines.find(item => item.id === id)
    return stored ? JSON.stringify(editable(stored)) !== JSON.stringify(value) : !!(value.text.trim() || value.instructions.trim() || value.context_text.trim())
  })
  async function requestClose() {
    if (busy) return
    if ((voiceDirty || unsavedLines || apiKey.trim()) && !await confirm({ title: '关闭配音', message: '有未保存的修改，关闭后将丢弃这些修改。', confirmLabel: '丢弃并关闭', cancelLabel: '继续编辑' })) return
    onClose()
  }
  function edit(values: Partial<LineDraft>) { if (draft) setDrafts(current => ({ ...current, [selectedId]: { ...draft, ...values } })) }
  async function action(key: string, run: () => Promise<void>) {
    if (busy) return
    setBusy(key); setError(''); setNotice('')
    try { await run() } catch (issue) { if (alive.current) setError(errorText(issue)) }
    finally { if (alive.current) setBusy('') }
  }
  async function reload() {
    const next = await api<SpeechData>(path)
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
    setVoices(current => [...current, { id: `local-${++localVoiceId.current}`, name: current.some(item => item.name === '旁白') ? '' : '旁白', speaker: config?.default_speaker || '', instructions: '', speech_rate: config?.speech_rate || 0 }]); setTab('voices')
  }
  async function generate() {
    if (!config?.has_key || !config.enabled || !draft?.text.trim() || !voice?.speaker || voice.name.trim() === '待分配角色' || activeTake) return
    await action('generate', async () => {
      const ids = selectedVoiceDirty ? await saveVoiceBindings(voice.id) : {}
      const id = await saveLine({ ...draft, voice_id: draft.voice_id ? ids[draft.voice_id] || draft.voice_id : null })
      await api(`${path}/lines/${encodeURIComponent(id)}/generate`, json('POST', {})); await reload()
    })
  }
  const sourceLabel = (line: LineDraft) => scenes.find(scene => scene.id === line.scene_id)?.heading || '手动台词'
  function updateVoice(index: number, values: Partial<Voice>) { setVoices(current => current.map((row, i) => i === index ? { ...row, ...values } : row)) }

  return <><Modal opened onClose={() => void requestClose()} closeOnClickOutside={!busy} closeOnEscape={!busy} closeButtonProps={{ disabled: !!busy }} centered size="min(1080px, 94vw)" radius={18} title={<span className="speech-title"><Mic2 size={18} />配音{projectName && <small>{projectName}</small>}</span>}
    classNames={{ content: 'speech-studio', header: 'speech-studio-header', body: 'speech-studio-body' }}>
    <div className="speech-toolbar">
      <div className="speech-tabs" role="tablist" aria-label="配音工作区">
        <button type="button" role="tab" aria-selected={tab === 'lines'} onClick={() => setTab('lines')}>台词与旁白<span>{data.lines.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'voices'} onClick={() => setTab('voices')}>角色声音<span>{voices.length}</span></button>
      </div>
      <button type="button" className="speech-config-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={14} />语音配置{config?.has_key && config.enabled && <span className="speech-connected">已配置</span>}<ChevronDown size={13} /></button>
    </div>
    {settingsOpen && <section className="speech-config" aria-label="语音配置">
      <div><strong>豆包语音合成 2.0</strong><p>使用标准音色。API Key 保存在本机服务配置中。</p></div>
      <PasswordInput aria-label="语音 API Key" placeholder={config?.has_key ? '填写新密钥以更换' : '填写新版语音控制台 API Key'} value={apiKey} onChange={event => setApiKey(event.currentTarget.value)} autoComplete="new-password" disabled={!!busy} />
      <Button size="xs" variant="default" disabled={!!busy || (!apiKey.trim() && !config?.has_key)} onClick={() => void action('config', async () => {
        const configuration = await api<SpeechConfig>('/speech/config', json('PUT', { ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}), enabled: true }))
        if (alive.current) { setApiKey(''); setConfig(configuration); setNotice('语音配置已保存') }
      })}>{config?.enabled ? '保存密钥' : '保存并启用'}</Button>
    </section>}
    {error && <p className="speech-error" role="alert">{error}</p>}
    {loading ? <div className="speech-empty">正在读取配音资料…</div> : tab === 'voices' ? <section className="speech-voices">
      <header><div><h3>固定角色声音</h3><p>每个角色使用固定音色，逐句表演可以单独调整。</p></div><Button variant="default" size="xs" leftSection={<Plus size={13} />} disabled={!!busy} onClick={addVoice}>新增角色</Button></header>
      {!voices.length && <div className="speech-voice-empty">先为旁白或剧中角色添加一个声音。</div>}
      <div className="speech-voice-list">{voices.map((item, index) => <div className="speech-voice-entry" key={item.id}><div className="speech-voice-row">
        <TextInput label="角色名称" aria-label={`角色名称 ${index + 1}`} placeholder="例如：旁白、林晚" value={item.name} disabled={!!busy} onChange={event => updateVoice(index, { name: event.currentTarget.value })} />
        <Select label="标准音色" aria-label={`标准音色 ${index + 1}`} searchable data={standardVoices} value={standardVoices.some(row => row.value === item.speaker) ? item.speaker : null} placeholder="选择音色" disabled={!!busy} onChange={value => { if (value) updateVoice(index, { speaker: value }) }} />
        <TextInput label="标准音色 Speaker ID" aria-label={`Speaker ID ${index + 1}`} value={item.speaker} placeholder="从语音控制台音色库复制" disabled={!!busy} onChange={event => updateVoice(index, { speaker: event.currentTarget.value })} />
        <NumberInput label="语速调整" aria-label={`角色语速 ${index + 1}`} min={-50} max={100} step={5} value={item.speech_rate} disabled={!!busy} onChange={value => updateVoice(index, { speech_rate: Number(value) || 0 })} />
        <button type="button" className="speech-icon-button" aria-label={`移除角色声音 ${index + 1}`} disabled={!!busy} onClick={() => {
          if (!data.voices.some(row => row.id === item.id)) { setVoices(current => current.filter(row => row.id !== item.id)); return }
          void action('delete-voice', async () => { await api(`${path}/voices/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await reload(); if (alive.current) setVoices(current => current.filter(row => row.id !== item.id)) })
        }}><Trash2 size={15} /></button>
      </div><Textarea label="角色默认表演" aria-label={`角色默认表演 ${index + 1}`} placeholder="例如：低沉、克制；单句表演要求可补充。" value={item.instructions} autosize minRows={1} maxRows={3} disabled={!!busy} onChange={event => updateVoice(index, { instructions: event.currentTarget.value })} /></div>)}</div>
      {voiceIssue && <p className="speech-help">{voiceIssue}</p>}
      <footer><span>{voiceDirty ? '有未保存的声音配置' : '声音配置已保存'}</span><Button size="xs" variant="default" disabled={!!busy || !voiceDirty || !!voiceIssue} onClick={() => void action('voices', async () => { await saveVoiceBindings(); setNotice('角色声音已保存') })}>保存角色声音</Button></footer>
    </section> : <div className="speech-workspace">
      <aside className="speech-sidebar">
        <header><strong>台词列表</strong><button type="button" className="speech-icon-button" aria-label="新增台词" disabled={!!busy} onClick={() => { setDrafts(current => ({ ...current, new: current.new || blank(voices[0]?.id || null) })); setSelectedId('new') }}><Plus size={16} /></button></header>
        <details className="speech-import"><summary>从剧本导入<ChevronDown size={13} /></summary>
          <p>按场次导入对白和旁白，不会自动生成音频。</p>
          {!scenes.length && <p>暂无场次，请先创作或导入剧本。</p>}
          <div className="speech-import-scenes">{scenes.map(scene => <Checkbox key={scene.id} label={scene.heading} checked={sceneIds.includes(scene.id)} disabled={!!busy} onChange={event => { const checked = event.currentTarget.checked; setSceneIds(current => checked ? [...current, scene.id] : current.filter(id => id !== scene.id)) }} />)}</div>
          <Button size="xs" variant="default" disabled={!sceneIds.length || !!busy} onClick={() => void action('import', async () => {
            const result = await api<{ added: number; skipped: number }>(`${path}/import`, json('POST', { scene_ids: sceneIds })); const next = await reload()
            if (alive.current) { setVoices(current => [...current, ...next.voices.filter(row => !current.some(item => item.id === row.id))]); setSelectedId(next.lines[0]?.id || 'new'); setNotice(`已导入 ${result.added} 条台词${result.skipped ? `，已有 ${result.skipped} 条未重复导入` : ''}`) }
          })}>导入所选场次</Button>
        </details>
        <div className="speech-line-list">
          {drafts.new && <button type="button" className={`speech-line-item${selectedId === 'new' ? ' is-selected' : ''}`} onClick={() => setSelectedId('new')}><span className="speech-line-meta"><strong>新台词</strong><small>未保存</small></span><span>{drafts.new.text || '填写对白或旁白'}</span></button>}
          {data.lines.map((line, index) => <button type="button" key={line.id} className={`speech-line-item${selectedId === line.id ? ' is-selected' : ''}`} onClick={() => setSelectedId(line.id)}>
            <span className="speech-line-meta"><small>{String(index + 1).padStart(2, '0')}</small><strong>{voices.find(item => item.id === (drafts[line.id]?.voice_id || line.voice_id))?.name || '待分配角色'}</strong><small>{line.takes.some(isActive) ? '生成中' : line.selected_asset_id ? '已选用' : line.takes.filter(take => take.asset_id).length ? `${line.takes.filter(take => take.asset_id).length} 个候选` : '待配音'}</small></span>
            <span>{drafts[line.id]?.text || line.text || '空白台词'}</span><small>{sourceLabel(line)}{drafts[line.id] && ' · 未保存'}</small>
          </button>)}
        </div>
      </aside>
      {draft ? <main className="speech-editor">
        <div className="speech-editor-scroll">
          <header className="speech-editor-heading"><div><h3>{selected ? `台词 ${data.lines.indexOf(selected) + 1}` : '新增台词'}</h3><p>{sourceLabel(draft)}</p></div>{selected && <button type="button" className="speech-icon-button" aria-label="删除当前台词" disabled={!!busy || !!activeTake} onClick={() => void action('delete', async () => {
            await api(`${path}/lines/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); const next = await reload()
            if (alive.current) { setSelectedId(next.lines[0]?.id || 'new'); if (!next.lines.length) setDrafts(current => ({ ...current, new: blank(voices[0]?.id || null) })) }
          })}><Trash2 size={15} /></button>}</header>
          <Select label="角色声音" aria-label="台词角色" data={voiceOptions} value={draft.voice_id} searchable clearable placeholder="选择角色或旁白" disabled={!!busy || !!activeTake} onChange={value => edit({ voice_id: value })} />
          <div className="speech-bound-voice"><Volume2 size={13} /><span>{voice?.speaker || '尚未指定角色声音'}</span><button type="button" onClick={() => voices.length ? setTab('voices') : addVoice()}>设置声音</button></div>
          {voice?.name.trim() === '待分配角色' && <p className="speech-help">请先确认这句台词的角色，再指定对应声音。</p>}
          <Textarea label="朗读文本" aria-label="朗读文本" description="只填写需要说出的内容，角色名和表演要求单独设置。" placeholder="输入对白或旁白…" value={draft.text} autosize minRows={4} maxRows={10} disabled={!!busy || !!activeTake} onChange={event => edit({ text: event.currentTarget.value })} />
          <Textarea label="表演要求" aria-label="表演要求" placeholder="例如：压低声音，语气克制，最后一句稍作停顿。" value={draft.instructions} autosize minRows={2} maxRows={5} disabled={!!busy || !!activeTake} onChange={event => edit({ instructions: event.currentTarget.value })} />
          <details className="speech-performance"><summary>情境参考<ChevronDown size={13} /></summary><div>
            <Textarea label="情境参考" aria-label="情境参考" description="描述场景和情绪，作为表演参考，不会朗读。" value={draft.context_text} autosize minRows={2} maxRows={5} disabled={!!busy || !!activeTake} onChange={event => edit({ context_text: event.currentTarget.value })} />
          </div></details>
          {latestFailure && <p className="speech-error" role="alert">上次生成失败：{latestFailure.error || '请重试'}</p>}
          {selected && <section className="speech-candidates" aria-label="候选音频"><header><h4>候选音频</h4><span>{selected.takes.filter(take => take.asset_id).length}</span></header>
            {!selected.takes.some(take => take.asset_id) && <p className="speech-help">生成后可在这里试听，选择满意的版本。</p>}
            {selected.takes.filter(take => take.asset_id).map((take, index) => {
              const currentInstructions = [voice?.instructions, draft.instructions].filter(Boolean).join('\n')
              const stale = take.text !== draft.text || take.instructions !== currentInstructions || take.speaker !== voice?.speaker || take.context_text !== draft.context_text || take.speech_rate !== voice?.speech_rate
              return <div className={`speech-take${selected.selected_asset_id === take.asset_id ? ' is-selected' : ''}`} key={take.id}>
                <div className="speech-take-heading"><strong>候选 {index + 1}</strong>{typeof take.duration_ms === 'number' && <span>{(take.duration_ms / 1000).toFixed(1)} 秒</span>}{stale && <small>历史版本</small>}<Button variant="subtle" size="compact-xs" leftSection={selected.selected_asset_id === take.asset_id ? <Check size={12} /> : undefined} disabled={!!busy || !!activeTake || selected.selected_asset_id === take.asset_id} onClick={() => void action('select', async () => {
                  await api(`${path}/lines/${encodeURIComponent(selected.id)}/select`, json('POST', { asset_id: take.asset_id })); await reload(); await onAssetsChanged?.()
                })}>{selected.selected_asset_id === take.asset_id ? '已选用' : '选用此版本'}</Button></div>
                <audio controls preload="none" src={take.url || `/api/assets/${encodeURIComponent(take.asset_id!)}/file`} aria-label={`试听候选 ${index + 1}`} />
                {stale && <details className="speech-take-version"><summary>查看此版本文本与表演</summary><p>{take.text}</p>{take.instructions && <small>{take.instructions}</small>}<small>音色：{take.speaker}</small></details>}
              </div>
            })}
          </section>}
        </div>
        <footer className="speech-editor-actions"><div className="speech-action-status" role="status">{activeTake ? <><span className="speech-generating">生成中<span aria-hidden="true">...</span></span><small>{elapsed(activeTake, now)}</small></> : busy === 'generate' ? <span>正在准备配音…</span> : <span>{draftDirty ? '台词有未保存修改' : selected?.selected_asset_id ? '已选用配音版本' : '修改后可生成新的候选'}</span>}</div>
          <Button variant="default" size="xs" disabled={!!busy || !!activeTake || !draftDirty} onClick={() => void action('save', async () => {
            const ids = selectedVoiceDirty && voice ? await saveVoiceBindings(voice.id) : {}; await saveLine({ ...draft, voice_id: draft.voice_id ? ids[draft.voice_id] || draft.voice_id : null }); setNotice('台词已保存')
          })}>保存台词</Button>
          <Button className="speech-primary" size="xs" leftSection={<Mic2 size={13} />} disabled={!!busy || !!activeTake || !config?.has_key || !config.enabled || !draft.text.trim() || !voice?.speaker.trim() || !voice.name.trim() || voice.name.trim() === '待分配角色'} onClick={() => void generate()}>生成配音</Button>
        </footer>
      </main> : <div className="speech-empty">选择台词，或点击加号新增。</div>}
    </div>}
    {notice && <div className="speech-notice" role="status">{notice}</div>}
  </Modal>{dialog}</>
}
