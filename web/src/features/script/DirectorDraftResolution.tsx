import { useEffect, useState } from 'react'
import { Badge, Blockquote, Button, Group, Modal, Paper, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { ListChecks, Sparkles } from 'lucide-react'
import type { ScriptDraftResolution, ScriptDraftResolutionInput } from '@video-studio/shared/script/script-draft-resolution'
import { workflowLabels } from './script-workflow'
import './director-draft-resolution.css'

export default function DirectorDraftResolution({ resolution, opened, busy, onClose, onOpen, onResolve, onDiscard }: {
  resolution: ScriptDraftResolution | null; opened: boolean; busy: boolean;
  onClose: () => void; onOpen: () => void;
  onResolve: (input: ScriptDraftResolutionInput) => void; onDiscard: () => void;
}) {
  const [answers, setAnswers] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  useEffect(() => { setAnswers(resolution?.findings.map(finding => finding.previous_answer || '') || []) }, [resolution?.id, resolution?.version])
  useEffect(() => { setEditing(false) }, [resolution?.id, resolution?.version])
  if (!resolution) return null
  const manualReady = answers.length === resolution.findings.length && answers.every(answer => answer.trim())
  const submit = (strategy: 'manual' | 'ai') => onResolve({ id: resolution.id, version: resolution.version, strategy,
    ...(strategy === 'manual' ? { answers } : {}) })
  const continuing = Boolean(resolution.run) && !editing
  return <>
    <Paper className="sd-draft-resolution-notice" withBorder p="sm" radius="md" role="status">
      <Stack gap={4}>
        <Text size="sm" fw={600}>{continuing ? busy ? '正在落实草稿处理方案' : '草稿处理尚未完成' : `草稿有 ${resolution.findings.length} 项待处理`}</Text>
        <Text size="xs" c="dimmed">{resolution.run ? `已保留方案和进度：${resolution.run.completed}/${resolution.run.total} 项修订步骤已完成，全部完成后独立复核。无需重复决定。`
          : `已保留 ${resolution.document_count} 份候选文档，处理后继续校验。`}</Text>
        {resolution.run?.message && <Text size="xs" c="dimmed" lineClamp={2}>{resolution.run.message}</Text>}
      </Stack>
      <Group gap="xs" wrap="nowrap">
        {continuing && <Button size="xs" variant="subtle" onClick={onOpen} disabled={busy}>查看问题</Button>}
        <Button size="xs" variant="light" onClick={continuing ? () => onResolve({ id: resolution.id, version: resolution.version, strategy: 'continue' }) : onOpen} disabled={busy}>{continuing ? '继续处理' : '处理问题'}</Button>
      </Group>
    </Paper>
    <Modal opened={opened} onClose={onClose} title="处理草稿中的冲突与缺口" size="lg" centered zIndex={400}
      closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy} className="sd-draft-resolution-modal">
      <Stack gap="md">
        <Text size="sm" c="dimmed">{resolution.stage === 'episode' ? `第 ${resolution.episode_number} 集正文` : workflowLabels[resolution.stage]} · 已保留 {resolution.document_count} 份候选文档。{continuing ? '已有方案和授权已保留。下方为本轮处理范围，已完成步骤会复用，最终以独立复核为准。' : '填写每项方案，或将这些问题全部交给 AI 决定。'}</Text>
        <ScrollArea.Autosize className="sd-draft-resolution-scroll" mah="var(--resolution-scroll-height)" type="auto" offsetScrollbars>
          <Stack gap="sm">
            {resolution.findings.map((finding, index) => <Paper key={`${resolution.version}:${index}`} withBorder p="md" radius="md">
              <Stack gap="xs">
                <Group gap="xs"><Badge variant="light" color={finding.kind === 'contradiction' ? 'orange' : 'gray'}>{finding.kind === 'contradiction' ? '内容冲突' : '设定待补齐'}</Badge><Text size="xs" c="dimmed">第 {index + 1} 项</Text></Group>
                <Text size="sm" fw={500}>{finding.explanation}</Text>
                {!!finding.repair_attempts && <Text size="xs" c="dimmed">已修订 {finding.repair_attempts} 次，当前仍有未落实的内容。{finding.delegated ? '继续沿用 AI 决定权限。' : '已带入你之前填写的方案，可继续调整。'}</Text>}
                <Blockquote className="sd-draft-resolution-quote" color="gray" p="sm">{finding.quote}</Blockquote>
                {finding.related_findings?.map((related, index) => <Text key={index} size="sm">关联问题：{related.explanation}</Text>)}
                <Text size="xs" c="dimmed">建议：{finding.suggestion}</Text>
                {continuing ? <Text size="xs" c="dimmed">处理方案：{finding.previous_answer || '已委托 AI，继续沿用已有决定与约束。'}</Text>
                : <Textarea label={`第 ${index + 1} 项处理方案`} placeholder="填写具体决定；选择全部交给 AI 时无需填写" autosize minRows={2} maxRows={5}
                  maxLength={4000} value={answers[index] || ''} disabled={busy}
                  onChange={event => { const value = event.currentTarget.value; setAnswers(current => resolution.findings.map((_, i) => i === index ? value : current[i] || '')) }} />}
              </Stack>
            </Paper>)}
          </Stack>
        </ScrollArea.Autosize>
        <Stack className="sd-resolution-footer" gap="sm">
          <Text size="xs" c="dimmed">补齐会沿用原稿已明确的故事设定，并同步受影响段落。通过校验后可预览、确认保存。</Text>
          <Group className="sd-resolution-actions" justify="space-between" gap="md" wrap="nowrap">
            <Group className="sd-resolution-secondary" gap={4} wrap="nowrap">
              <Button className="sd-resolution-defer" data-workspace-control="" variant="subtle" color="gray" onClick={onClose} disabled={busy}>稍后处理</Button>
              <Button className="sd-resolution-discard" data-workspace-control="" variant="subtle" color="red" onClick={onDiscard} disabled={busy}>放弃候选稿</Button>
              {resolution.run && <Button variant="subtle" color="gray" onClick={() => setEditing(!editing)} disabled={busy}>{editing ? '取消调整' : '调整方案'}</Button>}
            </Group>
            <Group className="sd-resolution-submit" gap="xs" wrap="nowrap">
              {continuing && <Button onClick={() => onResolve({ id: resolution.id, version: resolution.version, strategy: 'continue' })} disabled={busy}>沿用方案继续</Button>}
              {!continuing && <Button className={`sd-resolution-ai${!manualReady ? ' is-primary' : ''}`} variant={manualReady ? 'default' : 'filled'}
                leftSection={<Sparkles size={15} aria-hidden="true" />} onClick={() => submit('ai')} disabled={busy}>全部交给 AI 决定</Button>
              }
              {!continuing && <Button className={`sd-resolution-manual${manualReady ? ' is-primary' : ''}`} variant={manualReady ? 'filled' : 'default'}
                leftSection={<ListChecks size={15} aria-hidden="true" />} onClick={() => submit('manual')} disabled={busy || !manualReady}>按填写内容补齐</Button>}
            </Group>
          </Group>
        </Stack>
      </Stack>
    </Modal>
  </>
}
