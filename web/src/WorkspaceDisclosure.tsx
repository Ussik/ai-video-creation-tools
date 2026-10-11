import { Accordion } from '@mantine/core'
import type { ReactNode } from 'react'

/** Shared library disclosure; keep panels mounted so drafts and media refs survive toggles. */
export function WorkspaceDisclosure({ label, initiallyOpen = false, children, className, ...props }: {
  label: ReactNode
  initiallyOpen?: boolean
  children: ReactNode
  className?: string
}) {
  return <Accordion className={`workspace-disclosure ${className || ''}`} defaultValue={initiallyOpen ? 'content' : null}
    keepMounted keepMountedMode="display-none" transitionDuration={120} {...props}>
    <Accordion.Item value="content">
      <Accordion.Control className="workspace-disclosure-control">{label}</Accordion.Control>
      <Accordion.Panel>{children}</Accordion.Panel>
    </Accordion.Item>
  </Accordion>
}
