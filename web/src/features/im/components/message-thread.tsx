import { useEffect, useRef } from 'react'
import { MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtFull, type Me, type MessageRow } from '@/lib/im'
import { UserAvatar } from './user-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { MessageMediaBody } from './message-media'

type Props = {
  messages: MessageRow[]
  loading: boolean
  hasSession: boolean
  /** 我自己（右侧气泡） */
  me?: Me | null
  /** 客户（左侧气泡） */
  them?: { nick?: string; avatar?: string } | null
  /** 当前会话 id（文件下载用） */
  sessionId?: string
}

const SENDER_MAP: Record<number, string> = {
  1: '文本',
  2: '图片',
  3: '语音',
  4: '视频',
  5: '表情',
  6: '文本卡',
  7: '商品卡',
  17: '转账',
  18: '语音通话',
  25: '卡片',
  26: '卡片',
  27: '撤回',
  28: '卡片消息',
  32: '卡片',
  33: '文件',
  40: '系统',
}

/** media.type → 右下角那行小字 */
const MEDIA_LABEL: Record<string, string> = {
  image: '图片',
  audio: '语音',
  emoji: '表情',
  file: '文件',
  item: '商品卡',
  card: '卡片',
  transfer: '转账',
  rtc: '语音通话',
  withdraw: '撤回',
}

/** 两条消息间隔超过 5 分钟就重新显示头像+昵称，否则合并成一组 */
const GROUP_GAP = 5 * 60 * 1000

export function MessageThread({ messages, loading, hasSession, me, them, sessionId }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  if (!hasSession) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-3 rounded-md border bg-card'>
        <div className='flex size-14 items-center justify-center rounded-full border-2 border-border'>
          <MessagesSquare className='size-7 text-muted-foreground' />
        </div>
        <p className='text-sm text-muted-foreground'>左侧选一个会话开始</p>
      </div>
    )
  }

  const myName = me?.nick || '我'
  const theirName = them?.nick || '客户'

  return (
    <ScrollArea className='min-h-0 flex-1 rounded-md border bg-card [&>[data-slot=scroll-area-viewport]>div]:!block'>
      <div className='flex flex-col gap-3 p-4'>
        {loading && messages.length === 0
          ? Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className={cn('flex items-end gap-2', i % 2 === 0 ? 'justify-start' : 'justify-end')}
              >
                <Skeleton className='size-8 rounded-full' />
                <Skeleton className='h-10 w-48 rounded-2xl' />
              </div>
            ))
          : messages.map((m, i) => {
              const prev = messages[i - 1]
              // 连续同一人且间隔不大 → 归为一组，只在组首显示头像与昵称
              const grouped =
                !!prev && prev.fromSelf === m.fromSelf && Math.abs(m.ts - prev.ts) < GROUP_GAP
              const name = m.fromSelf ? myName : theirName
              const avatar = m.fromSelf ? me?.avatar || '' : them?.avatar || ''
              const media = m.media
              // 图片/表情是"裸"内容，不要气泡底色和内边距；其它类型保留气泡
              const bare = media?.type === 'image' || media?.type === 'emoji'
              return (
                <div
                  key={m.id}
                  className={cn(
                    'flex max-w-[78%] items-start gap-2',
                    m.fromSelf ? 'flex-row-reverse self-end' : 'self-start',
                    grouped ? 'mt-0' : 'mt-2'
                  )}
                >
                  {/* 头像：自己的在右，客户在左；同一组只有第一条露出来，但保留占位对齐 */}
                  <div className={cn('shrink-0', grouped ? 'invisible' : 'visible')}>
                    <UserAvatar src={avatar} name={name} className='size-8' fallbackClassName='text-xs' />
                  </div>
                  <div
                    className={cn(
                      'flex min-w-0 flex-col gap-1',
                      m.fromSelf ? 'items-end' : 'items-start'
                    )}
                  >
                    {!grouped && (
                      <span className='px-1 text-[11px] font-medium text-muted-foreground'>
                        {name}
                      </span>
                    )}
                    <div
                      className={cn(
                        'text-sm break-words whitespace-pre-wrap',
                        bare
                          ? 'max-w-[260px]'
                          : cn(
                              'rounded-2xl px-3 py-2',
                              m.fromSelf
                                ? 'rounded-br-sm bg-primary text-primary-foreground'
                                : 'rounded-bl-sm bg-muted text-foreground'
                            )
                      )}
                    >
                      {media && media.type !== 'text' ? (
                        <MessageMediaBody media={media} fromSelf={m.fromSelf} sessionId={sessionId} />
                      ) : (
                        m.text || `[${SENDER_MAP[m.contentType] || '消息' + m.contentType}]`
                      )}
                    </div>
                    <span className='px-1 text-[11px] text-muted-foreground'>
                      {fmtFull(m.ts)}
                      {m.contentType !== 1 &&
                        ` · ${
                          (media && media.type !== 'text' && MEDIA_LABEL[media.type]) ||
                          SENDER_MAP[m.contentType] ||
                          m.contentType
                        }`}
                    </span>
                  </div>
                </div>
              )
            })}
        {!loading && messages.length === 0 && (
          <p className='py-10 text-center text-sm text-muted-foreground'>这个会话还没有拉到消息</p>
        )}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  )
}
