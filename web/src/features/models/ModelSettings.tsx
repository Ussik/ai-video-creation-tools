import { useEffect, useId, useState, type ReactNode } from 'react'
import { ActionIcon, Alert, Badge, Button, Checkbox, Modal, PasswordInput, Select, Switch, Tabs, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { ChevronDown, ChevronRight, GripHorizontal, HelpCircle, PencilLine, Plus, Search, Server, Settings2, Trash2 } from 'lucide-react'
import { api, json, type Model, type Modality, type Protocol, type Provider } from '../../shared/api/api'
import { migrateStandardTextSettings, standardTextSettings, textApiConfigError, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'
import { textContextConfigError } from '@video-studio/shared/models/text-context-settings'
import { scopeTextCapabilities, textCapabilitiesConfigError, type TextCapabilityDiscovery } from '@video-studio/shared/models/text-capabilities'
import { videoInputConfigError } from '@video-studio/shared/models/video-analysis-settings'
import { documentedImageConfigError, documentedImageSettings } from '@video-studio/shared/models/documented-images-api'
import { imageAnalysisConfigError } from '@video-studio/shared/models/image-analysis-settings'
import { videoModelConfigError } from '@video-studio/shared/models/video-model-settings'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import HarnessTextModelOptions from './HarnessTextModelOptions'
import ModelAdvancedEditor from './ModelAdvancedEditor'
import DefaultModelSettings from './DefaultModelSettings'
import './model-settings.css'
import './harness-provider-settings.css'
import './model-workbench.css'

type Props = { providers: Provider[]; models: Model[]; refresh: () => Promise<void>; action: (task: () => Promise<unknown>, success?: string) => Promise<void>; busy: boolean; headerControls?: ReactNode }
type DraftModel = Model & { local_id: string; inherit: boolean }
type CatalogItem = { remote_id: string; name: string; modality_hint: Modality | null; existing: boolean; capabilities?: TextCapabilityDiscovery }
type Configuration = { provider: Provider; models: Model[] }
type CatalogFreshness = { source: 'network' | 'cache' | 'revalidated'; fetched_at: string; validated_at: string; expires_at: string }
const protocols = [
  { value: 'chat_completions', label: 'OpenAI Chat Completions' },
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'anthropic_messages', label: 'Anthropic Messages' },
]
const modalities = [{value:'text',label:'文本'},{value:'image',label:'图片'},{value:'video',label:'视频'}]
const textProtocols = new Set(protocols.map(item => item.value))
function inferProtocol(provider: Provider, models: Model[]): TextApiProtocol {
  return (provider.protocol || models.find(model => model.modality === 'text' && textProtocols.has(model.protocol))?.protocol || 'chat_completions') as TextApiProtocol
}
function createSettings(modality: Modality, protocol: Protocol): Record<string, unknown> {
  if (modality === 'text') return standardTextSettings(protocol as TextApiProtocol)
  if (modality === 'image') return documentedImageSettings({ ratios: ['1:1'], default_ratio: '1:1' })
  return { create_path: 'contents/generations/tasks', get_path: 'contents/generations/tasks/{id}', request_template: {model:'{{model}}',content:'{{content}}',duration:'{{duration}}',ratio:'{{ratio}}',resolution:'{{resolution}}'}, content_template:[{type:'text',text:'{{prompt}}'}], id_path:'id',status_path:'status',result_path:'content.video_url',ratios:['16:9','9:16','1:1'],resolutions:['480p','720p','1080p'],default_resolution:'480p' }
}
function newDraftModel(localId: string, providerId: string, protocol: Protocol, modality: Modality, remoteId = '', name = '', capabilities?: TextCapabilityDiscovery): DraftModel {
  const settings = createSettings(modality, protocol)
  if (modality === 'text' && capabilities) settings.text_capabilities = { version: 1, discovered: capabilities }
  return { id: '', local_id: localId, provider_id: providerId, name, remote_id: remoteId, modality, protocol, settings, enabled: true, inherit: modality === 'text' }
}
function validateModel(model: DraftModel): string | null {
  if (!model.remote_id.trim()) return '请填写模型 ID'
  if (model.modality === 'text') return textApiConfigError(model.settings, model.protocol) || textCapabilitiesConfigError(model.settings) || textContextConfigError(model.settings) || videoInputConfigError(model.settings)
  if (model.modality === 'image') return documentedImageConfigError(model.settings) || imageAnalysisConfigError(model.settings)
  return videoModelConfigError(model.settings)
}
function matchesDiscovery(model: DraftModel, capabilities: TextCapabilityDiscovery | undefined, providerBaseUrl: string): capabilities is TextCapabilityDiscovery {
  if (!capabilities || model.modality !== 'text') return false
  const normalize = (value: string) => value.trim().replace(/\/+$/, '')
  const effectiveBaseUrl = typeof model.settings.api_base_url === 'string' ? model.settings.api_base_url : providerBaseUrl
  return normalize(effectiveBaseUrl) === normalize(capabilities.scope.base_url) && model.protocol === capabilities.scope.protocol && model.remote_id.trim() === capabilities.scope.remote_id
}

function ProviderEditor({ provider, models, onClose, onSaved, action, initialModelId, startWithNewModel }: { provider: Provider; models: Model[]; onClose: () => void; onSaved: () => Promise<void>; action: Props['action']; initialModelId?: string | null; startWithNewModel: boolean }) {
  const editorId = useId()
  const newModelId = editorId + '-new-model'
  const isNew = provider.id === '__new__'
  const initialProtocol = inferProtocol(provider, models)
  const [name,setName] = useState(isNew ? '' : provider.name)
  const [baseUrl,setBaseUrl] = useState(provider.base_url)
  const [key,setKey] = useState('')
  const [clearKey,setClearKey] = useState(false)
  const [protocol,setProtocol] = useState<TextApiProtocol>(initialProtocol)
  const [protocolTouched,setProtocolTouched] = useState(false)
  const [enabled,setEnabled] = useState(provider.enabled)
  const [customOpen,setCustomOpen] = useState(isNew)
  const [draft,setDraft] = useState<DraftModel[]>(() => {
    const existing = models.map(model => ({ ...model, settings: structuredClone(model.settings), local_id: model.id,
      inherit: model.modality === 'text' && model.protocol === initialProtocol && !!migrateStandardTextSettings(model.settings, model.protocol as TextApiProtocol) }))
    return startWithNewModel ? [...existing, newDraftModel(newModelId, provider.id, initialProtocol, 'text')] : existing
  })
  const [expanded,setExpanded] = useState<string[]>(startWithNewModel ? [newModelId] : initialModelId ? [initialModelId] : [])
  const [advanced,setAdvanced] = useState<string|null>(null)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [catalogOpen,setCatalogOpen] = useState(false)
  const [catalogLoading,setCatalogLoading] = useState(false)
  const [capabilitiesRefreshed,setCapabilitiesRefreshed] = useState(0)
  const [catalog,setCatalog] = useState<CatalogItem[]>([])
  const [catalogFreshness,setCatalogFreshness] = useState<CatalogFreshness>()
  const [catalogSearch,setCatalogSearch] = useState('')
  const [selected,setSelected] = useState<Record<string,Modality>>({})
  const [dragged,setDragged] = useState<string|null>(null)
  const editingModel = draft.find(model => model.local_id === advanced)
  function update(id:string,patch:Partial<DraftModel>) { setDraft(current => current.map(model => model.local_id === id ? {...model,...patch} : model));setError('') }
  function changeProtocol(next:TextApiProtocol) {
    setDraft(current => current.map(model => model.modality === 'text' && model.inherit && migrateStandardTextSettings(model.settings,model.protocol as TextApiProtocol) ? {...model, protocol:next, settings:migrateStandardTextSettings(model.settings,model.protocol as TextApiProtocol) || model.settings} : model))
    setProtocol(next);setProtocolTouched(true);setError('')
  }
  function addModel(modality:Modality='text',remoteId='',displayName='',capabilities?:TextCapabilityDiscovery) {
    const local_id=crypto.randomUUID()
    const nextProtocol:Protocol=modality==='text'?protocol:modality==='image'?'image_generations':'async_video'
    setDraft(current => [...current, newDraftModel(local_id, provider.id, nextProtocol, modality, remoteId, displayName, capabilities)])
    setExpanded(current => [...current,local_id])
  }
  function move(id:string,target:string) { setDraft(current => { const from=current.findIndex(model=>model.local_id===id),to=current.findIndex(model=>model.local_id===target);if(from<0||to<0||from===to)return current;const next=[...current];next.splice(to,0,next.splice(from,1)[0]);return next }) }
  async function save() {
    setError('')
    if(!name.trim()||!baseUrl.trim()){setError('请填写显示名称和 API 地址');setCustomOpen(true);return}
    const scopedDraft=draft.map(model=>model.modality==='text'?{...model,settings:scopeTextCapabilities(model.settings,{base_url:typeof model.settings.api_base_url==='string'?model.settings.api_base_url:baseUrl,protocol:model.protocol,remote_id:model.remote_id.trim()})}:model)
    for(const model of scopedDraft){const original=models.find(item=>item.id===model.id);const unchanged=original&&original.protocol===model.protocol&&original.modality===model.modality&&JSON.stringify(original.settings)===JSON.stringify(model.settings);const issue=unchanged?(!model.remote_id.trim()?'请填写模型 ID':null):validateModel(model);if(issue){setError(`${model.name||model.remote_id||'未命名模型'}：${issue}`);setExpanded(current=>[...new Set([...current,model.local_id])]);setCustomOpen(true);return}}
    setSaving(true)
    try {
      await action(async()=>{
        try {
        await api<Configuration>(isNew?'/providers/configuration':`/providers/${provider.id}/configuration`,json(isNew?'POST':'PUT',{
          provider:{name:name.trim(),base_url:baseUrl.trim(),...(isNew||protocolTouched||provider.protocol?{protocol}:{}),enabled,...(clearKey?{api_key:null}:key?{api_key:key}:{})},
          models:scopedDraft.map(model=>({... (model.id?{id:model.id}:{}),name:model.name.trim()||model.remote_id.trim(),remote_id:model.remote_id.trim(),modality:model.modality,protocol:model.protocol,enabled:model.enabled,settings:model.settings})),
        }))
        setKey('');await onSaved();onClose()
        } catch(cause) {setError(cause instanceof Error?cause.message:String(cause));throw cause}
      },'提供商配置已保存')
    } catch(cause){setError(cause instanceof Error?cause.message:String(cause))}
    finally{setSaving(false)}
  }
  async function fetchCatalog(refresh = false){
    setCatalogOpen(true);setCatalogLoading(true);setError('');setCatalog([]);setSelected({});setCapabilitiesRefreshed(0);setCatalogFreshness(undefined)
    try{const result=await api<{models:CatalogItem[];freshness?:CatalogFreshness}>('/providers/model-catalog/preview',json('POST',{...(refresh?{refresh:true}:{}),...(!isNew?{provider_id:provider.id}:{}),base_url:baseUrl.trim(),...(key?{api_key:key}:{}),...(clearKey?{clear_key:true}:{}),protocol}));setCatalog(result.models);setCatalogFreshness(result.freshness)
      const discovered=new Map(result.models.filter(item=>item.capabilities).map(item=>[item.remote_id,item.capabilities!]))
      setCapabilitiesRefreshed(draft.filter(model=>matchesDiscovery(model,discovered.get(model.remote_id),baseUrl)).length)
      setDraft(current=>current.map(model=>{const capabilities=discovered.get(model.remote_id);if(!matchesDiscovery(model,capabilities,baseUrl))return model;const previous=model.settings.text_capabilities;const configured=previous&&typeof previous==='object'&&!Array.isArray(previous)?previous as Record<string,unknown>:typeof model.settings.context_window_tokens==='number'?{override:{budget_mode:'shared',context_tokens:model.settings.context_window_tokens}}:{};return{...model,settings:{...model.settings,text_capabilities:{...configured,version:1,discovered:capabilities}}}}))
    }
    catch(cause){setError(cause instanceof Error?cause.message:String(cause))}
    finally{setCatalogLoading(false)}
  }
  return <div className="hp-editor hp-workbench-editor">
    <section className="hp-draft-catalog" aria-label="模型目录草稿">
      <header className="hp-workbench-pane-head"><h2>模型目录</h2><Button variant="subtle" size="compact-xs" disabled={saving||!baseUrl.trim()} loading={catalogLoading} onClick={()=>void fetchCatalog()}>获取可用模型</Button></header>
      <div className="hp-draft-catalog-scroll">
        <div className="hp-model-list">{draft.map((model,index)=>{const open=expanded.includes(model.local_id);return <div className={`hp-model${open ? ' is-selected' : ''}`} key={model.local_id} onDragOver={event=>{if(dragged)event.preventDefault()}} onDrop={event=>{event.preventDefault();if(dragged)move(dragged,model.local_id);setDragged(null)}}>
          <div className="hp-model-row">
            <Tooltip label="拖动排序；方向键调整顺序"><ActionIcon variant="subtle" color="gray" className="hp-drag" aria-label={`调整模型顺序 ${index+1}`} draggable={!saving} disabled={saving} onDragStart={event=>{setDragged(model.local_id);event.dataTransfer.setData('text/plain',model.local_id)}} onDragEnd={()=>setDragged(null)} onKeyDown={event=>{if(event.key==='ArrowUp'&&index>0){event.preventDefault();move(model.local_id,draft[index-1].local_id)}if(event.key==='ArrowDown'&&index<draft.length-1){event.preventDefault();move(model.local_id,draft[index+1].local_id)}}}><GripHorizontal size={16}/></ActionIcon></Tooltip>
            <div className="hp-draft-model-fields">
              <TextInput label="模型 ID" aria-label={`模型 ID ${index+1}`} value={model.remote_id} disabled={saving} onChange={event=>update(model.local_id,{remote_id:event.currentTarget.value})}/>
              <TextInput label="模型显示名称" aria-label={`显示名称 ${index+1}`} value={model.name} disabled={saving} onChange={event=>update(model.local_id,{name:event.currentTarget.value})}/>
            </div>
            <Tooltip label={open ? '关闭模型设置' : '编辑模型设置'}>
              <ActionIcon variant="subtle" color={open ? undefined : 'gray'} aria-label={`模型选项 ${index+1}`} aria-expanded={open} disabled={saving}
                onClick={()=>setExpanded(open?[]:[model.local_id])}><Settings2 size={16}/></ActionIcon>
            </Tooltip>
            <Tooltip label="从草稿移除模型">
              <ActionIcon variant="subtle" color="gray" aria-label={`删除模型 ${index+1}`} disabled={saving} onClick={()=>setDraft(current=>current.filter(item=>item.local_id!==model.local_id))}><Trash2 size={16}/></ActionIcon>
            </Tooltip>
          </div>

        </div>})}</div>
        {!draft.length && <div className="hp-workbench-empty"><Server size={25}/><p>还没有模型</p></div>}
        <Button className="hp-add-model" variant="default" leftSection={<Plus size={15}/>} disabled={saving} onClick={()=>addModel()}>添加模型</Button>
      </div>
    </section>
    <aside className="hp-draft-inspector" aria-label="模型配置检查器">
      <header className="hp-workbench-pane-head"><h2>{draft.some(model=>expanded.includes(model.local_id)) ? '模型设置' : isNew?'添加模型提供商':'连接配置'}</h2><Badge variant="light" color="gray">草稿</Badge></header>
      <div className="hp-inspector-scroll">
        <section className="hp-connection-fields" aria-label="提供商连接">
    <div className="hp-key-field">
      <div className="hp-secret-label"><label htmlFor={`${editorId}-key`}>API 密钥</label><Tooltip label="密钥保存在本机，留空使用已保存凭据。"><ActionIcon variant="subtle" size="xs" aria-label="认证说明"><HelpCircle size={14}/></ActionIcon></Tooltip></div>
      <PasswordInput id={`${editorId}-key`} aria-label="API 密钥" autoComplete="new-password" placeholder={provider.has_key&&!clearKey?'留空使用已保存凭据':'输入 API 密钥'} value={key} disabled={saving} onChange={event=>{setKey(event.currentTarget.value);setClearKey(false)}}/>
      {provider.has_key&&<div className="hp-key-feedback"><span className={clearKey?'is-clearing':''} role="status">{clearKey?'保存后将清除密钥':key?'保存后将替换现有密钥':'已保存密钥，留空即可保留'}</span><Button className="hp-clear-key" variant="subtle" size="compact-xs" color={clearKey?'red':'gray'} disabled={saving} onClick={()=>{setClearKey(!clearKey);setKey('')}}>{clearKey?'撤销清除密钥':'清除已保存密钥'}</Button></div>}
    </div>
    <UnstyledButton className="hp-custom-toggle" aria-expanded={customOpen} aria-controls={`${editorId}-custom`} disabled={saving} onClick={()=>setCustomOpen(!customOpen)}>{customOpen?<ChevronDown size={16}/>:<ChevronRight size={16}/>}自定义设置</UnstyledButton>
    {customOpen&&<div className="hp-custom-fields" id={`${editorId}-custom`}>
      <TextInput label="显示名称" maxLength={120} placeholder="提供商名称" value={name} disabled={saving} onChange={event=>setName(event.currentTarget.value)}/>
      <TextInput label="API 地址" type="url" placeholder="https://api.example.com/v1" value={baseUrl} disabled={saving} onChange={event=>setBaseUrl(event.currentTarget.value)}/>
      <Select className="hp-protocol" label="API 协议" data={protocols} allowDeselect={false} value={protocol} disabled={saving} onChange={value=>value&&changeProtocol(value as TextApiProtocol)}/>
      <Switch label="启用提供商" checked={enabled} onChange={event=>setEnabled(event.currentTarget.checked)} disabled={saving}/>
    </div>}
        </section>
        {draft.filter(model=>expanded.includes(model.local_id)).map(model=><section className="hp-selected-model-settings" key={model.local_id}><h3>{model.name || model.remote_id || '新模型'}</h3>
          {<div className="hp-model-options">
            <div className="hp-model-kind"><Select label="模型类型" data={modalities} value={model.modality} allowDeselect={false} disabled={saving} onChange={value=>{if(!value||value===model.modality)return;const modality=value as Modality;const nextProtocol:Protocol=modality==='text'?protocol:modality==='image'?'image_generations':'async_video';update(model.local_id,{modality,protocol:nextProtocol,inherit:modality==='text',settings:createSettings(modality,nextProtocol)})}}/><Switch label="启用模型" checked={model.enabled} disabled={saving} onChange={event=>update(model.local_id,{enabled:event.currentTarget.checked})}/></div>
            {model.modality==='text'?<>
              {!model.inherit&&<Select label="此模型 API 协议" data={[{value:'inherit',label:'使用提供商协议'},...protocols]} value={model.protocol} allowDeselect={false} disabled={saving} onChange={value=>{if(!value)return;const migrated=migrateStandardTextSettings(model.settings,model.protocol as TextApiProtocol);if(!migrated){setError('此模型使用自定义接口，请先在高级设置中切换标准接口，再更改协议');return}update(model.local_id,{protocol:(value==='inherit'?protocol:value) as Protocol,inherit:value==='inherit',settings:migrated})}}/>}
              <WorkspaceDisclosure className="hp-text-options-disclosure" label="文本参数">
                <HarnessTextModelOptions settings={model.settings} protocol={model.protocol as TextApiProtocol} scope={{base_url:typeof model.settings.api_base_url==='string'?model.settings.api_base_url:baseUrl,protocol:model.protocol,remote_id:model.remote_id}} disabled={saving} onChange={settings=>update(model.local_id,{settings})}/>
              </WorkspaceDisclosure>
            </>:<Button variant="default" leftSection={<Settings2 size={14}/>} disabled={saving} onClick={()=>setAdvanced(model.local_id)}>{model.modality==='image'?'图片':'视频'}模型设置</Button>}
            <Button className="hp-advanced-button" variant="subtle" color="gray" size="compact-xs" disabled={saving} onClick={()=>setAdvanced(model.local_id)}>高级设置</Button>
          </div>}        </section>)}
      </div>
      {error&&!catalogOpen&&<Alert className="hp-inspector-error" color="red" role="alert">{error}</Alert>}
      <footer className="hp-editor-actions"><Button variant="subtle" disabled={saving} onClick={onClose}>取消</Button><Button className="hp-save" loading={saving} disabled={!name.trim()||!baseUrl.trim()} onClick={()=>void save()}>保存</Button></footer>
    </aside>
    {editingModel&&<ModelAdvancedEditor key={editingModel.local_id} model={editingModel} provider={{...provider,name,base_url:baseUrl}} onClose={()=>setAdvanced(null)} onApply={next=>update(editingModel.local_id,{...next,inherit:editingModel.inherit&&next.protocol===protocol&&!!migrateStandardTextSettings(next.settings,next.protocol as TextApiProtocol)})}/>}
    <Modal opened={catalogOpen} onClose={()=>setCatalogOpen(false)} title="获取可用模型" size="lg" centered classNames={{ content: 'hp-remote-catalog-modal', body: 'hp-remote-catalog-body' }}>
      <div className="hp-remote-catalog"><div className="hp-remote-catalog-scroll"><TextInput aria-label="搜索可用模型" placeholder="搜索模型" leftSection={<Search size={15}/>} value={catalogSearch} onChange={event=>setCatalogSearch(event.currentTarget.value)}/>
      {error&&<Alert color="red">{error}</Alert>}{catalogLoading&&<p role="status">正在获取模型…</p>}
      <div className="hp-catalog-freshness">{catalogFreshness&&<small role="status">{catalogFreshness.source==='cache'?'缓存目录':catalogFreshness.source==='revalidated'?'目录已核验':'最新获取目录'} · 更新于 {new Date(catalogFreshness.validated_at).toLocaleString('zh-CN')}</small>}<Button variant="subtle" color="gray" size="compact-xs" loading={catalogLoading} onClick={()=>void fetchCatalog(true)}>重新获取目录</Button></div>
      {!catalogLoading&&capabilitiesRefreshed>0&&<Alert color="gray">已更新 {capabilitiesRefreshed} 个模型的目录能力草稿；手动覆盖和请求设置保留，保存提供商后生效。</Alert>}
      {catalog.filter(item=>`${item.name} ${item.remote_id}`.toLowerCase().includes(catalogSearch.toLowerCase())).map(item=>{const exists=draft.some(model=>model.remote_id===item.remote_id);return <div className="hp-remote-row" key={item.remote_id}><Checkbox aria-label={`选择 ${item.remote_id}`} label={item.name} disabled={exists} checked={exists||!!selected[item.remote_id]} onChange={event=>{const checked=event.currentTarget.checked;setSelected(current=>{const next={...current};if(checked)next[item.remote_id]=item.modality_hint||'text';else delete next[item.remote_id];return next})}}/>{exists?<Badge color="gray">已添加</Badge>:selected[item.remote_id]&&<Select aria-label={`${item.remote_id} 模型类型`} data={modalities} value={selected[item.remote_id]} allowDeselect={false} onChange={value=>value&&setSelected(current=>({...current,[item.remote_id]:value as Modality}))}/>}</div>})}
      </div><footer className="hp-editor-actions"><Button variant="default" onClick={()=>setCatalogOpen(false)}>关闭</Button><Button disabled={!Object.keys(selected).length} onClick={()=>{for(const item of catalog)if(selected[item.remote_id])addModel(selected[item.remote_id],item.remote_id,item.name,item.capabilities);setCatalogOpen(false);setError('')}}>添加所选模型</Button></footer></div>
    </Modal>
  </div>
}

export default function ModelSettings(props:Props) {
  const providers=props.providers.filter(provider=>provider.adapter!=='demo')
  const [selectedProviderId,setSelectedProviderId] = useState<string|null>(providers[0]?.id || null)
  const [selectedModelId,setSelectedModelId] = useState<string|null>(null)
  const [editing,setEditing] = useState(false)
  const [editorModelId,setEditorModelId] = useState<string|null>(null)
  const [startWithNewModel, setStartWithNewModel] = useState(false)
  const [adding,setAdding] = useState(false)
  const [defaultsOpen,setDefaultsOpen] = useState(false)
  const [deleting,setDeleting] = useState<Provider|null>(null)
  const [query,setQuery] = useState('')
  const selectedProvider=providers.find(provider=>provider.id===selectedProviderId) || providers[0]
  const providerModels=props.models.filter(model=>model.provider_id===selectedProvider?.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))
  const selectedModel=providerModels.find(model=>model.id===selectedModelId) || providerModels[0]
  const visibleModels=providerModels.filter(model=>`${model.name} ${model.remote_id}`.toLowerCase().includes(query.toLowerCase()))
  const placeholder={id:'__new__',name:'新提供商',adapter:'http',base_url:'',has_key:false,enabled:true,auth_header:'Authorization',auth_prefix:'Bearer ',created_at:'',model_catalog:{path:'models',list_path:'data',id_path:'id',name_path:'id'},protocol:null} as Provider
  const locked=editing||adding||props.busy
  function addProvider(withModel: boolean) {
    setDefaultsOpen(false)
    setStartWithNewModel(withModel)
    setAdding(true)
  }
  function addModel() {
    if (!selectedProvider) { addProvider(true); return }
    setDefaultsOpen(false)
    setStartWithNewModel(true)
    setEditing(true)
  }
  useEffect(()=>{ if(selectedProviderId&&!providers.some(provider=>provider.id===selectedProviderId))setSelectedProviderId(providers[0]?.id||null) },[providers,selectedProviderId])
  return <section className="hp-page hp-workbench" aria-label="模型提供商设置">
    <header className="hp-heading hp-workbench-heading"><h1>模型设置</h1><div>{props.headerControls}<Button variant="default" leftSection={<Settings2 size={15}/>} disabled={locked} onClick={()=>setDefaultsOpen(true)}>默认模型</Button><Button leftSection={<Plus size={15}/>} disabled={locked} onClick={addModel}>新增模型</Button></div></header>
    <div className="hp-workbench-layout">
      <nav className="hp-provider-nav" aria-label="模型服务商">
        <header><h2>服务商</h2><Tooltip label="添加模型提供商"><ActionIcon aria-label="添加模型提供商" variant="subtle" disabled={locked} onClick={() => addProvider(false)}><Plus size={15}/></ActionIcon></Tooltip></header>
        <div className="hp-provider-nav-list">{providers.map(provider=>{const count=props.models.filter(model=>model.provider_id===provider.id).length;return <UnstyledButton key={provider.id} className={`hp-provider-nav-item${provider.id===selectedProvider?.id&&!adding?' is-active':''}`} aria-label={`选择服务商 ${provider.name}`} aria-current={provider.id===selectedProvider?.id&&!adding?'true':undefined} disabled={locked} onClick={()=>{setSelectedProviderId(provider.id);setSelectedModelId(null);setQuery('');setDefaultsOpen(false)}}>
          <span className="hp-provider-monogram" aria-hidden="true">{provider.name.slice(0,1).toUpperCase()}</span><span className="hp-provider-name"><strong>{provider.name}</strong><small><i className={`hp-status-dot ${!provider.enabled?'is-disabled':provider.has_key?'is-ready':'is-missing'}`} />{count} 个模型</small></span>
        </UnstyledButton>})}</div>
        {selectedProvider && <footer>
          <span className="hp-provider-connection-state">{selectedProvider.has_key ? '已配置连接' : '待配置连接'}</span>
          <ActionIcon variant="subtle" color="red" aria-label={`删除提供商 ${selectedProvider.name}`} disabled={locked}
            onClick={() => setDeleting(selectedProvider)}><Trash2 size={15} /></ActionIcon>
        </footer>}
      </nav>
      {defaultsOpen ? <section className="hp-default-models-panel" aria-label="默认模型设置"><header className="hp-workbench-pane-head"><h2>默认模型</h2></header><div className="hp-inspector-scroll"><DefaultModelSettings {...props}/></div><footer className="hp-inspector-footer"><Button variant="default" onClick={()=>setDefaultsOpen(false)}>完成</Button></footer></section> : adding||editing&&selectedProvider ? <ProviderEditor key={adding?'__new__':selectedProvider!.id} provider={adding?placeholder:selectedProvider!} models={adding?[]:providerModels} initialModelId={adding?null:editorModelId} startWithNewModel={startWithNewModel} action={props.action} onSaved={props.refresh} onClose={()=>{setEditing(false);setAdding(false);setStartWithNewModel(false);setEditorModelId(null)}}/> : <>
        <section className="hp-model-catalog" aria-label="模型目录">
          <header className="hp-workbench-pane-head">
            <h2>{selectedProvider?.name || '模型目录'}</h2>
            {selectedProvider && <Button variant="subtle" size="compact-xs" disabled={locked}
              aria-label={`编辑 ${selectedProvider.name}`} onClick={() => {
                setDefaultsOpen(false)
                setEditorModelId(null)
                setEditing(true)
              }}>连接设置</Button>}
          </header>
          <div className="hp-catalog-search"><TextInput aria-label="搜索模型目录" placeholder="搜索模型…" leftSection={<Search size={14}/>} value={query} onChange={event=>setQuery(event.currentTarget.value)}/></div>
          <div className="hp-model-catalog-list">{visibleModels.map(model=><UnstyledButton key={model.id} className={`hp-catalog-model${selectedModel?.id===model.id?' is-active':''}`} aria-label={`查看模型 ${model.name}`} aria-pressed={selectedModel?.id===model.id} onClick={()=>setSelectedModelId(model.id)}>
            <span className="hp-model-type">{modalities.find(item=>item.value===model.modality)?.label.slice(0,1)}</span><span><strong>{model.name}</strong>{model.remote_id!==model.name&&<small>{model.remote_id}</small>}<span className="hp-model-tags"><span>{modalities.find(item=>item.value===model.modality)?.label}生成</span>{model.is_default&&<Badge size="xs" variant="light">默认</Badge>}{!model.enabled&&<Badge size="xs" color="gray" variant="light">未启用</Badge>}</span></span><ChevronRight size={14}/>
          </UnstyledButton>)}{!visibleModels.length&&<div className="hp-workbench-empty"><Server size={25}/><p>{providerModels.length?'没有匹配的模型':'还没有模型'}</p>{selectedProvider&&!providerModels.length&&<Button size="xs" variant="default" onClick={addModel}>添加模型</Button>}</div>}</div>
          {selectedProvider&&<footer className="hp-catalog-footer"><Button variant="subtle" leftSection={<Plus size={14}/>} onClick={()=>setEditing(true)}>管理模型目录</Button></footer>}
        </section>
        <aside className="hp-model-inspector" aria-label="模型详情">
          <header className="hp-workbench-pane-head"><h2>模型详情</h2></header>
          {selectedModel&&selectedProvider?<><div className="hp-inspector-scroll"><div className="hp-inspector-identity"><span className="hp-model-type">{modalities.find(item=>item.value===selectedModel.modality)?.label.slice(0,1)}</span><div><h3>{selectedModel.name}</h3><p>{selectedProvider.name} · {modalities.find(item=>item.value===selectedModel.modality)?.label}生成</p></div></div>
            <Tabs key={selectedModel.id} defaultValue="defaults" variant="pills" className="hp-inspector-tabs">
              <Tabs.List aria-label="模型详情视图">
                <Tabs.Tab value="defaults">默认设置</Tabs.Tab>
                <Tabs.Tab value="advanced">高级配置</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="defaults">
            <dl className="hp-model-facts"><div><dt>模型 ID</dt><dd>{selectedModel.remote_id}</dd></div><div><dt>API 协议</dt><dd>{protocols.find(item=>item.value===selectedModel.protocol)?.label || (selectedModel.modality==='image'?'Images API':'Async Video')}</dd></div><div><dt>状态</dt><dd>{!selectedProvider.enabled?'提供商已停用':!selectedProvider.has_key?'待配置密钥':selectedModel.enabled?'已启用':'未启用'}</dd></div><div><dt>默认选择</dt><dd>{selectedModel.is_default?'默认模型':'按需选择'}</dd></div>{['default_ratio','default_resolution','context_window_tokens'].filter(key=>selectedModel.settings[key]!==undefined).map(key=><div key={key}><dt>{{default_ratio:'默认画幅',default_resolution:'默认分辨率',context_window_tokens:'上下文窗口'}[key]}</dt><dd>{String(selectedModel.settings[key])}</dd></div>)}</dl>
              </Tabs.Panel>
              <Tabs.Panel value="advanced"><section className="hp-request-preview"><h3>请求配置</h3><pre>{JSON.stringify(selectedModel.settings,null,2)}</pre></section></Tabs.Panel>
            </Tabs>
          </div><footer className="hp-inspector-footer"><Button leftSection={<PencilLine size={14}/>} aria-label={`编辑模型 ${selectedModel.name}`} disabled={props.busy} onClick={()=>{setEditorModelId(selectedModel.id);setEditing(true)}}>编辑模型设置</Button></footer></>:<div className="hp-workbench-empty"><Settings2 size={25}/><p>选择模型查看配置</p></div>}
        </aside>
      </>}
    </div>
    <Modal opened={!!deleting} onClose={()=>setDeleting(null)} title="删除提供商" size="sm" centered><p>删除「{deleting?.name}」及其模型？已生成的素材仍会保留。</p><div className="hp-editor-actions"><Button variant="default" onClick={()=>setDeleting(null)}>取消</Button><Button color="red" loading={props.busy} onClick={()=>void props.action(async()=>{await api(`/providers/${deleting!.id}`,{method:'DELETE'});await props.refresh();setDeleting(null)},'提供商已删除')}>删除</Button></div></Modal>
  </section>
}
