import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleDot } from 'lucide-react'
import { toast } from 'sonner'
import { imApi, type CustomerInfo, type Health, type Me, type MessageRow, type OrderRow, type SessionRow } from '@/lib/im'
import { Badge } from '@/components/ui/badge'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ConfigDrawer } from '@/components/config-drawer'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { Composer } from './components/composer'
import { CustomerPanel } from './components/customer-panel'
import { MessageThread } from './components/message-thread'
import { SessionList } from './components/session-list'

const SESSION_POLL = 8000
const MESSAGE_POLL = 5000

export function ImWorkbench() {
  const [health, setHealth] = useState<Health | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [customer, setCustomer] = useState<CustomerInfo | null>(null)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [loadingCustomer, setLoadingCustomer] = useState(false)
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [sending, setSending] = useState(false)
  const selectedRef = useRef<string | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const r = await imApi.sessions(100)
      setSessions(r.sessions)
      // 支持 /im?session=xxx 直接定位（截图/排查/分享用）
      const want = new URLSearchParams(window.location.search).get('session')
      if (!selectedRef.current && want) {
        const hit = r.sessions.find((s) => s.id === want)
        selectedRef.current = hit ? hit.id : want
        setSelectedId(selectedRef.current)
        return
      }
      if (!selectedRef.current && r.sessions.length > 0) {
        selectedRef.current = r.sessions[0].id
        setSelectedId(r.sessions[0].id)
      }
    } catch (e) {
      toast.error('拉会话失败：' + (e as Error).message)
    } finally {
      setLoadingSessions(false)
    }
  }, [])

  const loadMessages = useCallback(async (id: string) => {
    setLoadingMessages(true)
    try {
      const r = await imApi.messages(id, 100)
      setMessages(r.messages)
    } catch (e) {
      toast.error('拉消息失败：' + (e as Error).message)
    } finally {
      setLoadingMessages(false)
    }
  }, [])

  const loadOrders = useCallback(async (id: string) => {
    setLoadingOrders(true)
    try {
      const r = await imApi.orders(id, 50)
      setOrders(r.orders || [])
    } catch {
      setOrders([])
    } finally {
      setLoadingOrders(false)
    }
  }, [])

  // 订单保鲜：选中会话期间每 30s 刷一次（服务端另有 45s 内的 sold.get 节流）
  useEffect(() => {
    if (!selectedId) return
    const t = setInterval(() => { void loadOrders(selectedId) }, 30 * 1000)
    return () => clearInterval(t)
  }, [selectedId, loadOrders])

  // 初始化
  useEffect(() => {
    void imApi.health().then(setHealth).catch((e) => toast.error('后端未连上：' + (e as Error).message))
    void imApi.me().then((r) => setMe(r.me)).catch(() => {})
    void loadSessions()
  }, [loadSessions])

  // 会话轮询
  useEffect(() => {
    const t = setInterval(() => void loadSessions(), SESSION_POLL)
    return () => clearInterval(t)
  }, [loadSessions])

  // 选中会话 → 拉消息 + 客户信息
  useEffect(() => {
    if (!selectedId) return
    selectedRef.current = selectedId
    void loadMessages(selectedId)
    setLoadingCustomer(true)
    void imApi
      .customer(selectedId)
      .then(setCustomer)
      .catch(() => setCustomer(null))
      .finally(() => setLoadingCustomer(false))
    void imApi.read(selectedId).catch(() => {})
    // 本地立刻消掉徽标，不等下一轮会话同步（服务端 unread 由 /api/read 清）
    setSessions((prev) => prev.map((s) => (s.id === selectedId ? { ...s, unread: 0 } : s)))
    setOrders([])
    void loadOrders(selectedId)
  }, [selectedId, loadMessages, loadOrders])

  // 消息轮询
  useEffect(() => {
    if (!selectedId) return
    const t = setInterval(() => void loadMessages(selectedId), MESSAGE_POLL)
    return () => clearInterval(t)
  }, [selectedId, loadMessages])

  const doSync = async () => {
    setSyncing(true)
    try {
      const r = await imApi.sync(true)
      toast.success(`同步完成：会话 ${r.sessions} 条，新消息 ${r.messages} 条`)
      await loadSessions()
      if (selectedRef.current) await loadMessages(selectedRef.current)
    } catch (e) {
      toast.error('同步失败：' + (e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const doSend = async (text: string) => {
    if (!selectedId) return
    setSending(true)
    try {
      const r = await imApi.send(selectedId, text)
      toast.success(r.dryRun ? '已入 dryRun 队列' : '已发送')
      await loadMessages(selectedId)
    } catch (e) {
      toast.error('发送失败：' + (e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const current = sessions.find((s) => s.id === selectedId) || null

  return (
    <>
      <Header>
        <div className='me-auto flex items-center gap-2'>
          <h1 className='text-base font-semibold'>闲管家客服工作台</h1>
          {health ? (
            <Badge variant={health.hasCookie ? 'secondary' : 'destructive'}>
              {health.hasCookie ? `已绑定 ${health.account || '账号'}` : '缺 Cookie'}
            </Badge>
          ) : (
            <Badge variant='outline'>
              <CircleDot className='animate-pulse' />
              连接中
            </Badge>
          )}
          {health?.dryRun && <Badge variant='outline'>dryRun</Badge>}
        </div>
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main fixed fluid>
        <section className='flex h-full min-h-0 gap-4'>
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            loading={loadingSessions}
            syncing={syncing}
            onSelect={setSelectedId}
            onSync={() => void doSync()}
          />
          <div className='flex min-h-0 flex-1 flex-col gap-3'>
            <MessageThread
            messages={messages}
            loading={loadingMessages}
            hasSession={!!selectedId}
            me={me}
            them={current ? { nick: current.nickname, avatar: current.logo } : null}
            sessionId={selectedId || undefined}
          />
            <Composer
              disabled={!selectedId}
              sending={sending}
              dryRun={!!health?.dryRun}
              onSend={doSend}
            />
          </div>
          <CustomerPanel
            session={current}
            customer={customer}
            loading={loadingCustomer}
            orders={orders}
            loadingOrders={loadingOrders}
            onRefreshOrders={() => selectedId && void loadOrders(selectedId)}
          />
        </section>
      </Main>
    </>
  )
}
