import { useCallback, useEffect, useState } from 'react'
import { Coins, Loader2 } from 'lucide-react'
import { imApi, type OrderPrice, type OrderRow } from '@/lib/im'
import { cn } from '@/lib/utils'

/**
 * 订单金额：现金 + 闲鱼币
 *
 * 平台的「实付款」只是支付宝担保账户里的现金，买家若用了闲鱼币抵扣，
 * 真实成交额 = 现金 + 闲鱼币抵扣，开票要按这个合计开。
 * 数据来自 mtop.idle.web.trade.order.detail（网页订单详情页同款），
 * 服务端 6 小时内缓存，所以重复打开页面不会反复请求。
 */
const cache = new Map<string, OrderPrice | null>()

export function getCachedPrice(orderId: string): OrderPrice | null | undefined {
  return cache.get(orderId)
}

export async function loadPrice(orderId: string, refresh = false): Promise<OrderPrice | null> {
  if (!orderId) return null
  if (!refresh && cache.has(orderId)) return cache.get(orderId) ?? null
  try {
    const r = await imApi.orderPrice(orderId, refresh)
    const p = r.ok ? r.price : null
    cache.set(orderId, p)
    return p
  } catch {
    cache.set(orderId, null)
    return null
  }
}

const money = (n: number | null | undefined) =>
  n == null ? '' : n.toFixed(2)

export function OrderAmount({
  order,
  auto = false,
  version = 0,
  className,
}: {
  order: OrderRow
  /** true 时进页面就自动补全（默认只在点「补全金额」时请求，避免一次打开几十单） */
  auto?: boolean
  /** 外部批量补全时递增，用来把缓存的金额刷进卡片 */
  version?: number
  className?: string
}) {
  const cached = cache.get(order.orderId)
  const [price, setPrice] = useState<OrderPrice | null>(cached ?? null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true)
      setFailed(false)
      const p = await loadPrice(order.orderId, refresh)
      setPrice(p)
      setLoading(false)
      if (!p) setFailed(true)
    },
    [order.orderId]
  )

  useEffect(() => {
    if (auto && cache.get(order.orderId) === undefined) void load()
  }, [auto, load, order.orderId])

  // 批量补全后，把结果同步进卡片
  useEffect(() => {
    const c = cache.get(order.orderId)
    if (c !== undefined) setPrice(c ?? null)
  }, [version, order.orderId])

  // 还不知道拆分明细：先按老样子显示实付，给一个补全入口
  if (!price) {
    return (
      <span className={cn('inline-flex items-center gap-1', className)}>
        <span className='text-sm font-medium'>¥{order.price || '0.00'}</span>
        <span className='text-xs text-muted-foreground'>{order.priceLabel || '实收款'}</span>
        <button
          type='button'
          className='inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground'
          title='读取订单详情，拆出「现金 + 闲鱼币」并算出开票金额'
          disabled={loading}
          onClick={() => void load(true)}
        >
          {loading ? <Loader2 className='size-2.5 animate-spin' /> : <Coins className='size-2.5' />}
          {failed ? '重试金额' : '补全金额'}
        </button>
      </span>
    )
  }

  const cash = money(price.cashAmount)
  const coins = price.coinCount ?? 0
  const total = money(price.invoiceTotal)

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
      <span className='text-sm font-medium'>
        金额：¥{cash}
        {coins > 0 ? <span className='text-amber-600 dark:text-amber-400'>+（闲鱼币）{coins}</span> : null}
      </span>
      {coins > 0 ? (
        <span className='text-[11px] text-muted-foreground'>
          合计 / 开票 ¥{total}
        </span>
      ) : null}
    </span>
  )
}
