import { useCallback, useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, MessageSquare, RefreshCw, ShoppingBag, Users, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import {
  Area,
  AreaChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { UserAvatar } from '@/features/im/components/user-avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { imApi, type OverviewStats } from '@/lib/im'

const PIE_COLORS = ['#16a34a', '#f59e0b', '#ef4444', '#6366f1', '#06b6d4', '#a855f7', '#64748b']

/** 状态语义配色：成交=绿、待办=橙、退款=红、已关闭=灰 */
const STATUS_COLOR: Record<string, string> = {
  trade_success: '#16a34a',
  seller_to_send: '#f59e0b',
  buyer_to_confirm: '#0ea5e9',
  refund_by_buyer: '#ef4444',
  refund_by_seller: '#ef4444',
  refund_success: '#94a3b8',
  seller_send: '#0ea5e9',
}

const STATUS_LABEL: Record<string, string> = {
  seller_to_send: '待发货',
  buyer_to_confirm: '待买家确认',
  trade_success: '交易成功',
  refund_by_buyer: '买家申请退款',
  refund_success: '已退款关闭',
}

function yuan(n: number) {
  return '¥' + (Math.round((n || 0) * 100) / 100).toLocaleString('zh-CN')
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof Wallet
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <Card>
      <CardContent className='flex items-start gap-3 py-4'>
        <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-md bg-muted', accent)}>
          <Icon className='size-4' />
        </div>
        <div className='flex min-w-0 flex-col'>
          <span className='text-xs text-muted-foreground'>{label}</span>
          <span className='text-xl font-semibold leading-tight'>{value}</span>
          {sub ? <span className='mt-0.5 text-[11px] text-muted-foreground'>{sub}</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewStats | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await imApi.overview(7))
    } catch (e) {
      toast.error('拉统计失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const d = data
  const trend = d?.trend || []
  const inTotal = trend.reduce((s, t) => s + t.in, 0)
  const outTotal = trend.reduce((s, t) => s + t.out, 0)

  const pie = (d?.orderStatus || []).map((s) => ({
    name: STATUS_LABEL[s.status] || s.text || s.status,
    value: s.n,
    color: STATUS_COLOR[s.status] || PIE_COLORS[0],
  }))

  return (
    <>
      <Header>
        <div className='me-auto flex items-center gap-2'>
          <h1 className='text-base font-semibold'>概览</h1>
          <Badge variant='outline'>近 7 天</Badge>
        </div>
        <Button size='sm' variant='outline' onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          刷新
        </Button>
      </Header>

      <Main fluid>
        <div className='flex flex-col gap-4'>
          {/* 第一行：今日/累计 */}
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
            {loading && !d ? (
              <>
                <Skeleton className='h-[86px]' />
                <Skeleton className='h-[86px]' />
                <Skeleton className='h-[86px]' />
                <Skeleton className='h-[86px]' />
              </>
            ) : (
              <>
                <StatCard
                  icon={MessageSquare}
                  label='今日消息'
                  value={String((d?.today.messagesIn || 0) + (d?.today.messagesOut || 0))}
                  sub={`客户 ${d?.today.messagesIn || 0} · 我 ${d?.today.messagesOut || 0}`}
                  accent='bg-sky-500/10 text-sky-600'
                />
                <StatCard
                  icon={Users}
                  label='今日新会话'
                  value={String(d?.today.sessions || 0)}
                  sub={`累计会话 ${d?.totals.sessions || 0}`}
                  accent='bg-violet-500/10 text-violet-600'
                />
                <StatCard
                  icon={ShoppingBag}
                  label='今日订单'
                  value={String(d?.today.orders || 0)}
                  sub={`累计 ${d?.totals.orders || 0} 单`}
                  accent='bg-amber-500/10 text-amber-600'
                />
                <StatCard
                  icon={Wallet}
                  label='累计成交额'
                  value={yuan(d?.totals.amount || 0)}
                  sub={`今日 ${yuan(d?.today.amount || 0)}`}
                  accent='bg-emerald-500/10 text-emerald-600'
                />
              </>
            )}
          </div>

          {/* 第二行：待办 */}
          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>待办</CardTitle>
              <CardDescription className='text-xs'>需要你今天处理的活儿</CardDescription>
            </CardHeader>
            <CardContent className='grid gap-3 pt-1 sm:grid-cols-4'>
              {[
                { k: '未读会话', v: d?.pending.unreadSessions || 0, href: '/im' },
                { k: '待发货', v: d?.pending.unshipped || 0, href: '/orders' },
                { k: '退款中', v: d?.pending.refunding || 0, href: '/orders' },
                { k: '待评价', v: d?.pending.unrated || 0, href: '/orders' },
              ].map((x) => (
                <a
                  key={x.k}
                  href={x.href}
                  className='flex items-center justify-between rounded-md border px-3 py-2 transition-colors hover:bg-muted/60'
                >
                  <span className='text-xs text-muted-foreground'>{x.k}</span>
                  <span className={cn('text-lg font-semibold', x.v > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                    {x.v}
                  </span>
                </a>
              ))}
            </CardContent>
          </Card>

          {/* 第三行：趋势 + 状态分布 */}
          <div className='grid gap-3 lg:grid-cols-5'>
            <Card className='lg:col-span-3'>
              <CardHeader className='pb-1'>
                <CardTitle className='text-sm'>消息趋势</CardTitle>
                <CardDescription className='text-xs'>
                  近 7 天 客户 {inTotal} 条 · 我 {outTotal} 条
                </CardDescription>
              </CardHeader>
              <CardContent className='h-[260px] pt-2'>
                {trend.length ? (
                  <ResponsiveContainer width='100%' height='100%'>
                    <AreaChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                      <defs>
                        <linearGradient id='gIn' x1='0' y1='0' x2='0' y2='1'>
                          <stop offset='5%' stopColor='#0ea5e9' stopOpacity={0.35} />
                          <stop offset='95%' stopColor='#0ea5e9' stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id='gOut' x1='0' y1='0' x2='0' y2='1'>
                          <stop offset='5%' stopColor='#10b981' stopOpacity={0.35} />
                          <stop offset='95%' stopColor='#10b981' stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey='date' tickLine={false} axisLine={false} fontSize={11} />
                      <YAxis tickLine={false} axisLine={false} fontSize={11} width={44} />
                      <Tooltip
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        formatter={(v, n) => [String(v ?? 0) + ' 条', n === 'in' ? '客户' : '我']}
                      />
                      <Legend
                        verticalAlign='top'
                        height={22}
                        iconType='circle'
                        wrapperStyle={{ fontSize: 11 }}
                        formatter={(v: string) => (v === 'in' ? '客户发来' : '我发出')}
                      />
                      <Area type='monotone' dataKey='in' stroke='#0ea5e9' fill='url(#gIn)' strokeWidth={2} />
                      <Area type='monotone' dataKey='out' stroke='#10b981' fill='url(#gOut)' strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className='flex h-full items-center justify-center text-xs text-muted-foreground'>暂无数据</div>
                )}
              </CardContent>
            </Card>

            <Card className='lg:col-span-2'>
              <CardHeader className='pb-1'>
                <CardTitle className='text-sm'>订单状态分布</CardTitle>
                <CardDescription className='text-xs'>共 {d?.totals.orders || 0} 单</CardDescription>
              </CardHeader>
              <CardContent className='h-[260px] pt-2'>
                {pie.length ? (
                  <ResponsiveContainer width='100%' height='100%'>
                    <PieChart>
                      <Pie data={pie} dataKey='value' nameKey='name' innerRadius={46} outerRadius={78} paddingAngle={2}>
                        {pie.map((p, i) => (
                          <Cell key={i} fill={p.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                        formatter={(v, n) => [String(v ?? 0) + ' 单', String(n ?? '')]}
                      />
                      <Legend verticalAlign='bottom' height={38} iconType='circle' wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className='flex h-full items-center justify-center text-xs text-muted-foreground'>暂无数据</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 第四行：活跃客户 + 最近订单 */}
          <div className='grid gap-3 lg:grid-cols-2'>
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>最活跃客户</CardTitle>
                <CardDescription className='text-xs'>按客户发来的消息数排序</CardDescription>
              </CardHeader>
              <CardContent className='flex flex-col gap-1 pt-1'>
                {(d?.topCustomers || []).map((c, i) => (
                  <div key={c.userId} className='flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60'>
                    <span className='w-4 text-center text-[11px] text-muted-foreground'>{i + 1}</span>
                    <UserAvatar src={c.avatar} name={c.nick} className='size-7' fallbackClassName='text-[10px]' />
                    <span className='min-w-0 flex-1 truncate text-xs'>{c.nick || '客户 ' + c.userId}</span>
                    <span className='text-[11px] text-muted-foreground'>{c.msgs} 条</span>
                  </div>
                ))}
                {!d?.topCustomers?.length ? (
                  <span className='py-4 text-center text-xs text-muted-foreground'>暂无数据</span>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>最近订单</CardTitle>
                <CardDescription className='text-xs'>按创建时间倒序</CardDescription>
              </CardHeader>
              <CardContent className='flex flex-col divide-y pt-1'>
                {(d?.recentOrders || []).map((o) => (
                  <div key={o.orderId} className='flex items-center gap-2 py-1.5'>
                    {o.pic ? (
                      <img
                        src={o.pic}
                        alt={o.title}
                        referrerPolicy='no-referrer'
                        className='size-8 shrink-0 rounded object-cover'
                      />
                    ) : (
                      <div className='size-8 shrink-0 rounded bg-muted' />
                    )}
                    <div className='flex min-w-0 flex-1 flex-col'>
                      <span className='truncate text-xs'>{o.title || '（无标题）'}</span>
                      <span className='text-[11px] text-muted-foreground'>
                        {o.createTime} · {o.buyer?.nick || '—'}
                      </span>
                    </div>
                    <div className='flex shrink-0 flex-col items-end'>
                      <span className='text-xs font-medium'>¥{o.price || '0.00'}</span>
                      <span className='text-[11px] text-muted-foreground'>{STATUS_LABEL[o.status] || o.statusText}</span>
                    </div>
                  </div>
                ))}
                {!d?.recentOrders?.length ? (
                  <span className='py-4 text-center text-xs text-muted-foreground'>暂无数据</span>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Separator />
          <div className='flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground'>
            <span className='inline-flex items-center gap-1'>
              <ArrowDownRight className='size-3' /> 客户发来
            </span>
            <span className='inline-flex items-center gap-1'>
              <ArrowUpRight className='size-3' /> 我发出
            </span>
            <span>累计消息 {d?.totals.messages || 0} 条 · 客户档案 {d?.totals.customers || 0} 个</span>
          </div>
        </div>
      </Main>
    </>
  )
}
