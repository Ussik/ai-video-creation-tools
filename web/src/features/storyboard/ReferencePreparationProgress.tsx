import { useId, useState } from 'react'
import { Button, Loader, Select } from '@mantine/core'
import type { CanvasPreparationRecovery, Model } from '@video-studio/shared/api/contracts'

type UnitProgress = { label: string; completed_units: number; total_units: number | null }
function valid(progress?: UnitProgress): progress is UnitProgress {
  return !!progress?.label && Number.isSafeInteger(progress.completed_units) && progress.completed_units >= 0
    && (progress.total_units === null || Number.isSafeInteger(progress.total_units) && progress.total_units >= progress.completed_units)
}
export const preparationCount = (progress: UnitProgress) => `已完成 ${progress.completed_units}${progress.total_units === null ? '' : `/${progress.total_units}`}`

/** A phase counter describes that phase only, never the whole canvas workflow. */
export function ReferencePreparationProgress({ capabilities, activity, preparing }: {
  capabilities?: CanvasPreparationRecovery; activity?: string; preparing?: boolean
}) {
  const id = useId(), [expanded, setExpanded] = useState(false)
  const serverPhase = !activity || preparing
  const progress = serverPhase && valid(capabilities?.inspection?.progress) ? capabilities.inspection.progress : undefined
  const history = (capabilities?.inspection?.steps || []).filter(valid)
  return <>
    <div className="reference-current-step" aria-label="当前步骤">
      <Loader size={16} aria-hidden="true" />
      <div><span>{progress?.label || activity || '等待服务端更新当前步骤'}</span>
        {progress && <span className="reference-progress-count">{preparationCount(progress)}</span>}
      </div>
    </div>
    {history.length > 1 && <div className="reference-step-history">
      <Button variant="subtle" size="compact-xs" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>步骤记录（{history.length}）</Button>
      {expanded && <ul id={id}>{history.map(step => <li key={step.phase_id}><span>{step.label}</span><span>{preparationCount(step)}</span></li>)}</ul>}
    </div>}
  </>
}

/** Both canvas entry points use the persisted run model while work is active. */
export function ReferencePreparationModel({ working, capabilities, models, modelId, onChange, disabled, label, dropdownZIndex = 350 }: {
  working: boolean; capabilities?: CanvasPreparationRecovery; models: Model[]; modelId: string; onChange: (id: string) => void
  disabled?: boolean; label: string; dropdownZIndex?: number
}) {
  const eligible = models.filter(model => model.modality === 'text' && model.enabled)
  if (working) {
    const runModel = capabilities?.state === 'running' ? capabilities.model_id : modelId
    const name = models.find(model => model.id === runModel)?.name
    return <p className="reference-preparation-model"><span>模型</span><span>{name || (runModel ? '当前运行模型' : '等待服务端确认')}</span></p>
  }
  return <Select label={label} aria-label="整理参考设定文本模型" data={eligible.map(model => ({value:model.id,label:model.name}))}
    value={modelId || null} allowDeselect={false} disabled={disabled} onChange={value => { if (value) onChange(value) }} comboboxProps={{zIndex:dropdownZIndex}} />
}
