import { useState } from 'react'
import { Button, Checkbox, Modal, NumberInput, Select } from '@mantine/core'
import { Settings2 } from 'lucide-react'
import { defaultAudioMix } from '@video-studio/shared/media/speech-timeline'
import { api, json } from '../../shared/api/api'
import type { ProjectDetail } from '../../shared/api/api'

export default function FinalCutOutputSettings({ detail, onRefresh }: { detail: ProjectDetail; onRefresh: () => Promise<unknown> }) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [ratio, setRatio] = useState(detail.ratio), [music, setMusic] = useState(detail.music_asset_id)
  const [volume, setVolume] = useState<number | string>(24)
  const [duckMusic, setDuckMusic] = useState(true), [duckSource, setDuckSource] = useState(true)
  const speechAssets = new Set(detail.speech?.lines.flatMap(line => line.takes.flatMap(take => take.asset_id ? [take.asset_id] : [])) || [])
  const musicOptions = detail.assets.filter(asset => asset.kind === 'audio' && (!speechAssets.has(asset.id) || asset.id === detail.music_asset_id))
  function open() {
    const mix = detail.audio_settings || defaultAudioMix
    setRatio(detail.ratio); setMusic(detail.music_asset_id); setVolume(mix.music_gain * 100)
    setDuckMusic(mix.duck_music); setDuckSource(mix.duck_source); setError(''); setOpened(true)
  }
  async function save() {
    if (busy || volume === '' || Number(volume) < 0 || Number(volume) > 100) return
    setBusy(true); setError('')
    try {
      await api(`/projects/${detail.id}/audio-settings`, json('PUT', { ratio, music_asset_id: music, music_gain: Number(volume) / 100, duck_music: duckMusic, duck_source: duckSource }))
      await onRefresh(); setOpened(false)
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setBusy(false) }
  }
  return <><Button variant="default" size="xs" leftSection={<Settings2 size={15} />} onClick={open}>成片设置</Button>
    <Modal opened={opened} onClose={() => !busy && setOpened(false)} title="成片设置" centered>
      <div className="final-cut-output-settings">
        <Select label="输出画幅" description="应用到整个项目；当前导出为 720p、24fps" value={ratio} data={['16:9', '9:16']} allowDeselect={false} disabled={busy} onChange={value => value && setRatio(value as typeof ratio)} />
        <Select label="背景配乐" description="随成片播放并循环，台词音频在镜头配音中管理" placeholder="无配乐" searchable clearable value={music} disabled={busy} data={musicOptions.map(asset => ({ value: asset.id, label: asset.filename }))} onChange={setMusic} />
        <NumberInput label="配乐音量" suffix=" %" min={0} max={100} step={5} value={volume} onChange={setVolume} disabled={busy} />
        <Checkbox label="对白播放时降低配乐" checked={duckMusic} onChange={event => setDuckMusic(event.currentTarget.checked)} disabled={busy} />
        <Checkbox label="对白播放时降低视频原声" checked={duckSource} onChange={event => setDuckSource(event.currentTarget.checked)} disabled={busy} />
        {error && <p role="alert">{error}</p>}
        <Button loading={busy} disabled={volume === '' || !Number.isFinite(Number(volume))} onClick={() => void save()}>保存成片设置</Button>
      </div>
    </Modal></>
}
