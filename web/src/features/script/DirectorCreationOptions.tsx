import { Popover, UnstyledButton } from '@mantine/core'
import { useId, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { directorModes, directorModeProfiles, type DirectorMode } from '@video-studio/shared/script/script-creation-mode'
import './director-creation-options.css'

const modeDescriptions: Record<DirectorMode, string> = {
  all: '兼顾故事与画面',
  script: '故事、人物与对白',
  director: '镜头、调度与表演',
}

export default function DirectorCreationOptions({ mode, onModeChange, opened, onOpenedChange, disabled = false, skillSelector, skillLabel }: {
  mode: DirectorMode
  onModeChange: (mode: DirectorMode) => void
  opened: boolean
  onOpenedChange: (opened: boolean) => void
  disabled?: boolean
  skillSelector: ReactNode
  skillLabel: string
}) {
  const optionsId = useId()
  return <Popover id={optionsId} opened={opened} onChange={onOpenedChange} withinPortal position="top-start" offset={8}
    zIndex={360} trapFocus returnFocus width="min(300px, calc(100vw - 24px))" shadow="md">
    <Popover.Target><UnstyledButton type="button" className="sd-composer-mode-trigger" aria-label="创作选项"
      aria-expanded={opened} aria-controls={`${optionsId}-dropdown`} disabled={disabled} onClick={() => onOpenedChange(!opened)} data-workspace-control="">
      <span>{directorModeProfiles[mode].label}</span><ChevronDown size={12} aria-hidden="true" />
    </UnstyledButton></Popover.Target>
    <Popover.Dropdown className="sd-creation-options-popover" role="dialog" aria-label="创作选项面板" data-canvas-overlay>
      <header className="sd-creation-options-heading"><strong>创作方式</strong><p>调整回答视角，沿用当前任务和资料</p></header>
      <div className="sd-creation-options-modes" role="group" aria-label="创作模式">
        {directorModes.map(value => <UnstyledButton type="button" key={value} className="sd-creation-option" aria-label={directorModeProfiles[value].label} aria-pressed={mode === value}
          disabled={disabled} onClick={() => onModeChange(value)} data-workspace-control="">
          <span><strong>{directorModeProfiles[value].label}</strong><small>{modeDescriptions[value]}</small></span>
          {mode === value && <Check size={15} aria-hidden="true" />}
        </UnstyledButton>)}
      </div>
      <div className="sd-creation-options-skill"><span>{skillLabel}</span>{skillSelector}</div>
    </Popover.Dropdown>
  </Popover>
}
