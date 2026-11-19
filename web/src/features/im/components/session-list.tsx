import { useMemo, useState } from 'react'
import { Package, Pin, RefreshCw, Search as SearchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtTime, type SessionRow } from '@/lib/im'
import { UserAvatar } from './user-avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

type Props = {
  sessions: SessionRow[]
  selectedId: string | null
  loading: boolean
  syncing: boolean
  onSelect: (id: string) => void
  onSync: () => void
}

export function SessionList({ sessions, selectedId, loading, syncing, onSelect, onSync }: Props) {
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return sessions
    return sessions.filter((s) => {
      const name = (s.nickname || s.withWho || '').toLowerCase()
      return name.includes(kw) || s.withWho.toLowerCase().includes(kw) || s.abstractContent.toLowerCase().includes(kw)
    })
  }, [sessions, q])

  return (
    <div className='flex h-full w-full shrink-0 flex-col gap-3 sm:w-72 lg:w-80 xl:w-88'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <h2 className='text-lg font-semibold'>会话</h2>
          <Badge variant='secondary'>{sessions.length}</Badge>
        </div>
        <Button variant='ghost' size='icon' onClick={onSync} disabled={syncing} title='同步会话与消息'>
          <RefreshCw className={cn(syncing && 'animate-spin')} />
        </Button>
      </div>

      <div className='relative'>
        <SearchIcon className='pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='搜索客户或消息…'
          className='ps-8'
        />
      </div>

      {/* Radix ScrollArea 的 Viewport 内层是 display:table（宽度按内容撑开），
          不强制成 block 的话每行会被撑到上千像素，右侧的缩略图/时间就被裁到可视区之外 */}
      <ScrollArea className='min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block'> 
        <div className='flex flex-col gap-1 pe-2'>
          {loading && sessions.length === 0
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className='flex items-center gap-2 p-2'>
                  <Skeleton className='size-9 rounded-full' />
                  <div className='flex flex-1 flex-col gap-1'>
                    <Skeleton className='h-3 w-24' />
                    <Skeleton className='h-3 w-40' />
                  </div>
                </div>
              ))
            : filtered.map((s) => {
                const name = s.nickname || s.withWho || '未命名客户'
                const active = s.id === selectedId
                return (
                  <button
                    key={s.id}
                    type='button'
                    onClick={() => onSelect(s.id)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-2 text-start transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      active && 'bg-accent text-accent-foreground'
                    )}
                  >
                    <UserAvatar src={s.logo} name={name} className='size-9' />
                    <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='flex min-w-0 items-center gap-1'>
                          <span className='truncate text-sm font-medium'>{name}</span>
                          {s.tradeText && (
                            <span
                              className={cn(
                                'shrink-0 text-[10px] leading-3',
                                s.tradeTone === 'ok' && 'text-green-600 dark:text-green-500',
                                s.tradeTone === 'warn' && 'text-orange-500 dark:text-orange-400',
                                s.tradeTone === 'muted' && 'text-muted-foreground'
                              )}
                            >
                              {s.tradeText}
                            </span>
                          )}
                          {s.pinned && (
                            <Pin className='size-3 shrink-0 text-muted-foreground' aria-label='置顶' />
                          )}
                        </span>
                        <span className='shrink-0 text-xs text-muted-foreground'>
                          {fmtTime(s.orderTs || s.lastMsgTs)}
                        </span>
                      </div>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='truncate text-xs text-muted-foreground'>
                          {s.abstractContent || '（无消息）'}
                        </span>
                        {s.unread > 0 && (
                          <Badge variant='default' className='shrink-0 px-1.5 py-0 text-[10px]'>
                            {s.unread > 99 ? '99+' : s.unread}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {/* 客户来咨询的商品主图：官方会话对象里自带，取不到就占位不占视觉重量 */}
                    <span
                      className='relative size-9 shrink-0 overflow-hidden rounded-md border bg-muted'
                      title={s.itemTitle || (s.itemId ? `商品 ${s.itemId}` : '无商品信息')}
                    >
                      {s.itemPic ? (
                        <img
                          src={s.itemPic}
                          alt={s.itemTitle || '商品主图'}
                          referrerPolicy='no-referrer'
                          className='size-full object-cover'
                        />
                      ) : (
                        <span className='flex size-full items-center justify-center text-muted-foreground'>
                          <Package className='size-4' />
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
          {!loading && filtered.length === 0 && (
            <p className='p-6 text-center text-sm text-muted-foreground'>
              {sessions.length === 0 ? '还没有会话，点右上角同步' : '没有匹配的会话'}
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
