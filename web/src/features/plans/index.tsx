import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  fmtTime,
  imApi,
  type BindingRow,
  type PlanFull,
  type PlanJob,
  type PlanTier,
  type PlansResp,
  type ProductRow,
} from '@/lib/im'

function money(n?: number) {
  if (!n && n !== 0) return '-'
  return `¥${Number(n).toFixed(2)}`
}

export function PlansPage() {
  const [q, setQ] = useState('')
  const [company, setCompany] = useState('')
  const [cls, setCls] = useState('')
  const [resp, setResp] = useState<PlansResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [openKey, setOpenKey] = useState('')
  const [planCode, setPlanCode] = useState('')
  const [plan, setPlan] = useState<PlanFull | null>(null)
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [itemPick, setItemPick] = useState('')
  const [items, setItems] = useState<ProductRow[]>([])
  const [job, setJob] = useState<PlanJob | null>(null)
  const [jobSaving, setJobSaving] = useState(false)

  const products = resp?.products || []
  const facets = resp?.facets

  const openPlan = useCallback(async (code: string) => {
    if (!code) return
    setPlanCode(code)
    try {
      const r = await imApi.plan(code)
      setPlan(r.plan)
      setBindings(r.bindings || [])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }, [])

  const load = useCallback(
    async (opts: { q?: string; company?: string; cls?: string } = {}) => {
      setLoading(true)
      try {
        const r = await imApi.plans({
          q: opts.q ?? q,
          company: opts.company ?? company,
          cls: opts.cls ?? cls,
          limit: 400,
        })
        setResp(r)
        const first = r.products[0]
        const stillThere = r.products.find((p) => p.key === openKey)
        if (stillThere) {
          const keep = stillThere.plans.find((p) => p.planCode === planCode) || stillThere.plans[0]
          await openPlan(keep.planCode)
        } else if (first) {
          setOpenKey(first.key)
          await openPlan(first.plans[0].planCode)
        } else {
          setOpenKey('')
          setPlanCode('')
          setPlan(null)
          setBindings([])
        }
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, company, cls, openKey, planCode]
  )

  const loadJob = useCallback(async () => {
    try {
      setJob(await imApi.planJob())
    } catch {
      /* 刷新任务状态拿不到不影响主流程 */
    }
  }, [])

  const toggleAuto = useCallback(async (enabled: boolean, hour?: number) => {
    setJobSaving(true)
    try {
      const r = await imApi.planJobSave({ enabled, ...(hour != null ? { hour } : {}) })
      setJob(r)
      toast.success(enabled ? `已开启：每天 ${String(r.hour).padStart(2, '0')}:00 自动刷新` : '已关闭自动刷新')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setJobSaving(false)
    }
  }, [])

  const runNow = useCallback(async () => {
    try {
      toast.message('开始刷新方案库，85 个档位大概要几分钟…')
      const r = await imApi.planJobRun()
      setJob(r)
      toast.success(`刷新完成：成功 ${r.ok} / 失败 ${r.fail}`)
      await load({})
    } catch (e) {
      toast.error((e as Error).message)
      void loadJob()
    }
  }, [load, loadJob])

  useEffect(() => {
    void load({ q: '', company: '', cls: '' })
    void loadJob()
    void imApi
      .products()
      .then((r) => setItems(r.products || []))
      .catch(() => setItems([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 刷新进行中时每 3 秒刷一次进度
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(() => void loadJob(), 3000)
    return () => clearInterval(t)
  }, [job?.running, loadJob])

  const current = useMemo(() => products.find((p) => p.key === openKey), [products, openKey])

  const pickProduct = async (key: string) => {
    setOpenKey(key)
    const p = products.find((x) => x.key === key)
    if (p) await openPlan(p.plans[0].planCode)
  }

  const sync = async () => {
    setLoading(true)
    try {
      const r = await imApi.plansSync({ limit: 200, detail: true })
      toast.success(`同步完成：目录 ${r.catalog ?? 0} 个，详情 ${r.detailSynced ?? 0} 个`)
      await load({})
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const bind = async () => {
    if (!plan) return
    const id = itemPick.trim()
    if (!id) return toast.error('先选一个已上架商品')
    const hit = items.find((x) => x.itemId === id)
    try {
      // 按「方案」绑定：只传 productCode，默认档由后端取（计划一），不用逐档绑
      await imApi.bindPlan(id, undefined, hit?.title || '', current?.key)
      toast.success('已绑定到方案「' + (current?.name || current?.key || '') + '」')
      setItemPick('')
      await openPlan(plan.planCode)
      await load({})
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const unbind = async (id: string) => {
    try {
      await imApi.unbindPlan(id)
      toast.success('已解绑')
      if (plan) await openPlan(plan.planCode)
      await load({})
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const tier: PlanTier | undefined = current?.plans.find((p) => p.planCode === planCode)
  const ratio = Number(tier?.realPercent || 0) || 1

  return (
    <>
      <Header fixed>
        <div className='me-auto flex items-center gap-2'>
          <ShieldCheck className='size-5' />
          <h1 className='text-lg font-semibold'>保险平台</h1>
          <Badge variant='secondary'>{products.length} 个产品</Badge>
          <Badge variant='outline'>{resp?.count ?? 0} 个保额档</Badge>
        </div>
        <Button size='sm' variant='outline' onClick={sync} disabled={loading}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          同步方案
        </Button>
      </Header>

      <Main fixed fluid>
        <div className='flex min-h-0 flex-1 flex-col gap-3'>
          {/* 每天自动刷新方案库（开关在 data/plan-sync.json，这里直接改） */}
          <div className='flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 text-xs'>
            <div className='flex items-center gap-2'>
              <Switch
                id='plan-auto'
                checked={!!job?.enabled}
                onCheckedChange={(v) => void toggleAuto(v)}
                disabled={jobSaving}
              />
              <label htmlFor='plan-auto' className='cursor-pointer font-medium'>
                每天自动刷新方案库
              </label>
            </div>
            <div className='flex items-center gap-1.5 text-muted-foreground'>
              每天
              <Select
                value={String(job?.hour ?? 3)}
                onValueChange={(v) => void toggleAuto(!!job?.enabled, Number(v))}
                disabled={jobSaving}
              >
                <SelectTrigger className='h-7 w-[86px] text-xs'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }).map((_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              跑一次（旅云保）
            </div>
            {job?.running ? (
              <span className='flex items-center gap-1.5 text-amber-600'>
                <RefreshCw className='size-3.5 animate-spin' />
                刷新中 {job.done}/{job.total}
                {job.current ? ` · ${job.current}` : ''}
              </span>
            ) : (
              <span className='text-muted-foreground'>
                {job?.lastRunAt
                  ? `上次 ${fmtTime(job.lastRunAt)} · ${job.lastResult || ''}`
                  : '还没跑过'}
              </span>
            )}
            <Button
              size='sm'
              variant='ghost'
              className='ms-auto h-7 text-xs'
              onClick={() => void runNow()}
              disabled={!!job?.running}
            >
              立即刷新
            </Button>
          </div>
          {/* 筛选条 */}
          <div className='flex flex-wrap items-center gap-1.5 text-xs'>
            <button
              onClick={() => {
                setCompany('')
                void load({ company: '' })
              }}
              className={cn(
                'rounded-full border px-2.5 py-1',
                !company ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'
              )}
            >
              全部公司
            </button>
            {(facets?.companies || []).map((c) => (
              <button
                key={c.name}
                onClick={() => {
                  const next = company === c.name ? '' : c.name
                  setCompany(next)
                  void load({ company: next })
                }}
                className={cn(
                  'rounded-full border px-2.5 py-1',
                  company === c.name ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'
                )}
              >
                {c.name} <span className='opacity-60'>{c.n}</span>
              </button>
            ))}
            <span className='mx-2 h-4 w-px bg-border' />
            {(facets?.classes || []).map((k) => (
              <button
                key={k.name}
                onClick={() => {
                  const next = cls === k.name ? '' : k.name
                  setCls(next)
                  void load({ cls: next })
                }}
                className={cn(
                  'rounded-full border px-2.5 py-1',
                  cls === k.name ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'
                )}
              >
                {k.name} <span className='opacity-60'>{k.n}</span>
              </button>
            ))}
          </div>

          <div className='flex min-h-0 flex-1 gap-4'>
            <Card className='flex h-full w-full shrink-0 flex-col sm:w-96'>
              <div className='p-3'>
                <div className='relative'>
                  <Search className='text-muted-foreground absolute top-2.5 left-2.5 size-4' />
                  <Input
                    className='pl-8'
                    placeholder='搜产品名 / 公司 / 方案编码'
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value)
                      void load({ q: e.target.value })
                    }}
                  />
                </div>
              </div>
              <Separator />
              <ScrollArea className='[&>[data-slot=scroll-area-viewport]>div]:!block min-h-0 flex-1'>
                <div className='p-2'>
                  {products.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => void pickProduct(p.key)}
                      className={cn(
                        'hover:bg-accent mb-1 w-full rounded-md border p-2 text-left',
                        openKey === p.key ? 'border-primary bg-accent' : 'border-transparent'
                      )}
                    >
                      <div className='truncate text-sm font-medium'>{p.name}</div>
                      <div className='text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]'>
                        <span>{p.company}</span>
                        <span>·</span>
                        <span>{p.className}</span>
                        <span>·</span>
                        <span>{p.levels} 档</span>
                        <span>·</span>
                        <span>{money(p.quotePrice ?? p.basePrice)} 起</span>
                        {p.boundItems > 0 && (
                          <Badge variant='secondary' className='ml-auto h-4 px-1 text-[10px]'>
                            已绑 {p.boundItems}
                          </Badge>
                        )}
                      </div>
                    </button>
                  ))}
                  {!products.length && (
                    <div className='text-muted-foreground p-6 text-center text-sm'>
                      {loading ? '加载中…' : '没有产品，点右上角「同步方案」'}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </Card>

            <Card className='flex h-full min-h-0 min-w-0 flex-1 flex-col'>
              {!current || !plan ? (
                <div className='text-muted-foreground flex h-full flex-1 items-center justify-center text-sm'>
                  左边选一个产品
                </div>
              ) : (
                <>
                  <CardHeader className='pb-2'>
                    <CardTitle className='text-base'>{current.name}</CardTitle>
                    <div className='text-muted-foreground flex flex-wrap items-center gap-2 text-xs'>
                      <span>{current.company}</span>
                      <span>·</span>
                      <span>{current.className}</span>
                      <span>·</span>
                      <span>
                        承保年龄 {current.minAge} 天 ~ {current.maxAge} 周岁
                      </span>
                      <Badge variant='outline' className='ml-1'>
                        {current.key}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className='min-h-0 flex-1'>
                    {/* 保额档（计划一/二/三…） */}
                    <div className='mb-3 flex flex-wrap gap-1.5'>
                      {current.plans.map((p) => (
                        <button
                          key={p.planCode}
                          onClick={() => void openPlan(p.planCode)}
                          className={cn(
                            'rounded-md border px-2.5 py-1 text-xs',
                            planCode === p.planCode
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'hover:bg-accent'
                          )}
                        >
                          {p.level}
                        </button>
                      ))}
                    </div>

                    <Tabs defaultValue='coverage' className='flex h-full flex-col'>
                      <TabsList>
                        <TabsTrigger value='coverage'>保障内容 {plan.coverage.length}</TabsTrigger>
                        <TabsTrigger value='notice'>投保须知</TabsTrigger>
                        <TabsTrigger value='clause'>条款全文</TabsTrigger>
                        <TabsTrigger value='price'>价目</TabsTrigger>
                        <TabsTrigger value='bind'>绑定商品 {bindings.length}</TabsTrigger>
                      </TabsList>

                      <TabsContent value='coverage' className='min-h-0 flex-1 overflow-auto'>
                        <div className='text-muted-foreground mb-2 text-xs'>
                          当前档：<span className='text-foreground font-medium'>{tier?.level || plan.name}</span>
                          <span className='ml-2 text-foreground'>
                            报价 {money(tier?.quotePrice ?? plan.basePrice)}
                          </span>
                          <span className='ml-2'>
                            成本 {money(tier?.costPrice ?? 0)}
                            {tier?.realPercent ? `（${Math.round(tier.realPercent * 1000) / 10}% 结算）` : ''}
                          </span>
                          <span className='ml-2 font-mono text-[11px]'>{plan.planCode}</span>
                        </div>
                        <table className='w-full text-sm'>
                          <thead className='text-muted-foreground sticky top-0 bg-card text-left text-xs'>
                            <tr>
                              <th className='py-1.5 pr-2'>类别</th>
                              <th className='py-1.5 pr-2'>保障项目</th>
                              <th className='py-1.5'>保额 / 说明</th>
                            </tr>
                          </thead>
                          <tbody>
                            {plan.coverage.map((c, i) => (
                              <tr key={i} className='border-t'>
                                <td className='text-muted-foreground py-1.5 pr-2 text-xs'>{c.group || '—'}</td>
                                <td className='py-1.5 pr-2'>{c.name}</td>
                                <td className='py-1.5 font-medium'>{c.value}</td>
                              </tr>
                            ))}
                            {!plan.coverage.length && (
                              <tr>
                                <td colSpan={3} className='text-muted-foreground py-6 text-center'>
                                  这个档还没同步到保障内容
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </TabsContent>

                      <TabsContent value='notice' className='min-h-0 flex-1 overflow-auto'>
                        <pre className='text-xs leading-relaxed whitespace-pre-wrap'>{plan.notice || '（无）'}</pre>
                      </TabsContent>

                      <TabsContent value='clause' className='min-h-0 flex-1 overflow-auto'>
                        <pre className='text-xs leading-relaxed whitespace-pre-wrap'>
                          {plan.clause || '（无，条款 PDF 没抓到）'}
                        </pre>
                      </TabsContent>

                      <TabsContent value='price' className='min-h-0 flex-1 overflow-auto'>
                        <div className='text-muted-foreground mb-2 text-xs'>
                          「报价」= 客户看到的保费；「成本」= 报价 × 结算比例
                          {tier?.realPercent ? `（${Math.round(tier.realPercent * 1000) / 10}%）` : ''}
                        </div>
                        <div className='grid gap-4 md:grid-cols-2'>
                          <div>
                            <div className='mb-1 text-xs font-medium'>按人数（同一档多被保人）</div>
                            <table className='w-full text-sm'>
                              <thead className='text-muted-foreground text-left text-[11px]'>
                                <tr>
                                  <th className='py-1'>人数</th>
                                  <th className='py-1 text-right'>报价</th>
                                  <th className='py-1 text-right'>成本</th>
                                </tr>
                              </thead>
                              <tbody>
                                {plan.feeTable.map((f, i) => (
                                  <tr key={i} className='border-t'>
                                    <td className='py-1'>
                                      {f.start === f.end ? `${f.start} 人` : `${f.start}-${f.end} 人`}
                                    </td>
                                    <td className='py-1 text-right'>{money(f.price)}</td>
                                    <td className='py-1 text-right text-muted-foreground'>
                                      {money(f.price * ratio)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div>
                            <div className='mb-1 text-xs font-medium'>按天数</div>
                            <table className='w-full text-sm'>
                              <thead className='text-muted-foreground text-left text-[11px]'>
                                <tr>
                                  <th className='py-1'>天数</th>
                                  <th className='py-1 text-right'>报价</th>
                                  <th className='py-1 text-right'>成本</th>
                                </tr>
                              </thead>
                              <tbody>
                                {plan.priceTable.slice(0, 60).map((p, i) => (
                                  <tr key={i} className='border-t'>
                                    <td className='py-1'>{p.days} 天</td>
                                    <td className='py-1 text-right'>{money(p.price)}</td>
                                    <td className='py-1 text-right text-muted-foreground'>
                                      {money(p.price * ratio)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </TabsContent>

                      <TabsContent value='bind' className='min-h-0 flex-1 overflow-auto'>
                        <div className='mb-3 flex flex-wrap items-end gap-2'>
                          <div>
                            <div className='text-muted-foreground mb-1 text-[11px]'>
                              选择已上架商品（{items.length} 个）
                            </div>
                            <select
                              className='border-input bg-background h-9 w-[26rem] rounded-md border px-2 text-sm'
                              value={itemPick}
                              onChange={(e) => setItemPick(e.target.value)}
                            >
                              <option value=''>— 选一个商品 —</option>
                              {items.map((it) => (
                                <option key={it.itemId} value={it.itemId}>
                                  {it.title || it.itemId}（{it.itemId}）· {it.sessions} 会话
                                </option>
                              ))}
                            </select>
                          </div>
                          <Button onClick={bind} disabled={!itemPick}>
                            <Link2 className='size-4' />
                            绑定整个方案（默认 {current?.plans[0]?.level || '计划一'}）
                          </Button>
                        </div>
                        <p className='text-muted-foreground mb-2 text-[11px]'>
                          绑的是「{current?.name || ''}」这个方案，不用一档一档绑；客户买哪一档由订单里的规格决定，报价按当前档算。
                        </p>
                        <table className='w-full text-sm'>
                          <thead className='text-muted-foreground text-left text-xs'>
                            <tr>
                              <th className='py-1.5'>商品</th>
                              <th className='py-1.5'>标题</th>
                              <th className='py-1.5'>绑定方案</th>
                              <th className='py-1.5'></th>
                            </tr>
                          </thead>
                          <tbody>
                            {bindings.map((b) => (
                              <tr key={b.item_id} className='border-t'>
                                <td className='py-1.5 font-mono text-xs'>{b.item_id}</td>
                                <td className='py-1.5'>{b.item_title || '—'}</td>
                                <td className='py-1.5'>
                                  {b.product_code || String(b.plan_code || '').slice(0, 9)}
                                  <span className='text-muted-foreground'>（默认 {b.plan_name || b.plan_code}）</span>
                                </td>
                                <td className='py-1.5 text-right'>
                                  <Button size='sm' variant='ghost' onClick={() => void unbind(b.item_id)}>
                                    <X className='size-4' />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                            {!bindings.length && (
                              <tr>
                                <td colSpan={4} className='text-muted-foreground py-6 text-center'>
                                  这个档还没绑商品
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </>
              )}
            </Card>
          </div>
        </div>
      </Main>
    </>
  )
}
