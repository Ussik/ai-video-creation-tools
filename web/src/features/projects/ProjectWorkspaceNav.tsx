import type { ReactNode } from 'react'
import { ActionIcon, Menu, Select, Tabs, Tooltip } from '@mantine/core'
import { ArrowLeft, Ellipsis, Menu as MenuIcon, Settings2, FileText, Pencil } from 'lucide-react'
import ThemeToggle from '../../shared/ui/ThemeToggle'
import type { Project } from '../../shared/api/api'

export type ProjectWorkspace = 'script' | 'canvas' | 'shots' | 'visuals' | 'speech' | 'studio' | 'settings' | 'source'
const workspaces: Array<{ value: ProjectWorkspace; label: string }> = [
  { value: 'script', label: '剧本' }, { value: 'canvas', label: '画布' },
  { value: 'visuals', label: '视觉设定' }, { value: 'studio', label: '成片' },
]

export default function ProjectWorkspaceNav({ projects, projectId, value, onChange, onProjectChange, onBack, onMenu, onRename, children }: {
  projects: Project[]; projectId: string; value: ProjectWorkspace;
  onChange: (value: ProjectWorkspace) => void; onProjectChange: (id: string | null) => void;
  onBack: () => void; onMenu: () => void; onRename: () => void; children?: ReactNode;
}) {
  return <header className="project-workspace-nav">
    <div className="project-workspace-identity">
      <Tooltip label="返回项目"><ActionIcon variant="subtle" aria-label="返回项目列表" onClick={onBack}><ArrowLeft size={17} /></ActionIcon></Tooltip>
      <Select aria-label="切换项目" value={projectId} onChange={onProjectChange} searchable allowDeselect={false}
        data={projects.map(project => ({ value: project.id, label: project.name }))} comboboxProps={{ width: 300, position: 'bottom-start' }} />
      <Tooltip label="创作设定">
        <ActionIcon variant="subtle" aria-label="创作设定" onClick={() => onChange('settings')}><Settings2 size={17} /></ActionIcon>
      </Tooltip>
    </div>
    <Tabs value={value} onChange={next => next && onChange(next as ProjectWorkspace)} className="project-workspace-tabs">
      <Tabs.List aria-label="项目工作区">{workspaces.map(item => <Tabs.Tab key={item.value} value={item.value}>{item.label}</Tabs.Tab>)}</Tabs.List>
    </Tabs>
    <div className="project-workspace-nav-actions">
      <Menu position="bottom-end" width={180}>
        <Menu.Target><ActionIcon variant="subtle" aria-label="项目工具" data-active={value === 'settings' || value === 'source' || undefined}><Ellipsis size={18} /></ActionIcon></Menu.Target>
        <Menu.Dropdown><Menu.Item leftSection={<FileText size={15} />} onClick={() => onChange('source')}>原稿与分析</Menu.Item>
          <Menu.Item leftSection={<FileText size={15} />} onClick={() => onChange('shots')}>分镜管理</Menu.Item>
          <Menu.Item leftSection={<FileText size={15} />} onClick={() => onChange('speech')}>配音工作台</Menu.Item>
          <Menu.Divider /><Menu.Item leftSection={<Pencil size={15} />} onClick={onRename}>重命名项目</Menu.Item></Menu.Dropdown>
      </Menu>
      {children}
      <ThemeToggle />
      <ActionIcon className="mobile-toggle" variant="subtle" aria-label="打开导航" onClick={onMenu}><MenuIcon size={18} /></ActionIcon>
    </div>
  </header>
}
