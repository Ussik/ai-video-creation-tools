import { Button, Menu } from '@mantine/core'
import { Check, ChevronDown, FileText, Film, Image, Layers3, ScrollText } from 'lucide-react'
import type { CanvasNodeTypeFilter as NodeTypeFilter } from './canvas-node-type-filter'
import './canvas-node-type-filter.css'

type Props = {
  value: NodeTypeFilter
  counts: Record<NodeTypeFilter, number>
  onChange: (value: NodeTypeFilter) => void
}

const options = [
  { value: 'all', label: '全部节点', trigger: '全部类型', icon: Layers3 },
  { value: 'image', label: '图片节点', trigger: '图片节点', icon: Image },
  { value: 'video', label: '视频节点', trigger: '视频节点', icon: Film },
  { value: 'text', label: '文本节点', trigger: '文本节点', icon: FileText },
  { value: 'project_script_ref', label: '剧本节点', trigger: '剧本节点', icon: ScrollText },
] as const

export default function CanvasNodeTypeFilter({ value, counts, onChange }: Props) {
  const current = options.find(option => option.value === value) || options[0]
  const Icon = current.icon
  return <Menu position="top-start" offset={8} width={208} withinPortal zIndex={200}
    classNames={{ dropdown: 'pc-sidebar-dropdown pc-node-type-dropdown' }}>
    <Menu.Target>
      <Button variant="subtle" size="compact-xs" className="pc-node-type-filter nodrag nowheel" data-canvas-overlay
        data-active={value !== 'all' || undefined} aria-label="筛选画布节点类型"
        leftSection={<Icon size={14} />} rightSection={<ChevronDown size={12} />}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        {current.trigger}
      </Button>
    </Menu.Target>
    <Menu.Dropdown data-canvas-overlay className="nodrag nowheel"
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation() }}>
      {options.map(option => <Menu.Item key={option.value} leftSection={<option.icon size={15} />}
        data-active={value === option.value || undefined} onClick={() => onChange(option.value)}
        rightSection={<span className="pc-node-type-option-meta"><span className="pc-node-type-option-count">{counts[option.value]}</span><span className="pc-node-type-option-check" aria-hidden="true">{value === option.value && <Check size={13} />}</span></span>}>
        {option.label}
      </Menu.Item>)}
      <Menu.Divider />
      <Menu.Label className="pc-node-type-filter-note">仅影响当前画布的显示</Menu.Label>
    </Menu.Dropdown>
  </Menu>
}
