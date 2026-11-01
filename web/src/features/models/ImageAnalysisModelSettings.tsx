import { Alert, Switch, TextInput } from '@mantine/core'

type Props = {
  value: string
  providerBaseUrl: string
  remoteId: string
  onChange: (settings: Record<string, unknown>) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export default function ImageAnalysisModelSettings({ value, providerBaseUrl, remoteId, onChange }: Props) {
  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return null
    settings = parsed
  } catch { return null }
  const config = isRecord(settings.image_analysis) ? settings.image_analysis : {}
  const enabled = config.enabled === true
  function update(patch: Record<string, unknown>) {
    const next = { ...config, ...patch }
    for (const key of ['api_base_url', 'remote_id', 'request_path']) {
      if (typeof next[key] === 'string' && !next[key].trim()) delete next[key]
    }
    onChange({ ...settings, image_analysis: next })
  }
  return <section className="ms-image-config" aria-label="图片反推设置">
    <div className="ms-image-config-heading"><strong>图片反推</strong></div>
    <Switch label="启用 Gemini 图片反推" checked={enabled}
      description="服务商须支持 Gemini generateContent 的图片输入与文字输出，认证沿用当前提供商。"
      onChange={event => update({ enabled: event.currentTarget.checked, protocol: 'gemini_generate_content' })} />
    {enabled && <>
      <TextInput label="分析 API 地址" type="url" placeholder={providerBaseUrl || 'https://generativelanguage.googleapis.com/v1beta'}
        description="留空使用提供商 API 地址；可单独填写 Gemini 接口地址。"
        value={typeof config.api_base_url === 'string' ? config.api_base_url : ''}
        onChange={event => update({ api_base_url: event.currentTarget.value })} />
      <TextInput label="分析模型 ID" placeholder={remoteId || 'gemini-2.5-flash-image'}
        description="留空使用当前模型 ID。请填写服务商实际支持的 Gemini ID，例如 gemini-2.5-flash-image。"
        value={typeof config.remote_id === 'string' ? config.remote_id : ''}
        onChange={event => update({ remote_id: event.currentTarget.value })} />
      <TextInput label="分析请求路径" placeholder="models/{model}:generateContent"
        description="留空使用 models/{model}:generateContent，{model} 会替换为分析模型 ID。"
        value={typeof config.request_path === 'string' ? config.request_path : ''}
        onChange={event => update({ request_path: event.currentTarget.value })} />
    </>}
    <Alert color="gray">GPT Image 生图接口只返回图片；使用 GPT 反推时，请添加支持图片理解的 GPT 文本模型并启用“支持图片理解”。</Alert>
  </section>
}
