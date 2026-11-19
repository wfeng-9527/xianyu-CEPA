import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bot, Check, Loader2, PlayCircle, Plug, RefreshCw, Save, Send, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { imApi, type AiConfig, type AiModel, type AutoState, type Decision } from '@/lib/im'

export function AiPage() {
  const [conf, setConf] = useState<AiConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [key, setKey] = useState('')
  const [testResult, setTestResult] = useState<string>('')
  const [testing, setTesting] = useState(false)
  const [models, setModels] = useState<AiModel[]>([])
  const [modelEndpoint, setModelEndpoint] = useState('')
  const [fetchingModels, setFetchingModels] = useState(false)

  const [sid, setSid] = useState('')
  const [text, setText] = useState('你们这个保险住院能报吗')
  const [decision, setDecision] = useState<Decision | null>(null)
  const [running, setRunning] = useState(false)

  // 自动回复运行模式
  const [auto, setAuto] = useState<AutoState | null>(null)
  const [white, setWhite] = useState('')
  const [savingAuto, setSavingAuto] = useState(false)
  const [ticking, setTicking] = useState(false)

  const loadAuto = useCallback(async () => {
    try {
      const st = await imApi.autoState()
      setAuto(st)
      setWhite((st.whitelist || []).join(','))
    } catch {
      /* 老服务端没有这个接口 */
    }
  }, [])

  const saveAuto = useCallback(async () => {
    setSavingAuto(true)
    try {
      const r = await imApi.autoConfig({
        mode: auto?.mode || 'shadow',
        whitelist: white.split(',').map((x) => x.trim()).filter(Boolean),
      })
      toast.success(`已保存：${r.mode === 'live' ? '真发（仅白名单）' : '影子模式'}`)
      await loadAuto()
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e))
    } finally {
      setSavingAuto(false)
    }
  }, [auto?.mode, white, loadAuto])

  const switchMode = useCallback(
    async (live: boolean) => {
      setSavingAuto(true)
      try {
        const r = await imApi.autoConfig({
          mode: live ? 'live' : 'shadow',
          whitelist: white.split(',').map((x) => x.trim()).filter(Boolean),
        })
        setAuto((p) => (p ? { ...p, mode: r.mode, whitelist: r.whitelist } : p))
        toast.success(r.mode === 'live' ? '已切到真发（仅白名单会话）' : '已切到影子模式（只记录不发送）')
      } catch (e) {
        toast.error(String(e instanceof Error ? e.message : e))
      } finally {
        setSavingAuto(false)
      }
    },
    [white]
  )

  const runTick = useCallback(async () => {
    setTicking(true)
    try {
      const r = await imApi.autoTick()
      toast.success(`决策 ${r.taken} 条：回复 ${r.reply} / 转人工 ${r.handoff} / 忽略 ${r.ignore}${r.sent ? ` · 真发 ${r.sent}` : ''}`)
      await loadAuto()
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e))
    } finally {
      setTicking(false)
    }
  }, [loadAuto])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setConf(await imApi.aiConfig())
    } catch (e) {
      toast.error('读取配置失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadAuto()
  }, [load, loadAuto])

  // 配好 Key 就顺手把模型列表拉一次，省得每次都点
  const [autoFetched, setAutoFetched] = useState(false)
  useEffect(() => {
    if (autoFetched || loading || !conf?.hasKey) return
    setAutoFetched(true)
    void fetchModels(true)
  }, [conf, loading, autoFetched])

  const patch = (p: Partial<AiConfig>) => setConf((c) => (c ? { ...c, ...p } : c))

  const save = async () => {
    if (!conf) return
    setSaving(true)
    try {
      const r = await imApi.saveAiConfig({
        enabled: conf.enabled,
        baseUrl: conf.baseUrl,
        model: conf.model,
        temperature: conf.temperature,
        maxTokens: conf.maxTokens,
        persona: conf.persona,
        knowledge: conf.knowledge,
        handoffWhen: conf.handoffWhen,
        maxLen: conf.maxLen,
        dailyLimit: conf.dailyLimit,
        retryOnCheckFail: conf.retryOnCheckFail,
        apiKey: key || undefined,
      })
      setConf(r.config)
      setKey('')
      toast.success('已保存')
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const fetchModels = async (silent = false) => {
    setFetchingModels(true)
    try {
      const r = await imApi.aiModels({ apiKey: key || undefined, baseUrl: conf?.baseUrl })
      setModels(r.models || [])
      setModelEndpoint(r.endpoint || '')
      if (r.models?.length && !r.models.some((m) => m.id === conf?.model)) {
        patch({ model: r.models[0].id })
      }
      if (!silent) toast.success(`拿到 ${r.count} 个模型`)
    } catch (e) {
      setModels([])
      if (!silent) toast.error((e as Error).message)
    } finally {
      setFetchingModels(false)
    }
  }

  const testConn = async () => {
    setTesting(true)
    setTestResult('')
    try {
      const r = await imApi.aiTest()
      setTestResult(r.ok ? `通了：${r.text}（${r.model}）` : r.skipped ? '没配 Key' : '失败：' + (r.error || ''))
    } catch (e) {
      setTestResult('失败：' + (e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const run = async () => {
    setRunning(true)
    setDecision(null)
    try {
      const r = await imApi.aiAnswer(sid, text)
      setDecision(r.decision)
    } catch (e) {
      toast.error('试跑失败：' + (e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Header fixed>
        <div className='me-auto flex items-center gap-2'>
          <h1 className='text-lg font-semibold'>AI 与规则</h1>
          {conf?.ready.ok ? (
            <Badge variant='secondary'>已就绪</Badge>
          ) : (
            <Badge variant='destructive'>{conf?.ready.reason || '未配置'}</Badge>
          )}
        </div>
        <Button size='sm' variant='outline' onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('me-1 size-4', loading && 'animate-spin')} /> 重新读取
        </Button>
        <Button size='sm' onClick={() => void save()} disabled={saving}>
          <Save className='me-1 size-4' /> {saving ? '保存中…' : '保存'}
        </Button>
      </Header>

      <Main fluid>
        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader className='pb-3'>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Plug className='size-4' /> 模型
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-3'>
              <div className='flex items-center justify-between rounded-lg border p-3'>
                <div>
                  <div className='text-sm font-medium'>自动回复总开关</div>
                  <div className='text-xs text-muted-foreground'>关掉只给建议，不发出去</div>
                </div>
                <Switch checked={Boolean(conf?.enabled)} onCheckedChange={(v) => patch({ enabled: v })} />
              </div>

              <div className='space-y-2 rounded-lg border p-3'>
                <div className='flex items-center justify-between'>
                  <div>
                    <div className='text-sm font-medium'>真发模式（live）</div>
                    <div className='text-xs text-muted-foreground'>
                      关 = 只记录不发送（影子）；开 = 只对下面白名单里的会话真发
                    </div>
                  </div>
                  <Switch checked={auto?.mode === 'live'} onCheckedChange={(v) => void switchMode(v)} />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>真发白名单（会话 ID，逗号分隔）</Label>
                  <Input
                    value={white}
                    placeholder='48467699134'
                    onChange={(e) => setWhite(e.target.value)}
                    className='h-8 text-xs'
                  />
                </div>
                <div className='flex flex-wrap items-center gap-3 text-xs text-muted-foreground'>
                  <span>待处理 {auto?.pending ?? 0}</span>
                  <span>今日已回 {auto?.usedToday ?? 0}/{auto?.dailyLimit ?? 0}</span>
                  <Badge variant={auto?.mode === 'live' ? 'default' : 'secondary'} className='text-[10px]'>
                    {auto?.mode === 'live' ? '真发中' : '影子模式'}
                  </Badge>
                  <Button size='sm' variant='outline' className='h-7' onClick={() => void saveAuto()} disabled={savingAuto}>
                    <Save className='me-1 size-3' /> {savingAuto ? '保存中…' : '保存白名单'}
                  </Button>
                  <Button size='sm' variant='ghost' className='h-7' onClick={() => void runTick()} disabled={ticking}>
                    <PlayCircle className='me-1 size-3' /> {ticking ? '决策中…' : '立即决策一次'}
                  </Button>
                </div>
              </div>

              <div className='space-y-1'>
                <Label className='text-xs'>
                  API Key
                  {conf?.hasKey && <span className='text-muted-foreground'>（已保存 {conf.apiKeyMasked}）</span>}
                </Label>
                <Input
                  type='password'
                  value={key}
                  placeholder={conf?.hasKey ? '留空 = 继续用已保存的 Key' : 'sk-... 填入服务商给的 Key'}
                  onChange={(e) => setKey(e.target.value)}
                />
              </div>

              <div className='space-y-1'>
                <Label className='text-xs'>Base URL</Label>
                <Input
                  value={conf?.baseUrl || ''}
                  placeholder='https://api.deepseek.com/anthropic'
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                />
                <div className='text-xs text-muted-foreground'>
                  填到 /v1 或 /anthropic 为止都行，会自动试 <code>/models</code> 找模型列表
                </div>
              </div>

              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-1'>
                  <Label className='text-xs'>协议</Label>
                  <Select
                    value={conf?.protocol || 'auto'}
                    onValueChange={(v) => patch({ protocol: v as AiConfig['protocol'] })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='自动' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='auto'>自动（按 URL 判断）</SelectItem>
                      <SelectItem value='anthropic'>Anthropic Messages</SelectItem>
                      <SelectItem value='openai'>OpenAI 兼容</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>模型</Label>
                  {models.length ? (
                    <Select value={conf?.model || ''} onValueChange={(v) => patch({ model: v })}>
                      <SelectTrigger className='w-full [&>span]:truncate'>
                        <SelectValue placeholder='选一个模型' />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name && m.name !== m.id ? m.name : m.id}
                            {m.context ? ` · ${Math.round(m.context / 1024)}K` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={conf?.model || ''}
                      placeholder='先点「获取模型」，或直接手填'
                      onChange={(e) => patch({ model: e.target.value })}
                    />
                  )}
                </div>
              </div>

              <div className='flex flex-wrap items-center gap-2'>
                <Button size='sm' variant='outline' onClick={() => void fetchModels()} disabled={fetchingModels}>
                  {fetchingModels ? <Loader2 className='me-1 size-4 animate-spin' /> : <RefreshCw className='me-1 size-4' />}
                  获取模型
                </Button>
                <Button size='sm' variant='outline' onClick={() => void testConn()} disabled={testing}>
                  <Zap className='me-1 size-4' /> 测试连接
                </Button>
                {modelEndpoint && (
                  <span className='text-xs text-muted-foreground'>列表来自 {modelEndpoint}</span>
                )}
                {testResult && (
                  <span className={cn('text-xs', testResult.startsWith('通了') ? 'text-emerald-600' : 'text-red-600')}>
                    {testResult}
                  </span>
                )}
              </div>

              <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                <div className='space-y-1'>
                  <Label className='text-xs'>温度</Label>
                  <Input
                    type='number'
                    step='0.1'
                    value={conf?.temperature ?? 0.6}
                    onChange={(e) => patch({ temperature: Number(e.target.value) })}
                  />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>max_tokens</Label>
                  <Input
                    type='number'
                    value={conf?.maxTokens ?? 300}
                    onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
                  />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>回复字数上限</Label>
                  <Input
                    type='number'
                    value={conf?.maxLen ?? 120}
                    onChange={(e) => patch({ maxLen: Number(e.target.value) })}
                  />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>每日上限</Label>
                  <Input
                    type='number'
                    value={conf?.dailyLimit ?? 300}
                    onChange={(e) => patch({ dailyLimit: Number(e.target.value) })}
                  />
                </div>
              </div>

              {conf?.protocol && (
                <div className='rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground'>
                  当前生效：{conf.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容'} · {conf.model} ·{' '}
                  {conf.hasKey ? `密钥 ${conf.apiKeyMasked}` : '未填 Key'}
                  {conf.keySource?.startsWith('harness') ? '（暂用 Harness 里的 key 兜底）' : ''}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='pb-3'>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Bot className='size-4' /> 人设与常识
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>人设（它会照着这个说话）</Label>
                <Textarea
                  rows={3}
                  value={conf?.persona || ''}
                  placeholder='你是「伴游旅途」的客服，说话短、口语化，像微信聊天；先答问题再补一句提醒，不推销。'
                  onChange={(e) => patch({ persona: e.target.value })}
                />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>店铺常识（每行一条，AI 只能依据这些回答）</Label>
                <Textarea
                  rows={5}
                  value={(conf?.knowledge || []).join('\n')}
                  placeholder={'默认发中通/圆通，48 小时内发出\n电子保单当天出，邮箱发送\n生效前可退，生效后按条款退'}
                  onChange={(e) =>
                    patch({ knowledge: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
                  }
                />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>必须转人工的词（逗号分隔）</Label>
                <Input
                  value={(conf?.handoffWhen || []).join(',')}
                  onChange={(e) =>
                    patch({
                      handoffWhen: e.target.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
                    })
                  }
                />
              </div>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                「回复规则」页里的固定话术也会一并进 prompt —— AI 会知道这些标准答案，兜底时才自己组织语言。
                硬红线（不加微信、不做绝对化承诺、不放链接、不承诺退款）写死在代码里，改不掉。
              </p>
            </CardContent>
          </Card>

          <Card className='lg:col-span-2'>
            <CardHeader className='pb-3'>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Send className='size-4' /> 试跑（不会发给客户）
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-3'>
              <div className='grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end'>
                <div className='space-y-1'>
                  <Label className='text-xs'>会话 ID（可空）</Label>
                  <Input value={sid} onChange={(e) => setSid(e.target.value)} placeholder='54577822625' />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>客户说的话</Label>
                  <Input value={text} onChange={(e) => setText(e.target.value)} />
                </div>
                <Button onClick={() => void run()} disabled={running}>
                  {running ? '跑…' : '跑一遍'}
                </Button>
              </div>

              {decision && (
                <div className='grid gap-3 md:grid-cols-2'>
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
                  </div>
                  <div className='space-y-1 rounded-lg border p-3'>
                    <div className='text-xs font-medium text-muted-foreground'>今日已自动回复</div>
                    <div className='text-2xl font-semibold'>{conf?.usedToday ?? 0}</div>
                    <div className='text-xs text-muted-foreground'>上限 {conf?.dailyLimit ?? 300} 条 / 天</div>
                    <div className='pt-2 text-xs text-muted-foreground'>配置文件：{conf?.file}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}
