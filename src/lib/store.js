'use strict';
/**
 * 本地状态库（node:sqlite，零外部依赖）
 * 目的：断点续拉、去重、事件留存、发送流水 —— 自动化系统的地基。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { cfg } = require('../config');

fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
const db = new DatabaseSync(cfg.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 8000;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  type INTEGER,
  with_id TEXT,
  abstract TEXT,
  last_ts INTEGER,
  unread INTEGER,
  orign TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER,
  ctype INTEGER,
  text TEXT,
  sender_id TEXT,
  from_self INTEGER,
  raw TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_session_ts ON messages(session_id, ts);

CREATE TABLE IF NOT EXISTS customers (
  user_id TEXT PRIMARY KEY,
  nick TEXT,
  avatar TEXT,
  city TEXT,
  head TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS cursors (k TEXT PRIMARY KEY, v TEXT);

/* 买家订单索引：从消息卡片里捞到订单号后，逐个 sold.get 落库。
   tab 分组用 status（tradeStatusEnum）在查询时算，不落冗余列。 */
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  session_id TEXT,
  status TEXT,
  status_text TEXT,
  create_time TEXT,
  item_id TEXT,
  title TEXT,
  pic TEXT,
  sku TEXT,
  amount INTEGER,
  price TEXT,
  buyer_id TEXT,
  buyer_nick TEXT,
  buyer_avatar TEXT,
  actions TEXT,
  fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_time ON orders(create_time);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, payload TEXT, ts INTEGER, handled INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, session_id TEXT, content TEXT, status TEXT, ts INTEGER, resp TEXT
);

/* 保险平台的方案目录（从旅云保同步下来）：
   plans      一条 = 一个计划（planCode），含方案内容/须知/条款纯文本与价目表
   item_plans 商品 ↔ 计划 的绑定，一个商品绑一个计划（换绑即覆盖） */
CREATE TABLE IF NOT EXISTS plans (
  plan_code TEXT PRIMARY KEY,
  name TEXT,
  company_id TEXT,
  company TEXT,
  class_id TEXT,
  class_name TEXT,
  nick TEXT,
  min_age INTEGER,
  max_age INTEGER,
  clause_file TEXT,
  intro_file TEXT,
  base_price REAL,
  price_table TEXT,
  fee_table TEXT,
  coverage TEXT,
  notice TEXT,
  clause TEXT,
  synced_at INTEGER
);
CREATE TABLE IF NOT EXISTS item_plans (
  item_id TEXT PRIMARY KEY,
  plan_code TEXT,
  item_title TEXT,
  bound_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_item_plans_plan ON item_plans(plan_code);
`);

/* 方案表补列：real_percent = 旅云保的 REALPERCENT（成本率），
   报价 = 标准价，成本 = 标准价 × real_percent */
{
  const planCols = db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name);
  if (!planCols.includes('real_percent')) {
    try { db.exec('ALTER TABLE plans ADD COLUMN real_percent REAL'); } catch (_) {}
  }
  // 条款集分节（本方案条款 PDF 里包含主险 + 若干附加险，各带注册号）
  for (const [col, ddl] of [
    ['clause_sections', 'TEXT'],
    ['clause_pages', 'INTEGER'],
    ['clause_garbled', 'TEXT'],
    ['clause_ocr', 'TEXT'],
  ]) {
    if (!planCols.includes(col)) {
      try { db.exec(`ALTER TABLE plans ADD COLUMN ${col} ${ddl}`); } catch (_) {}
    }
  }
  // item_plans 按「方案」绑定（product_code = planCode 前两段），plan_code 表示该方案的默认保额档
  const ipCols = db.prepare('PRAGMA table_info(item_plans)').all().map((c) => c.name);
  if (!ipCols.includes('product_code')) {
    try {
      db.exec('ALTER TABLE item_plans ADD COLUMN product_code TEXT');
      db.exec("UPDATE item_plans SET product_code = substr(plan_code, 1, 9) WHERE COALESCE(product_code,'') = ''");
    } catch (_) {}
  }
}

/* 订单金额拆分（老库自动 ALTER 补齐）：
   闲鱼订单的「付款金额」= 现金 + 闲鱼币抵扣，只显示实付会把开票金额算少。
   cash_amount   = 成交价（现金，支付宝担保账户里的钱）
   coin_amount   = 买家闲鱼币抵扣的「元」（-0.30 → 0.30）
   coin_count    = 上面的钱换算成币数（1000 币 = 1 元）
   goods_total   = 商品总价（= cash + coin，开票就按这个）
   coins_receiving = 待收闲鱼币（含平台奖励，仅供参考）
   smart_deduct  = 闲鱼币智能抵扣的元（卖家侧，从货款里换币）
   pay_time / alipay_no / address / price_at = 订单详情快照 */
{
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  for (const [col, ddl] of [
    ['cash_amount', 'TEXT'],
    ['coin_amount', 'TEXT'],
    ['coin_count', 'INTEGER'],
    ['goods_total', 'TEXT'],
    ['coins_receiving', 'INTEGER'],
    ['smart_deduct', 'TEXT'],
    ['pay_time', 'TEXT'],
    ['alipay_no', 'TEXT'],
    ['address', 'TEXT'],
    ['price_at', 'INTEGER'],
  ]) {
    if (!orderCols.includes(col)) {
      try { db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${ddl}`); } catch (_) {}
    }
  }
}

/* 官方列表排序所需的列（老库自动 ALTER 补齐）：
   order_ts  = 官方列表里这条会话的最后一条消息时间
   pinned    = 是否置顶
   pin_rank  = 置顶顺序（listTop 返回顺序，0 在最前） */
const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
for (const [col, ddl] of [
  ['order_ts', 'ALTER TABLE sessions ADD COLUMN order_ts INTEGER'],
  ['pinned', 'ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0'],
  ['pin_rank', 'ALTER TABLE sessions ADD COLUMN pin_rank INTEGER'],
  ['source', "ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'mtop'"],
  // 客户来咨询的商品：主图 URL + 标题 + itemId（官方会话对象里就有，不用额外请求）
  ['item_id', 'ALTER TABLE sessions ADD COLUMN item_id TEXT'],
  ['item_pic', 'ALTER TABLE sessions ADD COLUMN item_pic TEXT'],
  ['item_title', 'ALTER TABLE sessions ADD COLUMN item_title TEXT'],
  // item_seller_id = 这条会话对应的商品是谁在卖（用来区分「我卖的商品」和「我买的商品」）
  ['item_seller_id', 'ALTER TABLE sessions ADD COLUMN item_seller_id TEXT'],
  // 交易状态气泡（昵称右边那个）：session.sync 的 summary.redReminder + redReminderStyle
  ['trade_text', 'ALTER TABLE sessions ADD COLUMN trade_text TEXT'],
  ['trade_style', 'ALTER TABLE sessions ADD COLUMN trade_style INTEGER'],
]) {
  if (!sessionCols.includes(col)) db.exec(ddl);
}

const q = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id,type,with_id,abstract,last_ts,unread,orign,updated_at,trade_text,trade_style)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, with_id=excluded.with_id, abstract=excluded.abstract,
      last_ts=excluded.last_ts, unread=excluded.unread, orign=excluded.orign,
      updated_at=excluded.updated_at,
      trade_text=excluded.trade_text,
      trade_style=CASE WHEN excluded.trade_style IS NOT NULL THEN excluded.trade_style ELSE sessions.trade_style END`),
  getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
  // 官方排序：置顶在前（按 listTop 顺序），其余按官方列表里的最后消息时间倒序
  listSessions: db.prepare(`
    SELECT * FROM sessions
    ORDER BY COALESCE(pinned,0) DESC, COALESCE(pin_rank, 999999) ASC,
             COALESCE(order_ts, last_ts) DESC LIMIT ?`),
  listSessionsJoined: db.prepare(`
    SELECT s.*, c.nick AS c_nick, c.avatar AS c_avatar
    FROM sessions s LEFT JOIN customers c ON c.user_id = s.with_id
    ORDER BY COALESCE(s.pinned,0) DESC, COALESCE(s.pin_rank, 999999) ASC,
             COALESCE(s.order_ts, s.last_ts) DESC LIMIT ?`),
  /**
   * 按「真实活跃度」排序的会话（给 doSync 决定这一轮扫哪些会话用）。
   * 不能只按 order_ts 排：官方列表被限流时 order_ts 会停在几天前，
   * 有新消息的会话就被挤到 120 名开外，永远轮不到同步 —— 表现就是「消息没收到」。
   * 这里把 messages 表里最新的 ts 也算进来。
   */
  listSessionsByActivity: db.prepare(`
    SELECT s.*,
           MAX(
             COALESCE(s.order_ts,0),
             COALESCE(s.last_ts,0),
             COALESCE((SELECT MAX(m.ts) FROM messages m WHERE m.session_id = s.id),0)
           ) AS activity_ts
    FROM sessions s
    ORDER BY COALESCE(s.pinned,0) DESC,
             COALESCE(s.pin_rank, 999999) ASC,
             activity_ts DESC
    LIMIT ?`),
  setOrdering: db.prepare(`
    UPDATE sessions SET order_ts=?, pinned=?, pin_rank=? WHERE id=?`),
  upsertImpaasSession: db.prepare(`
    INSERT INTO sessions (id,type,with_id,abstract,last_ts,unread,orign,updated_at,
                          order_ts,pinned,pin_rank,source,item_id,item_pic,item_title,item_seller_id,
                          trade_text,trade_style)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'impaas',?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type,
      with_id=CASE WHEN excluded.with_id<>'' THEN excluded.with_id ELSE sessions.with_id END,
      abstract=excluded.abstract, last_ts=excluded.last_ts, unread=excluded.unread,
      orign=CASE WHEN excluded.orign<>'' THEN excluded.orign ELSE sessions.orign END,
      updated_at=excluded.updated_at, order_ts=excluded.order_ts,
      pinned=excluded.pinned, pin_rank=excluded.pin_rank, source='impaas',
      item_id=CASE WHEN COALESCE(excluded.item_id,'')<>'' THEN excluded.item_id ELSE sessions.item_id END,
      item_pic=CASE WHEN COALESCE(excluded.item_pic,'')<>'' THEN excluded.item_pic ELSE sessions.item_pic END,
      item_title=CASE WHEN COALESCE(excluded.item_title,'')<>'' THEN excluded.item_title ELSE sessions.item_title END,
      item_seller_id=CASE WHEN COALESCE(excluded.item_seller_id,'')<>'' THEN excluded.item_seller_id ELSE sessions.item_seller_id END,
      trade_text=excluded.trade_text,
      trade_style=CASE WHEN excluded.trade_style IS NOT NULL THEN excluded.trade_style ELSE sessions.trade_style END`),
  clearPinned: db.prepare(`UPDATE sessions SET pinned=0, pin_rank=NULL WHERE pinned<>0`),
  upsertCustomer: db.prepare(`
    INSERT INTO customers (user_id,nick,avatar,city,head,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      nick=excluded.nick, avatar=excluded.avatar, city=excluded.city,
      head=excluded.head, updated_at=excluded.updated_at`),
  getCustomer: db.prepare('SELECT * FROM customers WHERE user_id=?'),
  insertMessage: db.prepare(`
    INSERT INTO messages (id,session_id,ts,ctype,text,sender_id,from_self,raw,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      -- 推送帧只有 extension.reminderContent，没有 content；等历史同步拿到完整 content 时用更长的 raw 覆盖
      raw = CASE WHEN length(excluded.raw) > length(COALESCE(messages.raw,'')) THEN excluded.raw ELSE messages.raw END,
      text = CASE WHEN length(excluded.raw) > length(COALESCE(messages.raw,'')) THEN excluded.text ELSE messages.text END,
      ctype = CASE WHEN length(excluded.raw) > length(COALESCE(messages.raw,'')) THEN excluded.ctype ELSE messages.ctype END`),
  listMessages: db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY ts DESC LIMIT ?'),
  clearUnread: db.prepare('UPDATE sessions SET unread=0 WHERE id=? AND COALESCE(unread,0)<>0'),
  // 消息一到就把会话顶上去：last_ts 与 order_ts 都取较大值，列表排序用的是 order_ts
  touchSession: db.prepare(`
    UPDATE sessions
       SET last_ts = MAX(COALESCE(last_ts,0), ?),
           order_ts = MAX(COALESCE(order_ts,0), ?),
           unread = COALESCE(unread,0) + ?,
           updated_at = ?
     WHERE id = ?`),
  getCursor: db.prepare('SELECT v FROM cursors WHERE k=?'),
  setCursor: db.prepare('INSERT INTO cursors (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  upsertOrder: db.prepare(`
    INSERT INTO orders (order_id,session_id,status,status_text,create_time,item_id,title,pic,
                        sku,amount,price,buyer_id,buyer_nick,buyer_avatar,actions,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET
      session_id=COALESCE(excluded.session_id, orders.session_id),
      status=excluded.status, status_text=excluded.status_text, create_time=excluded.create_time,
      item_id=excluded.item_id, title=excluded.title, pic=excluded.pic, sku=excluded.sku,
      amount=excluded.amount, price=excluded.price, buyer_id=excluded.buyer_id,
      buyer_nick=excluded.buyer_nick, buyer_avatar=excluded.buyer_avatar,
      actions=excluded.actions, fetched_at=excluded.fetched_at`),
  getOrder: db.prepare('SELECT * FROM orders WHERE order_id=?'),
  setOrderPrice: db.prepare(`
    UPDATE orders SET cash_amount=?, coin_amount=?, coin_count=?, goods_total=?,
      coins_receiving=?, smart_deduct=?, pay_time=?, alipay_no=?, address=?, price_at=?
    WHERE order_id=?`),
  listOrders: db.prepare('SELECT * FROM orders ORDER BY create_time DESC LIMIT ?'),
  orderCounts: db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
  addEvent: db.prepare('INSERT INTO events (kind,payload,ts,handled) VALUES (?,?,?,0)'),
  pendingEvents: db.prepare('SELECT * FROM events WHERE handled=0 ORDER BY id LIMIT ?'),
  markHandled: db.prepare('UPDATE events SET handled=1 WHERE id=?'),
  addOutbox: db.prepare('INSERT INTO outbox (id,session_id,content,status,ts,resp) VALUES (?,?,?,?,?,?)'),
  setOutbox: db.prepare('UPDATE outbox SET status=?, resp=? WHERE id=?'),
};

/* 订单状态分组：tab 名 → tradeStatusEnum 列表（平台的枚举是 camel/snake，见第 14 节实测）
   赔付单不在 sold.get 里，走补偿接口，这里先留空数组占位。 */
const ORDER_TABS = {
  unpaid: ['buyer_to_pay', 'trade_no_pay', 'wait_buyer_pay'],
  unshipped: ['seller_to_send'],
  refunding: ['refund_by_buyer', 'refund_by_seller', 'refund_wait_seller', 'refund_agree'],
  shipped: ['seller_send', 'seller_sent', 'buyer_to_confirm'],
  unrated: ['trade_success'],
  compensate: [],
};

function rowToOrder(r) {
  let actions = [];
  try { actions = JSON.parse(r.actions || '[]'); } catch (_) {}
  return {
    orderId: r.order_id,
    sessionId: r.session_id,
    status: r.status,
    statusText: r.status_text,
    createTime: r.create_time,
    itemId: r.item_id,
    title: r.title,
    pic: r.pic,
    sku: r.sku,
    amount: r.amount,
    price: r.price,
    buyer: { userId: r.buyer_id, nick: r.buyer_nick, avatar: r.buyer_avatar },
    actions,
    fetchedAt: r.fetched_at,
    // 金额拆分（没有就都是 null，前端按「只有实付」的老样子显示）
    cashAmount: r.cash_amount == null ? null : Number(r.cash_amount),
    coinAmount: r.coin_amount == null ? null : Number(r.coin_amount),
    coinCount: r.coin_count == null ? null : Number(r.coin_count),
    goodsTotal: r.goods_total == null ? null : Number(r.goods_total),
    coinsReceiving: r.coins_receiving == null ? null : Number(r.coins_receiving),
    smartDeduct: r.smart_deduct == null ? null : Number(r.smart_deduct),
    payTime: r.pay_time || null,
    alipayNo: r.alipay_no || null,
    address: r.address || null,
    priceAt: r.price_at == null ? null : Number(r.price_at),
    // 开票金额：有拆分的用商品总价，否则退回 price
    invoiceTotal: r.goods_total != null ? Number(r.goods_total) : Number(r.price) || null,
  };
}
const now = () => Date.now();

const store = {
  /** 只读直连（给 style/分析类模块用，别在业务里乱写 SQL） */
  raw() {
    return db;
  },
  saveSessions(list) {
    for (const s of list) {
      q.upsertSession.run(s.id, s.type || 0, s.withWho ? s.withWho.id : '', s.abstractContent || '',
        s.lastMsgTs || 0, s.unread || 0, s.orignJson || '', now(),
        s.tradeText || '', s.tradeStyle === undefined ? null : s.tradeStyle);
    }
    return list.length;
  },

  getSession: id => q.getSession.get(id),
  listSessions: (n = 50) => q.listSessions.all(n),
  /** 按「真实活跃度」（order_ts / last_ts / 最新消息 ts 取最大）排序 */
  listSessionsByActivity: (n = 50) => q.listSessionsByActivity.all(n),

  saveMessages(sessionId, msgs) {
    let added = 0;
    for (const m of msgs) {
      const id = m.messageId || `${sessionId}:${m.version}`;
      const r = q.insertMessage.run(id, sessionId, m.ts || m.version || 0, m.contentType || 0,
        m.text || '', m.senderId || '', m.fromSelf ? 1 : 0, JSON.stringify(m.raw || m), now());
      if (r.changes) added++;
    }
    return added;
  },

  listMessages: (sessionId, n = 50) => q.listMessages.all(sessionId, n),

  /** 打开会话后清未读徽标（本地立即生效，服务端已读回执是尽力而为） */
  clearUnread(sessionId) {
    const r = q.clearUnread.run(String(sessionId));
    return r.changes || 0;
  },

  /**
   * 有新消息时把会话行的「最后消息时间 / 未读」推上去。
   * 官方会话列表（order_ts 的真正的来源）会被 IM 侧限流，限流期间如果没有这一步，
   * 新消息就只躺在 messages 表里，列表不排序、未读不涨 —— 表现就是「消息没收到」。
   */
  touchSession(sessionId, ts, unreadDelta = 0) {
    const t = Number(ts) || 0;
    if (!t) return 0;
    const r = q.touchSession.run(t, t, Math.max(0, Number(unreadDelta) || 0), now(), String(sessionId));
    return r.changes || 0;
  },

  // ---------------------------------------------------------- 客户档案
  saveCustomer(c) {
    q.upsertCustomer.run(
      String(c.userId), c.nick || '', c.avatar || '', c.city || '',
      c.head ? JSON.stringify(c.head).slice(0, 4000) : '', now()
    );
  },
  getCustomer: userId => {
    const r = q.getCustomer.get(String(userId));
    if (!r) return null;
    let head = null;
    try { head = r.head ? JSON.parse(r.head) : null; } catch (_) {}
    return { userId: r.user_id, nick: r.nick, avatar: r.avatar, city: r.city, head, updatedAt: r.updated_at };
  },
  /** 会话 + 客户档案（昵称/头像优先取 customers 表） */
  listSessionsWithCustomer(n = 50) {
    return q.listSessionsJoined.all(n).map(r => ({
      id: r.id, type: r.type, with_id: r.with_id, abstract: r.abstract,
      last_ts: r.last_ts, unread: r.unread, orign: r.orign, updated_at: r.updated_at,
      nick: r.c_nick || '', avatar: r.c_avatar || '',
      order_ts: r.order_ts, pinned: r.pinned, pin_rank: r.pin_rank, source: r.source,
    }));
  },

  /** 把官方列表顺序写回 sessions（置顶 + 时间） */
  saveOrder(o) {
    if (!o || !o.orderId) return 0;
    q.upsertOrder.run(
      String(o.orderId),
      o.sessionId == null ? null : String(o.sessionId),
      String(o.status || ''),
      String(o.statusText || ''),
      String(o.createTime || ''),
      String(o.itemId || ''),
      String(o.title || ''),
      String(o.pic || ''),
      String(o.sku || ''),
      o.amount == null ? null : Number(o.amount),
      String(o.price || ''),
      String(o.buyer && o.buyer.userId || ''),
      String(o.buyer && o.buyer.nick || ''),
      String(o.buyer && o.buyer.avatar || ''),
      JSON.stringify(o.actions || []),
      Date.now()
    );
    return 1;
  },

  getOrder(id) {
    const r = q.getOrder.get(String(id));
    return r ? rowToOrder(r) : null;
  },

  /** 存订单金额拆分（来自 mtop.idle.web.trade.order.detail 的 priceInfo） */
  saveOrderPrice(p) {
    if (!p || !p.orderId) return 0;
    const num = (v) => (v == null || v === '' ? null : Number(v));
    q.setOrderPrice.run(
      num(p.cashAmount),
      num(p.coinAmount),
      num(p.coinCount),
      num(p.goodsTotal),
      num(p.coinsReceiving),
      num(p.smartDeduct),
      p.payTime ? String(p.payTime) : null,
      p.alipayNo ? String(p.alipayNo) : null,
      p.address ? String(p.address) : null,
      Date.now(),
      String(p.orderId)
    );
    return 1;
  },

  /** tab 过滤：tab='all' 或 status 数组（空数组=不匹配任何） */
  listOrders(tab, limit = 100) {
    if (!tab || tab === 'all') return q.listOrders.all(limit).map(rowToOrder);
    const sts = ORDER_TABS[tab] || [];
    if (!sts.length) return [];
    const ph = sts.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM orders WHERE status IN (${ph}) ORDER BY create_time DESC LIMIT ?`)
      .all(...sts, limit);
    return rows.map(rowToOrder);
  },

  listOrdersBySession(sessionId, limit = 5) {
    const rows = db
      .prepare('SELECT * FROM orders WHERE session_id=? ORDER BY create_time DESC LIMIT ?')
      .all(String(sessionId), limit);
    return rows.map(rowToOrder);
  },

  /**
   * 某买家的全部订单（跨会话）。sold.get 的列表结果里带 buyer_id，
   * 用买家 id 查比用 session_id 查更稳（同一买家可能开过多个会话）。
   */
  listOrdersByBuyer(buyerId, limit = 50) {
    if (!buyerId) return [];
    const rows = db
      .prepare('SELECT * FROM orders WHERE buyer_id=? ORDER BY create_time DESC LIMIT ?')
      .all(String(buyerId), limit);
    return rows.map(rowToOrder);
  },

  /** 按买家 id 找最近活跃的会话（订单列表 → 会话归属用） */
  findSessionByPeer(peerId) {    if (!peerId) return null;
    return db
      .prepare('SELECT id FROM sessions WHERE with_id=? ORDER BY COALESCE(order_ts,last_ts) DESC LIMIT 1')
      .get(String(peerId));
  },

  /** 把订单的 session_id 按 buyer_id 重新对齐（修历史脏数据） */
  remapOrderSessions() {
    const r = db.prepare(`
      UPDATE orders SET session_id = COALESCE(
        (SELECT s.id FROM sessions s WHERE s.with_id = orders.buyer_id
          ORDER BY COALESCE(s.order_ts, s.last_ts) DESC LIMIT 1), orders.session_id)
      WHERE COALESCE(buyer_id,'') <> ''`).run();
    return r.changes || 0;
  },

  /** 各 tab 计数（全部 + 各状态组） */
  orderTabCounts() {
    const byStatus = {};
    for (const r of q.orderCounts.all()) byStatus[r.status || ''] = r.n;
    const out = { all: 0 };
    for (const [k, n] of Object.entries(byStatus)) out.all += n;
    for (const [tab, sts] of Object.entries(ORDER_TABS)) {
      out[tab] = sts.reduce((s, k) => s + (byStatus[k] || 0), 0);
    }
    return out;
  },

  /** 概览页统计：今日/累计/待办/7 日趋势/状态分布/活跃客户/最近订单 */
  overviewStats({ days = 7, self = '' } = {}) {
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const todayStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStart = todayStartDate.getTime();
    const todayStr = ymd(todayStartDate);

    const msgToday = db
      .prepare('SELECT from_self, COUNT(*) AS n FROM messages WHERE ts >= ? GROUP BY from_self')
      .all(todayStart);
    const today = {
      messagesIn: 0,
      messagesOut: 0,
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(order_ts,last_ts) >= ?').get(todayStart).n,
      orders: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE substr(create_time,1,10) = ?").get(todayStr).n,
      amount: db
        .prepare("SELECT COALESCE(SUM(CAST(price AS REAL)),0) AS s FROM orders WHERE substr(create_time,1,10) = ?")
        .get(todayStr).s,
    };
    for (const r of msgToday) {
      if (Number(r.from_self) === 1) today.messagesOut = r.n;
      else today.messagesIn = r.n;
    }

    const totals = {
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
      amount: db.prepare('SELECT COALESCE(SUM(CAST(price AS REAL)),0) AS s FROM orders').get().s,
    };

    const pending = {
      unreadSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE COALESCE(unread,0) > 0').get().n,
      unshipped: (this.orderTabCounts().unshipped || 0) + 0,
      refunding: this.orderTabCounts().refunding || 0,
      unrated: this.orderTabCounts().unrated || 0,
    };

    // 近 N 天趋势（从早到晚）
    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const start = d.getTime();
      const end = start + 86400000;
      const rows = db
        .prepare('SELECT from_self, COUNT(*) AS n FROM messages WHERE ts >= ? AND ts < ? GROUP BY from_self')
        .all(start, end);
      const item = { date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, in: 0, out: 0 };
      for (const r of rows) {
        if (Number(r.from_self) === 1) item.out = r.n;
        else item.in = r.n;
      }
      trend.push(item);
    }

    const orderStatus = db
      .prepare(
        'SELECT status, MAX(status_text) AS text, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC'
      )
      .all();

    const topCustomers = db
      .prepare(
        `SELECT s.with_id AS userId,
                COALESCE(c.nick,'') AS nick,
                COALESCE(c.avatar,'') AS avatar,
                COUNT(m.id) AS msgs
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
           LEFT JOIN customers c ON c.user_id = s.with_id
          WHERE m.from_self = 0 AND COALESCE(s.with_id,'') <> ''
            AND s.with_id <> ?
          GROUP BY s.with_id
          ORDER BY msgs DESC
          LIMIT 8`
      )
      .all(String(self || ''));

    const recentOrders = db
      .prepare('SELECT * FROM orders ORDER BY create_time DESC LIMIT 6')
      .all()
      .map(rowToOrder);

    return { today, totals, pending, trend, orderStatus, topCustomers, recentOrders };
  },

  knownOrderIds() {
    return new Set(db.prepare('SELECT order_id FROM orders').all().map(r => String(r.order_id)));
  },

  /** 从消息卡片里捞所有订单号（含首次出现的会话 id），按出现时间倒序 */
  orderIdsFromDb(limit = 500) {
    const rows = db
      .prepare("SELECT session_id, raw FROM messages WHERE raw LIKE '%order%' ORDER BY ts DESC LIMIT 1200")
      .all();
    const seen = new Map();
    const re = /(?:[?&]orderId=|order_detail\?id=|"orderIdStr"\s*:\s*")(\d{15,22})/g;
    for (const r of rows) {
      let m;
      const s = String(r.raw || '');
      while ((m = re.exec(s))) {
        if (!seen.has(m[1])) seen.set(m[1], String(r.session_id || ''));
      }
    }
    return [...seen.entries()].slice(0, limit).map(([orderId, sessionId]) => ({ orderId, sessionId }));
  },
  saveOrdering(list) {
    let n = 0;
    for (const it of list) {
      if (!it || !it.sid) continue;
      const r = q.setOrdering.run(
        Number(it.ts) || 0,
        it.pinned ? 1 : 0,
        it.pinRank == null ? null : Number(it.pinRank),
        String(it.sid)
      );
      if (r.changes) n++;
    }
    return n;
  },

  /**
   * 官方会话列表（IMPaaS）落库：会话 id、对端、摘要、最后消息时间、未读、置顶与顺序。
   * 官方列表里没有的旧会话保持原样（source 仍为 mtop），排序时自然落到后面。
   */
  saveImpaasSessions(list, opts) {
    const self = String((opts && opts.self) || '');
    q.clearPinned.run();              // 先清空置顶标记，避免取消置顶后仍显示在最前

    // 老行兜底：对端算不出来时别把 with_id 写空，昵称也尽量保留上一轮的值
    const prev = new Map();
    for (const r of db.prepare('SELECT id, with_id, orign FROM sessions').all()) {
      let nick = '';
      try { nick = (JSON.parse(r.orign || '{}').session || {}).userInfo.fishNick || ''; } catch (_) {}
      prev.set(String(r.id), { withId: String(r.with_id || ''), nick });
    }

    let n = 0;
    for (const c of list) {
      if (!c || !c.sid) continue;
      const before = prev.get(String(c.sid)) || { withId: '', nick: '' };
      // 对端不能是自己；算不出来（pairFirst=0 之类的坏数据）就沿用上一轮
      let peerId = String(c.peerId || '');
      if (!peerId || peerId === '0' || peerId === self) peerId = before.withId === self ? '' : before.withId;
      const nick = c.title || (before.withId === peerId ? before.nick : '');
      const orign = JSON.stringify({
        source: 'impaas',
        session: { sessionId: c.sid, sessionType: c.sessionType, userInfo: { userId: peerId, fishNick: nick } },
        item: { itemId: c.itemId || '', title: c.itemTitle || '', pic: c.itemPic || '' },
        lastMessage: { text: c.text, ts: c.ts },
        pinned: !!c.pinned,
      });
      q.upsertImpaasSession.run(
        String(c.sid), Number(c.sessionType) || 1, peerId, c.text || '',
        Number(c.ts) || 0, Number(c.unread) || 0, orign, now(),
        Number(c.ts) || 0, c.pinned ? 1 : 0,
        c.pinRank == null ? null : Number(c.pinRank),
        String(c.itemId || ''), String(c.itemPic || ''), String(c.itemTitle || ''),
        String(c.itemSellerId || ''),
        String(c.tradeText || ''),
        c.tradeStyle == null ? null : Number(c.tradeStyle)
      );
      n++;
    }
    return n;
  },

  getCursor: k => { const r = q.getCursor.get(k); return r ? r.v : null; },
  setCursor: (k, v) => q.setCursor.run(k, String(v === null || v === undefined ? '' : v)),

  pushEvent(kind, payload) {
    q.addEvent.run(kind, JSON.stringify(payload || {}), now());
  },
  pendingEvents: (n = 20) => q.pendingEvents.all(n),
  markHandled: id => q.markHandled.run(id),

  outboxAdd(id, sessionId, content) {
    q.addOutbox.run(id, sessionId, JSON.stringify(content), 'pending', now(), '');
  },
  outboxDone(id, status, resp) {
    q.setOutbox.run(status, JSON.stringify(resp || {}).slice(0, 2000), id);
  },

  close: () => db.close(),
  db,
};

// ---------------------------------------------------------------- 保险方案
const planQ = {
  upsert: db.prepare(`
    INSERT INTO plans (plan_code,name,company_id,company,class_id,class_name,nick,min_age,max_age,
                       clause_file,intro_file,base_price,real_percent,price_table,fee_table,coverage,notice,clause,
                       clause_sections,clause_pages,clause_garbled,clause_ocr,synced_at)
    VALUES (@plan_code,@name,@company_id,@company,@class_id,@class_name,@nick,@min_age,@max_age,
            @clause_file,@intro_file,@base_price,@real_percent,@price_table,@fee_table,@coverage,@notice,@clause,
            @clause_sections,@clause_pages,@clause_garbled,@clause_ocr,@synced_at)
    ON CONFLICT(plan_code) DO UPDATE SET
      name=CASE WHEN COALESCE(excluded.name,'')<>'' THEN excluded.name ELSE plans.name END,
      company_id=CASE WHEN COALESCE(excluded.company_id,'')<>'' THEN excluded.company_id ELSE plans.company_id END,
      company=CASE WHEN COALESCE(excluded.company,'')<>'' THEN excluded.company ELSE plans.company END,
      class_id=CASE WHEN COALESCE(excluded.class_id,'')<>'' THEN excluded.class_id ELSE plans.class_id END,
      class_name=CASE WHEN COALESCE(excluded.class_name,'')<>'' THEN excluded.class_name ELSE plans.class_name END,
      nick=CASE WHEN COALESCE(excluded.nick,'')<>'' THEN excluded.nick ELSE plans.nick END,
      min_age=excluded.min_age, max_age=excluded.max_age,
      clause_file=CASE WHEN COALESCE(excluded.clause_file,'')<>'' THEN excluded.clause_file ELSE plans.clause_file END,
      intro_file=CASE WHEN COALESCE(excluded.intro_file,'')<>'' THEN excluded.intro_file ELSE plans.intro_file END,
      base_price=CASE WHEN COALESCE(excluded.base_price,0)>0 THEN excluded.base_price ELSE plans.base_price END,
      real_percent=CASE WHEN COALESCE(excluded.real_percent,0)>0 THEN excluded.real_percent ELSE plans.real_percent END,
      price_table=CASE WHEN COALESCE(excluded.price_table,'[]') NOT IN ('','[]') THEN excluded.price_table ELSE plans.price_table END,
      fee_table=CASE WHEN COALESCE(excluded.fee_table,'[]') NOT IN ('','[]') THEN excluded.fee_table ELSE plans.fee_table END,
      coverage=CASE WHEN COALESCE(excluded.coverage,'[]') NOT IN ('','[]') THEN excluded.coverage ELSE plans.coverage END,
      notice=CASE WHEN COALESCE(excluded.notice,'')<>'' THEN excluded.notice ELSE plans.notice END,
      clause=CASE WHEN COALESCE(excluded.clause,'')<>'' THEN excluded.clause ELSE plans.clause END,
      clause_sections=CASE WHEN COALESCE(excluded.clause_sections,'[]') NOT IN ('','[]') THEN excluded.clause_sections ELSE plans.clause_sections END,
      clause_pages=excluded.clause_pages,
      clause_garbled=excluded.clause_garbled,
      clause_ocr=excluded.clause_ocr,
      synced_at=excluded.synced_at`),
  list: db.prepare('SELECT * FROM plans ORDER BY company, class_id, plan_code'),
  get: db.prepare('SELECT * FROM plans WHERE plan_code=?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM plans'),
  bind: db.prepare(`
    INSERT INTO item_plans (item_id, plan_code, product_code, item_title, bound_at) VALUES (?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET plan_code=excluded.plan_code, product_code=excluded.product_code,
      item_title=excluded.item_title, bound_at=excluded.bound_at`),
  unbind: db.prepare('DELETE FROM item_plans WHERE item_id=?'),
  bindings: db.prepare(`
    SELECT ip.*, p.name AS plan_name, p.company AS company, p.class_name AS class_name
    FROM item_plans ip LEFT JOIN plans p ON p.plan_code = ip.plan_code
    ORDER BY ip.bound_at DESC`),
  forItem: db.prepare(`
    SELECT p.*, ip.product_code AS product_code, ip.item_title AS item_title_bound, ip.plan_code AS bound_plan_code
    FROM item_plans ip JOIN plans p ON p.plan_code = ip.plan_code WHERE ip.item_id=?`),
  byProduct: db.prepare("SELECT * FROM plans WHERE substr(plan_code,1,9)=? ORDER BY plan_code"),
  bindingOfPlan: db.prepare('SELECT * FROM item_plans WHERE plan_code=? ORDER BY bound_at DESC'),
};

Object.assign(store, {
  savePlan(p) {
    planQ.upsert.run({
      plan_code: String(p.planCode || p.plan_code || ''),
      name: String(p.name || ''),
      company_id: String(p.companyId || p.company_id || ''),
      company: String(p.company || ''),
      class_id: String(p.classId || p.class_id || ''),
      class_name: String(p.className || p.class_name || ''),
      nick: String(p.nick || ''),
      min_age: Number(p.minAge || 0),
      max_age: Number(p.maxAge || 0),
      clause_file: String(p.clauseFile || ''),
      intro_file: String(p.introFile || ''),
      base_price: Number(p.basePrice || 0),
      real_percent: Number(p.realPercent || p.real_percent || 0),
      price_table: JSON.stringify(p.priceTable || []),
      fee_table: JSON.stringify(p.feeTable || []),
      coverage: JSON.stringify(p.coverage || []),
      notice: String(p.notice || ''),
      clause: String(p.clause || ''),
      clause_sections: JSON.stringify(p.clauseSections || []),
      clause_pages: Number(p.clausePages || 0),
      clause_garbled: JSON.stringify(p.clauseGarbled || []),
    clause_ocr: p.clauseOcr ? JSON.stringify(p.clauseOcr) : null,
      synced_at: now(),
    });
  },
  listPlans: () => planQ.list.all().map(rowToPlan),
  getPlan: (code) => {
    const r = planQ.get.get(String(code));
    return r ? rowToPlan(r) : null;
  },
  planCount: () => planQ.count.get().n,
  bindItemPlan(itemId, planCode, itemTitle = '') {
    const code = String(planCode || '').trim();
    const prod = productOf(code) || code;
    planQ.bind.run(String(itemId), code, prod, String(itemTitle || ''), now());
  },
  unbindItemPlan: (itemId) => planQ.unbind.run(String(itemId)),
  listBindings: () => planQ.bindings.all(),
  /** 商品绑定的方案：返回默认档 + 该方案所有档位（前端/提示词都需要知道这系列有几档） */
  planForItem: (itemId) => {
    const r = planQ.forItem.get(String(itemId));
    if (!r) return null;
    const plan = rowToPlan(r);
    const prod = r.product_code || productOf(r.plan_code) || '';
    const tiers = prod ? planQ.byProduct.all(prod).map(rowToPlan) : [];
    plan.productCode = prod;
    plan.tiers = tiers;
    return plan;
  },
  bindingsOfPlan: (planCode) => planQ.bindingOfPlan.all(String(planCode)),
});

/** planCode 形如 0018-0580-0001，前两段是「方案」，第三段是保额档（计划一/二/三…） */
function productOf(code) {
  const m = String(code || '').match(/^(\d{4}-\d{4})/);
  return m ? m[1] : '';
}

function rowToPlan(r) {  const j = (s, d) => {
    try { return JSON.parse(s); } catch (_) { return d; }
  };
  return {
    planCode: r.plan_code,
    name: r.name,
    companyId: r.company_id,
    company: r.company,
    classId: r.class_id,
    className: r.class_name,
    nick: r.nick,
    minAge: r.min_age,
    maxAge: r.max_age,
    clauseFile: r.clause_file,
    introFile: r.intro_file,
    basePrice: r.base_price,
    realPercent: r.real_percent,
    priceTable: j(r.price_table, []),
    feeTable: j(r.fee_table, []),
    coverage: j(r.coverage, []),
    notice: r.notice,
    clause: r.clause,
    clauseSections: j(r.clause_sections, []),
    clausePages: r.clause_pages || 0,
    clauseGarbled: j(r.clause_garbled, []),
    clauseOcr: j(r.clause_ocr, null),
    syncedAt: r.synced_at,
  };
}

module.exports = store;
