import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  Mail,
  Plug,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { imApi, type MailConfig } from '@/lib/im'

type VerifyInfo = { ok: boolean; auth?: string; caps?: string[]; host?: string; port?: number; error?: string }

export function MailPage() {
  const [conf, setConf] = useState<MailConfig | null>(null)
  const [draft, setDraft] = useState<Partial<MailConfig>>({})
  const [pass, setPass] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [sending, setSending] = useState(false)
  const [verify, setVerify] = useState<VerifyInfo | null>(null)
  const [testTo, setTestTo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const c = await imApi.mailConfig()
      setConf(c)
      setDraft({})
      setPass('')
      if (!testTo) setTestTo(c.fromAddr || '')
    } catch (e) {
      toast.error('读取邮箱配置失败：' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [testTo])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const val = <K extends keyof MailConfig>(k: K): MailConfig[K] | undefined =>
    (draft[k] as MailConfig[K] | undefined) ?? conf?.[k]
  const set = (patch: Partial<MailConfig>) => setDraft((d) => ({ ...d, ...patch }))

  const applyPreset = (key: string) => {
    const p = conf?.presets?.[key]
    if (!p) return
    set({ host: p.host, port: p.port, secure: p.secure })
    toast.message(`已套用 ${key}：${p.host}:${p.port}`)
  }

  const save = async () => {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = { ...draft }
      if (pass) patch.pass = pass
      const r = await imApi.saveMailConfig(patch as Partial<MailConfig> & { pass?: string })
      setConf(r.config)
      setDraft({})
      setPass('')
      toast.success('邮箱配置已保存')
    } catch (e) {
      toast.error('保存失败：' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const doVerify = async () => {
    setVerifying(true)
    setVerify(null)
    try {
      const r = await imApi.mailVerify()
      setVerify(r)
      if (r.ok && r.auth === 'ok') toast.success('连接与登录都通过')
      else if (r.ok) toast.warning('能连上服务器，但没有登录（未填账号/授权码）')
      else toast.error(r.error || '连接失败')
    } catch (e) {
      const msg = (e as Error).message
      setVerify({ ok: false, error: msg })
      toast.error('连接失败：' + msg)
    } finally {
      setVerifying(false)
    }
  }

  const doTest = async () => {
    const to = testTo.trim()
    if (!to) {
      toast.error('先填一个收件邮箱')
      return
    }
    setSending(true)
    try {
      const r = await imApi.mailTest(to)
      if (r.ok) toast.success(`已发出（${r.size} 字节）→ ${r.to}`)
      else toast.error(r.error || '发送失败')
    } catch (e) {
      toast.error('发送失败：' + (e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const ready = conf?.ready
  const sent = conf?.sentToday ?? 0
  const limit = conf?.dailyLimit ?? 0

  return (
    <>
      <Header fixed>
        <div className='flex flex-1 items-center gap-2'>
          <Mail className='size-4 text-muted-foreground' />
          <h1 className='text-base font-medium'>邮箱配置</h1>
          {loading ? (
            <Badge variant='outline' className='ms-1'>
              <Loader2 className='me-1 size-3 animate-spin' /> 读取中
            </Badge>
          ) : ready ? (
            <Badge variant='secondary' className='ms-1'>
              <CheckCircle2 className='me-1 size-3' /> 可用
            </Badge>
          ) : (
            <Badge variant='destructive' className='ms-1'>
              <ShieldAlert className='me-1 size-3' /> 未配好
            </Badge>
          )}
        </div>
        <div className='ms-auto flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={() => void load()} disabled={loading}>
            <RefreshCw className='me-1 size-4' /> 重新读取
          </Button>
          <Button size='sm' onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Loader2 className='me-1 size-4 animate-spin' /> : <Save className='me-1 size-4' />} 保存
          </Button>
        </div>
      </Header>

      <Main fluid>
        <div className='grid gap-4 lg:grid-cols-3'>
          <Card className='lg:col-span-2'>
            <CardHeader>
              <CardTitle className='text-base'>发信服务器</CardTitle>
              <CardDescription>
                换了邮箱就把这里整段改掉——受限时可以直接切到另一个邮箱，改完点保存即可生效。
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label>服务商预设</Label>
                  <Select onValueChange={applyPreset}>
                    <SelectTrigger className='w-full [&>span]:truncate'>
                      <SelectValue placeholder='选一个，自动填 host/端口' />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(conf?.presets || {}).map(([k, v]) => (
                        <SelectItem key={k} value={k}>
                          {k} · {v.host}:{v.port}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-1.5'>
                  <Label>SMTP 主机</Label>
                  <Input
                    value={val('host') || ''}
                    onChange={(e) => set({ host: e.target.value })}
                    placeholder='smtp.qq.com'
                  />
                </div>
              </div>

              <div className='grid gap-3 sm:grid-cols-3'>
                <div className='space-y-1.5'>
                  <Label>端口</Label>
                  <Input
                    type='number'
                    value={String(val('port') ?? 465)}
                    onChange={(e) => set({ port: Number(e.target.value) })}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>加密方式</Label>
                  <Select
                    value={val('secure') ? 'ssl' : 'starttls'}
                    onValueChange={(v) => set({ secure: v === 'ssl', port: v === 'ssl' ? 465 : 587 })}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='ssl'>SSL（465，推荐）</SelectItem>
                      <SelectItem value='starttls'>STARTTLS（587）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-1.5'>
                  <Label>每日上限</Label>
                  <Input
                    type='number'
                    value={String(val('dailyLimit') ?? 200)}
                    onChange={(e) => set({ dailyLimit: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label>登录账号</Label>
                  <Input
                    value={val('user') || ''}
                    onChange={(e) => set({ user: e.target.value })}
                    placeholder='完整邮箱地址'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>
                    授权码 / 密码
                    {conf?.hasPass && (
                      <span className='ms-2 font-normal text-muted-foreground'>已存 {conf.passMasked}</span>
                    )}
                  </Label>
                  <Input
                    type='password'
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    placeholder={conf?.hasPass ? '留空 = 继续用已保存的' : 'QQ/163 用授权码，不是登录密码'}
                  />
                </div>
              </div>

              <div className='grid gap-3 sm:grid-cols-3'>
                <div className='space-y-1.5'>
                  <Label>发件人地址</Label>
                  <Input
                    value={val('fromAddr') || ''}
                    onChange={(e) => set({ fromAddr: e.target.value })}
                    placeholder='同登录账号一般都行'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>发件人名称</Label>
                  <Input
                    value={val('fromName') || ''}
                    onChange={(e) => set({ fromName: e.target.value })}
                    placeholder='伴游旅途'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>回复地址（可选）</Label>
                  <Input
                    value={val('replyTo') || ''}
                    onChange={(e) => set({ replyTo: e.target.value })}
                    placeholder='客户回信落到哪'
                  />
                </div>
              </div>

              <div className='flex flex-wrap items-center gap-2 border-t pt-3'>
                <Button variant='outline' size='sm' onClick={() => void doVerify()} disabled={verifying}>
                  {verifying ? <Loader2 className='me-1 size-4 animate-spin' /> : <Plug className='me-1 size-4' />}
                  验证登录
                </Button>
                <Input
                  className='h-9 w-64'
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder='测试收件邮箱'
                />
                <Button variant='outline' size='sm' onClick={() => void doTest()} disabled={sending}>
                  {sending ? <Loader2 className='me-1 size-4 animate-spin' /> : <Send className='me-1 size-4' />}
                  发测试信
                </Button>
                <span className='text-xs text-muted-foreground'>改完记得先「保存」再验证</span>
              </div>

              {verify && (
                <div
                  className={cn(
                    'rounded-md border p-3 text-xs',
                    verify.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'
                  )}
                >
                  <div className='font-medium'>
                    {verify.ok ? `连接成功${verify.auth === 'ok' ? '，登录通过' : '（未登录）'}` : '连接失败'}
                  </div>
                  {verify.host && (
                    <div className='mt-1 opacity-80'>
                      {verify.host}:{verify.port}
                    </div>
                  )}
                  {verify.caps && verify.caps.length > 0 && (
                    <div className='mt-1 font-mono text-[11px] leading-5 opacity-80'>{verify.caps.join(' | ')}</div>
                  )}
                  {verify.error && <div className='mt-1'>{verify.error}</div>}
                </div>
              )}
            </CardContent>
          </Card>

          <div className='space-y-4'>
            <Card>
              <CardHeader>
                <CardTitle className='text-base'>当前状态</CardTitle>
              </CardHeader>
              <CardContent className='space-y-3 text-sm'>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>通道</span>
                  <span className='font-mono text-xs'>
                    {conf ? `${conf.host}:${conf.port}${conf.secure ? ' SSL' : ' STARTTLS'}` : '-'}
                  </span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>发件人</span>
                  <span className='max-w-[60%] truncate text-xs'>{conf?.fromAddr || '-'}</span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>今日已发</span>
                  <span className='text-xs'>
                    {sent} / {limit || '-'}
                  </span>
                </div>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>密码</span>
                  <span className='text-xs'>{conf?.hasPass ? conf.passMasked : '未设置'}</span>
                </div>
                <div className='rounded-md bg-muted/60 p-2 text-xs leading-5 text-muted-foreground'>
                  换邮箱流程：改「服务商预设」→ 填登录账号 + 授权码 → 保存 → 验证登录 → 发测试信。
                  一封测试信会进你自己的收件箱，不会打扰客户。
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className='text-base'>授权码怎么拿</CardTitle>
              </CardHeader>
              <CardContent className='space-y-2 text-xs leading-5 text-muted-foreground'>
                <p>
                  <span className='font-medium text-foreground'>QQ 邮箱</span>：设置 → 账号 → 开启 IMAP/SMTP
                  服务 → 生成 16 位授权码（用小写连写，别带空格）。
                </p>
                <p>
                  <span className='font-medium text-foreground'>163/126</span>：设置 → POP3/SMTP/IMAP →
                  开启服务 → 新增授权码。
                </p>
                <p>
                  <span className='font-medium text-foreground'>腾讯企业邮</span>：管理后台给账号分配 SMTP
                  权限，用客户端专用密码。
                </p>
                <p className='text-amber-600'>Gmail / Outlook 在大陆基本不可用（一个要专线，一个已禁基本认证）。</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </Main>
    </>
  )
}
