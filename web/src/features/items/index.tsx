import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, HelpCircle, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { imApi, type ClauseHit, type ProductDetail, type ProductDoc, type ProductRow } from '@/lib/im'

const KIND_LABEL: Record<string, string> = {
  docx: 'Word',
  pdf: 'PDF',
  txt: '文本',
  md: 'Markdown',
  csv: 'CSV',
  json: 'JSON',
}

function money(n: number) {
  return '¥' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('zh-CN')
}

export function ItemsPage() {
  const [list, setList] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [itemId, setItemId] = useState('')
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteName, setPasteName] = useState('保险条款.txt')
  const [pasteText, setPasteText] = useState('')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<ClauseHit[] | null>(null)
  const [asking, setAsking] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await imApi.products()
      setList(r.products)
      setItemId((prev) => prev || r.products[0]?.itemId || '')
    } catch (e) {
      toast.error('读取商品失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return
    setDetailLoading(true)
    setHits(null)
    try {
      const r = await imApi.product(id)
      setDetail(r)
    } catch (e) {
      toast.error('读取商品详情失败：' + (e as Error).message)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadDetail(itemId)
  }, [itemId, loadDetail])

  const shown = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return list
    return list.filter((p) => (p.title || '').toLowerCase().includes(k) || p.itemId.includes(k))
  }, [list, keyword])

  const product = detail
  const docs = product?.docs || []

  const refreshDetail = async () => {
    await loadDetail(itemId)
    await load()
  }

  const onPickFile = async (file: File) => {
    const ok = /\.(docx|pdf|txt|md|csv|json)$/i.test(file.name)
    if (!ok) {
      toast.error('只支持 .docx / .pdf / .txt / .md / .csv / .json')
      return
    }
    if (file.size > 16 * 1024 * 1024) {
      toast.error('文件太大（上限 16MB）')
      return
    }
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buf)
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
      }
      const b64 = btoa(binary)
      const r = await imApi.uploadDoc(itemId, file.name, b64)
      // 服务端返回 { ok, doc:{ id,name,kind,chars,chunks,note } }；doc 缺失时兜底读平铺字段
      const doc = r.doc || (r as unknown as ProductDoc)
      if (!r.ok) throw new Error((r as unknown as { error?: string }).error || '服务端没接受这个文件')
      if (doc.note) {
        toast.warning(`已保存《${file.name}》，但${doc.note}`, { description: `抽出 ${doc.chars || 0} 字` })
      } else {
        toast.success(`已绑定《${file.name}》，抽出 ${doc.chars || 0} 字`)
      }
      await refreshDetail()
    } catch (e) {
      toast.error('上传失败：' + (e as Error).message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const savePaste = async () => {
    const text = pasteText.trim()
    if (text.length < 10) {
      toast.error('内容太短，至少 10 个字')
      return
    }
    try {
      const r = await imApi.pasteDoc(itemId, pasteName.trim() || '粘贴的条款.txt', text)
      const doc = r.doc || (r as unknown as ProductDoc)
      toast.success(`已保存，${doc.chars || 0} 字`)
      setPasteOpen(false)
      setPasteText('')
      await refreshDetail()
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    }
  }

  const removeDoc = async (doc: ProductDoc) => {
    try {
      await imApi.deleteDoc(doc.id)
      toast.success(`已删除《${doc.name}》`)
      await refreshDetail()
    } catch (e) {
      toast.error('删除失败：' + (e as Error).message)
    }
  }

  const ask = async () => {
    const text = q.trim()
    if (!text) return
    setAsking(true)
    try {
      const r = await imApi.productQa(itemId, text, 3)
      setHits(r.hits)
      if (!r.hits.length) toast.message('条款里没找到相关句子', { description: '换个说法，或先绑定这款商品的条款文件' })
    } catch (e) {
      toast.error('检索失败：' + (e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  return (
    <>
      <Header>
        <div className='min-w-0'>
          <h1 className='truncate text-base font-medium'>商品</h1>
          <p className='truncate text-xs text-muted-foreground'>
            给商品绑定保险条款，AI 回答「保不保」时以此为准
          </p>
        </div>
        <Button variant='outline' size='sm' className='ms-auto' onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('me-1 size-4', loading && 'animate-spin')} />
          刷新
        </Button>
      </Header>
      <Main fluid className='flex gap-4'>
        <Card className='w-96 shrink-0 py-3'>
          <div className='px-3 pb-2'>
            <div className='relative'>
              <Search className='pointer-events-none absolute start-2 top-2.5 size-4 text-muted-foreground' />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder='搜索商品名或商品 ID'
                className='h-9 ps-8'
              />
            </div>
            <p className='mt-2 text-xs text-muted-foreground'>
              共 {list.length} 个商品，{list.filter((p) => p.docs > 0).length} 个已绑定条款
            </p>
          </div>
          <ScrollArea className='h-[calc(100vh-16rem)] [&>[data-slot=scroll-area-viewport]>div]:!block'>
            {loading && (
              <div className='space-y-2 px-3'>
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className='h-14 w-full' />
                ))}
              </div>
            )}
            {!loading && !shown.length && (
              <p className='px-3 py-6 text-center text-sm text-muted-foreground'>没有匹配的商品</p>
            )}
            {shown.map((p) => (
              <button
                key={p.itemId}
                onClick={() => setItemId(p.itemId)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
                  p.itemId === itemId && 'bg-accent'
                )}
              >
                {p.pic ? (
                  <img src={p.pic} alt='' loading='lazy' className='size-12 shrink-0 rounded object-cover' />
                ) : (
                  <div className='grid size-12 shrink-0 place-items-center rounded bg-muted'>
                    <FileText className='size-5 text-muted-foreground' />
                  </div>
                )}
                <span className='min-w-0 flex-1'>
                  <span className='line-clamp-2 text-sm leading-5'>{p.title || '（无标题）'}</span>
                  <span className='mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground'>
                    <span>{p.sessions} 会话</span>
                    <span>·</span>
                    <span>{p.orders} 单</span>
                    {p.docs > 0 ? (
                      <Badge variant='secondary' className='ms-auto h-4 px-1 text-[10px]'>
                        {p.docs} 份条款
                      </Badge>
                    ) : (
                      <span className='ms-auto text-[10px] text-amber-600'>未绑定条款</span>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </ScrollArea>
        </Card>

        <div className='min-w-0 flex-1 space-y-4'>
          {detailLoading && <Skeleton className='h-40 w-full' />}
          {!detailLoading && !product && (
            <Card className='grid h-40 place-items-center text-sm text-muted-foreground'>
              左侧选一个商品
            </Card>
          )}
          {!detailLoading && product && (
            <>
              <Card className='py-4'>
                <CardContent className='flex gap-4'>
                  {product.pic ? (
                    <img src={product.pic} alt='' className='size-20 rounded object-cover' />
                  ) : (
                    <div className='grid size-20 place-items-center rounded bg-muted'>
                      <FileText className='size-6 text-muted-foreground' />
                    </div>
                  )}
                  <div className='min-w-0 flex-1'>
                    <h2 className='line-clamp-2 text-base font-medium'>{product.title}</h2>
                    <p className='mt-1 text-xs text-muted-foreground'>商品 ID：{product.itemId}</p>
                    <div className='mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm'>
                      <span>
                        会话 <strong>{product.sessions}</strong>
                      </span>
                      <span>
                        订单 <strong>{product.orders}</strong>
                      </span>
                      <span>
                        成交 <strong>{money(product.amount)}</strong>
                      </span>
                      <span>
                        条款 <strong>{docs.length}</strong> 份 /{' '}
                        {docs.reduce((n, d) => n + (d.chars || 0), 0)} 字
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className='py-4'>
                <CardContent className='space-y-3'>
                  <div className='flex items-center justify-between'>
                    <div>
                      <h3 className='text-sm font-medium'>保险条款</h3>
                      <p className='text-xs text-muted-foreground'>
                        支持 .docx / .pdf / .txt / .md，也可以直接粘贴文本。AI 回答时会检索这里
                      </p>
                    </div>
                    <div className='flex gap-2'>
                      <input
                        ref={fileRef}
                        type='file'
                        accept='.docx,.pdf,.txt,.md,.csv,.json'
                        className='hidden'
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) void onPickFile(f)
                        }}
                      />
                      <Button size='sm' variant='outline' disabled={uploading} onClick={() => fileRef.current?.click()}>
                        <Upload className='me-1 size-4' />
                        {uploading ? '解析中…' : '选择文件'}
                      </Button>
                      <Button size='sm' variant='outline' onClick={() => setPasteOpen(true)}>
                        <FileText className='me-1 size-4' />
                        粘贴文本
                      </Button>
                    </div>
                  </div>

                  {!docs.length && (
                    <p className='rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground'>
                      还没有绑定条款。绑定后，客户问「XX 保不保」AI 会引用原文回答，而不是自己编。
                    </p>
                  )}

                  {docs.map((d) => (
                    <div key={d.id} className='flex items-center gap-3 rounded-md border px-3 py-2'>
                      <FileText className='size-4 shrink-0 text-muted-foreground' />
                      <div className='min-w-0 flex-1'>
                        <p className='truncate text-sm'>{d.name}</p>
                        <p className='text-xs text-muted-foreground'>
                          {KIND_LABEL[d.kind] || d.kind} · {d.chars} 字
                          {d.note ? ` · ${d.note}` : ''}
                        </p>
                      </div>
                      <Button size='icon' variant='ghost' onClick={() => void removeDoc(d)} title='删除'>
                        <Trash2 className='size-4 text-muted-foreground' />
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className='py-4'>
                <CardContent className='space-y-3'>
                  <div>
                    <h3 className='flex items-center gap-1 text-sm font-medium'>
                      <HelpCircle className='size-4' />
                      条款问答测试
                    </h3>
                    <p className='text-xs text-muted-foreground'>
                      先用客户可能的问法试一遍，看检索是否命中对的条款，再去接 AI
                    </p>
                  </div>
                  <div className='flex gap-2'>
                    <Input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void ask()
                      }}
                      placeholder='例如：高空作业保不保 / 60岁能买吗 / 私立医院能报销吗'
                    />
                    <Button onClick={() => void ask()} disabled={asking}>
                      {asking ? '检索中…' : '检索'}
                    </Button>
                  </div>
                  {hits?.length ? (
                    <div className='space-y-2'>
                      {hits.map((h, i) => (
                        <div key={i} className='rounded-md bg-muted/60 px-3 py-2'>
                          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                            <Badge variant='outline' className='h-4 px-1 text-[10px]'>
                              相关度 {h.score}
                            </Badge>
                            <span>第 {h.seq + 1} 段</span>
                            {h.matched?.length ? <span>命中：{h.matched.join(' / ')}</span> : null}
                          </div>
                          <p className='mt-1 whitespace-pre-wrap text-sm leading-6'>{h.text}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </Main>

      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>粘贴保险条款</DialogTitle>
            <DialogDescription>
              从 PDF 或网页复制条款正文粘进来（扫描件 PDF 抽不出字，用这个方式最稳）
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-3'>
            <div className='space-y-1'>
              <Label htmlFor='doc-name'>文件名</Label>
              <Input id='doc-name' value={pasteName} onChange={(e) => setPasteName(e.target.value)} />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='doc-text'>条款正文</Label>
              <Textarea
                id='doc-text'
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder='第一条 保险责任 …'
                className='h-64 font-mono text-xs'
              />
              <p className='text-xs text-muted-foreground'>{pasteText.trim().length} 字</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setPasteOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void savePaste()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
