import { Button, Menu } from '@mantine/core'
import { Fragment } from 'react'
import { ChevronDown, FileText, Lock, Pencil, Plus, RotateCcw } from 'lucide-react'
import { scriptStageOrder } from '@video-studio/shared/script/script-stage-content'
import { missingSavedStageArtifacts, stageLabels, workflowProgress, type StageTarget, type WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'

export default function ScriptStageActions({ script, disabled, onAction }: {
  script: WorkflowProgressInput; disabled: boolean; onAction: (target: StageTarget) => void;
}) {
  const progress = workflowProgress(script)
  return <div className="sd-stage-actions" aria-label="阶段处理">
    {scriptStageOrder.map(stage => {
      const saved = stage === 'episode' ? progress.episodes.length > 0 : progress.completed[stage]
      const current = progress.next_stage === stage
      const target = { stage, episode_number: stage === 'episode' ? progress.next_episode || 1 : 0 }
      if (saved) return <Menu key={stage} position="bottom-start" withinPortal zIndex={400}>
        <Menu.Target><Button variant="subtle" className="sd-stage-button is-saved" disabled={disabled}
          aria-label={`处理已保存的${stageLabels[stage]}`}>{stageLabels[stage]}<ChevronDown size={12} /></Button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{stage === 'episode' ? '已保存分集' : `${stageLabels[stage]} · 已保存`}</Menu.Label>
          {stage === 'episode' ? <>
            {progress.episodes.map(episode => <Fragment key={episode}>
              <Menu.Item leftSection={<Pencil size={14} />} onClick={() => onAction({ stage, episode_number: episode, operation: 'revise' })}>修改第 {episode} 集正文</Menu.Item>
              <Menu.Item leftSection={<RotateCcw size={14} />} onClick={() => onAction({ stage, episode_number: episode, operation: 'regenerate' })}>重新设计第 {episode} 集正文</Menu.Item>
            </Fragment>)}
            {current && <Menu.Item leftSection={<FileText size={14} />} onClick={() => onAction({ ...target, operation: 'generate' })}>生成第 {progress.next_episode} 集正文</Menu.Item>}
          </> : <>
            <Menu.Item leftSection={<Pencil size={14} />} onClick={() => onAction({ ...target, operation: 'revise' })}>局部修改</Menu.Item>
            {!!missingSavedStageArtifacts(script, target).length && <Menu.Item leftSection={<Plus size={14} />} onClick={() => onAction({ ...target, operation: 'supplement' })}>补齐栏目 · 缺 {missingSavedStageArtifacts(script, target).length} 项</Menu.Item>}
            <Menu.Item leftSection={<RotateCcw size={14} />} onClick={() => onAction({ ...target, operation: 'regenerate' })}>重新设计</Menu.Item>
          </>}
        </Menu.Dropdown>
      </Menu>
      return <Button key={stage} variant="subtle" className={`sd-stage-button${current ? ' is-current' : ''}`}
        disabled={disabled || !current} title={current ? '生成后确认保存，再继续下一阶段' : '完成并保存前面的阶段后开放'}
        onClick={() => onAction({ ...target, operation: 'generate' })}>{current ? <FileText size={13} /> : <Lock size={12} />}{stageLabels[stage]}</Button>
    })}
  </div>
}
