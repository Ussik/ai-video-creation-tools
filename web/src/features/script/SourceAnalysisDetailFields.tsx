import { ActionIcon, CopyButton } from '@mantine/core'
import { Check, Copy } from 'lucide-react'
import type { ReactNode } from 'react'

export function SourceAnalysisField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="sd-analysis-field"><dt>{label}</dt><dd>{children}</dd></div>
}

export function SourceAnalysisIdentifier({ label, value }: { label: string; value: string }) {
  return <div className="sd-analysis-identifier">
    <span>{label}</span>
    <div><code>{value}</code><CopyButton value={value}>{({ copied, copy }) => <ActionIcon variant="subtle" size="sm"
      aria-label={`${copied ? '已复制' : '复制'}${label}`} title={copied ? '已复制' : '复制完整编号'} onClick={copy}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </ActionIcon>}</CopyButton></div>
  </div>
}
