import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  FlaskConical,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { imApi, type TrainContext, type TrainItem, type TrainDraft, type TrainStats } from '@/lib/im'

export function TrainPage() {
  const [q, setQ] = useState('')
  const [sid, setSid] = useState('')
  const [asking, setAsking] = useState(false)
  const [item, setItem] = useState<TrainItem | null>(null)
  const [fixing, setFixing] = useState(false)
  const [corrected, setCorrected] = useState('')
  const [note, setNote] = useState('')
  const [items, setItems] = useState<TrainItem[]>([])
  const [stats, setStats] = useState<TrainStats | null>(null)
  const [drafts, setDrafts] = useState<TrainDraft[]>([])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [distilling, setDistilling] = useState(false)
  const [applying, setApplying] = useState(false)
  const [contexts, setContexts] = useState<TrainContext[]>([])
  const [itemId, setItemId] = useState('')
  const current = contexts.find((c) => c.itemId === itemId)

  const load = useCallback(async () => {
    try {
      const r = await imApi.trainList(80)
      setItems(r.items)
      setStats(r.stats)
    } catch (e) {
      toast.error('读取训练记录失败：' + (e as Error).message)
    }
  }, [])

  const loadContexts = useCallback(async () => {
    try {
      const r = await imApi.trainContexts()
      setContexts(r.items)
    } catch {
      /* 没绑定商品时为空，不影响训练 */
    }
  }, [])

  useEffect(() => {
    void load()
    void loadContexts()
  }, [load, loadContexts])

  // 从「运行日志」点「拿去训练」跳过来时，自动带问题并问一次
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    const sp = new URLSearchParams(window.location.search)
    const text = sp.get('text')
    if (!text) return
    const iid = sp.get('itemId') || ''
    setQ(text)
    if (iid) setItemId(iid)
    if (sp.get('sid')) setSid(sp.get('sid') || '')
    setTimeout(() => void ask(text, iid), 120)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ask = async (textArg?: string, itemArg?: string) => {
    const text = (textArg ?? q).trim()
    const iid = itemArg ?? itemId
    const ctxItem = contexts.find((c) => c.itemId === iid)
    if (!text) {
      toast.error('先写一句客户会问的话')
      return
    }
    setAsking(true)
    setItem(null)
    setFixing(false)
    setCorrected('')
    setNote('')
    try {
      const r = await imApi.trainAsk(text, sid.trim() || undefined, iid || undefined, ctxItem?.itemTitle)
      setItem(r)
      if (!r.ok) toast.error(r.note || '模型没给出答案（检查 AI 配置）')
      else if (r.selfcheck && !JSON.parse(r.selfcheck || '{}').ok) toast.warning('自检没通过，答案被拦了')
      void load()
    } catch (e) {
      toast.error('提问失败：' + (e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  const judge = async (verdict: 'good' | 'bad') => {
    if (!item) return
    if (verdict === 'bad' && !fixing) {
      setFixing(true)
      setCorrected(item.answer || '')
      return
    }
    try {
      const r = await imApi.trainLabel({
        id: item.id,
        verdict,
        corrected: verdict === 'bad' ? corrected : undefined,
        note: note || undefined,
      })
      setItem(r.item)
      setFixing(false)
      toast.success(verdict === 'good' ? '记下了：答得好' : '记下了：已修正')
      void load()
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    }
  }

  const distill = async () => {
    setDistilling(true)
    try {
      const r = await imApi.trainDistill()
      setDrafts(r.drafts)
      const p: Record<string, boolean> = {}
      r.drafts.forEach((d) => (p[d.id] = true))
      setPicked(p)
      if (!r.drafts.length) toast.message('还没有「判错 + 写了修正」的样本，先攒几条')
      else toast.success(`归纳出 ${r.drafts.length} 条规则草稿`)
    } catch (e) {
      toast.error('归纳失败：' + (e as Error).message)
    } finally {
      setDistilling(false)
    }
  }

  const apply = async () => {
    const chosen = drafts.filter((d) => picked[d.id])
    if (!chosen.length) {
      toast.error('先勾选要写入的规则')
      return
    }
    setApplying(true)
    try {
      const r = await imApi.trainApply(chosen)
      toast.success(`已写入规则：新增 ${r.added} 条、更新 ${r.updated} 条，现有 ${r.total} 条`)
      setDrafts([])
      setPicked({})
    } catch (e) {
      toast.error('写入失败：' + (e as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const openItem = (it: TrainItem) => {
    setItem(it)
    setQ(it.question)
    setFixing(false)
    setCorrected(it.corrected || '')
    setNote(it.note || '')
  }

  return (
    <>
      <Header fixed>
        <div className='flex flex-1 items-center gap-2'>
          <FlaskConical className='size-4 text-muted-foreground' />
          <h1 className='text-base font-medium'>回复训练</h1>
          {stats && (
            <Badge variant='outline' className='ms-1'>
              样本 {stats.total} · 好评 {stats.good} · 判错 {stats.bad} · 已修正 {stats.fixed}
            </Badge>
          )}
        </div>
        <div className='ms-auto flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={() => void load()}>
            <RefreshCw className='me-1 size-4' /> 刷新
          </Button>
          <Button size='sm' onClick={() => void distill()} disabled={distilling}>
            {distilling ? <Loader2 className='me-1 size-4 animate-spin' /> : <Wand2 className='me-1 size-4' />}
            归纳成规则
          </Button>
        </div>
      </Header>

      <Main fluid>
        <div className='grid gap-4 lg:grid-cols-[260px_1fr_320px]'>
          {/* 左：历史 */}
          <Card className='flex min-h-0 flex-col'>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>训练记录</CardTitle>
            </CardHeader>
            <CardContent className='min-h-0 flex-1 p-0'>
              <ScrollArea className='h-[calc(100vh-220px)] [&>[data-slot=scroll-area-viewport]>div]:!block'>
                <div className='space-y-1 p-2'>
                  {items.length === 0 && <p className='p-2 text-xs text-muted-foreground'>还没有记录</p>}
                  {items.map((it) => (
                    <button
                      key={it.id}
                      onClick={() => openItem(it)}
                      className={cn(
                        'w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                        item?.id === it.id ? 'border-primary/40 bg-accent' : 'border-transparent'
                      )}
                    >
                      <div className='flex items-center gap-1'>
                        {it.verdict === 'good' && <ThumbsUp className='size-3 text-emerald-600' />}
                        {it.verdict === 'bad' && <ThumbsDown className='size-3 text-red-600' />}
                        {!it.verdict && <span className='size-1.5 rounded-full bg-amber-500' />}
                        <span className='line-clamp-1 flex-1'>{it.question}</span>
                      </div>
                      <div className='mt-1 line-clamp-1 text-[11px] text-muted-foreground'>
                        {it.corrected || it.answer || '（空）'}
                      </div>
                      {it.item_title && (
                        <div className='mt-0.5 line-clamp-1 text-[10px] text-sky-600'>商品：{it.item_title}</div>
                      )}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* 中：提问 + 判定 */}
          <div className='space-y-4'>
            <Card>
              <CardHeader className='pb-3'>
                <CardTitle className='text-base'>提问</CardTitle>
                <CardDescription>以客户身份发一句，让模型按当前规则和话术回答（不会发给任何客户）</CardDescription>
              </CardHeader>
              <CardContent className='space-y-3'>
                <Textarea
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder='例：你们这个保险住院能报吗'
                  className='min-h-[72px]'
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask()
                  }}
                />
                <div className='flex flex-wrap items-center gap-2'>
                  <Select value={itemId || 'none'} onValueChange={(v) => setItemId(v === 'none' ? '' : v)}>
                    <SelectTrigger className='h-9 w-72 [&>span]:truncate'>
                      <SelectValue placeholder='商品上下文' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='none'>不指定（按会话，或没有商品）</SelectItem>
                      {contexts.map((c) => (
                        <SelectItem key={c.itemId} value={c.itemId}>
                          {c.itemTitle || c.itemId} · {c.planName || c.planCode}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className='h-9 w-44'
                    value={sid}
                    onChange={(e) => setSid(e.target.value)}
                    placeholder='会话 ID（可选）'
                  />
                  <Button size='sm' onClick={() => void ask()} disabled={asking}>
                    {asking ? <Loader2 className='me-1 size-4 animate-spin' /> : <Send className='me-1 size-4' />}
                    让模型答
                  </Button>
                  <span className='text-xs text-muted-foreground'>Ctrl/⌘ + Enter 也可以</span>
                </div>
                {!!current && (
                  <p className='text-xs text-muted-foreground'>
                    当前商品会带进 prompt：条款、保障内容、须知都按它取 —— 同一句「保不保」换商品答案就不同。
                  </p>
                )}
              </CardContent>
            </Card>

            {item && (
              <Card>
                <CardHeader className='pb-3'>
                  <CardTitle className='text-base'>模型答案</CardTitle>
                  <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
                    {item.source && <Badge variant='secondary'>{item.source}</Badge>}
                    {item.model && <span>模型 {item.model}</span>}
                    {item.verdict === 'good' && <Badge className='bg-emerald-600'>已判：好</Badge>}
                    {item.verdict === 'bad' && <Badge variant='destructive'>已判：要改</Badge>}
                  </div>
                </CardHeader>
                <CardContent className='space-y-3'>
                  <div className='rounded-md border bg-muted/40 p-3 text-sm leading-6'>
                    {item.answer || <span className='text-muted-foreground'>（空）{item.note || ''}</span>}
                  </div>

                  {!fixing ? (
                    <div className='flex flex-wrap gap-2'>
                      <Button size='sm' onClick={() => void judge('good')}>
                        <ThumbsUp className='me-1 size-4' /> 答得好
                      </Button>
                      <Button size='sm' variant='outline' onClick={() => void judge('bad')}>
                        <ThumbsDown className='me-1 size-4' /> 不对，我来改
                      </Button>
                    </div>
                  ) : (
                    <div className='space-y-2 rounded-md border border-amber-300 bg-amber-50/60 p-3'>
                      <Label className='text-xs'>应该怎么回（这句以后会被当成标准答案）</Label>
                      <Textarea
                        value={corrected}
                        onChange={(e) => setCorrected(e.target.value)}
                        className='min-h-[64px] bg-background'
                      />
                      <Input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder='为什么错（可选）：语气太硬 / 承诺了不该承诺的 / 没说清…'
                      />
                      <div className='flex gap-2'>
                        <Button size='sm' onClick={() => void judge('bad')}>
                          <Check className='me-1 size-4' /> 保存修正
                        </Button>
                        <Button size='sm' variant='ghost' onClick={() => setFixing(false)}>
                          <X className='me-1 size-4' /> 取消
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {drafts.length > 0 && (
              <Card>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Sparkles className='size-4' /> 归纳出的规则草稿（{drafts.length}）
                  </CardTitle>
                  <CardDescription>勾选后写入 rules.json，优先级 195；按商品归纳的规则只对那个商品生效</CardDescription>
                </CardHeader>
                <CardContent className='space-y-2'>
                  {drafts.map((d) => (
                    <label
                      key={d.id}
                      className='flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs hover:bg-accent'
                    >
                      <input
                        type='checkbox'
                        className='mt-1'
                        checked={Boolean(picked[d.id])}
                        onChange={(e) => setPicked((p) => ({ ...p, [d.id]: e.target.checked }))}
                      />
                      <div className='min-w-0 flex-1'>
                        <div className='flex flex-wrap items-center gap-1'>
                          <span className='font-medium'>{d.id}</span>
                          <Badge variant='outline'>{d.samples} 条样本</Badge>
                          {d.when?.itemId || d.itemId ? (
                            <Badge className='bg-sky-600'>限商品：{(d.itemTitle || d.when?.itemTitle || d.itemId || '').slice(0, 18)}</Badge>
                          ) : (
                            <Badge variant='secondary'>全局</Badge>
                          )}
                        </div>
                        <div className='mt-1 text-muted-foreground'>
                          触发词：{(d.match.keywords || []).join(' / ') || '（无）'}
                        </div>
                        <div className='mt-1 rounded bg-muted/50 p-1.5 leading-5'>{d.reply}</div>
                      </div>
                    </label>
                  ))}
                  <div className='flex justify-end gap-2 pt-1'>
                    <Button size='sm' variant='ghost' onClick={() => setDrafts([])}>
                      丢弃
                    </Button>
                    <Button size='sm' onClick={() => void apply()} disabled={applying}>
                      {applying ? <Loader2 className='me-1 size-4 animate-spin' /> : <Check className='me-1 size-4' />}
                      写入规则
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* 右：统计与方法 */}
          <div className='space-y-4'>
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>进度</CardTitle>
              </CardHeader>
              <CardContent className='space-y-2 text-xs'>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>已测样本</span>
                  <span>{stats?.total ?? 0}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>答得好</span>
                  <span className='text-emerald-600'>{stats?.good ?? 0}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>判错</span>
                  <span className='text-red-600'>{stats?.bad ?? 0}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>已写修正</span>
                  <span>{stats?.fixed ?? 0}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>待判</span>
                  <span className='text-amber-600'>{stats?.unlabeled ?? 0}</span>
                </div>
                <div className='mt-2 h-2 overflow-hidden rounded-full bg-muted'>
                  <div
                    className='h-full bg-emerald-500'
                    style={{ width: `${Math.min(100, stats?.rate ?? 0)}%` }}
                  />
                </div>
                <p className='text-[11px] text-muted-foreground'>好评率 {stats?.rate ?? 0}%</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>这套方法怎么用</CardTitle>
              </CardHeader>
              <CardContent className='space-y-2 text-[11px] leading-5 text-muted-foreground'>
                <p>
                  <span className='font-medium text-foreground'>1. 出题</span>：把客户常问的、刁钻的都问一遍（一次一条，越接近真实说法越好）。
                </p>
                <p>
                  <span className='font-medium text-foreground'>2. 判</span>：答得好点「答得好」；不对就点「我来改」，写你希望的标准回答。
                </p>
                <p>
                  <span className='font-medium text-foreground'>3. 归纳</span>：攒够一批点「归纳成规则」，系统按「同一句修正」聚成规则，触发词自动从问句里抽。
                </p>
                <p>
                  <span className='font-medium text-foreground'>4. 再测</span>：写入规则后再问同样的问题，应当直接命中规则、不再走 AI。
                </p>
                <p className='text-amber-600'>
                  注意：归纳只覆盖「能写成固定话术」的问题；需要看上下文才能答的（报价、出单进度），应该由 AI + 条款去答，别硬写规则。
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </Main>
    </>
  )
}
