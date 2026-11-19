import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type Props = {
  disabled: boolean
  sending: boolean
  dryRun: boolean
  onSend: (text: string) => Promise<void> | void
}

export function Composer({ disabled, sending, dryRun, onSend }: Props) {
  const [text, setText] = useState('')

  const submit = async () => {
    const body = text.trim()
    if (!body || disabled || sending) return
    setText('')
    await onSend(body)
  }

  return (
    <div className='flex flex-none flex-col gap-2'>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={disabled ? '先选一个会话' : '输入消息，Enter 发送，Shift+Enter 换行'}
        disabled={disabled}
        rows={2}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
        className='resize-none'
      />
      <div className='flex items-center justify-between gap-2'>
        <span className='text-xs text-muted-foreground'>
          {dryRun ? 'dryRun 模式：只入库不真发' : '真发模式'}
        </span>
        <Button onClick={() => void submit()} disabled={disabled || sending || !text.trim()}>
          <Send data-icon='inline-start' />
          {sending ? '发送中…' : '发送'}
        </Button>
      </div>
    </div>
  )
}
