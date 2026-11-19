/** 闲管家客服工作台 —— 后端 API 客户端（对接 src/server.js） */

export type SessionRow = {
  id: string
  type: number
  withWho: string
  /** 客户昵称（来自 user.page.head 的 module.base.displayName，回落会话 orign） */
  nickname?: string
  /** 头像 URL（user.page.head 的 module.base.avatar.avatar） */
  logo?: string
  city?: string
  /** 昵称右边那个交易状态气泡：交易成功 / 等待买家收货 / 交易关闭 …（来自 session.sync 的 redReminder，缺则用最近一单的订单状态推） */
  tradeText?: string
  /** 气泡颜色档位：ok=绿 / warn=橙 / muted=灰 / 空=不显示 */
  tradeTone?: 'ok' | 'warn' | 'muted' | ''
  abstractContent: string
  lastMsgTs: number
  unread: number
  syncedAt: number
  /** 官方列表里是否置顶（置顶排序与闲鱼客户端一致） */
  pinned?: boolean
  pinRank?: number | null
  /** 官方列表里的最后消息时间，排序用它 */
  orderTs?: number
  /** 客户来咨询的商品：itemId / 主图 / 标题（官方会话对象自带） */
  itemId?: string
  itemPic?: string
  itemTitle?: string
}

export type MessageRow = {
  id: string
  ts: number
  contentType: number
  text: string
  senderId: string
  fromSelf: boolean
  media?: MessageMedia
}

/** 后端 src/lib/mcontent.js 摊平后的可渲染结构 */
export type MessageMedia = {
  type:
    | 'text'
    | 'image'
    | 'audio'
    | 'file'
    | 'emoji'
    | 'item'
    | 'transfer'
    | 'rtc'
    | 'withdraw'
    | 'card'
    | 'other'
  text: string
  images?: { url: string; width: number; height: number }[]
  audio?: { url: string; duration: number; size: number }
  file?: { name: string; size: number; ext: string; key: string }
  emoji?: { name: string; url: string; lotie: string }
  item?: { itemId: string; title: string; pic: string; price: string }
  transfer?: { title: string; content: string; pic: string }
  rtc?: { duration: number; detail: string }
  withdraw?: { originText: string }
  card?: { title: string; desc: string; pic: string; button: string; url: string }
  contentType?: number
}

export type Health = {
  ok: boolean
  account: string
  sellerId: string
  hasCookie: boolean
  dbFile: string
  dryRun: boolean
  wsEnv: string
  lastSync: number
  cookieItems: number
}

export type CustomerInfo = {
  sessionId: string
  userId: string
  nick?: string
  avatar?: string
  city?: string
  head?: unknown
  error?: string
}

export type Me = {
  userId: string
  nick?: string
  avatar?: string
  city?: string
}

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } })
  const json = (await res.json()) as T & { error?: string; message?: string }
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
  return json
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = (await res.json()) as T & { error?: string; message?: string }
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`)
  return json
}

export type RuleItem = {
  id: string
  name?: string
  enabled?: boolean
  priority?: number
  match?: { keywords?: string[]; regex?: string; equals?: string; any?: boolean }
  reply?: string
  ai?: boolean
  handoff?: boolean
}

export type RuleConf = {
  cooldown: number
  maxPerSession: number
  minLength: number
  rules: RuleItem[]
  file?: string
  exists?: boolean
}

export type AiModel = {
  id: string
  name?: string
  context?: number | null
  maxOutput?: number | null
}

export type AiConfig = {
  enabled: boolean
  source?: 'harness' | 'manual'
  protocol?: 'auto' | 'anthropic' | 'openai'
  keySource?: string
  harness?: {
    home: string
    credFile: string
    credExists: boolean
    keyRef: string
    hasKey: boolean
    keyMasked: string
    defaultBaseUrl: string
    defaultModel: string
  }
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  persona: string
  knowledge: string[]
  handoffWhen: string[]
  maxLen: number
  dailyLimit: number
  retryOnCheckFail: number
  mock?: boolean
  apiKeyMasked: string
  hasKey: boolean
  file: string
  ready: { ok: boolean; reason?: string }
  usedToday?: number
}

export type Decision = {
  action: 'reply' | 'ai' | 'handoff' | 'ignore'
  source?: string
  text?: string
  reason?: string
  query?: string
  check?: { ok: boolean; issues: string[]; len: number }
  model?: string
  note?: string
  mode?: string
  tries?: number
}

export type SyncBeat = {
  at: number
  ms: number
  scanned: number
  total: number
  sessions: number
  messages: number
  autoQueued: number
  errors: number
  convError: string
  firstErr: string
}

export type CookieAuto = {
  enabled: boolean
  everyMin: number
  port: number
  lastAt: number
  lastOk: boolean | null
  msg: string
  refreshed: number
  failures: number
}

export type SyncStatus = {
  ok: boolean
  running: boolean
  lastSync: number
  sinceLast: number | null
  pollInterval: number
  last: SyncBeat | null
  recent: SyncBeat[]
  cookieAuto?: CookieAuto
}

export type AutoState = {
  mode: 'shadow' | 'live'
  whitelist: string[]
  enabled: boolean
  model: string
  hasKey: boolean
  dailyLimit: number
  usedToday: number
  pending: number
  running: boolean
  shadowFile: string
  shadow: {
    at: string
    mode: string
    sessionId: string
    text: string
    action: string
    source: string
    reason?: string
    reply?: string
    sent?: boolean
  }[]
}

export type ShadowRecord = {
  at: string
  mode?: string
  sessionId?: string
  text?: string
  action: string
  source?: string
  reason?: string
  reply?: string
  sent?: boolean
}

export type ShadowResp = { ok: boolean; count: number; file: string; records: ShadowRecord[] }

/** 运行日志：客户真实消息 + 对应决策（可能没有决策） */
export type RunLogItem = {
  ts: number
  sessionId: string
  nick: string
  ctype: number
  text: string
  action: string
  source: string
  reason: string
  reply: string
  sent: boolean
  mode: string
}

export type RunLogResp = {
  ok: boolean
  count: number
  counts: Record<string, number>
  items: RunLogItem[]
}

export type AutoTickResult = {
  mode: string
  taken: number
  reply: number
  handoff: number
  ignore: number
  sent: number
  errors: { sessionId: string; err: string }[]
}

export const imApi = {
  health: () => get<Health>('/health'),
  syncStatus: () => get<SyncStatus>('/sync/status'),
  accounts: () =>
    get<{ current: string; accounts: { unb: string; savedAtText: string; cookieCount: number }[] }>(
      '/accounts'
    ),
  sessions: (limit = 50) => get<{ sessions: SessionRow[]; count: number; lastSync: number }>(`/sessions?limit=${limit}`),
  messages: (sessionId: string, limit = 50) =>
    get<{ sessionId: string; messages: MessageRow[]; count: number }>(
      `/messages?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`
    ),
  customer: (sessionId: string) =>
    get<CustomerInfo>(`/customer?sessionId=${encodeURIComponent(sessionId)}`),
  me: () => get<{ me: Me; accountId: string }>('/me'),
  overview: (days = 7) => get<OverviewStats>('/overview?days=' + days),
  orderTabs: () => get<OrderTabsResp>('/orders/tabs'),
  orderList: (tab = 'all', limit = 100) => get<OrderListResp>('/orders/list?tab=' + tab + '&limit=' + limit),
  orderSync: (limit = 20) => post<{ tried: number; saved: number; cooldownUntil: number }>('/orders/sync', { limit }),
  orders: (sessionId: string, limit = 5) =>
    get<OrdersResp>('/orders?sessionId=' + encodeURIComponent(sessionId) + '&limit=' + limit),
  consignDummy: (orderId: string) =>
    post<{ ok: boolean; code?: string; order?: OrderRow | null; error?: string }>('/order/consign-dummy', { orderId }),
  orderPrice: (orderId: string, refresh = false) =>
    get<OrderPriceResp>('/order/price?orderId=' + encodeURIComponent(orderId) + (refresh ? '&refresh=1' : '')),
  products: () => get<{ products: ProductRow[] }>('/products'),
  product: (itemId: string) => get<ProductDetail>('/product?itemId=' + encodeURIComponent(itemId)),
  uploadDoc: (itemId: string, name: string, contentBase64: string) =>
    post<{ ok: boolean; doc: ProductDoc }>('/product/doc', { itemId, name, contentBase64 }),
  pasteDoc: (itemId: string, name: string, text: string) =>
    post<{ ok: boolean; doc: ProductDoc }>('/product/doc', { itemId, name, text }),
  deleteDoc: async (id: number) => {
    const res = await fetch(BASE + '/product/doc?id=' + id, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    })
    const json = (await res.json()) as { ok?: boolean; error?: string }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
    return { ok: Boolean(json.ok) }
  },
  productQa: (itemId: string, q: string, k = 3) =>
    get<{ itemId: string; q: string; hits: ClauseHit[] }>(
      '/product/qa?itemId=' + encodeURIComponent(itemId) + '&q=' + encodeURIComponent(q) + '&k=' + k
    ),
  aiStyle: () =>
    get<{ hasKey: boolean; model: string; pairs: number; card: string; profile: unknown }>('/ai/style'),
  aiPreview: (sessionId: string, text: string, live = false) =>
    post<AiPreview>('/ai/preview', { sessionId, text, live }),
  sync: (full = true) => post<{ sessions: number; messages: number; errors: unknown[] }>('/sync', { full }),
  send: (sessionId: string, text: string) => post<{ ok: boolean; localId: string; dryRun: boolean }>('/send', { sessionId, text }),
  read: (sessionId: string) => post<{ ok: boolean }>('/read', { sessionId }),
  rules: () => get<RuleConf>('/rules'),
  saveRules: (conf: RuleConf) => post<{ ok: boolean } & RuleConf>('/rules', conf),
  aiConfig: () => get<AiConfig>('/ai/config'),
  autoState: () => get<AutoState>('/autoreply/state'),
  autoConfig: (opts: { mode: 'shadow' | 'live'; whitelist: string[] }) =>
    post<{ ok: boolean; mode: 'shadow' | 'live'; whitelist: string[] }>('/autoreply/config', opts),
  autoTick: () => post<AutoTickResult>('/autoreply/tick', {}),
  runLog: (limit = 60, sessionId?: string) =>
    get<RunLogResp>('/runlog?limit=' + limit + (sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : '')),
  autoShadow: (action?: string, limit = 200) =>
    get<ShadowResp>(
      '/autoreply/shadow?limit=' + limit + (action ? '&action=' + encodeURIComponent(action) : '')
    ),
  saveAiConfig: (patch: Partial<AiConfig> & { apiKey?: string }) =>
    post<{ ok: boolean; config: AiConfig }>('/ai/config', patch),
  aiTest: () => post<{ ok: boolean; text?: string; model?: string; error?: string; skipped?: boolean }>('/ai/test', {}),
  aiModels: (opts: { apiKey?: string; baseUrl?: string } = {}) =>
    post<{ ok: boolean; endpoint: string; count: number; models: AiModel[]; error?: string }>('/ai/models', opts),
  plans: (opts: { q?: string; company?: string; cls?: string; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.q) p.set('q', opts.q)
    if (opts.company) p.set('company', opts.company)
    if (opts.cls) p.set('cls', opts.cls)
    p.set('limit', String(opts.limit ?? 400))
    return get<PlansResp>('/plans?' + p.toString())
  },
  plan: (code: string) => get<{ plan: PlanFull; bindings: BindingRow[] }>('/plan?code=' + encodeURIComponent(code)),
  plansSync: (opts: { code?: string; limit?: number; detail?: boolean } = {}) =>
    post<{ ok: boolean; catalog?: number; count?: number; detailSynced?: number }>('/plans/sync', opts),
  bindPlan: (itemId: string, planCode?: string, itemTitle = '', productCode?: string) =>
    post<{ ok: boolean }>('/plan/bind', { itemId, planCode, itemTitle, productCode }),
  unbindPlan: (itemId: string) => post<{ ok: boolean }>('/plan/unbind', { itemId }),
  planJob: () => get<PlanJob>('/plans/job'),
  planJobSave: (patch: { enabled?: boolean; hour?: number }) => post<PlanJob>('/plans/job', patch),
  planJobRun: () => post<PlanJob>('/plans/job', { runNow: true }),
  bindings: () => get<{ bindings: BindingRow[] }>('/bindings'),
  aiAnswer: (sessionId: string, text: string, live = true) =>
    post<{ decision: Decision }>('/ai/answer', { sessionId, text, live }),
  mailConfig: () => get<MailConfig>('/mail/config'),
  saveMailConfig: (patch: Partial<MailConfig> & { pass?: string }) =>
    post<{ ok: boolean; config: MailConfig }>('/mail/config', patch),
  mailVerify: () =>
    post<{ ok: boolean; host?: string; port?: number; secure?: boolean; auth?: string; caps?: string[]; error?: string }>(
      '/mail/verify',
      {}
    ),
  mailTest: (to?: string) =>
    post<{ ok: boolean; to?: string; size?: number; reply?: string; error?: string }>('/mail/test', to ? { to } : {}),
  mailSend: (body: { to: string; subject: string; text?: string; html?: string }) =>
    post<{ ok: boolean; to?: string; size?: number; reply?: string; error?: string }>('/mail/send', body),
  mailSendPolicy: (body: {
    sessionId?: string
    to?: string
    orderNo?: string
    policyNo?: string
    buyerName?: string
    planName?: string
    itemTitle?: string
    startTime?: string
    endTime?: string
    amount?: string
  }) =>
    post<{ ok: boolean; to?: string; subject?: string; size?: number; reply?: string; pdfFile?: string; bytes?: number; error?: string }>(
      '/mail/send-policy',
      body
    ),
  trainAsk: (text: string, sessionId?: string, itemId?: string, itemTitle?: string) =>
    post<TrainItem>('/train/ask', { text, sessionId, itemId, itemTitle }),
  trainContexts: () => get<{ items: TrainContext[]; count: number }>('/train/contexts'),
  trainLabel: (body: { id: number; verdict: 'good' | 'bad'; corrected?: string; note?: string }) =>
    post<{ ok: boolean; item: TrainItem }>('/train/label', body),
  trainList: (limit = 50, verdict?: 'good' | 'bad') =>
    get<{ items: TrainItem[]; stats: TrainStats }>(
      '/train/list?limit=' + limit + (verdict ? '&verdict=' + verdict : '')
    ),
  trainDistill: () => post<{ ok: boolean; total: number; groups: number; drafts: TrainDraft[] }>('/train/distill', {}),
  trainApply: (drafts: TrainDraft[]) =>
    post<{ ok: boolean; added: number; updated: number; total: number }>('/train/apply', { drafts }),
}

export type TrainItem = {
  id: number
  question: string
  answer: string
  model?: string
  source?: string
  selfcheck?: string
  session_id?: string
  item_id?: string | null
  item_title?: string | null
  verdict: 'good' | 'bad' | null
  corrected?: string | null
  tags?: string | null
  note?: string | null
  created_at?: number
  updated_at?: number
  ok?: boolean
}

export type TrainStats = {
  total: number
  good: number
  bad: number
  unlabeled: number
  fixed: number
  rate: number
}

export type TrainDraft = {
  id: string
  name: string
  priority: number
  match: { keywords?: string[] }
  handoff: boolean
  ai: boolean
  reply: string
  samples: number
  questions: string[]
  trainIds: number[]
  when?: { itemId: string; itemTitle?: string }
  itemId?: string
  itemTitle?: string
}

export type TrainContext = {
  itemId: string
  itemTitle: string
  planCode: string
  planName: string
  company?: string
  className?: string
  boundAt?: number
}

export type MailPreset = { key: string; host: string; port: number; secure: boolean; note: string }

export type MailConfig = {
  host: string
  port: number
  secure: boolean
  user: string
  fromName: string
  fromAddr: string
  replyTo: string
  dailyLimit: number
  sentToday: number
  sentDate: string
  ready: boolean
  hasPass: boolean
  passMasked: string
  presets: Record<string, { host: string; port: number; secure: boolean; note: string }>
}

export function fmtTime(ts: number | undefined): string {
  if (!ts || ts < 1e11) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n: number) => String(n).padStart(2, '0')
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`
}

export function fmtFull(ts: number | undefined): string {
  if (!ts || ts < 1e11) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type OrderAction = {
  name: string
  action: string
  /** 平台深链：fleamarket:// / alipays:// / https://h5.m.goofish.com/... */
  url: string
  disabled: boolean
}

export type OrderRow = {
  orderId: string
  status: string
  statusText: string
  createTime: string
  itemId: string
  title: string
  pic: string
  sku?: string
  amount?: number | null
  priceLabel?: string
  price?: string
  tags?: string[]
  buyer?: { userId?: string; nick?: string; avatar?: string }
  actions?: OrderAction[]
  error?: string
  /** 金额拆分（来自 /api/order/price，没有就是 null） */
  cashAmount?: number | null
  coinAmount?: number | null
  coinCount?: number | null
  goodsTotal?: number | null
  coinsReceiving?: number | null
  smartDeduct?: number | null
  payTime?: string | null
  alipayNo?: string | null
  address?: string | null
  invoiceTotal?: number | null
}

/** 订单金额拆分（现金 + 闲鱼币） */
export type OrderPrice = {
  orderId: string
  cashAmount: number | null
  coinAmount?: number | null
  coinCount: number | null
  goodsTotal?: number | null
  invoiceTotal: number | null
  coinsReceiving?: number | null
  smartDeduct?: number | null
  postFee?: number | null
  payTime?: string | null
  alipayNo?: string | null
  address?: string | null
}

export type OrderPriceResp = {
  ok: boolean
  from?: string
  price: OrderPrice | null
  line: string
  error?: string
}

export type OrdersResp = {
  sessionId: string
  orderIds: string[]
  orders: OrderRow[]
  count: number
  error?: string
}
export type OrderCounts = {
  all: number
  unpaid: number
  unshipped: number
  refunding: number
  shipped: number
  unrated: number
  compensate: number
}

export type OrderTabsResp = {  counts: OrderCounts
  coolingDown: boolean
  cooldownUntil: number
  known: boolean
}

export type OrderListResp = {
  tab: string
  orders: (OrderRow & { sessionId?: string; fetchedAt?: number })[]
  count: number
  counts: OrderCounts
}

export const ORDER_TABS: { key: keyof OrderCounts; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unpaid', label: '待付款' },
  { key: 'unshipped', label: '待发货' },
  { key: 'refunding', label: '退款中' },
  { key: 'shipped', label: '已发货' },
  { key: 'unrated', label: '待评价' },
  { key: 'compensate', label: '赔付单' },
]
/** tab → tradeStatusEnum（与服务端 src/lib/store.js 的 ORDER_TABS 保持一致） */
export const ORDER_STATUS_TABS: Record<string, string[]> = {
  unpaid: ['buyer_to_pay', 'trade_no_pay', 'wait_buyer_pay'],
  unshipped: ['seller_to_send'],
  refunding: ['refund_by_buyer', 'refund_by_seller', 'refund_wait_seller', 'refund_agree'],
  shipped: ['seller_send', 'seller_sent', 'buyer_to_confirm'],
  unrated: ['trade_success'],
  compensate: [],
}

export type OverviewStats = {
  today: { messagesIn: number; messagesOut: number; sessions: number; orders: number; amount: number }
  totals: { sessions: number; messages: number; customers: number; orders: number; amount: number }
  pending: { unreadSessions: number; unshipped: number; refunding: number; unrated: number }
  trend: { date: string; in: number; out: number }[]
  orderStatus: { status: string; text: string; n: number }[]
  topCustomers: { userId: string; nick: string; avatar: string; msgs: number }[]
  recentOrders: OrderRow[]
}
export type ProductDoc = {
  id: number
  name: string
  kind: string
  chars: number
  note?: string | null
  createdAt?: number
}

export type ProductRow = {
  itemId: string
  title: string
  pic: string
  sessions: number
  orders: number
  amount: number
  docs: number
  docChars: number
  lastTs?: number
}

export type ProductDetail = ProductRow & { docs: ProductDoc[] }

export type ClauseHit = {
  docId: number
  seq: number
  score: number
  hits: number
  matched?: string[]
  text: string
}

export type AiPreview = {
  skipped?: boolean
  hasKey?: boolean
  model?: string
  draft?: string
  selfCheck?: { ok: boolean; problems: string[] }
  examples?: { score: number; q: string; a: string }[]
  facts?: string[]
  error?: string
}

export type PlanRow = {
  planCode: string
  name: string
  company: string
  className: string
  minAge: number
  maxAge: number
  basePrice: number
  coverageCount: number
  noticeChars: number
  clauseChars: number
  syncedAt: number
  boundItems: number
}

export type PlanCoverage = { group: string; name: string; value: string; column?: string }

export type PlanFull = {
  planCode: string
  name: string
  company: string
  className: string
  minAge: number
  maxAge: number
  basePrice: number
  clauseFile?: string
  coverage: PlanCoverage[]
  notice: string
  clause: string
  priceTable: { days: number; price: number }[]
  feeTable: { start: number; end: number; price: number }[]
  syncedAt?: number
}

export type PlanTier = {
  planCode: string
  name: string
  level: string
  basePrice: number
  minAge: number
  maxAge: number
  coverageCount: number
  noticeChars: number
  clauseChars: number
  boundItems: number
  quotePrice?: number
  costPrice?: number
  realPercent?: number
}

export type PlanProduct = {
  key: string
  name: string
  company: string
  className: string
  minAge: number
  maxAge: number
  basePrice: number
  quotePrice?: number
  costPrice?: number
  levels: number
  boundItems: number
  plans: PlanTier[]
}

export type PlansResp = {
  total: number
  count: number
  products: PlanProduct[]
  plans: PlanRow[]
  facets: { companies: { name: string; n: number }[]; classes: { name: string; n: number }[] }
}

export type BindingRow = {
  item_id: string
  plan_code: string
  product_code?: string
  item_title: string
  bound_at: number
  plan_name?: string
}

export type PlanJob = {
  enabled: boolean
  hour: number
  detail: boolean
  lastRunDay: string
  lastRunAt: number
  lastResult: string
  lastOk: number
  lastFail: number
  running: boolean
  done: number
  total: number
  ok: number
  fail: number
  current: string
  lastError: string
  startedAt: number
  finishedAt: number
  file?: string
}
