import { useCallback, useRef, useState } from 'react'
import { Button, Modal, Text, TextInput } from '@mantine/core'
import { TriangleAlert } from 'lucide-react'

type BaseOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type DialogRequest = (BaseOptions & {
  kind: 'confirm'
}) | (BaseOptions & {
  kind: 'prompt'
  defaultValue?: string
  placeholder?: string
})

type Resolver = (value: boolean | string | null) => void

export function useAppDialog() {
  const [request, setRequest] = useState<DialogRequest | null>(null)
  const [value, setValue] = useState('')
  const resolver = useRef<Resolver | null>(null)

  const finish = useCallback((result: boolean | string | null) => {
    resolver.current?.(result)
    resolver.current = null
    setRequest(null)
    setValue('')
  }, [])

  const confirm = useCallback((options: Omit<Extract<DialogRequest, { kind: 'confirm' }>, 'kind'>) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = (value) => resolve(Boolean(value))
      setRequest({ ...options, kind: 'confirm' })
    })
  }, [])

  const prompt = useCallback((options: Omit<Extract<DialogRequest, { kind: 'prompt' }>, 'kind'>) => {
    return new Promise<string | null>((resolve) => {
      resolver.current = (value) => resolve(typeof value === 'string' ? value : null)
      setValue(options.defaultValue || '')
      setRequest({ ...options, kind: 'prompt' })
    })
  }, [])

  const dialog = request ? <Modal
    opened
    onClose={() => finish(request.kind === 'prompt' ? null : false)}
    centered
    size="sm"
    withCloseButton={false}
    closeOnClickOutside={false}
    classNames={{ content: 'app-dialog', body: 'app-dialog-body' }}
    aria-label={request.title}
  >
    <div className="app-dialog-copy">
      <div className="app-dialog-title">
        <div className="app-dialog-icon" aria-hidden="true"><TriangleAlert size={19} /></div>
        <h2>{request.title}</h2>
      </div>
      <Text component="p">{request.message}</Text>
    </div>
    {request.kind === 'prompt' && <TextInput
      autoFocus
      value={value}
      placeholder={request.placeholder}
      aria-label={request.title}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') finish(value.trim()) }}
    />}
    <div className="app-dialog-actions">
      <Button variant="default" onClick={() => finish(request.kind === 'prompt' ? null : false)}>{request.cancelLabel || '取消'}</Button>
      <Button color={request.danger ? 'red' : undefined} onClick={() => finish(request.kind === 'prompt' ? value.trim() : true)} disabled={request.kind === 'prompt' && !value.trim()}>
        {request.confirmLabel || (request.kind === 'prompt' ? '保存' : '确认')}
      </Button>
    </div>
  </Modal> : null

  return { confirm, prompt, dialog }
}
