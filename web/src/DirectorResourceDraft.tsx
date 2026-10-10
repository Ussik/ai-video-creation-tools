import { Select } from '@mantine/core'
import type { ResourceChange } from '../../backend/src/script-resource-types'

const labels: Record<string, string> = { name: '名称', variant: '版本', definition: '视觉设定', view_requirements: '视图与细节要求', title: '镜头标题',
  prompt: '叙事描述', image_prompt: '图片首帧提示词', video_prompt: '视频动作与运镜提示词', duration: '时长（秒）', start_state: '开镜状态', end_state: '收镜状态', cut_note: '接镜说明' }

export default function DirectorResourceDraft({ change, editing, disabled, onChange, profileNames, sceneNames }: {
  change: ResourceChange; editing: boolean; disabled: boolean; onChange: (change: ResourceChange) => void;
  profileNames: Record<string, string>; sceneNames: Record<string, string>
}) {
  const field = (key: string, value: string | number) => <label className="sd-resource-field" key={key}><span>{labels[key] || key}</span>
    {editing ? typeof value === 'number' ? <input type="number" min={1} max={30} aria-label={labels[key]} disabled={disabled} value={value}
      onChange={event => onChange({ ...change, value: { ...change.value, [key]: Math.max(1, Math.min(30, Number(event.currentTarget.value) || 1)) } } as ResourceChange)} />
      : <textarea aria-label={labels[key]} rows={['definition', 'image_prompt', 'video_prompt', 'prompt'].includes(key) ? 5 : 2} disabled={disabled} value={value}
        onChange={event => onChange({ ...change, value: { ...change.value, [key]: event.currentTarget.value } } as ResourceChange)} />
      : <p>{String(value) || '未填写'}</p>}
  </label>
  const bindingList = (value: Array<{ profile_id: string; required: boolean }>, editable: boolean) => <div className="sd-resource-bindings">{value.length ? value.map(binding => <div key={binding.profile_id}>
    <strong>{profileNames[binding.profile_id] || '待核对的视觉设定'}</strong>
    {editable && change.type === 'visual_binding' ? <><label><input type="checkbox" checked={binding.required} disabled={disabled} onChange={event => onChange({ ...change, value: change.value.map(item => item.profile_id === binding.profile_id ? { ...item, required: event.currentTarget.checked } : item) })} />需要参考图</label>
      <button type="button" disabled={disabled} onClick={() => onChange({ ...change, value: change.value.filter(item => item.profile_id !== binding.profile_id), refresh_profile_ids: change.refresh_profile_ids.filter(id => id !== binding.profile_id) })}>移除</button></> : <span>{binding.required ? '需要参考图' : '可选参考图'}</span>}
  </div>) : <p>无参考绑定</p>}</div>
  return <div className="sd-document-page sd-resource-draft"><h2>{change.title}</h2>
    <p className="sd-resource-kind">{change.type === 'visual_profile' ? change.original ? '视觉设定修订' : '新增视觉设定' : change.type === 'new_shot' ? '新增分镜' : change.type === 'shot' ? '分镜修订' : '参考绑定修改'}</p>
    {change.original && <details className="sd-original-document"><summary>查看修改前内容</summary>
      {Array.isArray(change.original) ? bindingList(change.original, false) : Object.entries(change.original).filter(([key]) => key in labels).map(([key, value]) => <div className="sd-resource-field" key={key}><span>{labels[key]}</span><p>{String(value) || '未填写'}</p></div>)}
    </details>}
    {change.type === 'visual_binding' ? <>
      {bindingList(change.value, editing)}
      {editing && <Select aria-label="添加参考设定" placeholder="添加参考设定" value={null} searchable disabled={disabled} comboboxProps={{ withinPortal: true, zIndex: 410 }}
        data={Object.entries(profileNames).filter(([id]) => !change.value.some(binding => binding.profile_id === id)).map(([value, label]) => ({ value, label }))}
        onChange={id => id && onChange({ ...change, value: [...change.value, { profile_id: id, required: true }] })} />}
      {!!change.refresh_profile_ids.length && <p>将更新指定绑定到当前设定版本；生成素材保留。</p>}
    </> : <>
      {Object.entries(change.value).filter(([key, value]) => key in labels && (typeof value === 'string' || typeof value === 'number')).map(([key, value]) => field(key, value as string | number))}
      {change.type === 'visual_profile' && !!change.value.scene_ids.length && <p>引用场次：{change.value.scene_ids.map(id => sceneNames[id] || '待核对场次').join('、')}</p>}
      {change.type === 'new_shot' && <p>来源场次：{sceneNames[change.source_scene_id] || '待核对场次'}</p>}
    </>}
  </div>
}
