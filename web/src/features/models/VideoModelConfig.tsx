import { Alert, Button, NumberInput, Select, Text } from '@mantine/core'
import { applySeedance2VideoSettings, applySeedance25VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import { videoRatioOptions, videoResolutionOptions } from '@video-studio/shared/media/video-parameters'
import { videoDefaultDuration, videoDefaultRatio, videoModelConfigError } from '@video-studio/shared/models/video-model-settings'

type Props = {
  value: string
  onChange: (settings: Record<string, unknown>) => void
  onError: (message: string) => void
  onAdvanced?: () => void
}

export default function VideoModelConfig({ value, onChange, onError, onAdvanced }: Props) {
  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    settings = parsed as Record<string, unknown>
  } catch {
    return <Alert color="red">请先修正高级配置，再调整视频设置。{onAdvanced && <Button variant="subtle" onClick={onAdvanced}>打开高级配置</Button>}</Alert>
  }
  const profile = settings.video_reference_profile
  const standard = profile === 'seedance_2_0' || profile === 'seedance_2_5'
  const ratios = videoRatioOptions(settings), resolutions = videoResolutionOptions(settings)
  const min = typeof settings.min_duration === 'number' ? settings.min_duration : 1
  const max = typeof settings.max_duration === 'number' ? settings.max_duration : 120
  const issue = videoModelConfigError(settings)
  function update(patch: Record<string, unknown>) { onChange({ ...settings, ...patch }); onError('') }
  return <section className="ms-image-config" aria-label="视频生成设置">
    <strong>视频生成设置</strong>
    <Select label="视频接口配置" description="根据提供商文档选择接口，模型 ID 可自由填写。" allowDeselect={false}
      value={standard ? profile : 'custom'}
      data={[{ value: 'custom', label: '保留当前自定义配置', disabled: standard },
        { value: 'seedance_2_5', label: 'Seedance 2.5 · 异步任务' }, { value: 'seedance_2_0', label: 'Seedance 2.0 · 异步任务' }]}
      onChange={next => {
        if (next === 'seedance_2_5') onChange(applySeedance25VideoSettings(settings))
        else if (next === 'seedance_2_0') onChange(applySeedance2VideoSettings(settings))
        onError('')
      }} />
    {!standard ? <Alert color="gray" title="已保留自定义请求">选择上方接口可应用标准配置。{onAdvanced && <Button variant="subtle" onClick={onAdvanced}>打开高级配置</Button>}</Alert> : <>
      <div className="ms-field-pair">
        <Select label="默认视频画幅" data={ratios} value={videoDefaultRatio(settings, ratios)} allowDeselect={false}
          onChange={ratio => ratio && update({ default_ratio: ratio })} />
        <Select label="默认视频分辨率" data={resolutions} value={String(settings.default_resolution || resolutions[0] || '')} allowDeselect={false}
          onChange={resolution => resolution && update({ default_resolution: resolution })} />
      </div>
      <NumberInput label="默认视频时长（秒）" description={`新建视频使用此时长，可选 ${min}–${max} 秒；分镜或节点已选值优先。`}
        value={typeof settings.default_duration === 'string' ? settings.default_duration : videoDefaultDuration(settings)} min={min} max={max} allowDecimal={false}
        onChange={duration => {
          const next = { ...settings }
          if (duration === '') delete next.default_duration
          else next.default_duration = duration
          onChange(next); onError('')
        }} />
      <Text size="xs" c="dimmed">提交后自动查询任务并下载视频。所选接口的画幅、时长和参考素材规则会随请求生效。</Text>
      {issue && <Alert color="red">{issue}</Alert>}
    </>}
  </section>
}
