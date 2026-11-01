import { Select } from '@mantine/core'
import { Film, Image as ImageIcon, Type } from 'lucide-react'
import { api, type Model, type Modality, type Provider } from '../../shared/api/api'

type Props = {
  providers: Provider[]
  models: Model[]
  busy: boolean
  refresh: () => Promise<void>
  action: (task: () => Promise<unknown>, success?: string) => Promise<void>
}

const modalities: Array<{ value: Modality; label: string; Icon: typeof Type }> = [
  { value: 'text', label: '文本', Icon: Type },
  { value: 'image', label: '图片', Icon: ImageIcon },
  { value: 'video', label: '视频', Icon: Film },
]
const automatic = '__automatic__'

export default function DefaultModelSettings({ providers, models, busy, refresh, action }: Props) {
  const available = models.filter(model => model.enabled && providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))

  async function changeDefault(modality: Modality, value: string | null) {
    const current = available.find(model => model.modality === modality && model.is_default)
    if (!value || value === current?.id || value === automatic && !current) return
    const target = value === automatic ? current : available.find(model => model.id === value && model.modality === modality)
    if (!target) return
    await action(async () => {
      await api(`/models/${target.id}/default`, { method: value === automatic ? 'DELETE' : 'PUT' })
      await refresh()
    }, value === automatic ? `已取消默认${modalities.find(item => item.value === modality)?.label}模型` : `默认${modalities.find(item => item.value === modality)?.label}模型已设置`)
  }

  return <section className="ms-defaults" aria-labelledby="ms-defaults-title">
    <div className="ms-section-heading"><div><h2 id="ms-defaults-title">默认模型</h2><p>在所有提供商中，每类可设置一个默认模型。新任务优先使用默认模型，已有选择保持不变。</p></div></div>
    <div className="ms-default-fields">
      {modalities.map(({ value, label, Icon }) => {
        const candidates = available.filter(model => model.modality === value)
        const current = candidates.find(model => model.is_default)
        return <Select key={value} label={`默认${label}模型`} aria-label={`默认${label}模型`}
          leftSection={<Icon size={15} />} value={current?.id || automatic}
          data={[{ value: automatic, label: '自动选择' }, ...candidates.map(model => ({ value: model.id, label: `${model.name} · ${providers.find(provider => provider.id === model.provider_id)?.name || ''}` }))]}
          description={candidates.length ? '自动选择时使用首个可用模型' : `暂无已启用的${label}模型`}
          allowDeselect={false} searchable disabled={busy || !candidates.length}
          onChange={next => void changeDefault(value, next)} />
      })}
    </div>
  </section>
}
