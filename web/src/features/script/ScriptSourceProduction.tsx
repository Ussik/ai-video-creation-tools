import { Accordion, Button, Checkbox, NumberInput, Select } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import type { SourceProductionState } from '@video-studio/shared/script/script-source-production'
import { api, json } from '../../shared/api/api'

type Props = { source: ScriptSourceDocument; scenesVersion: string; unavailable: boolean; canAdapt: boolean;
  onRefresh: () => Promise<unknown>; onAdapt: (episode: number) => void; onStoryboard: (sceneIds: string[]) => void }
export default function ScriptSourceProduction({ source, scenesVersion, unavailable, canAdapt, onRefresh, onAdapt, onStoryboard }: Props) {
  const [started, setStarted] = useState(false)
  const [state, setState] = useState<SourceProductionState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [offsets, setOffsets] = useState<number[]>([])
  const [duration, setDuration] = useState(30)
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('')
  const lock = useRef(false), serial = useRef(0)
  const endpoint = `/projects/${source.project_id}/script/source/production`
  const keyOf = (episode: SourceProductionState['episodes'][number]) => `${episode.episode_number}:${episode.offset}`
  useEffect(() => {
    if (!started) { setLoading(false); return }
    const token = ++serial.current
    setLoading(true); setError(null)
    void api<SourceProductionState>(endpoint).then(value => {
      if (token !== serial.current) return
      setState(value); setSelected(previous => {
        if (value.episodes.some(ep => keyOf(ep) === previous)) return previous
        const first = value.episodes.find(ep => ep.status !== 'ready') || value.episodes[0]
        return first && !first.ambiguous ? keyOf(first) : null
      })
    }).catch(issue => { if (token === serial.current) setError(issue instanceof Error ? issue.message : String(issue)) })
      .finally(() => { if (token === serial.current) setLoading(false) })
    return () => { serial.current++ }
  }, [started, endpoint, source.updated_at, source.revision, scenesVersion, reload])
  const episode = state?.episodes.find(item => keyOf(item) === selected)
  useEffect(() => { setOffsets(episode?.scenes.filter(scene => !episode.imported_offsets.includes(scene.offset) && !episode.blocked_scene_offsets?.includes(scene.offset)).map(scene => scene.offset).slice(0, 100) || []); setNotice('') }, [selected, state])
  async function prepare() {
    if (!state || !episode || lock.current || unavailable) return
    if (!offsets.length) { setError('请先选择本集要准备的场次'); return }
    lock.current = true; setWorking(true); setError(null)
    const token = serial.current
    try {
      const result = await api<{ production: SourceProductionState; imported_scene_ids: string[]; reused_scene_ids: string[] }>(`${endpoint}/prepare`, json('POST', {
        source_version: state.source_version, episode_number: episode.episode_number, episode_offset: episode.offset, scene_offsets: offsets, duration,
      }))
      if (token !== serial.current) return
      setState(result.production); setNotice(`已保存 ${result.imported_scene_ids.length} 场，复用 ${result.reused_scene_ids.length} 场；可以继续本集分镜。`)
      await onRefresh()
    } catch (issue) { if (token === serial.current) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { lock.current = false; setWorking(false) }
  }
  const disabled = unavailable || loading || working
  return <section className="sd-source-production" aria-label="按原稿制作">
    <strong>使用上传原稿</strong><p>{started ? '选择本次制作范围，直接使用原文；不会分析或审核原稿。' : '原稿已保存。仅在你发起具体创作或制作任务后读取原文。'}</p>
    {!started && <Button disabled={unavailable} onClick={() => setStarted(true)}>选择本次制作范围</Button>}
    {loading && <p role="status">正在读取本地目录与已保存场次…</p>}
    {state && <Select aria-label="选择制作集数" placeholder="请选择并核对实际正文范围" value={selected} onChange={setSelected} disabled={disabled} allowDeselect={false}
      data={state.episodes.map(ep => ({ value: keyOf(ep), label: `${ep.title.slice(0, 80)} · ${ep.saved_scene_ids.length} 场已保存${ep.ambiguous ? ' · 原稿有重复集号，请核对' : ''}` }))} />}
    {episode && <>
      <p role="status">{episode.status === 'ready' ? `本集 ${episode.saved_scene_ids.length} 场已保存，可以制作分镜。`
        : episode.scenes.length ? `识别到 ${episode.scenes.length} 场，已保留 ${episode.saved_scene_ids.length} 场。选择要导入的原文，不调用模型。`
          : '本集尚无可直接导入的分场正文；如上传的是大纲或小说，请主动改编本集，无需先生成全剧设计包。'}</p>
      {!!episode.changed_scene_ids.length && <p role="status">部分已保存场次或其原文发生变化，已有成果保留；请在分镜前核对相关场次。</p>}
      {episode.ambiguous && <p role="status">同一集号在原稿出现多次。请核对下列原文，并在集数选择中选定实际正文范围。</p>}
      {!!episode.scenes.length && episode.status !== 'ready' && <>
        <Accordion><Accordion.Item value="scenes"><Accordion.Control>核对本集原文与场次（{episode.scenes.length}）</Accordion.Control><Accordion.Panel>
          {episode.scenes.map(scene => <div key={scene.offset}><Checkbox label={`${scene.heading}${episode.blocked_scene_offsets?.includes(scene.offset) ? '（相关原文已变，请先核对）' : ''}`} checked={offsets.includes(scene.offset) || episode.imported_offsets.includes(scene.offset)}
            disabled={disabled || episode.imported_offsets.includes(scene.offset) || episode.blocked_scene_offsets?.includes(scene.offset) || !offsets.includes(scene.offset) && offsets.length >= 100} onChange={event => { const checked = event.currentTarget.checked; setOffsets(current => checked ? [...current, scene.offset] : current.filter(offset => offset !== scene.offset)) }} />
            <pre className="sd-source-production-text">{scene.text}</pre></div>)}
        </Accordion.Panel></Accordion.Item></Accordion>
        <NumberInput aria-label="导入场次暂定秒数" label="每场暂定时长（秒，可在场次中调整）" min={1} max={600} value={duration} disabled={disabled} onChange={value => setDuration(Math.min(600, Math.max(1, Number(value) || 30)))} />
      </>}
      <Button loading={working} disabled={disabled || episode.status !== 'ready' && episode.scenes.length > 0 && !offsets.length || !episode.scenes.length && !episode.saved_scene_ids.length && !canAdapt}
        onClick={() => episode.status === 'ready' ? onStoryboard(episode.saved_scene_ids) : episode.scenes.length ? void prepare() : onAdapt(episode.episode_number)}>
        {episode.status === 'ready' ? '继续制作分镜' : episode.scenes.length ? '继续制作 · 保存所选原文场次' : `改编第 ${episode.episode_number} 集正文（使用模型）`}</Button>
      {episode.status !== 'ready' && !!episode.saved_scene_ids.length && <Button variant="subtle" disabled={disabled} onClick={() => onStoryboard(episode.saved_scene_ids)}>使用已保存场次规划分镜</Button>}
      {!!notice && <p role="status">{notice}</p>}
    </>}
    {!!error && <p role="alert">{error} <Button variant="subtle" size="xs" disabled={working || loading} onClick={() => setReload(current => current + 1)}>重新读取制作资料</Button></p>}
  </section>
}
