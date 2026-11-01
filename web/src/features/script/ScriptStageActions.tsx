import { Box, Button, Menu, Tooltip } from '@mantine/core'
import { Fragment } from 'react'
import { ChevronDown, FileText, Lock, Pencil, Plus, RotateCcw } from 'lucide-react'
import { scriptStageOrder } from '@video-studio/shared/script/script-stage-content'
import { missingSavedStageArtifacts, stageLabels, workflowProgress, type StageTarget, type WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'
import type { ScriptTaskContract } from '@video-studio/shared/script/script-task-contract'

type StageActionTarget = StageTarget & Pick<ScriptTaskContract, 'intent' | 'artifact_types'>

export default function ScriptStageActions({ script, disabled, outlineIssue, hasSource = false, onAction }: {
  script: WorkflowProgressInput; disabled: boolean; outlineIssue?: string | null; hasSource?: boolean; onAction: (target: StageActionTarget) => void;
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
            <Menu.Item leftSection={<RotateCcw size={14} />} onClick={() => onAction({ ...target, operation: 'regenerate', ...(stage === 'outline' ? { intent: 'stage_design' as const } : {}) })}>{stage === 'outline' ? '完整大纲重新设计 · 9 栏' : '重新设计'}</Menu.Item>
          </>}
        </Menu.Dropdown>
      </Menu>
      const issue = stage === 'outline' && current ? outlineIssue : null
      if (stage === 'outline' && current) return <Menu key={stage} position="bottom-start" withinPortal zIndex={400}>
        <Menu.Target><Button variant="subtle" className="sd-stage-button is-current" disabled={disabled || Boolean(issue)} title={issue || '选择本次大纲交付范围'}
          aria-label="选择故事大纲生成范围"><FileText size={13} />{stageLabels[stage]}<ChevronDown size={12} /></Button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>选择本次交付范围</Menu.Label>
          <Menu.Item onClick={() => onAction({ ...target, operation: 'generate', intent: hasSource ? 'source_outline' : 'stage_design', artifact_types: ['outline'] })}>{hasSource ? '整理原稿大纲 · 仅概要设计' : '生成初步大纲 · 仅概要设计'}</Menu.Item>
          <Menu.Item onClick={() => onAction({ ...target, operation: 'generate', intent: 'stage_design' })}>完整大纲设计 · 9 栏</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      return <Tooltip key={stage} label={issue} disabled={!issue} withinPortal zIndex={400} withArrow>
        <Box component="span" w="100%" style={{ minWidth: 0 }}>
          <Button variant="subtle" className={`sd-stage-button${current ? ' is-current' : ''}`}
            disabled={disabled || !current || Boolean(issue)} title={issue || (current ? '生成后确认保存，再继续下一阶段' : '完成并保存前面的阶段后开放')}
            onClick={() => onAction({ ...target, operation: 'generate' })}>{current ? <FileText size={13} /> : <Lock size={12} />}{stageLabels[stage]}</Button>
        </Box>
      </Tooltip>
    })}
  </div>
}
