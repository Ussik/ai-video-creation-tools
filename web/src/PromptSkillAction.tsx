import { useEffect, useRef, useState } from 'react'
import { Button, Modal, Select, Textarea } from '@mantine/core'
import { LoaderCircle, Puzzle } from 'lucide-react'
import { api, json } from './api'
import type { Model } from './api'
import type { InstalledSkill } from './skills-api'
import './skills-center.css'

type Props = {
  projectId: string; nodeId: string; modality: 'image' | 'video'; prompt: string; models: Model[]; disabled: boolean;
  targetModelId: string; shotId: string | null; profileId?: string; ratio: string; duration: number; mode: string;
  referenceAssetIds: string[]; onApply: (prompt: string) => void;
}
export default function PromptSkillAction(props: Props) {
  const [opened, setOpened] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  const [skills, setSkills] = useState<InstalledSkill[]>([]), [modelId, setModelId] = useState(''), [result, setResult] = useState('')
  const [sourceKey, setSourceKey] = useState(''), [usedSkills, setUsedSkills] = useState<string[]>([])
  const serial = useRef(0), abort = useRef<AbortController | null>(null)
  useEffect(() => () => { serial.current++; abort.current?.abort() }, [])
  const currentKey = JSON.stringify([props.projectId, props.nodeId, props.modality, props.shotId, props.profileId,
    props.prompt, props.ratio, props.duration, props.mode, props.referenceAssetIds, props.targetModelId, modelId])
  const stage = props.modality === 'image' ? 'image_prompt' : 'video_prompt'
  const maxPromptLength = props.profileId ? 16_000 : 80_000
  async function open() {
    setOpened(true); setError(''); setResult(''); setPending(true)
    setModelId(previous => props.models.some(model => model.id === previous) ? previous : props.models[0]?.id || '')
    try {
      const response = await api<{ skills: InstalledSkill[] }>('/skills')
      setSkills(response.skills.filter(skill => skill.enabled && skill.stages.includes(stage)))
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)) } finally { setPending(false) }
  }
  function close() { serial.current++; abort.current?.abort(); setOpened(false); setPending(false); setResult(''); setUsedSkills([]); setError('') }
  async function refine() {
    const turn = ++serial.current, capturedKey = currentKey
    setPending(true); setError(''); setResult(''); abort.current = new AbortController()
    try {
      const response = await api<{ prompt: string; skills: Array<{ name: string }> }>(`/projects/${props.projectId}/skills/refine-prompt`, {
        ...json('POST', { stage, model_id: modelId, prompt: props.prompt, target_model_id: props.targetModelId || null, shot_id: props.shotId,
          profile_id: props.profileId, ratio: props.ratio, duration: props.duration, mode: props.mode, reference_asset_ids: props.referenceAssetIds }), signal: abort.current.signal,
      })
      if (turn !== serial.current) return
      setResult(response.prompt); setSourceKey(capturedKey); setUsedSkills(response.skills.map(skill => skill.name))
    } catch (issue) { if (turn === serial.current) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (turn === serial.current) setPending(false) }
  }
  const stale = !!result && sourceKey !== currentKey
  return <>
    <button type="button" className="pc-composer-chip" aria-label="使用技能整理提示词" disabled={props.disabled || !props.prompt.trim()} onClick={() => void open()}><Puzzle size={14} /><span>整理提示词</span></button>
    <Modal opened={opened} onClose={close} centered size="min(820px, calc(100vw - 40px))" radius={24} title="整理提示词" className="skills-modal" zIndex={230} overlayProps={{ backgroundOpacity: 0.65, blur: 3 }}>
      <p className="skills-detail-description">使用已启用的{props.modality === 'image' ? '图片' : '视频'}提示词技能整理当前内容，查看并编辑后应用到节点。</p>
      <Select className="skill-refine-model" label="文本模型" aria-label="整理提示词的文本模型" data={props.models.map(model => ({ value: model.id, label: model.name }))} value={modelId || null} onChange={value => setModelId(value || '')} placeholder="选择用于整理的文本模型" disabled={pending} allowDeselect={false} searchable />
      <p className="skills-detail-description" style={{ marginTop: 12 }}>{skills.length ? `已启用：${skills.map(skill => skill.name).join(' · ')}` : '请先在左侧“技能中心”为此提示词环节启用技能。'}</p>
      {!props.models.length && <p className="skills-modal-error">请先在模型设置中启用一个文本模型。</p>}
      {pending && <div className="skills-progress" role="status" style={{ marginTop: 16 }}><LoaderCircle size={15} />正在整理，请稍候…</div>}
      {error && <p className="skills-modal-error" role="alert">{error}</p>}
      {!!result && <div className="skill-refine-result"><Textarea aria-label="整理后的完整提示词" label="整理结果" value={result} onChange={event => setResult(event.currentTarget.value)} autosize minRows={8} maxRows={15} maxLength={maxPromptLength} /><p className="skills-detail-description">使用技能：{usedSkills.join(' · ')}</p></div>}
      {stale && <p className="skills-modal-error" role="alert">当前节点内容或生成配置已变化，请重新整理。</p>}
      <div className="skill-refine-actions"><Button variant="default" disabled={pending || !modelId || !skills.length} onClick={() => void refine()}>{result ? '重新整理' : '整理提示词'}</Button>
        {!!result && <Button disabled={pending || stale || !result.trim() || result.length > maxPromptLength} onClick={() => { props.onApply(result.trim()); close() }}>应用提示词</Button>}</div>
    </Modal>
  </>
}
