import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Select, Textarea } from '@mantine/core'
import { ChevronDown, LoaderCircle, Puzzle } from 'lucide-react'
import { api, json } from './api'
import type { Model } from './api'
import { useCreativeSkills } from './useCreativeSkills'
import CreativeSkillSelector from './CreativeSkillSelector'
import './prompt-skill-action.css'

type Props = {
  projectId: string; nodeId: string; modality: 'image' | 'video'; prompt: string; models: Model[]; disabled: boolean;
  targetModelId: string; shotId: string | null; profileId?: string; ratio: string; duration: number; mode: string;
  referenceAssetIds: string[]; onApply: (prompt: string) => void;
  storyboardReferenceAssetId?: string | null; visualReferenceMode?: string; excludedVisualProfileIds?: string[];
}
export default function PromptSkillAction(props: Props) {
  const [opened, setOpened] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  const [modelId, setModelId] = useState(''), [result, setResult] = useState('')
  const [elapsed, setElapsed] = useState(0), [requestLabel, setRequestLabel] = useState('整理提示词')
  const skillControl = useCreativeSkills(props.projectId, opened)
  const stage = props.modality === 'image' ? 'image_prompt' : 'video_prompt'
  const [sourceKey, setSourceKey] = useState(''), [usedSkills, setUsedSkills] = useState<string[]>([])
  const serial = useRef(0), abort = useRef<AbortController | null>(null)
  useEffect(() => () => { serial.current++; abort.current?.abort() }, [])
  useEffect(() => {
    if (!pending) return
    const started = Date.now(), timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  const selectedIds = skillControl.ids(stage), policy = skillControl.policies.find(item => item.stage === stage)
  const primary = policy?.skills.find(skill => skill.id === selectedIds[0])
  const defaults = policy?.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : []
  const matchesDefaults = selectedIds.length === defaults.length && selectedIds.every((id, index) => id === defaults[index])
  const selectionSource = !policy ? '配置未读取' : matchesDefaults ? policy.source === 'project' ? '项目默认' : '全局默认' : '本次选择'
  const skillName = skillControl.loading ? '正在读取技能' : skillControl.error ? '技能配置未读取' : selectedIds[0] && !primary ? '技能需重新选择' : primary?.name || '基础创作规则'
  const modalityLabel = props.modality === 'image' ? '图片' : '视频'
  const currentKey = JSON.stringify([props.projectId, props.nodeId, props.modality, props.shotId, props.profileId,
    props.prompt, props.ratio, props.duration, props.mode, props.referenceAssetIds, props.storyboardReferenceAssetId,
    props.visualReferenceMode, props.excludedVisualProfileIds, props.targetModelId, modelId, skillControl.ids(stage)])
  const maxPromptLength = props.profileId ? 16_000 : 80_000
  function open() {
    setOpened(true); setError(''); setResult('')
    setModelId(previous => props.models.some(model => model.id === previous) ? previous : props.models[0]?.id || '')
  }
  function close() { serial.current++; abort.current?.abort(); setOpened(false); setPending(false); setResult(''); setUsedSkills([]); setError('') }
  async function refine() {
    const turn = ++serial.current, capturedKey = currentKey
    setRequestLabel(result ? '重新整理' : '整理提示词'); setElapsed(0)
    setPending(true); setError(''); setResult(''); abort.current = new AbortController()
    try {
      const response = await api<{ prompt: string; skills: Array<{ name: string }> }>(`/projects/${props.projectId}/skills/refine-prompt`, {
        ...json('POST', { stage, skill_ids: skillControl.ids(stage), model_id: modelId, prompt: props.prompt, target_model_id: props.targetModelId || null, shot_id: props.shotId,
          profile_id: props.profileId, ratio: props.ratio, duration: props.duration, mode: props.mode, reference_asset_ids: props.referenceAssetIds,
          ...(props.modality === 'video' ? { storyboard_reference_asset_id: props.storyboardReferenceAssetId || null,
            visual_reference_mode: props.visualReferenceMode, excluded_visual_profile_ids: props.excludedVisualProfileIds || [] } : {}) }), signal: abort.current.signal,
      })
      if (turn !== serial.current) return
      setResult(response.prompt); setSourceKey(capturedKey); setUsedSkills(response.skills.map(skill => skill.name))
    } catch (issue) { if (turn === serial.current) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (turn === serial.current) setPending(false) }
  }
  const stale = !!result && sourceKey !== currentKey
  return <>
    <button type="button" className="pc-composer-chip" aria-label="使用技能整理提示词" disabled={props.disabled || !props.prompt.trim()} onClick={() => void open()}><Puzzle size={14} /><span>整理提示词</span></button>
    <Modal opened={opened} onClose={close} centered size="min(620px, calc(100vw - 32px))" radius={18}
      title={<div className="prompt-skill-heading"><span>整理提示词</span><small>{modalityLabel}提示词 · 编辑后应用到节点</small></div>} zIndex={230}
      classNames={{ content: 'prompt-skill-modal', header: 'prompt-skill-header', title: 'prompt-skill-title', body: 'prompt-skill-body', close: 'prompt-skill-close' }}
      overlayProps={{ backgroundOpacity: 0.6, blur: 4 }} closeButtonProps={{ 'aria-label': '关闭整理提示词' }}>
      <div className="prompt-skill-content">
        <section className="prompt-skill-card" aria-label={`本次${modalityLabel}提示词技能`}>
          <header><span>本次{modalityLabel}提示词技能</span><small>{selectionSource}</small></header>
          <div className="prompt-skill-selection"><div className="prompt-skill-primary"><Puzzle size={16} /><strong>{skillName}</strong></div>
            <CreativeSkillSelector stage={stage} policies={skillControl.policies} ids={selectedIds}
              onChange={values => { skillControl.change(stage, values); setResult('') }} projectId={props.projectId} disabled={pending}
              loading={skillControl.loading} error={skillControl.error} onDefaultsChanged={() => skillControl.reload(stage)} appearance="prompt" triggerLabel="更换" />
          </div>
          <p>{selectedIds.length ? '主技能' : '使用内置规则'}<span>·</span>辅助技能 {Math.max(0, selectedIds.length - 1)} 个</p>
        </section>
        <div className="prompt-skill-settings">
          <Select label="文本模型" aria-label="整理提示词的文本模型" data={props.models.map(model => ({ value: model.id, label: model.name }))}
            value={modelId || null} onChange={value => setModelId(value || '')} placeholder="选择用于整理的文本模型"
            disabled={pending} allowDeselect={false} searchable rightSection={<ChevronDown size={14} />} rightSectionPointerEvents="none"
            classNames={{ input: 'prompt-skill-model-input', dropdown: 'prompt-skill-dropdown' }} comboboxProps={{ zIndex: 320 }} />
        </div>
        <details className="prompt-skill-source"><summary><span>原始提示词</span><small>{props.prompt.length.toLocaleString()} 字</small><ChevronDown size={14} /></summary>
          <p>{props.prompt}</p>
        </details>
        {!props.models.length && <p className="prompt-skill-error">请先在模型设置中启用一个文本模型。</p>}
        {skillControl.error && <p className="prompt-skill-error" role="alert">{skillControl.error}</p>}
        {error && <p className="prompt-skill-error" role="alert">{error}</p>}
        {!!result && <div className="prompt-skill-result">
          <Textarea aria-label="整理后的完整提示词" label="整理结果 · 可编辑" value={result} onChange={event => setResult(event.currentTarget.value)} rows={10}
            maxLength={maxPromptLength} classNames={{ input: 'prompt-skill-editor' }} />
          <p className="prompt-skill-used">使用技能：{usedSkills.join(' · ') || '基础创作规则'}</p>
        </div>}
        {stale && <p className="prompt-skill-error" role="alert">当前节点内容或生成配置已变化，请重新整理。</p>}
      </div>
      <div className="prompt-skill-footer">
        {pending ? <div className="prompt-skill-progress" role="status"><LoaderCircle size={14} /><span>正在整理 · {elapsed} 秒</span></div>
          : <span className="prompt-skill-status">{result ? `已整理 · ${result.length.toLocaleString()} 字` : '确认应用后更新节点'}</span>}
        <div className="prompt-skill-actions"><Button variant="default" disabled={pending || !modelId || skillControl.loading || !!skillControl.error} onClick={() => void refine()}>{pending ? requestLabel : result ? '重新整理' : '整理提示词'}</Button>
        {!!result && <Button className="prompt-skill-apply" disabled={pending || stale || !result.trim() || result.length > maxPromptLength} onClick={() => { props.onApply(result.trim()); close() }}>应用提示词</Button>}</div>
      </div>
    </Modal>
  </>
}
