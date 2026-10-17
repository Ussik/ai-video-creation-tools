import { Alert } from '@mantine/core'
import { CircleAlert } from 'lucide-react'
import DirectorMessageTiming, { type MessageTiming } from './DirectorMessageTiming'
import ScriptMessageContent from './ScriptMessageContent'

export default function DirectorMessageFailure({ detail, ...timing }: MessageTiming & { detail: string }) {
  return <Alert className="sd-message-failure" classNames={{ icon: 'sd-message-failure-icon', title: 'sd-message-failure-title', message: 'sd-message-failure-content' }}
    variant="light" color="red" icon={<CircleAlert size={17} />} title="本轮未完成" role="alert">
    <ScriptMessageContent text={detail} />
    <DirectorMessageTiming {...timing} />
  </Alert>
}
