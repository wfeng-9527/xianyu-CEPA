import { useCallback, useEffect, useState } from 'react'
import { Coins, Copy, ExternalLink, PackageSearch, RefreshCw, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { imApi, ORDER_TABS, type OrderCounts, type OrderRow } from '@/lib/im'
import { OrderAmount, getCachedPrice, loadPrice } from './order-amount'

type Row = OrderRow & { sessionId?: string }

function statusVariant(statusText: string, status: string) {
  const t = statusText || ''
  if (/退款|关闭|失败/.test(t) || /refund/.test(status)) return 'destructive' as const
  if (/待发货|待付款|等待/.test(t) || /to_send|to_pay/.test(status)) return 'default' as const
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

function openAction(url: string) {
  if (!url) return
  if (/^https?:/i.test(url)) {
    window.open(url, '_blank', 'noopener')
    return
  }
  void copyText(url, ' App 深链（在闲鱼 App 打开）')
}

function OrderLine({ o, priceVer = 0, onShipped }: { o: Row; priceVer?: number; onShipped?: () => void }) {
  const actions = (o.actions || []).slice(0, 4)
  const [shipping, setShipping] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const needShip = o.status === 'seller_to_send'
  const ship = async () => {
    setShipping(true)
    try {
      const r = await imApi.consignDummy(o.orderId)
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
  return (
    <div className='flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start'>
      {o.pic ? (
        <img
          src={o.pic}
          alt={o.title}
          referrerPolicy='no-referrer'
          className='size-14 shrink-0 rounded object-cover'
        />
      ) : (
        <div className='flex size-14 shrink-0 items-center justify-center rounded bg-muted'>
          <PackageSearch className='size-5 text-muted-foreground' />
        </div>
      )}

      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <OrderAmount order={o} version={priceVer} />
          <span className='text-xs text-muted-foreground'>× {o.amount ?? 1}</span>
          <Badge variant={statusVariant(o.statusText, o.status)}>{o.statusText || o.status || '—'}</Badge>
        </div>
        <span className='line-clamp-2 text-xs' title={o.title}>
          {o.title || '（无标题）'}
        </span>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground'>
          {o.sku ? <span>{o.sku}</span> : null}
          <span>{o.createTime}</span>
          {o.buyer?.nick ? <span>买家 {o.buyer.nick}</span> : null}
          <button
            type='button'
            className='inline-flex items-center gap-0.5 hover:text-foreground'
            onClick={() => void copyText(o.orderId, '订单号')}
          >
            <Copy className='size-3' />
            {o.orderId}
          </button>
        </div>
      </div>

      <div className='flex flex-wrap gap-1 sm:w-64 sm:justify-end'>
        {needShip ? (
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button
                size='sm'
                className='h-6 px-1.5 text-[11px]'
                disabled={shipping}
                title='mtop.taobao.idle.logistic.consign.dummy：订单直接进入等待见面交易'
              >
                <Truck className='size-3' />
                {shipping ? '发货中…' : '无需物流发货'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>确认发货？</AlertDialogTitle>
                <AlertDialogDescription>
                  订单 <span className='font-mono'>{o.orderId}</span> 将执行「无需物流发货」，
                  状态会变成「等待见面交易」，不会产生运单号。此操作不可撤销。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className='rounded-md bg-muted px-3 py-2 text-xs'>
                <div className='line-clamp-2'>{o.title || '（无标题）'}</div>
                <div className='mt-1 text-muted-foreground'>
                  ¥{o.price || '0.00'} × {o.amount ?? 1} · 买家 {o.buyer?.nick || '—'}
                </div>
              </div>
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
            className='h-6 px-1.5 text-[11px]'
            disabled={a.disabled || !a.url}
            title={a.url || '该动作需要 App 内完成'}
            onClick={() => openAction(a.url)}
          >
            {a.name}
            {/^https?:/i.test(a.url) ? <ExternalLink className='size-3' /> : null}
          </Button>
        ))}
      </div>
    </div>
  )
}

export function OrdersPage() {
  const [tab, setTab] = useState<keyof OrderCounts>('all')
  const [counts, setCounts] = useState<OrderCounts | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  // 批量补全「现金 + 闲鱼币」金额
  const [filling, setFilling] = useState(0)
  const [priceVer, setPriceVer] = useState(0)

  const loadTabs = useCallback(async () => {
    try {
      const r = await imApi.orderTabs()
      setCounts(r.counts)
      setCooldown(r.cooldownUntil || 0)
    } catch {
      /* 后端没起来时静默 */
    }
  }, [])

  const loadList = useCallback(async (t: keyof OrderCounts) => {
    setLoading(true)
    try {
      const r = await imApi.orderList(t, 200)
      setRows(r.orders as Row[])
      setCounts(r.counts)
    } catch (e) {
      toast.error('拉订单失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTabs()
    void loadList(tab)
  }, [tab, loadTabs, loadList])

  /** 把本页还没拿到「现金+闲鱼币」拆分的订单逐个补全（每个约 0.5–1 秒，服务端 6h 缓存） */
  const fillPrices = async () => {
    const todo = rows.filter((o) => getCachedPrice(o.orderId) === undefined)
    if (!todo.length) {
      toast.info('本页金额都已经补全过了')
      return
    }
    setFilling(todo.length)
    let ok = 0
    for (const o of todo) {
      const p = await loadPrice(o.orderId)
      if (p) ok++
      setPriceVer((v) => v + 1)
      setFilling((n) => Math.max(0, n - 1))
      await new Promise((r) => setTimeout(r, 400))
    }
    toast.success(`金额补全完成：${ok}/${todo.length}`)
  }

  const doSync = async () => {    setSyncing(true)
    try {
      const r = await imApi.orderSync(20)
      if (r.cooldownUntil) {
        setCooldown(r.cooldownUntil)
        toast.warning('碰到风控了，30 分钟后再同步')
      } else {
        toast.success(`已拉取 ${r.saved}/${r.tried} 个订单`)
      }
      await loadTabs()
      await loadList(tab)
    } catch (e) {
      toast.error('同步失败：' + (e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const cooling = cooldown > Date.now()

  return (
    <>
      <Header>
        <div className='me-auto flex items-center gap-2'>
          <h1 className='text-base font-semibold'>订单</h1>
          <Badge variant='outline'>{counts?.all ?? 0} 单</Badge>
        </div>
        <Button size='sm' variant='outline' onClick={() => void doSync()} disabled={syncing || cooling}>
          <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />
          {cooling ? '风控冷却中' : '同步订单'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => void fillPrices()}
          disabled={filling > 0 || !rows.length}
          title='读取每单详情，把「实收款」拆成 现金 + 闲鱼币，并算出开票金额'
        >
          <Coins className={cn('size-3.5', filling > 0 && 'animate-pulse')} />
          {filling > 0 ? `补全中…剩 ${filling}` : '补全金额'}
        </Button>
      </Header>

      <Main fixed fluid>
        <div className='flex h-full min-h-0 flex-col gap-3'>
          {/* tab 条：文字右上角冒泡计数 */}
          <div className='flex flex-wrap items-center gap-1 border-b pb-2'>
            {ORDER_TABS.map((t) => {
              const n = counts ? counts[t.key] || 0 : 0
              const active = tab === t.key
              return (
                <Button
                  key={t.key}
                  variant={active ? 'secondary' : 'ghost'}
                  size='sm'
                  onClick={() => setTab(t.key)}
                  className={cn('h-8 gap-0.5 px-2 text-[13px]', active && 'font-semibold')}
                >
                  {t.label}
                  {n > 0 ? (
                    <sup className='ml-0.5 rounded-full bg-red-500 px-1 text-[10px] leading-4 font-normal text-white'>
                      {n > 999 ? '999+' : n}
                    </sup>
                  ) : null}
                </Button>
              )
            })}
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto [&>div]:!block'>
            <div className='flex flex-col gap-2 pe-1'>
              {loading ? (
                <>
                  <Skeleton className='h-24 w-full' />
                  <Skeleton className='h-24 w-full' />
                  <Skeleton className='h-24 w-full' />
                </>
              ) : rows.length === 0 ? (
                <Card>
                  <CardContent className='py-10 text-center text-sm text-muted-foreground'>
                    这个分类下还没有订单数据
                    <p className='mt-1 text-xs'>
                      订单号只从聊天里的订单卡片提取，点右上「同步订单」可以慢慢补齐（每个约 1 秒）
                    </p>
                  </CardContent>
                </Card>
              ) : (
                rows.map((o) => <OrderLine key={o.orderId} o={o} priceVer={priceVer} onShipped={() => void loadList(tab)} />)
              )}
            </div>
          </div>
        </div>
      </Main>
    </>
  )
}
