import { Accordion, Alert, Badge, Button, MultiSelect, NumberInput, Select, Switch, TagsInput, TextInput } from '@mantine/core'
import { documentedImageEndpoints, documentedImageProfile, documentedImageRatios, documentedImageSettings } from '@video-studio/shared/models/documented-images-api'
import { changeImageResolutions } from './image-model-settings'

type Props = {
  value: string
  providerBaseUrl: string
  onChange: (settings: Record<string, unknown>) => void
  onError: (message: string) => void
  onAdvanced: () => void
}

export default function ImageModelConfig({ value, providerBaseUrl, onChange, onAdvanced }: Props) {
  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    settings = parsed as Record<string, unknown>
  } catch {
    return <Alert color="red" title="配置格式有误">请展开高级配置修正 JSON。<Button variant="subtle" size="compact-sm" onClick={onAdvanced}>打开高级配置</Button></Alert>
  }
  const documented = settings.image_api_profile === documentedImageProfile
  const ratios = Array.isArray(settings.ratios) ? settings.ratios.filter((item): item is string => typeof item === 'string') : [...documentedImageRatios]
  const defaultRatio = typeof settings.default_ratio === 'string' ? settings.default_ratio : ratios[0] || '1:1'
  const pixels = settings.image_size_mode === 'pixels'
  const resolutions = Array.isArray(settings.resolutions) ? settings.resolutions.filter((item): item is string => typeof item === 'string') : []
  const address = typeof settings.api_base_url === 'string' ? settings.api_base_url : providerBaseUrl
  const endpoints = documentedImageEndpoints(address)
  const taskAddress = typeof settings.image_task_base_url === 'string' ? settings.image_task_base_url : endpoints.tasks
  const referencePath = settings.image_reference_path === 'images/generations' ? 'images/generations' : 'images/edits'
  const multipart = settings.image_reference_transport === 'multipart'
  function update(patch: Record<string, unknown>) {
    let next = documentedImageSettings({ ...settings, ...patch }, providerBaseUrl)
    if (patch.image_size_mode === 'pixels') next = changeImageResolutions(next, next.resolutions as string[])
    onChange(next)
  }
  return <section className="ms-image-config" aria-label="图片生成设置">
    <div className="ms-image-config-heading"><strong>图片生成设置</strong>{documented && <Badge variant="light" color="gray">异步任务</Badge>}</div>
    <Select label="请求配置" description="生成与编辑均支持多图参考；模型 ID 可自由填写。" allowDeselect={false}
      value={documented ? documentedImageProfile : 'custom'}
      data={[{ value: documentedImageProfile, label: 'Images API · 异步任务' }, ...(!documented ? [{ value: 'custom', label: '当前自定义配置', disabled: true }] : [])]}
      onChange={preset => preset === documentedImageProfile && update({})} />
    {!documented ? <Alert color="gray" title="已保留自定义请求">选择 Images API · 异步任务可应用生成与编辑文档的规范，也可继续编辑当前配置。<Button variant="subtle" size="compact-sm" onClick={onAdvanced}>打开高级配置</Button></Alert> : <>
      <p className="ms-image-config-note">提交后保存任务编号，自动查询并下载结果图片。</p>
      <Select label="参考图用途" value={referencePath} allowDeselect={false}
        data={[{ value: 'images/edits', label: '编辑图片 · images/edits' }, { value: 'images/generations', label: '参考生成 · images/generations' }]}
        description="有参考图时使用所选接口；无参考图时使用生成接口。"
        onChange={path => path && update({ image_reference_path: path })} />
      {referencePath === 'images/edits' && <Select label="参考图传递方式" value={multipart ? 'multipart' : 'json'} allowDeselect={false}
        data={[{ value: 'json', label: 'JSON · 图片数组' }, { value: 'multipart', label: '文件上传 · multipart' }]}
        description="文件上传使用重复的 image 字段，按选择顺序发送所有参考图。"
        onChange={transport => transport && update({ image_reference_transport: transport })} />}
      <Select label="尺寸传递方式" value={pixels ? 'pixels' : 'ratio'} allowDeselect={false}
        data={[{ value: 'ratio', label: '画幅比例 · 例如 16:9' }, { value: 'pixels', label: '像素尺寸 · 例如 1280x720' }]}
        description="通过 size 传递画幅比例或精确像素尺寸。"
        onChange={mode => mode && update({ image_size_mode: mode })} />
      {pixels && <div className="ms-field-pair">
        <TagsInput label="可用图片尺寸" description="填入模型支持的宽x高，按回车添加。" value={resolutions}
          onChange={next => onChange(changeImageResolutions(settings, next))} />
        <Select label="默认图片尺寸" value={String(settings.default_resolution || '')} allowDeselect={false} data={resolutions}
          onChange={size => size && onChange({ ...settings, default_resolution: size })} />
      </div>}
      <div className="ms-field-pair">
        <MultiSelect label="可选画幅" value={ratios} data={pixels ? [...new Set([...changeImageResolutions(settings, resolutions).ratios as string[], ...ratios])] : [...new Set([...documentedImageRatios, ...ratios])]} searchable hidePickedOptions
          onChange={next => onChange({ ...settings, ratios: next, default_ratio: next.includes(defaultRatio) ? defaultRatio : next[0] || '1:1' })} />
        <Select label="默认画幅" value={defaultRatio} allowDeselect={false} data={ratios} disabled={!ratios.length}
          onChange={ratio => ratio && onChange({ ...settings, default_ratio: ratio })} />
      </div>
      <Switch label="通过 imageSize 传递清晰度" description="仅在模型明确支持时开启；可选 1K、2K、4K。"
        checked={settings.image_clarity_parameter === true} onChange={event => update({ image_clarity_parameter: event.currentTarget.checked })} />
      {settings.image_clarity_parameter === true && <Select label="默认清晰度" value={String(settings.default_clarity || '2K')} data={['1K', '2K', '4K']} allowDeselect={false}
        onChange={clarity => clarity && update({ default_clarity: clarity })} />}
      <Switch label="压缩上传的参考图" description="仅压缩发送副本，最长边保留至 2048 像素，原始素材不变。"
        checked={settings.compress_reference_images !== false} onChange={event => update({ compress_reference_images: event.currentTarget.checked })} />
      <Accordion className="ms-image-fields" variant="default">
        <Accordion.Item value="connection">
          <Accordion.Control>连接与任务查询</Accordion.Control>
          <Accordion.Panel><div className="ms-image-field-controls">
            <TextInput label="图片提交 API 地址" placeholder={endpoints.submit} value={address} description="文档中的提交地址以 /draw/v1 结尾。"
              onChange={event => onChange({ ...settings, api_base_url: event.currentTarget.value })} />
            <TextInput label="任务查询 API 地址" value={taskAddress} description="文档中的查询地址以 /v1 结尾，不包含 /draw。"
              onChange={event => onChange({ ...settings, image_task_base_url: event.currentTarget.value })} />
            <Select label="JSON 参考图字段" value={multipart ? 'image' : String(settings.image_reference_field || 'image')} allowDeselect={false} disabled={multipart}
              data={['image', 'images']} onChange={field => field && update({ image_reference_field: field })} />
            <div className="ms-field-pair">
              <NumberInput label="请求超时（秒）" description="提交或上传参考图的最长等待时间。" min={30} max={1800} allowDecimal={false}
                value={Number(settings.request_timeout_seconds ?? 600)} onChange={timeout => onChange({ ...settings, request_timeout_seconds: timeout === '' ? undefined : Number(timeout) })} />
              <NumberInput label="任务查询间隔（秒）" min={1} max={60} allowDecimal={false}
                value={Number(settings.poll_seconds ?? 5)} onChange={seconds => onChange({ ...settings, poll_seconds: seconds === '' ? undefined : Number(seconds) })} />
            </div>
          </div></Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <div className="ms-image-field-controls">
        <p className="ms-image-address"><span>文生图</span><span>{endpoints.submit}/images/generations</span></p>
        <p className="ms-image-address"><span>参考图</span><span>{endpoints.submit}/{referencePath}</span></p>
        <p className="ms-image-address"><span>任务查询</span><span>{taskAddress}/tasks/任务编号</span></p>
      </div>
    </>}
  </section>
}
