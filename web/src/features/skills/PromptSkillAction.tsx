import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { useEffect, useMemo, useRef, useState } from 'react'
import { UnstyledButton, Button, Input, Modal, Select, Switch, Textarea } from '@mantine/core'
import type { VideoPromptDiagnostics } from '@video-studio/shared/media/video-prompt-checks'
import PromptVideoChecks from './PromptVideoChecks'
import { ArrowLeft, ChevronDown, LoaderCircle, Puzzle, ShieldCheck, WandSparkles } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import { preferredModel } from '../models/model-defaults'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import type { Model } from '../../shared/api/api'
import { useCreativeSkills } from './useCreativeSkills'
import CreativeSkillSelector from './CreativeSkillSelector'
import type { SkillAssignment } from '../../shared/api/skills-api'
import type { VideoReferenceUsageSelection } from '@video-studio/shared/media/video-reference-usage'
import { extractPromptBody } from '@video-studio/shared/visuals/prompt-document'
import { VISUAL_BOARD_PRIMARY_SECTION } from '@video-studio/shared/visuals/visual-board-document'
import { type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { extractPromptReferenceIds, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import CanvasPromptEditor, { type CanvasPromptReference } from '../canvas/CanvasPromptEditor'
import { promptPreviewText } from '../canvas/canvas-prompt-preview'
import { applyPromptRefinementContent, promptRefinementContent, promptRefinementContentError, promptRefinementSource } from './prompt-refinement-scope'
import './prompt-skill-action.css'

type Props = {
  projectId: string; nodeId: string; modality: 'image' | 'video'; prompt: string; models: Model[]; disabled: boolean;
  targetModelId: string; shotId: string | null; profileId?: string; ratio: string; duration: number; mode: string;
  referenceAssetIds: string[]; onApply: (prompt: string, body?: string, document?: PromptSectionDocument) => void;
  explicitReferenceAssetIds?: string[];
  promptBody?: string; promptTemplate?: string; promptDocument?: boolean;
  visualBoard?: boolean;
  promptSections?: PromptSectionDocument; promptReferences?: CanvasPromptReference[];
  promptReferenceOverrides?: Record<string, string | null>;
  resolution?: string | null; clarity?: string | null; quality?: string | null; background?: string | null;
  storyboardReferenceAssetId?: string | null; visualReferenceMode?: string; excludedVisualProfileIds?: string[];
  videoReferenceUsages?: VideoReferenceUsageSelection[];
  inline?: boolean;
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
  { label: '梳理材质', text: '梳理已有服装、物体或建筑的材质描述，保留既定材质、身份和造型事实，不添加未设定的细节。' },
  { label: '理清视图', text: '理清已有的视图与局部展示要求，保留原有视图数量、角度和版式，不新增或删减。' }, conciseDirection,
]
export default function PromptSkillAction(props: Props) {
  const [opened, setOpened] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState('')
  const visionFallback = props.modality === 'video' && props.referenceAssetIds.length
    ? preferredModel(props.models.filter(model => model.settings?.supports_vision === true && ['responses', 'chat_completions'].includes(model.protocol)))?.id : undefined
  const { modelId, selectModel } = useSharedModelSelection('text', props.models, { locked: pending, active: opened, fallbackId: visionFallback })
  const [hasResult, setHasResult] = useState(false)
  const [resultBefore, setResultBefore] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [inspection, setInspection] = useState<'fixed' | 'preview' | null>(null)
  const [diagnostics, setDiagnostics] = useState<VideoPromptDiagnostics>()
  const [loadedFiles, setLoadedFiles] = useState<string[]>([]), [checkedResult, setCheckedResult] = useState('')
  const [referenceVision, setReferenceVision] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const stage = props.modality === 'image' ? 'image_prompt' : 'video_prompt'
  const visualBoard = !!props.visualBoard && props.modality === 'image'
  const promptDocument = !!props.promptDocument || visualBoard
  const sourceBody = extractPromptBody({ prompt: props.prompt, prompt_body: promptDocument ? undefined : props.promptBody, prompt_template: props.promptTemplate })
  const source = useMemo(() => promptRefinementSource({ prompt: props.prompt, promptBody: props.promptBody,
    promptTemplate: props.promptTemplate, promptSections: props.promptSections, visualBoard, promptDocument }),
  [props.prompt, props.promptBody, props.promptTemplate, props.promptSections, visualBoard, promptDocument])
  const sourceContent = source.content, sourceHasContent = !!sourceContent.trim() && !source.error
  const hasResultContent = !!result.trim()
  const candidateScopeError = promptRefinementContentError(result)
  const resultError = candidateScopeError || ''
  const composedResult = useMemo(() => {
    if (!hasResult || !result.trim() || candidateScopeError || source.error) return undefined
    try { return applyPromptRefinementContent(source, tokenizePromptReferenceNumbers(result, props.referenceAssetIds)) } catch { return undefined }
  }, [hasResult, result, candidateScopeError, source, props.referenceAssetIds])
  const resultPreview = composedResult?.prompt || ''
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
  const selectionSource = !policy ? '配置未读取' : assignment.source === 'automatic' ? '模型自动选择' : assignment.source === 'manual' ? '已记住的选择' : assignment.task_kind ? '按功能分配' : policy.source === 'project' ? '项目默认' : '全局默认'
  const skillName = skillControl.loading ? '正在读取技能' : skillControl.error ? '技能配置未读取' : assignment.source === 'automatic' ? '模型自动选择' : selectedIds[0] && !primary ? '技能需重新选择' : primary?.name || '基础创作规则'
  const modalityLabel = props.profileId || visualBoard ? '设定图' : props.modality === 'image' ? '图片' : '视频'
  const directions = props.profileId || visualBoard ? profileDirections : props.modality === 'video' ? videoDirections : imageDirections
  const adjustmentPlaceholder = props.profileId || visualBoard ? '例如：精简重复描述，理清已有材质与视图要求，保持原有设定。'
    : props.modality === 'video' ? '例如：前半段缓慢推进，后半段人物回头，动作自然，不增加新镜头。'
      : '例如：保留人物动作，改成近景，突出面部情绪，背景简化。'
  const nodeKey = JSON.stringify([props.projectId, props.nodeId, props.modality, props.shotId, props.profileId,
    props.prompt, sourceBody, promptDocument, visualBoard, props.promptTemplate, props.promptSections, props.ratio, props.duration, props.mode, props.resolution, props.clarity, props.quality, props.background,
    props.referenceAssetIds, props.explicitReferenceAssetIds, props.promptReferences, props.storyboardReferenceAssetId, props.promptReferenceOverrides,
    props.visualReferenceMode, props.excludedVisualProfileIds, props.videoReferenceUsages, props.targetModelId])
  const chosenModel = props.models.find(model => model.id === modelId)
  const canSeeReferences = chosenModel?.settings?.supports_vision === true && ['responses', 'chat_completions'].includes(chosenModel.protocol)
  const inspectReferences = props.modality === 'video' && referenceVision && canSeeReferences && !!props.referenceAssetIds.length
  const skillVersions = policy?.skills.filter(skill => assignment.source === 'automatic' || selectedIds.includes(skill.id))
    .map(skill => [skill.id, skill.revision])
  const currentKey = JSON.stringify([nodeKey, modelId, chosenModel, assignment.source, selectedIds, skillVersions, inspectReferences])
  const maxPromptLength = props.profileId && !promptDocument ? 16_000 : 80_000
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
  const stale = hasResult && sourceKey !== currentKey
  const nodeChanged = hasResult && sourceNodeKey !== nodeKey
  const adjustmentChanged = hasResult && adjustment.trim() !== resultAdjustment
  const continueFromResult = hasResult && !nodeChanged
  const refineLabel = hasResult ? nodeChanged ? '重新整理' : '继续整理' : error ? '继续整理' : '生成整理草稿'
  const protectedBlocks = source.document.blocks.filter(block => block.kind === 'managed' && !block.deleted
    && (!visualBoard || block.name !== VISUAL_BOARD_PRIMARY_SECTION))
  const blockingDiagnostics = !!diagnostics?.issues.some(issue => issue.severity === 'error')
  const showingForm = !hasResult || adjusting
  const showingComparison = !showingForm && !pending
  const cannotRun = pending || props.disabled || !modelId || !chosenModel || !!source.error || skillControl.loading || !!skillControl.error
    || !!adjustmentReferenceError || continueFromResult && !!candidateScopeError || !(continueFromResult ? hasResultContent : sourceHasContent)
    || adjustment.length > maxAdjustmentLength
  const cannotApply = pending || props.disabled || stale || adjustmentChanged || !hasResultContent || !!resultError || !composedResult
    || result.length > maxPromptLength || resultPreview.length > 80_000 || blockingDiagnostics
  function open() {
    setDiagnostics(undefined); setLoadedFiles([]); setCheckedResult('')
    setOpened(true); setError(''); setResult(''); setHasResult(false); setResultBefore(sourceContent); setAdjusting(false); setInspection(null); setAdjustment(''); setResultAdjustment(''); setUsedSkills([]); setUsedAssignment(undefined)
  }
  function close() { serial.current++; abort.current?.abort(); refining.current = false; setOpened(false); setPending(false); setResult(''); setHasResult(false); setResultBefore(''); setAdjusting(false); setInspection(null); setUsedSkills([]); setUsedAssignment(undefined); setError(''); setAdjustment(''); setResultAdjustment('') }
  function addDirection(text: string) {
    setAdjustment(current => {
      if (current.includes(text)) return current
      const next = [current.trim(), text].filter(Boolean).join('\n')
      return next.length <= maxAdjustmentLength ? next : current
    })
  }
  async function refine(restart = false) {
    if (refining.current || props.disabled || !modelId || !chosenModel || source.error || skillControl.loading || skillControl.error || adjustmentReferenceError || continueFromResult && candidateScopeError) return
    const prompt = (continueFromResult ? promptDocument ? composedResult?.prompt || '' : result : promptDocument ? props.prompt : sourceContent).trim()
    const body = promptDocument ? extractPromptBody({ prompt }) : prompt
    if (!prompt || prompt.length > 80_000 || adjustment.length > maxAdjustmentLength) return
    refining.current = true
    const turn = ++serial.current, capturedKey = currentKey, capturedNodeKey = nodeKey, capturedAdjustment = adjustment.trim()
    if (!continueFromResult) setResultBefore(sourceContent)
    setElapsed(0)
    setPending(true); setError(''); abort.current = new AbortController()
    try {
      const response = await api<{ prompt: string; prompt_body?: string; reference_asset_ids?: string[]; skills: Array<{ name: string }>; skill_assignment?: SkillAssignment; loaded_files?: string[]; diagnostics?: VideoPromptDiagnostics }>(`/projects/${props.projectId}/skills/refine-prompt`, {
        ...json('POST', { ...(restart ? { restart: true } : {}), stage, skill_ids: skillControl.requestIds(stage), model_id: modelId, prompt, prompt_body: body,
          ...(promptDocument ? { prompt_document: true } : {}),
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
      const responsePrompt = promptDocument ? tokenizePromptReferenceNumbers(response.prompt, response.reference_asset_ids ?? props.referenceAssetIds)
        : extractPromptBody({ prompt: response.prompt, prompt_body: response.prompt_body })
      const nextResult = promptRefinementContent(responsePrompt, visualBoard)
      if (!nextResult.trim()) throw new Error('整理结果缺少主要创作内容，请重新整理。')
      setResult(nextResult); setHasResult(true); setAdjusting(false)
      setUsedAssignment(response.skill_assignment)
      setDiagnostics(response.diagnostics); setLoadedFiles(response.loaded_files || []); setCheckedResult(nextResult)
      setSourceKey(capturedKey); setSourceNodeKey(capturedNodeKey); setResultAdjustment(capturedAdjustment); setUsedSkills(response.skills.map(skill => skill.name))
    } catch (issue) { if (turn === serial.current) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (turn === serial.current) { refining.current = false; setPending(false) } }
  }
  const content = <>
    <div className="prompt-skill-content">
      {pending ? <section className="prompt-skill-running" role="status" aria-live="polite">
        <LoaderCircle size={28} /><strong>正在整理正文…</strong><span>{elapsed} 秒 · 当前正文尚未更改</span>
      </section> : <>
        {showingForm ? <>
          <section className="prompt-skill-adjustment" aria-label="提示词调整方向">
            <Input.Wrapper label={<>{hasResult ? '继续调整要求' : '本次调整要求'}<span className="prompt-skill-optional">可选</span></>}>
              <CanvasPromptEditor aria-label="本次调整要求" value={adjustment} onChange={setAdjustment} compact
                references={adjustmentReferences} choices={adjustmentChoices} minRows={3} maxLength={maxAdjustmentLength}
                placeholder={`${adjustmentPlaceholder} 输入 @ 引用图片。`} />
            </Input.Wrapper>
            <div className="prompt-skill-directions" role="group" aria-label={`${modalityLabel}调整快捷方向`}>
              {directions.map(direction => <Button key={direction.label} variant="default" size="compact-xs" aria-pressed={adjustment.includes(direction.text)}
                disabled={!adjustment.includes(direction.text) && adjustment.trim().length + direction.text.length + 1 > maxAdjustmentLength}
                onClick={() => addDirection(direction.text)}>{direction.label}</Button>)}
            </div>
            <div className="prompt-skill-adjustment-hint"><span>{continueFromResult ? '以当前草稿继续，最初正文保留用于对照。' : '输入 @ 可引用当前参考图'}</span><small>{adjustment.length.toLocaleString()} / 4,000</small></div>
            {adjustmentReferenceError && <p className="prompt-skill-error" role="alert">{adjustmentReferenceError}</p>}
          </section>
          <div className="prompt-skill-support">
            <WorkspaceDisclosure className="prompt-skill-source" label={<><span>{continueFromResult ? '查看当前草稿' : '查看当前正文'}</span><small>{(continueFromResult ? result : sourceContent).length.toLocaleString()} 字</small></>}>
              <p>{continueFromResult ? result : sourceContent}</p>
            </WorkspaceDisclosure>
            <section className="prompt-skill-context" aria-label="本次整理范围">
              <span><ShieldCheck size={14} />{protectedBlocks.length ? `${protectedBlocks.length} 项固定设定` : '保留既定事实与展示要求'}</span>
              {!!protectedBlocks.length && <Button variant="subtle" size="compact-xs" onClick={() => setInspection('fixed')}>查看</Button>}
            </section>
          </div>
      <WorkspaceDisclosure className="prompt-skill-configuration" label={<><span>整理配置</span><small>{chosenModel?.name || '选择文本模型'} · {skillName}</small></>}>
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
            value={modelId || null} onChange={value => selectModel(value || '')} placeholder="选择用于整理的文本模型"
            disabled={pending} allowDeselect={false} searchable rightSection={<ChevronDown size={14} />} rightSectionPointerEvents="none"
            classNames={{ input: 'prompt-skill-model-input', dropdown: 'prompt-skill-dropdown' }} comboboxProps={{ zIndex: 420 }} />
          {props.modality === 'video' && !!props.referenceAssetIds.length && <Switch label="参考图视觉诊断"
            description={canSeeReferences ? '查看实际参考图，诊断拼版、姿势与动作空间；一次最多查看前八张，其余会标为未查看。' : '当前模型仅依据文字整理。选择支持图片理解的模型后可开启。'}
            checked={inspectReferences} disabled={pending || !canSeeReferences} onChange={event => setReferenceVision(event.currentTarget.checked)} />}
        </div>
      </WorkspaceDisclosure>
        </> : <section className="prompt-skill-result" aria-label="正文对照">
          <div className="prompt-skill-comparison">
            <Textarea aria-label="整理前的主要内容" label="整理前" value={resultBefore} readOnly autosize minRows={8} maxRows={18}
              classNames={{ input: 'prompt-skill-before' }} />
            <Input.Wrapper label="整理后 · 草稿">
              <CanvasPromptEditor aria-label="整理后的主要内容" value={result} onChange={setResult} compact
                references={resultReferences} choices={resultReferences} minRows={8} maxLength={maxPromptLength} />
            </Input.Wrapper>
          </div>
          <section className="prompt-skill-context" aria-label="本次整理范围">
            <span><ShieldCheck size={14} />{protectedBlocks.length ? `${protectedBlocks.length} 项固定设定保持不变` : '保留既定事实与展示要求'}</span>
            {!!protectedBlocks.length && <Button variant="subtle" size="compact-xs" onClick={() => setInspection('fixed')}>查看</Button>}
          </section>
          {resultError && <p className="prompt-skill-error" role="alert">{resultError}</p>}
          {(result.length > maxPromptLength || resultPreview.length > 80_000) && <p className="prompt-skill-error" role="alert">提示词超过 {maxPromptLength.toLocaleString()} 字，请精简后应用。</p>}
          {resultAdjustment && <p className="prompt-skill-used">本次要求：{resultAdjustment}</p>}
          <div className="prompt-skill-result-meta"><p className="prompt-skill-used">使用技能：{usedSkills.join(' · ') || '基础创作规则'}</p>
            <Button variant="subtle" size="compact-xs" disabled={!composedResult} onClick={() => setInspection('preview')}>完整提示词预览</Button>
          </div>
          {usedAssignment?.reason && <p className="prompt-skill-used">选择理由：{usedAssignment.reason}</p>}
          {blockingDiagnostics && <p className="prompt-skill-error" role="alert">内容核对发现未解决的问题，请继续调整并重新核对后再应用。</p>}
          {(diagnostics || loadedFiles.length > 0) && <WorkspaceDisclosure className="prompt-skill-checks" label="查看内容核对与加载资料">
            <PromptVideoChecks diagnostics={diagnostics} files={loadedFiles} edited={!!checkedResult && checkedResult !== result} stale={stale || adjustmentChanged} />
          </WorkspaceDisclosure>}
        </section>}
        {!props.models.length && <p className="prompt-skill-error">请先在模型设置中启用一个文本模型。</p>}
        {source.error && <p className="prompt-skill-error" role="alert">{source.error}</p>}
        {skillControl.error && <p className="prompt-skill-error" role="alert">{skillControl.error}</p>}
        {error && <p className="prompt-skill-error" role="alert">{error}</p>}
        {nodeChanged && <p className="prompt-skill-error" role="alert">当前正文、固定设定、参考图或生成配置已变化，旧草稿不能应用。请重新整理。</p>}
        {stale && !nodeChanged && <p className="prompt-skill-adjustment-notice" role="status">文本模型或技能已变化，旧草稿不能应用。请继续调整生成新草稿。</p>}
        {adjustmentChanged && !stale && <p className="prompt-skill-adjustment-notice" role="status">调整要求已变化，旧草稿不能应用。请继续调整生成新草稿。</p>}
      </>}
    </div>
    <div className="prompt-skill-footer">
      <span className="prompt-skill-status">{pending ? '取消不会更改当前正文' : showingForm ? hasResult ? '原始正文保留用于对照' : '先看草稿，再决定是否应用' : `尚未应用 · ${result.length.toLocaleString()} 字`}</span>
      <div className="prompt-skill-actions">
        {error && <Button variant="subtle" disabled={cannotRun} onClick={() => void refine(true)}>重新生成</Button>}
        {hasResult && adjusting && !pending
          ? <Button variant="default" onClick={() => { setAdjustment(resultAdjustment); setAdjusting(false) }}>返回对照</Button>
          : <Button variant="default" onClick={close}>取消</Button>}
        {pending ? <Button disabled>正在整理</Button> : showingForm
          ? <Button className="prompt-skill-primary-action" disabled={cannotRun} onClick={() => void refine()}>{refineLabel}</Button>
          : <>
            <Button variant="default" disabled={props.disabled || !nodeChanged && (!hasResultContent || !!candidateScopeError)} onClick={() => { setError(''); setAdjusting(true) }}>{nodeChanged ? '重新整理' : '继续调整'}</Button>
            <Button className="prompt-skill-apply" disabled={cannotApply}
              onClick={() => { if (cannotApply || !composedResult) return; props.onApply(composedResult.prompt, composedResult.body, composedResult.document); close() }}>应用正文</Button>
          </>}
      </div>
    </div>
  </>
  const inspectedContent = inspection === 'fixed' ? <div className="prompt-skill-inspection">
    {protectedBlocks.map(block => <section key={block.id}><h3>{block.name}</h3><pre>{block.text.replace(/^【[^】]+】\s*/, '').replace(/\s*【[^】]+结束】$/, '')}</pre></section>)}
  </div> : <div className="prompt-skill-inspection"><pre>{promptPreviewText(resultPreview)}</pre></div>
  return <div className="prompt-skill-action nodrag nowheel" data-canvas-overlay
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
    <UnstyledButton type="button" className="pc-composer-chip prompt-skill-trigger" aria-label="使用技能整理提示词"
      aria-haspopup="dialog" aria-expanded={opened} disabled={props.disabled || !sourceHasContent} onClick={open}>
      <WandSparkles size={14} /><span>整理提示词</span>
    </UnstyledButton>
    <Modal opened={opened} onClose={() => inspection ? setInspection(null) : close()} centered
      size={`min(${inspection === 'fixed' || !inspection && !showingComparison ? 680 : 920}px, calc(100vw - 32px))`} radius={14} zIndex={400}
      title={<div className="prompt-skill-heading"><span>{inspection === 'fixed' ? '固定设定' : inspection === 'preview' ? '完整提示词' : showingComparison ? '整理结果' : '整理提示词'}</span>
        <small>{inspection ? '只读查看' : showingComparison ? '草稿可编辑，确认后应用到正文' : '润色正文表达，保留既定事实和展示要求'}</small></div>}
      classNames={{ content: `prompt-skill-modal${showingComparison && !inspection ? ' is-comparison' : ''}`, header: 'prompt-skill-header', title: 'prompt-skill-title', body: 'prompt-skill-body', close: 'prompt-skill-close' }}
      overlayProps={{ backgroundOpacity: 0.6, blur: 4 }} closeButtonProps={{ 'aria-label': inspection ? '返回整理提示词' : '关闭整理主要内容' }}>
      <div className="prompt-skill-stage" hidden={!!inspection}>{content}</div>
      {inspection && <>{inspectedContent}<div className="prompt-skill-footer"><span className="prompt-skill-status">固定设定不参与正文改写</span>
        <Button variant="default" leftSection={<ArrowLeft size={14} />} onClick={() => setInspection(null)}>返回整理</Button></div></>}
    </Modal>
  </div>
}
