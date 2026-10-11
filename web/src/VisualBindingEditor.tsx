import { useEffect, useState } from 'react'
import { Accordion, UnstyledButton, ActionIcon, Button, Checkbox, Select, Tabs, TextInput, Tooltip } from '@mantine/core'
import { ArrowUpRight, Check, ChevronUp, Image as ImageIcon, LoaderCircle, RefreshCcw, Search, X } from 'lucide-react'
import { api, json } from './api'
import type { Asset, ProjectDetail, VisualProfile, VisualProjectData } from './api'
import { visualDropdownProps, visualKinds } from './VisualProfileFields'
import { recommendVisualReferences } from '../../backend/src/visual-reference-selection'
import { visualReferencePurposeLabels, visualReferenceViewLabels } from '../../backend/src/visual-reference-types'
import { visualBindingUsageLabels, type VisualBindingUsage } from '../../backend/src/visual-binding-usage'
import './visual-binding-references.css'

export type VisualBindingContext = { target?: string; profileId?: string }
type Props = {
  detail: ProjectDetail; context: VisualBindingContext; onRefresh: () => Promise<void>; onClose: () => void;
  onBusyChange: (busy: boolean) => void; onLocate: (profile: VisualProfile) => void;
  presentation?: 'panel' | 'inline' | 'drawer'; id?: string; onPreview?: (asset: Asset) => void;
}
const projectData = (detail: ProjectDetail): VisualProjectData => ({ visual_profiles: detail.visual_profiles || [], scene_visual_bindings: detail.scene_visual_bindings || [], shot_visual_bindings: detail.shot_visual_bindings || [] })

export default function VisualBindingEditor({ detail, context, onRefresh, onClose, onBusyChange, onLocate, presentation = 'panel', id: editorId, onPreview }: Props) {
  const inline = presentation !== 'panel'
  const drawer = presentation === 'drawer'
  const [data, setData] = useState(() => projectData(detail))
  const [target, setTarget] = useState(() => context.target || (context.profileId && detail.shot_visual_bindings?.find(binding => binding.profile_id === context.profileId)?.shot_id
    ? `shot:${detail.shot_visual_bindings.find(binding => binding.profile_id === context.profileId)!.shot_id}`
    : `scene:${detail.scene_visual_bindings?.find(binding => binding.profile_id === context.profileId)?.scene_id || detail.script.scenes[0]?.id || ''}`))
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState(() => inline && context.target?.startsWith('shot:')
    && detail.shot_visual_bindings?.some(binding => binding.shot_id === context.target!.slice(5)) ? 'selected' : 'all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setData(projectData(detail)), [detail.visual_profiles, detail.scene_visual_bindings, detail.shot_visual_bindings])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const isShot = target.startsWith('shot:')
  const id = target.slice(isShot ? 5 : 6)
  const exists = isShot ? detail.shots.some(shot => shot.id === id) : detail.script.scenes.some(scene => scene.id === id)
  const selected = isShot ? data.shot_visual_bindings.filter(binding => binding.shot_id === id) : data.scene_visual_bindings.filter(binding => binding.scene_id === id)
  const profile = data.visual_profiles.find(item => item.id === context.profileId)
  const profiles = data.visual_profiles.filter(item => (!context.profileId || item.id === context.profileId)
    && (!inline || category === 'all' || (category === 'selected' ? selected.some(binding => binding.profile_id === item.id) : item.kind === category))
    && `${item.name} ${item.variant}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  if (inline) profiles.sort((a, b) => Number(selected.some(binding => binding.profile_id === b.id)) - Number(selected.some(binding => binding.profile_id === a.id)))
  const shotTitle = isShot ? detail.shots.find(shot => shot.id === id) : undefined
  const options = [
    { group: '场次', items: detail.script.scenes.map(scene => ({ value: `scene:${scene.id}`, label: `${scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}${scene.heading}` })) },
    { group: '镜头', items: detail.shots.map(shot => ({ value: `shot:${shot.id}`, label: `${shot.position + 1}. ${shot.title}` })) },
  ].filter(group => group.items.length)
  const usage = profile ? [
    ...data.scene_visual_bindings.filter(binding => binding.profile_id === profile.id).map(binding => ({ value: `scene:${binding.scene_id}`, label: detail.script.scenes.find(scene => scene.id === binding.scene_id)?.heading || '场次' })),
    ...data.shot_visual_bindings.filter(binding => binding.profile_id === profile.id).map(binding => ({ value: `shot:${binding.shot_id}`, label: detail.shots.find(shot => shot.id === binding.shot_id)?.title || '镜头' })),
  ] : []
  async function persist(bindings: Array<{ profile_id: string; required: boolean; reference_asset_ids?: string[]; usage?: VisualBindingUsage }>, refreshIds: string[] = [], apply = false) {
    if (busy || !exists) return
    setBusy(true); setError('')
    try {
      const result = await api<VisualProjectData>(apply ? `/script-scenes/${id}/visual-bindings/apply-to-shots` : `/${isShot ? 'shots' : 'script-scenes'}/${id}/visual-bindings`, json(apply ? 'POST' : 'PUT', apply ? {} : {
        bindings: bindings.map(binding => ({ profile_id: binding.profile_id, required: !!binding.required,
          ...(isShot && binding.usage ? { usage: binding.usage } : {}),
          ...(binding.reference_asset_ids !== undefined ? { reference_asset_ids: binding.reference_asset_ids } : {}) })),
        ...(isShot ? { refresh_profile_ids: refreshIds } : {}),
      }))
      setData(result); await onRefresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setBusy(false) }
  }
  const Surface = inline ? 'section' : 'aside'
  return <Surface id={editorId} className={inline ? `pc-binding-inline${drawer ? ' pc-binding-drawer' : ''}` : 'pc-visual-panel pc-profile-inspector'}
    aria-label={inline ? '当前镜头引用' : '场次与镜头引用管理'} data-canvas-overlay
    onKeyDown={inline && !drawer ? event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.stopPropagation()
        if (!busy) onClose()
      }
    } : undefined}>
    <header><div><small>{inline ? '镜头引用' : profile ? '设定使用范围' : '镜头参考设定'}</small>
      <strong>{inline ? shotTitle ? `${shotTitle.position + 1}. ${shotTitle.title}` : '当前镜头' : profile ? `${profile.name} · ${profile.variant}` : '场次 / 镜头引用'}</strong></div>
      <ActionIcon variant="subtle" aria-label={drawer ? '关闭镜头引用' : inline ? '收起镜头引用' : '关闭引用管理'} disabled={busy} onClick={onClose}>{inline && !drawer ? <ChevronUp size={16} /> : <X size={drawer ? 18 : 16} />}</ActionIcon></header>
    <div className={inline ? 'pc-binding-inline-body' : 'pc-profile-inspector-fields'}>
      {!inline && <p className="pc-visual-note">场次设定是候选资料。镜头可分别指定开镜图片与视频过程使用的对象；两者共用设定版本和参考图。勾选及用途调整会立即保存。</p>}
      {profile && <section className="pc-visual-usage"><strong>已引用 · {usage.length}</strong>{usage.length ? <div>{usage.map(item => <UnstyledButton type="button" key={item.value} disabled={busy} aria-pressed={target === item.value} onClick={() => { setTarget(item.value); setError('') }}>{item.value.startsWith('shot:') ? '镜头' : '场次'} · {item.label}</UnstyledButton>)}</div> : <p>尚未被场次或镜头使用。</p>}</section>}
      {!inline && <Select label="编辑使用范围" aria-label="选择绑定场次或镜头" value={exists ? target : null} data={options} searchable allowDeselect={false} disabled={busy} placeholder="选择场次或镜头" comboboxProps={visualDropdownProps} onChange={value => { if (value) { setTarget(value); setError('') } }} />}
      {!context.profileId && <TextInput aria-label="搜索引用设定" placeholder="搜索人物、场景或道具" size={drawer ? 'md' : inline ? 'xs' : 'sm'} leftSection={<Search size={14} />} value={search} onChange={event => setSearch(event.currentTarget.value)} />}
      {inline && <Tabs value={category} onChange={value => value && setCategory(value)} variant="pills" className="pc-binding-category-tabs">
        <Tabs.List aria-label="引用设定分类"><Tabs.Tab value="all">全部 <span>{data.visual_profiles.length}</span></Tabs.Tab>
          <Tabs.Tab value="selected">已引用 <span>{selected.length}</span></Tabs.Tab>
          {visualKinds.map(kind => <Tabs.Tab key={kind.value} value={kind.value}>{kind.label} <span>{data.visual_profiles.filter(item => item.kind === kind.value).length}</span></Tabs.Tab>)}
        </Tabs.List></Tabs>}
      {error && <p role="alert" className="pc-visual-error">{error}</p>}
      {!exists ? <p className="pc-visual-note">尚无可引用的场次或镜头，请先保存剧本或制作分镜。</p> : <div className="pc-visual-bindings">{profiles.map(item => {
        const binding = selected.find(binding => binding.profile_id === item.id)
        const snapshot = isShot ? data.shot_visual_bindings.find(binding => binding.shot_id === id && binding.profile_id === item.id) : undefined
        const frozen = snapshot?.reference_assets || []
        const stale = !!snapshot && (snapshot.revision !== item.revision || (frozen.length
          ? frozen.some(reference => detail.project_visual_style && reference.style_version && reference.style_version !== detail.project_visual_style.version)
          : snapshot.board_asset_id !== item.board_asset_id || snapshot.board_style_version !== item.board_style_version))
        const boardId = snapshot ? snapshot.board_asset_id : item.board_asset_id
        const available = (item.reference_assets || []).filter(reference => reference.status === 'confirmed' && reference.revision === item.revision
          && (!detail.project_visual_style || reference.style_version === detail.project_visual_style.version))
        const shot = isShot ? detail.shots.find(shot => shot.id === id) : undefined
        const recommended = shot ? recommendVisualReferences(item, available, snapshot?.usage === 'video'
          ? `${shot.video_prompt || ''}\n${shot.start_state || ''}` : `${shot.image_prompt || ''}\n${shot.prompt}`, detail.project_visual_style?.version) : []
        const choose = (referenceIds: string[]) => persist(selected.map(binding => binding.profile_id === item.id
          ? { ...binding, reference_asset_ids: referenceIds } : binding))
        const preview = detail.assets.find(asset => asset.id === (frozen[0]?.asset_id || boardId))
        const bindingDetails = <>
          {binding && <div className="pc-visual-binding-meta"><Checkbox label="必需" checked={!!binding.required} disabled={busy} onChange={event => { const required = event.currentTarget.checked; void persist(selected.map(binding => binding.profile_id === item.id ? { ...binding, required } : binding)) }} />
            <span>v{snapshot?.revision || item.revision} · {frozen.length ? `${frozen.length} 张独立参考图` : boardId ? detail.assets.some(asset => asset.id === boardId) ? '使用信息图' : '图片缺失' : '待确认参考图'}</span>
            {stale && <Button variant="default" size="xs" leftSection={<RefreshCcw size={12} />} disabled={busy} onClick={() => void persist(selected, [item.id])}>更新引用</Button>}
          </div>}
          {snapshot && <Select label="使用范围" aria-label={`${item.name} 使用范围`} size="xs" value={snapshot.usage || 'both'}
            data={Object.entries(visualBindingUsageLabels).map(([value, label]) => ({ value, label }))} allowDeselect={false} disabled={busy}
            comboboxProps={visualDropdownProps} onChange={value => value && void persist(selected.map(binding => binding.profile_id === item.id
              ? { ...binding, usage: value as VisualBindingUsage } : binding))} />}
          {snapshot && <div className="pc-binding-references">
            <div className="pc-binding-reference-actions"><span>本镜头参考</span>
              {recommended.length > 0 && <Button variant="default" size="xs" disabled={busy || stale} onClick={() => void choose(recommended.map(reference => reference.id))}>按镜头推荐</Button>}
              {frozen.length > 0 && <Button variant="subtle" size="xs" disabled={busy || stale || !boardId} onClick={() => void choose([])}>使用信息图</Button>}
            </div>
            {frozen.length > 0 && <div className="pc-binding-reference-current" aria-label={`${item.name} 当前镜头参考图`}>{frozen.map(reference => {
              const asset = detail.assets.find(asset => asset.id === reference.asset_id)
              const label = reference.label || visualReferenceViewLabels[reference.view]
              return <div className="pc-binding-reference-entry" key={reference.id}>{asset ? onPreview ? <UnstyledButton className="pc-binding-reference-preview" aria-label={`查看参考图：${item.name} ${label}`} onClick={() => onPreview(asset)}><img src={asset.url} alt={`${item.name} ${visualReferenceViewLabels[reference.view]}`} loading="lazy" /></UnstyledButton> : <a href={asset.url} target="_blank" rel="noreferrer" title={`查看${label}`}><img src={asset.url} alt={`${item.name} ${visualReferenceViewLabels[reference.view]}`} /></a> : <span>图片缺失</span>}
                <ActionIcon type="button" className="pc-binding-reference-remove" aria-label={`移除镜头参考：${label}`} title="移除此镜头参考" disabled={busy || stale}
                  onClick={() => void choose(frozen.filter(entry => entry.id !== reference.id).map(entry => entry.id))} data-workspace-control=""><X size={12} aria-hidden="true" /></ActionIcon>
                <small>{label}</small></div>
            })}</div>}
            {!stale && available.length > 0 && <div className="pc-binding-reference-choices" aria-label={`${item.name} 可选独立参考图`}>{available.map(reference => {
              const selectedIds = frozen.map(item => item.id)
              return <Checkbox key={reference.id} label={`${reference.label || visualReferenceViewLabels[reference.view]} · ${visualReferencePurposeLabels[reference.purpose]}`}
                checked={selectedIds.includes(reference.id)} disabled={busy} onChange={event => void choose(event.currentTarget.checked
                  ? [...selectedIds, reference.id] : selectedIds.filter(id => id !== reference.id))} />
            })}</div>}
            <p className="pc-visual-note">{stale ? '设定或画风已更新，请先更新引用再选择参考。' : !available.length ? '可在设定档案中裁切、生成或添加独立参考图，确认后在这里选择。' : '镜头保存后固定这些图片；更换默认图不会自动替换已有镜头。'}</p>
          </div>}
        </>
        return <section className={`pc-visual-binding${binding ? ' is-bound' : ''}`} key={item.id}>
          <div className="pc-binding-row-head">
            {inline && (preview ? onPreview ? <UnstyledButton className="pc-binding-profile-preview" aria-label={`查看引用图：${item.name}`} onClick={() => onPreview(preview)}><img src={preview.url} alt={`${item.name} 参考图`} loading="lazy" /></UnstyledButton> : <a className="pc-binding-profile-preview" href={preview.url} target="_blank" rel="noreferrer" aria-label={`查看引用图：${item.name}`}><img src={preview.url} alt={`${item.name} 参考图`} loading="lazy" /></a>
              : <span className="pc-binding-profile-preview" aria-hidden="true"><ImageIcon size={18} /></span>)}
            <div className="pc-binding-row-identity"><Checkbox label={`${item.name} · ${item.variant}`} checked={!!binding} disabled={busy || !binding && selected.length >= 50}
              onChange={event => void persist(event.currentTarget.checked ? [...selected, { profile_id: item.id, required: true }] : selected.filter(binding => binding.profile_id !== item.id))} />
              {inline && <small>{visualKinds.find(kind => kind.value === item.kind)?.label} · v{snapshot?.revision || item.revision} · {stale ? '引用待更新' : binding ? frozen.length ? `${frozen.length} 张参考图` : boardId ? '信息图' : '参考图待确认' : '未引用'}</small>}
            </div>
            <Tooltip label="定位或添加设定节点"><ActionIcon variant="subtle" aria-label={`定位引用设定：${item.name}`} disabled={busy} onClick={() => onLocate(item)}><ArrowUpRight size={15} /></ActionIcon></Tooltip>
          </div>
          {inline ? binding && <Accordion variant="default" className="pc-binding-details" chevronSize={13}>
            <Accordion.Item value={item.id}><Accordion.Control aria-label={`参考与用途：${item.name}`}>参考与用途{stale && <span className="pc-binding-stale">引用待更新</span>}</Accordion.Control>
              <Accordion.Panel>{bindingDetails}</Accordion.Panel></Accordion.Item>
          </Accordion> : bindingDetails}
        </section>
      })}{!profiles.length && <p className="pc-visual-note">{data.visual_profiles.length ? '没有匹配的设定。' : '暂无视觉设定，可在左侧新增，或在剧本对话中加入画布。'}</p>}</div>}
    </div>
    <footer><span className="pc-visual-note" role="status">{inline && (busy ? <LoaderCircle size={13} className="pc-spin" /> : <Check size={13} />)}{busy ? '正在保存引用…' : exists ? `已引用 ${selected.length} 份设定` : '未选择使用范围'}</span>
      {inline && <small>勾选及用途调整会立即保存</small>}
      {!isShot && exists && detail.shots.some(shot => shot.source_scene_id === id) && <Button variant="default" disabled={busy} onClick={() => void persist(selected, [], true)}>应用到本场镜头</Button>}
    </footer>
  </Surface>
}
