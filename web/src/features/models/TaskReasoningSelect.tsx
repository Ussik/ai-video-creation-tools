import { useEffect, useState } from 'react'
import { Select } from '@mantine/core'
import { taskReasoningOptions, type TaskReasoningChoice } from '@video-studio/shared/models/task-reasoning'
import type { Model } from '../../shared/api/api'

export type ReasoningModel = Pick<Model, 'id' | 'protocol' | 'settings' | 'task_reasoning_options'>
const labels: Record<TaskReasoningChoice, string> = {
  inherit: '跟随模型', auto: '跟随模型', fixed: '固定预算', off: '关闭', minimal: '极低',
  low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
}

export function taskReasoningLabel(value: TaskReasoningChoice) { return labels[value] }

export function useTaskReasoning(model: ReasoningModel | undefined) {
  const [selection, setSelection] = useState<{ modelId: string; value: TaskReasoningChoice }>()
  const available = model?.task_reasoning_options ?? (model?.settings && model.protocol ? taskReasoningOptions(model.settings, model.protocol) : [])
  const selected = selection && selection.modelId === model?.id && available.some(option => option.value === selection.value)
  const value = selected ? selection.value : 'inherit'
  useEffect(() => { if (selection && !selected) setSelection(undefined) }, [selection, selected])
  return {
    value,
    choices: [{ value: 'inherit', label: labels.inherit }, ...available.map(option => ({ value: option.value,
      label: 'budget_tokens' in option && option.budget_tokens ? `固定 · ${option.budget_tokens} tokens` : labels[option.value] }))],
    select: (value: string | null) => setSelection(model && available.some(option => option.value === value)
      ? { modelId: model.id, value: value as TaskReasoningChoice } : undefined),
    request: value === 'inherit' ? {} : { text_generation_options: { reasoning: value } },
  }
}

export function TaskReasoningSelect({ reasoning, disabled, zIndex = 400, inline = false }: {
  reasoning: ReturnType<typeof useTaskReasoning>; disabled?: boolean; zIndex?: number; inline?: boolean
}) {
  if (reasoning.choices.length < 2) return null
  const selected = reasoning.choices.find(choice => choice.value === reasoning.value)
  return <Select label={inline ? undefined : '推理等级'} aria-label="推理等级" size="xs" w={inline ? undefined : 148}
    className={inline ? 'sd-inline-reasoning' : undefined} title={inline ? selected?.label : undefined}
    searchValue={inline && selected ? `推理 ${selected.label}` : undefined}
    allowDeselect={false} disabled={disabled} value={reasoning.value} data={reasoning.choices} onChange={reasoning.select}
    comboboxProps={inline ? { zIndex, position: 'top-end', width: 160 } : { zIndex }} />
}
