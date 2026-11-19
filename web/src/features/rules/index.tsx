import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Plus, RefreshCw, Save, Trash2, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { imApi, type Decision, type RuleConf, type RuleItem } from '@/lib/im'

function ruleAction(r: RuleItem) {
  if (r.handoff) return 'handoff'
  if (r.ai) return 'ai'
  return 'reply'
}

function matchText(r: RuleItem) {
  const m = r.match || {}
  if (m.any) return '任何消息'
  if (m.keywords?.length) return '关键词：' + m.keywords.join(' / ')
  if (m.regex) return '正则：' + m.regex
  if (m.equals) return '等于：' + m.equals
  return '未设置条件'
}

export function RulesPage() {
  const [conf, setConf] = useState<RuleConf | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [testText, setTestText] = useState('这个保险私立医院能报销吗')
  const [testSid, setTestSid] = useState('')
  const [decision, setDecision] = useState<Decision | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await imApi.rules()
      setConf(r)
      setDirty(false)
    } catch (e) {
      toast.error('读取规则失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = (p: Partial<RuleConf>) => {
    setConf((c) => (c ? { ...c, ...p } : c))
    setDirty(true)
  }

  const patchRule = (idx: number, p: Partial<RuleItem>) => {
    if (!conf) return
    const rules = conf.rules.slice()
    rules[idx] = { ...rules[idx], ...p }
    patch({ rules })
  }

  const addRule = () => {
    if (!conf) return
    const id = 'rule-' + (conf.rules.length + 1)
    patch({
      rules: [
        ...conf.rules,
        { id, name: '新规则', enabled: true, priority: 50, match: { keywords: [] }, reply: '' },
      ],
    })
  }

  const delRule = (idx: number) => {
    if (!conf) return
    patch({ rules: conf.rules.filter((_, i) => i !== idx) })
  }

  const save = async () => {
    if (!conf) return
    setSaving(true)
    try {
      const r = await imApi.saveRules(conf)
      setConf(r)
      setDirty(false)
      toast.success('规则已保存，下一轮同步立即生效')
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setDecision(null)
    try {
      const r = await imApi.aiAnswer(testSid, testText)
      setDecision(r.decision)
    } catch (e) {
      toast.error('试跑失败：' + (e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const sorted = useMemo(
    () => (conf ? conf.rules.map((r, i) => ({ r, i })).sort((a, b) => (b.r.priority || 0) - (a.r.priority || 0)) : []),
    [conf]
  )

  return (
    <>
      <Header fixed>
        <div className='me-auto flex items-center gap-2'>
          <h1 className='text-lg font-semibold'>回复规则</h1>
          {dirty && <Badge variant='outline'>未保存</Badge>}
        </div>
        <Button size='sm' variant='outline' onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('me-1 size-4', loading && 'animate-spin')} /> 重新读取
        </Button>
        <Button size='sm' onClick={() => void save()} disabled={saving || !conf}>
          <Save className='me-1 size-4' /> {saving ? '保存中…' : '保存'}
        </Button>
      </Header>

      <Main fluid>
        <div className='flex flex-col gap-4 lg:flex-row'>
          <div className='flex min-w-0 flex-1 flex-col gap-4'>
            <Card>
              <CardHeader className='pb-3'>
                <CardTitle className='text-base'>节奏控制</CardTitle>
              </CardHeader>
              <CardContent className='grid grid-cols-3 gap-4'>
                <div className='space-y-1'>
                  <Label className='text-xs'>同一会话冷却（秒）</Label>
                  <Input
                    type='number'
                    value={conf?.cooldown ?? 60}
                    onChange={(e) => patch({ cooldown: Number(e.target.value) })}
                  />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>每小时最多回复</Label>
                  <Input
                    type='number'
                    value={conf?.maxPerSession ?? 3}
                    onChange={(e) => patch({ maxPerSession: Number(e.target.value) })}
                  />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>短于多少字不回</Label>
                  <Input
                    type='number'
                    value={conf?.minLength ?? 2}
                    onChange={(e) => patch({ minLength: Number(e.target.value) })}
                  />
                </div>
              </CardContent>
            </Card>

            <div className='flex items-center justify-between'>
              <h2 className='text-sm font-medium text-muted-foreground'>
                规则（按优先级从高到低匹配，命中第一条即停）
              </h2>
              <Button size='sm' variant='outline' onClick={addRule}>
                <Plus className='me-1 size-4' /> 新增规则
              </Button>
            </div>

            <ScrollArea className='[&>[data-slot=scroll-area-viewport]>div]:!block'>
              <div className='flex flex-col gap-3 pb-6'>
                {loading && <div className='text-sm text-muted-foreground'>读取中…</div>}
                {sorted.map(({ r, i }) => {
                  const act = ruleAction(r)
                  return (
                    <Card key={r.id + '-' + i} className={cn('transition', r.enabled === false && 'opacity-60')}>
                      <CardContent className='space-y-3 pt-4'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <input
                            type='checkbox'
                            className='size-4 accent-foreground'
                            checked={r.enabled !== false}
                            onChange={(e) => patchRule(i, { enabled: e.target.checked })}
                          />
                          <Input
                            className='h-8 w-40'
                            value={r.name || r.id}
                            placeholder='规则名'
                            onChange={(e) => patchRule(i, { name: e.target.value })}
                          />
                          <Badge variant='secondary'>{act === 'handoff' ? '转人工' : act === 'ai' ? 'AI' : '话术'}</Badge>
                          <div className='ms-auto flex items-center gap-2'>
                            <Label className='text-xs text-muted-foreground'>优先级</Label>
                            <Input
                              type='number'
                              className='h-8 w-20'
                              value={r.priority ?? 50}
                              onChange={(e) => patchRule(i, { priority: Number(e.target.value) })}
                            />
                            <Button size='icon' variant='ghost' onClick={() => delRule(i)} title='删除'>
                              <Trash2 className='size-4' />
                            </Button>
                          </div>
                        </div>

                        <div className='grid gap-2 md:grid-cols-2'>
                          <div className='space-y-1'>
                            <Label className='text-xs'>关键词（逗号分隔，命中任一即可）</Label>
                            <Input
                              value={(r.match?.keywords || []).join(',')}
                              placeholder='多少钱,便宜点,包邮吗'
                              onChange={(e) =>
                                patchRule(i, {
                                  match: {
                                    ...(r.match || {}),
                                    keywords: e.target.value
                                      .split(/[,，\s]+/)
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  },
                                })
                              }
                            />
                          </div>
                          <div className='space-y-1'>
                            <Label className='text-xs'>或用正则</Label>
                            <Input
                              value={r.match?.regex || ''}
                              placeholder='发货|几天到|快递'
                              onChange={(e) =>
                                patchRule(i, { match: { ...(r.match || {}), regex: e.target.value } })
                              }
                            />
                          </div>
                        </div>

                        <div className='flex flex-wrap items-center gap-3'>
                          <Label className='text-xs'>动作</Label>
                          <select
                            className='h-8 rounded-md border bg-background px-2 text-sm'
                            value={act}
                            onChange={(e) => {
                              const v = e.target.value
                              patchRule(i, {
                                reply: v === 'reply' ? r.reply || '' : undefined,
                                ai: v === 'ai' ? true : undefined,
                                handoff: v === 'handoff' ? true : undefined,
                              })
                            }}
                          >
                            <option value='reply'>固定话术</option>
                            <option value='ai'>交给 AI</option>
                            <option value='handoff'>转人工</option>
                          </select>
                          <label className='flex items-center gap-1 text-xs text-muted-foreground'>
                            <input
                              type='checkbox'
                              className='size-3.5'
                              checked={Boolean(r.match?.any)}
                              onChange={(e) =>
                                patchRule(i, { match: { ...(r.match || {}), any: e.target.checked } })
                              }
                            />
                            兜底（任何消息）
                          </label>
                        </div>

                        {act === 'reply' && (
                          <div className='space-y-1'>
                            <Label className='text-xs'>固定话术</Label>
                            <Textarea
                              rows={2}
                              value={r.reply || ''}
                              onChange={(e) => patchRule(i, { reply: e.target.value })}
                            />
                          </div>
                        )}

                        <div className='text-xs text-muted-foreground'>{matchText(r)}</div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </ScrollArea>
          </div>

          <div className='w-full shrink-0 lg:w-96'>
            <Card className='sticky top-20'>
              <CardHeader className='pb-3'>
                <CardTitle className='text-base'>试跑一句话</CardTitle>
              </CardHeader>
              <CardContent className='space-y-3'>
                <div className='space-y-1'>
                  <Label className='text-xs'>会话 ID（可留空，仅影响冷却与历史）</Label>
                  <Input value={testSid} onChange={(e) => setTestSid(e.target.value)} placeholder='54577822625' />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>客户说的话</Label>
                  <Textarea rows={3} value={testText} onChange={(e) => setTestText(e.target.value)} />
                </div>
                <Button className='w-full' onClick={() => void runTest()} disabled={testing}>
                  <Zap className='me-1 size-4' /> {testing ? '跑…' : '跑一遍'}
                </Button>

                {decision && (
                  <div className='space-y-2 rounded-lg border p-3 text-sm'>
                    <div className='flex items-center gap-2'>
                      <Badge
                        variant={
                          decision.action === 'handoff' ? 'destructive' : decision.action === 'ignore' ? 'outline' : 'default'
                        }
                      >
                        {decision.action === 'reply'
                          ? '固定话术'
                          : decision.action === 'ai'
                            ? 'AI 回复'
                            : decision.action === 'handoff'
                              ? '转人工'
                              : '不回'}
                      </Badge>
                      <span className='text-xs text-muted-foreground'>{decision.source}</span>
                    </div>
                    {decision.text && <div className='rounded bg-muted p-2 whitespace-pre-wrap'>{decision.text}</div>}
                    {decision.reason && (
                      <div className='flex items-start gap-1 text-xs text-amber-600'>
                        <AlertTriangle className='mt-0.5 size-3.5 shrink-0' />
                        {decision.reason}
                      </div>
                    )}
                    {decision.check && (
                      <div className={cn('text-xs', decision.check.ok ? 'text-green-600' : 'text-destructive')}>
                        {decision.check.ok ? (
                          <span className='inline-flex items-center gap-1'>
                            <Check className='size-3.5' /> 自检通过（{decision.check.len} 字）
                          </span>
                        ) : (
                          '自检问题：' + decision.check.issues.join('；')
                        )}
                      </div>
                    )}
                    {decision.note && <div className='text-xs text-muted-foreground'>{decision.note}</div>}
                  </div>
                )}
                <p className='text-xs leading-relaxed text-muted-foreground'>
                  顺序：敏感词（转人工）→ 规则（按优先级）→ AI（人设+条款+样例）→ 自检（不过就重写）。
                  这里的试跑不会发给客户。
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </Main>
    </>
  )
}
