import { useEffect, useMemo, useState } from 'react'
import { Copy, ExternalLink, PackageSearch, RefreshCw, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { UserAvatar } from './user-avatar'
import { OrderAmount } from '@/features/orders/order-amount'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  imApi,
  ORDER_STATUS_TABS,
  ORDER_TABS,
  type CustomerInfo,
  type OrderRow,
  type SessionRow,
} from '@/lib/im'

type Props = {
  session: SessionRow | null
  customer: CustomerInfo | null
  loading: boolean
  orders: OrderRow[]
  loadingOrders: boolean
  onRefreshOrders: () => void
}

function pick(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number') return String(v)
  }
  return null
}

/** 订单状态 → 徽标配色（闲管家同一套语义：红＝要处理，绿＝完成，灰＝关闭） */
function statusVariant(statusText: string, status: string) {
  const t = statusText || ''
  if (/退款|关闭|失败/.test(t) || /refund|close/.test(status)) return 'destructive' as const
  if (/待发货|待付款|等待|待收货/.test(t)) return 'default' as const
  if (/成功|完成/.test(t)) return 'secondary' as const
  return 'outline' as const
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`已复制${label}`)
  } catch {
    toast.error('复制失败，请手动选择')
  }
}

function OrderCard({ order, onShipped }: { order: OrderRow; onShipped?: () => void }) {
  const actions = (order.actions || []).slice(0, 4)
  const [shipping, setShipping] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const needShip = order.status === 'seller_to_send'
  const ship = async () => {
    setShipping(true)
    try {
      const r = await imApi.consignDummy(order.orderId)
      if (r.ok) {
        toast.success('已发货（无需物流）')
        onShipped?.()
      } else {
        toast.error(r.error || '发货失败')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '发货失败')
    } finally {
      setShipping(false)
      setConfirmOpen(false)
    }
  }
  const open = (url: string) => {
    if (!url) return
    if (/^https?:/i.test(url)) {
      window.open(url, '_blank', 'noopener')
      return
    }
    // fleamarket:// / alipays:// 这类深链浏览器打不开，复制给用户去 App 里用
    void copyText(url, ' App 深链（在闲鱼 App 打开）')
  }
  return (
    <div className='rounded-md border p-2'>
      <div className='flex items-start gap-2'>
        {order.pic ? (
          <img
            src={order.pic}
            alt={order.title}
            referrerPolicy='no-referrer'
            className='size-10 shrink-0 rounded object-cover'
          />
        ) : (
          <div className='flex size-10 shrink-0 items-center justify-center rounded bg-muted'>
            <PackageSearch className='size-4 text-muted-foreground' />
          </div>
        )}
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span className='line-clamp-2 text-xs leading-tight' title={order.title}>
            {order.title || '（无标题）'}
          </span>
          <div className='flex items-center gap-1'>
            <Badge variant={statusVariant(order.statusText, order.status)} className='px-1 py-0 text-[10px]'>
              {order.statusText || order.status || '未知状态'}
            </Badge>
            {order.amount ? (
              <span className='text-[11px] text-muted-foreground'>×{order.amount}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground'>
        <OrderAmount order={order} className='text-[11px]' />
        {order.sku ? <span className='truncate'>{order.sku}</span> : null}
        {order.createTime ? <span>{order.createTime}</span> : null}
      </div>

      {order.error ? (
        <p className='mt-1 text-[11px] text-destructive'>{order.error}</p>
      ) : (
        <div className='mt-1.5 flex flex-wrap gap-1'>
          {needShip ? (
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  size='sm'
                  disabled={shipping}
                  className='h-6 px-1.5 text-[11px]'
                  title='调用 mtop.taobao.idle.logistic.consign.dummy：订单直接进入等待见面交易'
                >
                  <Truck className='size-3' />
                  {shipping ? '发货中…' : '无需物流发货'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认发货？</AlertDialogTitle>
                  <AlertDialogDescription>
                    订单 <span className='font-mono'>{order.orderId}</span> 将执行「无需物流发货」，
                    状态会变成「等待见面交易」，不会产生运单号。此操作不可撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={shipping}>取消</AlertDialogCancel>
                  <AlertDialogAction disabled={shipping} onClick={() => void ship()}>
                    {shipping ? '发货中…' : '确认发货'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
          {actions.map((a) => (
            <Button
              key={a.action + a.name}
              variant='outline'
              size='sm'
              disabled={a.disabled || !a.url}
              onClick={() => open(a.url)}
              className='h-6 px-1.5 text-[11px]'
              title={a.url || '该动作需要 App 内完成'}
            >
              {a.name}
              {/^https?:/i.test(a.url) ? <ExternalLink className='size-3' /> : null}
            </Button>
          ))}

          <Button
            variant='ghost'
            size='sm'
            className='h-6 px-1.5 text-[11px]'
            onClick={() => void copyText(order.orderId, '订单号')}
          >
            <Copy className='size-3' />
            订单号
          </Button>
        </div>
      )}
    </div>
  )
}

export function CustomerPanel({ session, customer, loading, orders, loadingOrders, onRefreshOrders }: Props) {
  // 每个客户单独记一个 tab，切客户时回到「全部」
  const [orderTab, setOrderTab] = useState<string>('all')
  const sessionId = session?.id
  useEffect(() => {
    setOrderTab('all')
  }, [sessionId])

  const tabCounts = useMemo(() => {
    const c: Record<string, number> = { all: orders.length }
    for (const t of ORDER_TABS) {
      if (t.key === 'all') continue
      const sts = ORDER_STATUS_TABS[t.key] || []
      c[t.key] = orders.filter((o) => sts.includes(o.status)).length
    }
    return c
  }, [orders])

  const shownOrders = useMemo(() => {
    if (orderTab === 'all') return orders
    const sts = ORDER_STATUS_TABS[orderTab] || []
    return orders.filter((o) => sts.includes(o.status))
  }, [orders, orderTab])

  if (!session) {
    return (
      <Card className='hidden w-80 shrink-0 lg:flex'>
        <CardHeader>
          <CardTitle className='text-sm'>客户信息</CardTitle>
        </CardHeader>
        <CardContent>
          <p className='text-xs text-muted-foreground'>选中会话后显示</p>
        </CardContent>
      </Card>
    )
  }

  const head = customer?.head as Record<string, unknown> | undefined
  const data = (head?.data as Record<string, unknown> | undefined) || head
  const nick = customer?.nick || pick(data, ['displayName', 'nick', 'nickName', 'nickname', 'userNick']) || session.nickname || ''
  const avatar = customer?.avatar || session.logo || ''
  const city = customer?.city || session.city || ''
  const userId = customer?.userId || session.withWho || ''
  const raw = head ? JSON.stringify(head, null, 2) : ''

  return (
    <Card className='hidden w-80 shrink-0 flex-col lg:flex'>
      <CardHeader>
        <CardTitle className='text-sm'>客户信息</CardTitle>
      </CardHeader>
      <CardContent className='flex min-h-0 flex-1 flex-col gap-3'>
        <div className='flex items-center gap-2'>
          <UserAvatar src={avatar} name={nick || userId} className='size-10' />
          <div className='flex min-w-0 flex-1 flex-col'>
            <span className='truncate text-sm font-medium'>{nick || '未命名客户'}</span>
            <span className='truncate text-xs text-muted-foreground'>{userId || '未知 ID'}</span>
          </div>
          {userId ? (
            <Button
              variant='ghost'
              size='icon'
              className='size-7'
              title='复制客户 ID'
              onClick={() => void copyText(userId, '客户 ID')}
            >
              <Copy className='size-3.5' />
            </Button>
          ) : null}
        </div>

        <div className='grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs'>
          <span className='text-muted-foreground'>会话</span>
          <span className='truncate text-end'>{session.id}</span>
          <span className='text-muted-foreground'>所在地</span>
          <span className='truncate text-end'>{city || '—'}</span>
          <span className='text-muted-foreground'>未读</span>
          <span className='text-end'>
            <Badge variant={session.unread > 0 ? 'default' : 'secondary'}>{session.unread}</Badge>
          </span>
        </div>

        <Separator />

        <div className='flex items-center justify-between gap-1'>
          <span className='flex items-center gap-1 text-xs font-medium'>
            买家订单
            <Badge variant='secondary' className='px-1 py-0 text-[10px]'>
              {orders.length}
            </Badge>
          </span>
          <Button
            variant='ghost'
            size='icon'
            className='size-6'
            onClick={onRefreshOrders}
            disabled={loadingOrders}
            title='重新拉订单'
          >
            <RefreshCw className={cn('size-3.5', loadingOrders && 'animate-spin')} />
          </Button>
        </div>

        {/* tab 条：和订单页一致，只是计数按「这个客户」算 */}
        <div className='-mt-1 flex flex-wrap items-center gap-0.5'>
          {ORDER_TABS.map((t) => {
            const n = tabCounts[t.key as keyof typeof tabCounts] || 0
            const active = orderTab === t.key
            return (
              <button
                key={t.key}
                type='button'
                onClick={() => setOrderTab(t.key)}
                className={cn(
                  'rounded px-1 py-0.5 text-[11px] whitespace-nowrap transition-colors',
                  active ? 'bg-secondary font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
                {n > 0 ? (
                  <sup className='ms-0.5 rounded-full bg-red-500 px-1 text-[9px] leading-3 font-normal text-white'>
                    {n > 99 ? '99+' : n}
                  </sup>
                ) : null}
              </button>
            )
          })}
        </div>

        <ScrollArea className='min-h-24 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block'>
          <div className='flex flex-col gap-2 pe-1'>
            {loadingOrders && orders.length === 0 ? (
              <>
                <Skeleton className='h-24 w-full' />
                <Skeleton className='h-24 w-full' />
              </>
            ) : orders.length === 0 ? (
              <p className='rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground'>
                这个会话里没有找到订单卡片
              </p>
            ) : shownOrders.length === 0 ? (
              <p className='rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground'>
                这个客户没有<strong className='mx-0.5'>{ORDER_TABS.find((t) => t.key === orderTab)?.label}</strong>的订单
              </p>
            ) : (
              shownOrders.map((o) => <OrderCard key={o.orderId} order={o} onShipped={onRefreshOrders} />)
            )}
          </div>
        </ScrollArea>

        <Separator />

        <details className='flex flex-col gap-1'>
          <summary className='cursor-pointer text-xs text-muted-foreground'>原始 user.page.head</summary>
          {loading ? (
            <Skeleton className='h-24 w-full' />
          ) : (
            <ScrollArea className='mt-1 h-40 rounded-sm border [&>[data-slot=scroll-area-viewport]>div]:!block'>
              <pre className='p-2 text-[10px] leading-tight break-all whitespace-pre-wrap'>
                {raw || '（无数据）'}
              </pre>
            </ScrollArea>
          )}
        </details>
      </CardContent>
    </Card>
  )
}
