import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { useEffect, useRef, useState } from 'react'
import { UnstyledButton, Button, Input, Modal, Select, Switch, Textarea } from '@mantine/core'
import type { VideoPromptDiagnostics } from '@video-studio/shared/media/video-prompt-checks'
import PromptVideoChecks from './PromptVideoChecks'
import { ChevronDown, LoaderCircle, Puzzle } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import { preferredModel } from '../models/model-defaults'
import type { Model } from '../../shared/api/api'
import { useCreativeSkills } from './useCreativeSkills'
import CreativeSkillSelector from './CreativeSkillSelector'
import type { SkillAssignment } from '../../shared/api/skills-api'
import type { VideoReferenceUsageSelection } from '@video-studio/shared/media/video-reference-usage'
import { extractPromptBody, getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { parsePromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { extractPromptReferenceIds, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import CanvasPromptEditor, { type CanvasPromptReference } from '../canvas/CanvasPromptEditor'
import './prompt-skill-action.css'

type Props = {
  projectId: string; nodeId: string; modality: 'image' | 'video'; prompt: string; models: Model[]; disabled: boolean;
  targetModelId: string; shotId: string | null; profileId?: string; ratio: string; duration: number; mode: string;
  referenceAssetIds: string[]; onApply: (prompt: string, body?: string, document?: PromptSectionDocument) => void;
  explicitReferenceAssetIds?: string[];
  promptBody?: string; promptTemplate?: string; promptDocument?: boolean;
  promptSections?: PromptSectionDocument; promptReferences?: CanvasPromptReference[];
  promptReferenceOverrides?: Record<string, string | null>;
  resolution?: string | null; clarity?: string | null; quality?: string | null; background?: string | null;
  storyboardReferenceAssetId?: string | null; visualReferenceMode?: string; excludedVisualProfileIds?: string[];
  videoReferenceUsages?: VideoReferenceUsageSelection[];
}
const maxAdjustmentLength = 4_000
const conciseDirection = { label: '精简描述', text: '精简重复和空泛描述，保留关键事实、画面要求和逐字对白。' }
const imageDirections = [
  { label: '加强构图', text: '加强主体位置、景别和画面层次，保持原有剧情与人物动作。' },
  { label: '突出情绪', text: '细化表情、视线和光线对情绪的表达，保持人物身份和原有情境。' }, conciseDirection,
]
const videoDirections = [
  { label: '细化动作', text: '细化动作先后和衔接，让动作在当前时长内自然完成，保留原有事件和对白。' },
  { label: '优化运镜', text: '明确机位、镜头运动和节奏，保持单个镜头连续，不增加新镜头。' }, conciseDirection,
]
const profileDirections = [
  { label: '细化材质', text: '细化已有服装、物体或建筑的材质与关键细节，保持设定身份和造型特征。' },
  { label: '补充视图', text: '按照已有设定的视图要求，明确各视角和局部细节的展示，保持同一对象一致。' }, conciseDirection,
]
export default function PromptSkillAction(props: Props) {
  const [opened, setOpened] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  const [modelId, setModelId] = useState(''), [result, setResult] = useState('')
  const [resultSystemPrompt, setResultSystemPrompt] = useState('')
  const [diagnostics, setDiagnostics] = useState<VideoPromptDiagnostics>()
  const [loadedFiles, setLoadedFiles] = useState<string[]>([]), [checkedResult, setCheckedResult] = useState('')
  const [referenceVision, setReferenceVision] = useState(true)
  const [resultSections, setResultSections] = useState<PromptSectionDocument>()
  const [elapsed, setElapsed] = useState(0), [requestLabel, setRequestLabel] = useState('整理提示词')
  const stage = props.modality === 'image' ? 'image_prompt' : 'video_prompt'
  const sourceBody = extractPromptBody({ prompt: props.prompt, prompt_body: props.promptDocument ? undefined : props.promptBody, prompt_template: props.promptTemplate })
  const resultPreview = [result, resultSystemPrompt].filter(Boolean).join('\n\n')
  const [sourceKey, setSourceKey] = useState(''), [usedSkills, setUsedSkills] = useState<string[]>([])
  const [usedAssignment, setUsedAssignment] = useState<SkillAssignment>()
  const [sourceNodeKey, setSourceNodeKey] = useState('')
  const [adjustment, setAdjustment] = useState(''), [resultAdjustment, setResultAdjustment] = useState('')
  const skillControl = useCreativeSkills(props.projectId, opened, { rememberSelections: true })
  const refining = useRef(false)
  const serial = useRef(0), abort = useRef<AbortController | null>(null)
  useEffect(() => () => { serial.current++; abort.current?.abort() }, [])
  useEffect(() => {
    if (!pending) return
    const started = Date.now(), timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  const selectedIds = skillControl.ids(stage), policy = skillControl.policies.find(item => item.stage === stage)
  const primary = policy?.skills.find(skill => skill.id === selectedIds[0])
  const assignment = skillControl.selection(stage)
  const selectionSource = !policy ? '配置未读取' : assignment.source === 'automatic' ? '模型自动选择' : assignment.source === 'manual' ? '已记住的选择' : policy.source === 'project' ? '项目默认' : '全局默认'
  const skillName = skillControl.loading ? '正在读取技能' : skillControl.error ? '技能配置未读取' : assignment.source === 'automatic' ? '模型自动选择' : selectedIds[0] && !primary ? '技能需重新选择' : primary?.name || '基础创作规则'
  const modalityLabel = props.profileId ? '设定图' : props.modality === 'image' ? '图片' : '视频'
  const directions = props.profileId ? profileDirections : props.modality === 'video' ? videoDirections : imageDirections
  const adjustmentPlaceholder = props.profileId ? '例如：突出服装材质和配饰细节，减少环境描述。'
    : props.modality === 'video' ? '例如：前半段缓慢推进，后半段人物回头，动作自然，不增加新镜头。'
      : '例如：保留人物动作，改成近景，突出面部情绪，背景简化。'
  const nodeKey = JSON.stringify([props.projectId, props.nodeId, props.modality, props.shotId, props.profileId,
    props.prompt, sourceBody, props.promptDocument, props.promptTemplate, props.promptSections, props.ratio, props.duration, props.mode, props.resolution, props.clarity, props.quality, props.background,
    props.referenceAssetIds, props.explicitReferenceAssetIds, props.promptReferences, props.storyboardReferenceAssetId, props.promptReferenceOverrides,
    props.visualReferenceMode, props.excludedVisualProfileIds, props.videoReferenceUsages, props.targetModelId])
  const chosenModel = props.models.find(model => model.id === modelId)
  const canSeeReferences = chosenModel?.settings?.supports_vision === true && ['responses', 'chat_completions'].includes(chosenModel.protocol)
  const inspectReferences = props.modality === 'video' && referenceVision && canSeeReferences && !!props.referenceAssetIds.length
  const currentKey = JSON.stringify([nodeKey, modelId, assignment.source, selectedIds, inspectReferences])
  const maxPromptLength = props.profileId && !props.promptDocument ? 16_000 : 80_000
  const referenceMetadata = new Map(props.promptReferences?.map(reference => [reference.assetId, reference]))
  const resultReferences = props.referenceAssetIds.map((assetId, index) => referenceMetadata.get(assetId)
    ?? { assetId, label: `参考图 ${index + 1}`, url: `/api/assets/${assetId}/file` })
  const adjustmentReferences = [...resultReferences, ...(props.promptReferences || []).filter(reference => !props.referenceAssetIds.includes(reference.assetId))]
    .map(reference => ({ ...reference, required: false, invalid: !!reference.invalid || !props.referenceAssetIds.includes(reference.assetId) }))
  const adjustmentChoices = adjustmentReferences.filter(reference => !reference.invalid)
  let adjustmentReferenceError = ''
  try {
    const invalidIds = extractPromptReferenceIds(adjustment).filter(assetId => !adjustmentChoices.some(reference => reference.assetId === assetId))
    if (invalidIds.length) adjustmentReferenceError = `调整要求中的图片引用已失效：${invalidIds.map(assetId => referenceMetadata.get(assetId)?.label || '引用图片').join('、')}。请重新选择或移除后整理。`
  } catch { adjustmentReferenceError = '调整要求中存在无效的图片引用，请重新选择或移除后整理。' }
  const stale = !!result && sourceKey !== currentKey
  const nodeChanged = !!result && sourceNodeKey !== nodeKey
  const adjustmentChanged = !!result && adjustment.trim() !== resultAdjustment
  const continueFromResult = !!result.trim() && !nodeChanged
  const refineLabel = result ? nodeChanged ? '重新整理' : '继续调整' : '整理提示词'
  function open() {
    setDiagnostics(undefined); setLoadedFiles([]); setCheckedResult('')
    setOpened(true); setError(''); setResult(''); setResultSections(undefined); setResultSystemPrompt(''); setAdjustment(''); setResultAdjustment(''); setUsedSkills([]); setUsedAssignment(undefined)
    setModelId(previous => props.models.some(model => model.id === previous) ? previous
      : (props.modality === 'video' && props.referenceAssetIds.length ? preferredModel(props.models.filter(model => model.settings?.supports_vision === true && ['responses', 'chat_completions'].includes(model.protocol)))?.id : '') || preferredModel(props.models)?.id || '')
  }
  function close() { serial.current++; abort.current?.abort(); refining.current = false; setOpened(false); setPending(false); setResult(''); setResultSections(undefined); setResultSystemPrompt(''); setUsedSkills([]); setUsedAssignment(undefined); setError(''); setAdjustment(''); setResultAdjustment('') }
  function addDirection(text: string) {
    setAdjustment(current => {
      if (current.includes(text)) return current
      const next = [current.trim(), text].filter(Boolean).join('\n')
      return next.length <= maxAdjustmentLength ? next : current
    })
  }
  async function refine() {
    if (refining.current || props.disabled || !modelId || skillControl.loading || skillControl.error || adjustmentReferenceError) return
    const prompt = continueFromResult ? result.trim() : (props.promptDocument ? props.prompt : sourceBody).trim()
    const body = props.promptDocument ? extractPromptBody({ prompt }) : prompt
    if (!prompt || prompt.length > 80_000 || adjustment.length > maxAdjustmentLength) return
    refining.current = true
    const turn = ++serial.current, capturedKey = currentKey, capturedNodeKey = nodeKey, capturedAdjustment = adjustment.trim()
    setRequestLabel(refineLabel); setElapsed(0)
    setPending(true); setError(''); abort.current = new AbortController()
    try {
      const response = await api<{ prompt: string; prompt_body?: string; reference_asset_ids?: string[]; skills: Array<{ name: string }>; skill_assignment?: SkillAssignment; loaded_files?: string[]; diagnostics?: VideoPromptDiagnostics }>(`/projects/${props.projectId}/skills/refine-prompt`, {
        ...json('POST', { stage, skill_ids: skillControl.requestIds(stage), model_id: modelId, prompt, prompt_body: body,
          ...(props.promptDocument ? { prompt_document: true } : {}),
          prompt_template: props.promptTemplate, adjustment_request: capturedAdjustment, target_model_id: props.targetModelId || null, shot_id: props.shotId,
          profile_id: props.profileId, ratio: props.ratio, duration: props.duration, mode: props.mode, reference_asset_ids: props.referenceAssetIds,
          ...(props.explicitReferenceAssetIds?.length ? { explicit_reference_asset_ids: props.explicitReferenceAssetIds } : {}),
          prompt_reference_overrides: props.promptReferenceOverrides,
          resolution: props.resolution, clarity: props.clarity, quality: props.quality, background: props.background,
          visual_reference_mode: props.visualReferenceMode, excluded_visual_profile_ids: props.excludedVisualProfileIds || [],
          ...(props.modality === 'video' ? { check_video_content: true, analyze_reference_images: inspectReferences,
            storyboard_reference_asset_id: props.storyboardReferenceAssetId || null,
            video_reference_usages: props.mode === 'reference' ? props.videoReferenceUsages || [] : [] } : {}) }), signal: abort.current.signal,
      })
      if (turn !== serial.current) return
      const nextResult = props.promptDocument ? tokenizePromptReferenceNumbers(response.prompt, response.reference_asset_ids ?? props.referenceAssetIds)
        : extractPromptBody({ prompt: response.prompt, prompt_body: response.prompt_body })
      setResult(nextResult)
      setUsedAssignment(response.skill_assignment)
      setDiagnostics(response.diagnostics); setLoadedFiles(response.loaded_files || []); setCheckedResult(nextResult)
      setResultSections(props.promptDocument ? parsePromptSectionDocument(nextResult, {
        sourceText: props.promptTemplate, previousDocument: continueFromResult ? resultSections : props.promptSections,
      }) : undefined)
      setResultSystemPrompt(props.promptDocument ? '' : getManagedPromptBlocks(response.prompt).join('\n\n'));
      setSourceKey(capturedKey); setSourceNodeKey(capturedNodeKey); setResultAdjustment(capturedAdjustment); setUsedSkills(response.skills.map(skill => skill.name))
    } catch (issue) { if (turn === serial.current) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (turn === serial.current) { refining.current = false; setPending(false) } }
  }
  return <>
    <UnstyledButton type="button" className="pc-composer-chip" aria-label="使用技能整理提示词" disabled={props.disabled || !sourceBody.trim()} onClick={() => void open()}><Puzzle size={14} /><span>整理提示词</span></UnstyledButton>
    <Modal opened={opened} onClose={close} centered size="min(620px, calc(100vw - 32px))" radius={18}
      title={<div className="prompt-skill-heading"><span>整理提示词</span><small>{modalityLabel}正文 · 编辑后应用到节点</small></div>} zIndex={230}
      classNames={{ content: 'prompt-skill-modal', header: 'prompt-skill-header', title: 'prompt-skill-title', body: 'prompt-skill-body', close: 'prompt-skill-close' }}
      overlayProps={{ backgroundOpacity: 0.6, blur: 4 }} closeButtonProps={{ 'aria-label': '关闭整理提示词' }}>
      <div className="prompt-skill-content">
        <section className="prompt-skill-card" aria-label={`本次${modalityLabel}提示词技能`}>
          <header><span>本次{modalityLabel}提示词技能</span><small>{selectionSource}</small></header>
          <div className="prompt-skill-selection"><div className="prompt-skill-primary"><Puzzle size={16} /><strong>{skillName}</strong></div>
            <CreativeSkillSelector stage={stage} policies={skillControl.policies} ids={selectedIds}
              selection={assignment} onUseAutomatic={() => skillControl.useAutomatic(stage)}
              onChange={values => skillControl.change(stage, values)} projectId={props.projectId} disabled={pending}
              loading={skillControl.loading} error={skillControl.error} onDefaultsChanged={() => skillControl.reload(stage)}
              onRetry={() => skillControl.reload(stage, { keepSelection: true })} appearance="prompt" triggerLabel="更换" />
          </div>
          {assignment.source !== 'automatic' && <p>{selectedIds.length ? '主技能' : '使用内置规则'}<span>·</span>辅助技能 {Math.max(0, selectedIds.length - 1)} 个</p>}
          <p>{assignment.reason}</p>
        </section>
        <div className="prompt-skill-settings">
          <Select label="文本模型" aria-label="整理提示词的文本模型" data={props.models.map(model => ({ value: model.id, label: model.name }))}
            value={modelId || null} onChange={value => setModelId(value || '')} placeholder="选择用于整理的文本模型"
            disabled={pending} allowDeselect={false} searchable rightSection={<ChevronDown size={14} />} rightSectionPointerEvents="none"
            classNames={{ input: 'prompt-skill-model-input', dropdown: 'prompt-skill-dropdown' }} comboboxProps={{ zIndex: 320 }} />
          {props.modality === 'video' && !!props.referenceAssetIds.length && <Switch label="参考图视觉诊断"
            description={canSeeReferences ? '查看实际参考图，诊断拼版、姿势与动作空间；一次最多查看前八张，其余会标为未查看。' : '当前模型仅依据文字整理。选择支持图片理解的模型后可开启。'}
            checked={inspectReferences} disabled={pending || !canSeeReferences} onChange={event => setReferenceVision(event.currentTarget.checked)} />}
        </div>
        <WorkspaceDisclosure className="prompt-skill-source" label={<><span>原始提示词正文</span><small>{sourceBody.length.toLocaleString()} 字</small><ChevronDown size={14} /></>}>
          <p>{sourceBody}</p>
        </WorkspaceDisclosure>
        <section className="prompt-skill-adjustment" aria-label="提示词调整方向">
          <Input.Wrapper label="本次调整要求" description="输入 @ 选择当前已生效的参考图，并写明人物、参考用途和画面变化。设定、画风和生成参数按节点设置保留。">
            <CanvasPromptEditor aria-label="本次调整要求" value={adjustment} onChange={setAdjustment} compact
              references={adjustmentReferences} choices={adjustmentChoices} disabled={pending} minRows={3} maxLength={maxAdjustmentLength}
              placeholder={`${adjustmentPlaceholder} 输入 @ 引用图片。`} />
          </Input.Wrapper>
          <div className="prompt-skill-directions" role="group" aria-label={`${modalityLabel}调整快捷方向`}>
            {directions.map(direction => <Button key={direction.label} variant="default" size="compact-xs" aria-pressed={adjustment.includes(direction.text)}
              disabled={pending || !adjustment.includes(direction.text) && adjustment.trim().length + direction.text.length + 1 > maxAdjustmentLength}
              onClick={() => addDirection(direction.text)}>{direction.label}</Button>)}
          </div>
          <div className="prompt-skill-adjustment-hint"><span>{continueFromResult ? '继续调整将以当前整理结果为基础。' : '只调整指定部分，其余内容尽量保留。'}</span><small>{adjustment.length.toLocaleString()} / 4,000</small></div>
          {adjustmentReferenceError && <p className="prompt-skill-error" role="alert">{adjustmentReferenceError}</p>}
        </section>
        {!props.models.length && <p className="prompt-skill-error">请先在模型设置中启用一个文本模型。</p>}
        {skillControl.error && <p className="prompt-skill-error" role="alert">{skillControl.error}</p>}
        {error && <p className="prompt-skill-error" role="alert">{error}</p>}
        {!!result && <div className="prompt-skill-result">
          {props.promptDocument ? <><label className="mantine-InputWrapper-label">整理后的完整提示词 · 可编辑</label>
            <CanvasPromptEditor aria-label="整理后的完整提示词" value={result} sectionDocument={resultSections}
              onChange={(value, document) => { setResult(value); setResultSections(document) }}
              references={resultReferences} choices={resultReferences} disabled={pending} minRows={10} />
            {result.length > maxPromptLength && <p className="prompt-skill-error" role="alert">提示词超过 80,000 字，请精简后应用。</p>}</>
            : <Textarea aria-label="整理后的正文" label="整理后的正文 · 可编辑" value={result} onChange={event => setResult(event.currentTarget.value)} rows={10} disabled={pending}
              maxLength={maxPromptLength} classNames={{ input: 'prompt-skill-editor' }} />}
          {!props.promptDocument && <WorkspaceDisclosure label="完整提示词预览"><Textarea aria-label="整理后的完整提示词预览" value={resultPreview} readOnly autosize minRows={4} maxRows={12} /></WorkspaceDisclosure>}
          <p className="prompt-skill-used">使用技能：{usedSkills.join(' · ') || '基础创作规则'}</p>
          {usedAssignment?.reason && <p className="prompt-skill-used">选择理由：{usedAssignment.reason}</p>}
          <PromptVideoChecks diagnostics={diagnostics} files={loadedFiles} edited={!!checkedResult && checkedResult !== result} stale={nodeChanged} />
        </div>}
        {nodeChanged && <p className="prompt-skill-error" role="alert">当前节点内容或生成配置已变化，请重新整理。</p>}
        {stale && !nodeChanged && <p className="prompt-skill-adjustment-notice" role="status">文本模型或技能已变化，请点击「继续调整」后应用，当前结果将保留为调整基稿。</p>}
        {adjustmentChanged && !stale && <p className="prompt-skill-adjustment-notice" role="status">调整要求已变化，请点击「继续调整」生成新结果后应用。</p>}
      </div>
      <div className="prompt-skill-footer">
        {pending ? <div className="prompt-skill-progress" role="status"><LoaderCircle size={14} /><span>正在整理 · {elapsed} 秒</span></div>
          : <span className="prompt-skill-status">{result ? `已整理 · ${result.length.toLocaleString()} 字` : '确认应用后更新节点'}</span>}
        <div className="prompt-skill-actions"><Button variant="default" disabled={pending || props.disabled || !modelId || skillControl.loading || !!skillControl.error || !!adjustmentReferenceError || !(continueFromResult ? result : sourceBody).trim() || adjustment.length > maxAdjustmentLength} onClick={() => void refine()}>{pending ? requestLabel : refineLabel}</Button>
        {!!result && <Button className="prompt-skill-apply" disabled={pending || props.disabled || stale || adjustmentChanged || !result.trim() || result.length > maxPromptLength} onClick={() => { props.onApply(resultPreview.trim(), props.promptDocument ? extractPromptBody({ prompt: result }) : result.trim(), resultSections); close() }}>应用提示词</Button>}</div>
      </div>
    </Modal>
  </>
}
