import { Select } from '@mantine/core'
import type { SelectProps } from '@mantine/core'
import { ChevronDown } from 'lucide-react'

/** Canvas controls share the app menu theme, while portal interactions stay
 * inside the active node's editing session. */
export default function CanvasSelect({ className, comboboxProps, attributes, ...props }: SelectProps) {
  return <Select
    allowDeselect={false}
    nothingFoundMessage="没有可用选项"
    {...props}
    className={`pc-styled-select nodrag nowheel ${className || ''}`}
    data-canvas-overlay
    attributes={{ ...attributes, dropdown: { ...(attributes?.dropdown || {}), 'data-canvas-overlay': true } }}
    rightSection={<ChevronDown size={14} />}
    comboboxProps={{ withinPortal: true, zIndex: 320, position: 'bottom-start',
      ...comboboxProps }}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
  />
}
