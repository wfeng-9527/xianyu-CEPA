'use strict';
/**
 * 本地 HTTP API：给 web/ 前端提供数据（零依赖，node:http）。
 *
 *   node src/server.js --account=YOUR_ACCOUNT_ID --port=5175
 *
 * 单进程绑定一个账号（切账号 = 换 --account 重启，避免运行中重开数据库踩坑）。
 * 路由：
 *   GET  /api/health                     当前绑定信息
 *   GET  /api/accounts                   账号库
 *   GET  /api/sessions?limit=50          本地库会话列表
 *   GET  /api/messages?sessionId=&limit= 本地库消息（按时间倒序返回，前端再翻转）
 *   GET  /api/customer?sessionId=        客户信息（session.withWho → user.page.head）
 *   POST /api/sync       {full?}         拉会话 + 每会话增量消息
 *   POST /api/send       {sessionId,text}
 *   POST /api/read       {sessionId}     清未读（系统会话走 mtop，普通会话只清本地）
 *   GET  /*                              静态托管 web/dist（SPA 回落到 index.html）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { cfg, ROOT, listAccounts, unbFromCookie } = require('./config');
const mtop = require('./lib/mtop');
const { looksLikeName, fallbackName } = require('./lib/names');
const mcontent = require('./lib/mcontent');
const orderPrice = require('./lib/orderprice');
// store 必须在 cfg.dbFile 定稿之后再 require（它构造时就把路径打开了）
const api = require('./core/api');
const rules = require('./core/rules');
const ordersCore = () => require('./core/orders');
const autoreply = require('./core/autoreply');
const planjob = require('./core/planjob');
let store;

/* ── 自动回复：默认影子模式 ────────────────────────────────────────
   配置文件 data/autoreply.json：{mode:'shadow'|'live', whitelist:['<sid>']}
   环境变量优先：XY_AUTOREPLY_MODE / XY_AUTOREPLY_SESSIONS（逗号分隔）        */
const AUTO_CONF = path.join(ROOT, 'data', 'autoreply.json');
function readAutoConf() {
  try {
    return JSON.parse(fs.readFileSync(AUTO_CONF, 'utf8')) || {};
  } catch {
    return {};
  }
}
const _ac0 = readAutoConf();
let AUTO_MODE = process.env.XY_AUTOREPLY_MODE || _ac0.mode || 'shadow';
AUTO_MODE = AUTO_MODE === 'live' ? 'live' : 'shadow';
let AUTO_WHITE = String(process.env.XY_AUTOREPLY_SESSIONS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
if (!AUTO_WHITE.length && Array.isArray(_ac0.whitelist)) AUTO_WHITE = _ac0.whitelist.map(String);
const SHADOW_FILE = path.join(ROOT, 'data', 'autoreply-shadow.jsonl');
const SYNC_LOG = path.join(ROOT, 'data', 'sync.log');
let autoRunning = false;

function shadowLog(rec) {
  try {
    fs.mkdirSync(path.dirname(SHADOW_FILE), { recursive: true });
    fs.appendFileSync(SHADOW_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    /* 影子日志写不进去不影响主流程 */
  }
}

async function autoReplyTick() {
  if (autoRunning) return { skipped: true };
  autoRunning = true;
  const out = { mode: AUTO_MODE, taken: 0, reply: 0, handoff: 0, ignore: 0, sent: 0, errors: [] };
  try {
    const evs = store.pendingEvents(10);
    for (const e of evs) {
      let p = {};
      try {
        p = JSON.parse(e.payload || '{}');
      } catch {
        p = {};
      }
      out.taken++;
      if (!p.sessionId || !p.text) {
        store.markHandled(e.id);
        continue;
      }
      try {
        const st = await autoreply.answer({ store, sessionId: String(p.sessionId), text: String(p.text) });
        const isReply = st.action === 'reply' || st.action === 'ai';
        if (isReply) out.reply++;
        else if (st.action === 'handoff') out.handoff++;
        else out.ignore++;
        const rec = {
          at: new Date().toISOString(),
          mode: AUTO_MODE,
          sessionId: String(p.sessionId),
          msgId: p.msgId,
          text: p.text,
          action: st.action,
          source: st.source,
          reason: st.reason || '',
          reply: st.text || '',
        };
        if (AUTO_MODE === 'live' && isReply && st.text && AUTO_WHITE.includes(String(p.sessionId))) {
          const r = await autoreply.respondAndSend({
            store,
            api,
            sessionId: String(p.sessionId),
            text: String(p.text),
          });
          rec.sent = Boolean(r && r.sent);
          rec.resp = r;
          if (rec.sent) out.sent++;
        }
        shadowLog(rec);
      } catch (err) {
        out.errors.push({ sessionId: p.sessionId, err: err.message });
      }
      store.markHandled(e.id);
    }
  } finally {
    autoRunning = false;
  }
  return out;
}

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const hit = argv.find(a => a === `--${k}` || a.startsWith(`--${k}=`) || a.startsWith(`--${k} `));
  if (!hit) return d;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(hit);
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PORT = Number(argOf('port', process.env.XY_PORT || 5175));
const ACCOUNT = argOf('account', process.env.XY_ACCOUNT_ID || '');
const DIST = path.join(ROOT, 'web', 'dist');

let lastSync = 0;
// 全店最近订单上一次同步时间（交易状态气泡的数据源）
let lastOrdersAt = 0;
// 每个会话最近一次「打开即拉」的时间，避免前端 5s 轮询把 IMPaaS 打爆
const liveAt = new Map();
// 买家订单缓存：同会话 2 分钟内复用，避免反复打 sold.get
const orderCache = new Map();
let syncing = false;
let syncStartedAt = 0;
// 任何一次外部请求都可能挂住（WS 不回包、https 不超时），挂住会卡死整个同步循环，
// 所以每个 await 都套一层硬超时；doSync 本身也有看门狗。
function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('timeout ' + label + ' ' + ms + 'ms')), ms);
      t.unref && t.unref();
    }),
  ]);
}

// ---------------------------------------------------------------- 启动绑定
function bind() {
  let raw = '';
  try { raw = require('./config').loadCookie(ACCOUNT); } catch (e) { raw = ''; }
  if (raw) {
    mtop.setCookie(raw);
    const unb = unbFromCookie(raw);
    if (unb && !cfg.accountId) cfg.accountId = unb;
    cfg.sellerId = cfg.sellerId || cfg.accountId;
  }
  const uid = cfg.accountId || ACCOUNT || 'default';
  if (!process.env.XY_DB_FILE) cfg.dbFile = path.join(ROOT, 'data', `xianyu-${uid}.db`);
  store = require('./lib/store');   // 路径定稿后才能打开库
  rules.load();
  // 自动回复只处理「本次启动之后」的消息，这条游标是防回填历史的硬闸
  store.setCursor('boot:at', Date.now());
  return { hasCookie: !!raw, unb: unbFromCookie(raw), uid };
}

const bound = bind();

// ---------------------------------------------------------------- 业务动作
async function doSync(full) {
  if (syncing) {
    // 看门狗：上一轮超过 5 分钟还没结束，认为它卡死了，强制放行
    if (Date.now() - syncStartedAt < 5 * 60 * 1000) return { skipped: true };
    syncing = false;
  }
  syncing = true;
  syncStartedAt = Date.now();
  const out = { sessions: 0, messages: 0, errors: [] };
  try {
    // 会话列表：以 IMPaaS 官方列表为准（它与网页版/App 完全一致：置顶 + 最后消息时间倒序，
    // 还带对方昵称与未读数）。mtop 的 session.sync 只是旧 id 空间的历史会话，full 时照旧并进来。
    if (full) {
      try {
        const list = await withTimeout(api.getAllSessions(), 90000, 'getAllSessions');
        out.sessionsMtop = store.saveSessions(list);
        store.setCursor('sessions:at', Date.now());
      } catch (e) {
        out.mtopError = e.ret || e.message;
      }
    }
    // 官方会话列表（新会话、置顶、未读、最后一条摘要都靠它）。
    // 这个 LWP 有 IM 侧的频率限制：每轮（30s）× 8 页 = 一分钟十几次，会被回
    // {code:400600001, reason:'The request has been flow controled'}，而且历史上被
    // 「body.userConvs || []」吞成空列表 → 新会话永远进不来、列表顺序不刷新。
    // 现在：① 默认 90s 才拉一次；② 命中限流就退避（5→30 分钟）；③ 错误写进 out 与日志。
    const convAt = Number(store.getCursor('conv:at') || 0);
    const convCd = Number(store.getCursor('conv:cooldown') || 0);
    const convEvery = Number(process.env.XY_CONV_EVERY || 120) * 1000;
    const convDue = Date.now() >= convCd && Date.now() - convAt >= convEvery;
    if (!convDue) {
      out.convSkipped = true;
    } else {
      try {
        out.official = await withTimeout(
          api.syncOfficialSessions(store, {
            pages: Number(process.env.XY_SESSION_PAGES || 2),
            pageSize: 50,
          }),
          90000,
          'syncOfficialSessions'
        );
        store.setCursor('conv:at', String(Date.now()));
        store.setCursor('conv:flowhits', '0');
        // 已读保护：同步会把官方 unreadCount 写回来，这里按 read:<sid> 游标再清一次
        let keepZero = 0;
        for (const s of store.listSessions(400)) {
          const cur = store.getCursor('read:' + s.id);
          if (cur && Number(cur) >= Number(s.last_ts || 0) && Number(s.unread || 0) > 0) {
            store.clearUnread(s.id);
            keepZero++;
          }
        }
        if (keepZero) out.readKept = keepZero;
      } catch (e) {
        const ret = String(e.ret || e.message || '');
        out.convError = ret;
        store.setCursor('conv:at', String(Date.now()));
        if (e.flow || /flow|限流|400600001/i.test(ret)) {
          // 限流是按设备号记的（实测换 did 立刻恢复），所以先换身份再重试一次，
          // 重试仍失败才退避。
          const rotated = api.rotateDeviceId();
          out.convRotated = rotated;
          console.log(`[conv] 会话列表被限流（${ret}），换设备号重试…`);
          try {
            out.official = await withTimeout(
              api.syncOfficialSessions(store, {
                pages: Number(process.env.XY_SESSION_PAGES || 2),
                pageSize: 50,
              }),
              90000,
              'syncOfficialSessions(retry)'
            );
            store.setCursor('conv:flowhits', '0');
            store.setCursor('conv:cooldown', '0');
            console.log('[conv] 换设备号后恢复');
            return out;
          } catch (e2) {
            out.convError = String(e2.ret || e2.message || '');
          }
          const hits = Number(store.getCursor('conv:flowhits') || 0) + 1;
          store.setCursor('conv:flowhits', String(hits));
          const waitMin = Math.min(30, 5 * hits);
          store.setCursor('conv:cooldown', String(Date.now() + waitMin * 60 * 1000));
          console.log(`[conv] 会话列表被限流（${ret}），${waitMin} 分钟后再试`);
        } else {
          store.setCursor('conv:cooldown', String(Date.now() + 60 * 1000));
          console.log(`[conv] 会话列表失败（${ret}），60 秒后重试`);
        }
      }
    }

    // 交易状态的真实来源是订单状态：每分钟拉一次全店最近订单（一次请求拿 10 条，很轻），
    // 这样即使不打开客户面板，列表右侧的「交易成功 / 等待买家收货 / 交易关闭」也会自己跟上
    if (Date.now() - lastOrdersAt > 60 * 1000) {
      lastOrdersAt = Date.now();
      try {
        out.orders = await withTimeout(api.syncRecentOrders(store, { pageSize: 10 }), 45000, 'syncRecentOrders');
      } catch (e) {
        out.ordersError = e.message;
      }
    }
    // IMPaaS 走的是已有 WebSocket，拉一页成本很低（无鉴权签名、无风控计数），
    // 但 900+ 会话全量扫一遍要好几分钟，所以每轮只扫「最近活跃的前 N 个 + 尾部轮转几个」，
    // 剩下的靠用户点开会话时的 /api/messages 按需拉取（见该路由）。
    const all = store.listSessionsByActivity(9999);
    const topN = Number(process.env.XY_SYNC_TOP || 120) || all.length;
    const ringN = Number(process.env.XY_SYNC_RING || 40) || 0;
    const head = all.slice(0, topN);
    const tail = all.slice(topN);
    let batch = head;
    if (ringN && tail.length) {
      const skip = Number(store.getCursor('sync:rr') || 0) % tail.length;
      const ring = [];
      for (let i = 0; i < Math.min(ringN, tail.length); i++) ring.push(tail[(skip + i) % tail.length]);
      store.setCursor('sync:rr', String((skip + ringN) % tail.length));
      batch = head.concat(ring);
    }
    out.scanned = batch.length;
    out.total = all.length;
    // 轮次计数 + 空闲退避：连续没新消息的会话，拉取间隔按 1→2→4→8 轮翻倍。
    // 目的：把「每轮 160 个会话 × pageSize 条」的固定流量摊薄（实测 20 条=55.8KB/会话，
    // 160 会话 60s 一轮就是 368GB/月，300GB 的机器撑不住）。
    const roundNo = Number(store.getCursor('sync:round') || 0) + 1;
    store.setCursor('sync:round', String(roundNo));
    out.skipped = 0;
    out.fetched = 0;
    for (const s of batch) {
      const dueAt = Number(store.getCursor('poll:due:' + s.id) || 0);
      if (dueAt > roundNo) {
        out.skipped++;
        continue;
      }
      out.fetched++;
      try {
        // 优先 IMPaaS：mtop 的 message.sync 对很多会话只回「我发出去的」，
        // 客户回的消息只有 IMPaaS 的 listUserMessages 才有。
        let msgs = [];
        let used = 'impaas';
        try {
          const prevTs = store.getCursor('imsg:' + s.id);
          const deepDone = store.getCursor('imsg:deep:' + s.id);
          const maxPages = prevTs ? 8 : (deepDone ? 2 : 4);   // 首屏 1 页就够；有积压时 fetchSinceImpaas 会自动往前翻（最多 8 页）
          msgs = await withTimeout(
            api.fetchSinceImpaas(s.id, prevTs ? Number(prevTs) : 0, { maxPages, pageSize: cfg.msgPageSize }),
            45000,
            'fetchSinceImpaas'
          );
          if (!deepDone) store.setCursor('imsg:deep:' + s.id, '1');
          if (msgs.length) {
            const cap = (cfg.msgPageSize || 5) * maxPages;
            // 翻满上限说明可能还没接上旧游标 → 游标只能推进到本批最老一条，下一轮继续往前补
            const nextCur = msgs.length >= cap ? Math.min(...msgs.map(m => m.ts)) : Math.max(...msgs.map(m => m.ts));
            store.setCursor('imsg:' + s.id, nextCur);
          } else if (!prevTs) {
            store.setCursor('imsg:' + s.id, Date.now());
          }
        } catch (e) {
          used = 'mtop';
          const prev = store.getCursor('msg:' + s.id);
          msgs = await withTimeout(api.fetchSince(s.id, prev ? Number(prev) : 0, { maxPages: 1 }), 45000, 'fetchSince');
          const top = msgs.reduce((m, x) => Math.max(m, Number(x.version) || 0), Number(prev) || 0);
          if (top) store.setCursor('msg:' + s.id, top);
        }
        const added = store.saveMessages(s.id, msgs);
        out.messages += added;
        // 有新消息 → 这个会话回到「每轮都扫」；没新消息 → 退避 2/4/8 轮
        try {
          if (added > 0) {
            store.setCursor('poll:quiet:' + s.id, '0');
            store.setCursor('poll:due:' + s.id, String(roundNo + 1));
          } else {
            const q = Math.min(Number(store.getCursor('poll:quiet:' + s.id) || 0) + 1, 3);
            store.setCursor('poll:quiet:' + s.id, String(q));
            store.setCursor('poll:due:' + s.id, String(roundNo + Math.pow(2, q)));
          }
        } catch {}
        out.lastPath = used;
        // 会话行的「最后消息时间 / 未读」也顺手更新：
        // 官方会话列表被限流时它拉不动，这里靠消息本身把会话顶到前面，不至于
        // 「消息进了库但列表不动、未读不涨」。
        // 未读只加「比会话上次时间更新的客户消息」，否则每轮都会把历史消息重复计一遍。
        try {
          const before = store.getSession(s.id) || {};
          const beforeTs = Number(before.last_ts || 0);
          let maxTs = 0;
          let newIn = 0;
          for (const m of msgs) {
            const ts = Number(m.ts) || 0;
            if (ts > maxTs) maxTs = ts;
            if (!m.fromSelf && ts > beforeTs) newIn++;
          }
          if (maxTs) store.touchSession(s.id, maxTs, newIn);
        } catch (e) {
          out.touchError = e.message;
        }
        // 自动回复的事件源：只收「本次启动之后」的客户文本消息，绝不回填历史
        try {
          const bootAt = Number(store.getCursor('boot:at') || 0);
          for (const m of msgs) {
            if (m.fromSelf) continue;
            if (Number(m.contentType) !== 1) continue;
            const ts = Number(m.ts) || 0;
            if (!bootAt || ts <= bootAt) continue;
            if (ts <= Number(store.getCursor('auto:' + s.id) || 0)) continue;
            store.pushEvent('msg', { sessionId: s.id, msgId: m.id, ts, text: m.text });
            store.setCursor('auto:' + s.id, ts);
            out.autoQueued = (out.autoQueued || 0) + 1;
          }
        } catch (e) {
          out.autoEventError = e.message;
        }
        // 顺手把消息里带的客户资料存起来（fishNick / senderName 未打码，零额外请求）
        for (const m of msgs) {
          const p = m.peer || {};
          const peerId = p.userId || (!m.fromSelf ? m.senderId : '');
          const peerNick = p.nick || (!m.fromSelf ? m.senderName : '');
          if (peerId && peerNick && looksLikeName(peerNick) && String(peerId) !== String(api.selfUnb())) {
            const old = store.getCustomer(peerId);
            if (!old || !old.nick || old.nick.includes('*')) {
              store.saveCustomer({ userId: peerId, nick: peerNick, avatar: p.avatar, city: old && old.city });
            }
          }
        }
      } catch (e) {
        out.errors.push({ sessionId: s.id, err: e.ret || e.message });
      }
      await new Promise(r => setTimeout(r, 120));
    }
    lastSync = Date.now();
    store.setCursor('sync:at', lastSync);
  } finally {
    syncing = false;
    // 同步心跳：每轮落一行，用来区分「后台没干活」和「干活了但没新消息」
    try {
      const rec = {
        at: lastSync || Date.now(),
        ms: Date.now() - syncStartedAt,
        scanned: out.scanned,
        total: out.total,
        fetched: out.fetched || 0,
        skipped: out.skipped || 0,
        sessions: out.sessions,
        messages: out.messages,
        autoQueued: out.autoQueued || 0,
        errors: (out.errors || []).length,
        convError: out.convError || '',
        firstErr: (out.errors && out.errors[0] && (out.errors[0].err || '')) || '',
      };
      fs.appendFileSync(SYNC_LOG, JSON.stringify(rec) + '\n', 'utf8');
      const lines = fs.readFileSync(SYNC_LOG, 'utf8').trim().split('\n');
      if (lines.length > 500) fs.writeFileSync(SYNC_LOG, lines.slice(-300).join('\n') + '\n', 'utf8');

      // 自愈：整轮几乎全错且首错是登录态过期 → 立刻续一次 Cookie（5 分钟内不重复）
      const authish = /SESSION_EXPIRED|USER_VALIDATE|登录|令牌/i.test(rec.firstErr || '');
      if (authish && rec.errors > 0 && Date.now() - cookieState.lastAt > 5 * 60 * 1000) {
        console.log(`[cookie] 同步报登录态失效（${rec.firstErr}），自动续一次`);
        refreshCookieOnce('auto-auth').catch(() => {});
      }
    } catch (e) {
      /* 心跳写不进去不影响同步 */
    }
  }
  return out;
}

const customerCache = new Map();
async function doCustomer(sessionId) {
  const s = store.getSession(String(sessionId));
  if (!s) return { error: 'session not found' };
  const userId = s.with_id || '';                      // 列名是 with_id（会话对端 userId）
  if (!userId) return { sessionId, userId: '', nick: '', avatar: '' };
  const known = store.getCustomer(userId);
  if (known && known.nick) return { sessionId, ...known };
  if (customerCache.has(userId)) return customerCache.get(userId);
  let out = { sessionId, userId, nick: '', avatar: '', city: '', head: null };
  try {
    // 优先 user.query v4.0（网页版 /im 自己用的接口，几乎不触发风控）；
    // 拿不到再退回 user.page.head（慢，且十几条就滑块）。
    let got = null;
    try {
      const su = await api.sessionUser(s.id, s.type || 1);
      if (su.nick || su.avatar) got = { nick: su.nick, avatar: su.avatar, city: '', raw: su.raw };
    } catch (_) {}
    if (!got) {
      const head = await api.userHead(userId);
      got = { nick: head.nick, avatar: head.avatar, city: head.city, raw: head.raw };
    }
    out = { sessionId, userId, nick: got.nick, avatar: got.avatar, city: got.city, head: got.raw };
    if (got.nick || got.avatar) {
      store.saveCustomer({ userId, nick: got.nick, avatar: got.avatar, city: got.city, head: got.raw });
    }
  } catch (e) {
    out.head = { ret: e.ret || [e.message] };
  }
  customerCache.set(userId, out);
  return out;
}

/** 后台批量补昵称/头像：只补 customers 表里还没有的。
 *  user.page.head 一密集就 FAIL_SYS_USER_VALIDATE（风控滑块），所以：
 *   - 单次最多 batch 条，条间 900ms；
 *   - 命中风控立刻停并记 30 分钟冷却（cursors 里的 enrich:cooldown），冷却期内不发起任何请求。
 */
let enriching = false;
const ENRICH_GAP = 900;
const ENRICH_COOLDOWN = 30 * 60 * 1000;
async function enrichCustomers(batch = 5) {
  if (enriching) return { skipped: true };
  const cd = Number(store.getCursor('enrich:cooldown') || 0);
  if (cd && Date.now() < cd) {
    return { cooldown: Math.ceil((cd - Date.now()) / 1000), remain: null };
  }
  enriching = true;
  const todo = store.listSessionsWithCustomer(400)
    .filter(r => r.with_id && !r.nick && String(r.with_id) !== String(cfg.accountId))
    .slice(0, batch);
  let done = 0;
  let stopped = null;
  try {
    for (const r of todo) {
      try {
        // 走 user.query（温和），成功就不再碰 user.page.head
        const su = await api.sessionUser(r.id, r.type || 1);
        if (su.nick || su.avatar) {
          store.saveCustomer({ userId: r.with_id, nick: su.nick, avatar: su.avatar, head: su.raw });
          done++;
          continue;
        }
        const head = await api.userHead(r.with_id);
        if (head.nick) { store.saveCustomer({ ...head, head: head.raw }); done++; }
      } catch (e) {
        const ret = String((e.ret && e.ret[0]) || e.message || '');
        if (/USER_VALIDATE|RISK|ILLEGAL_ACCESS/.test(ret)) {
          store.setCursor('enrich:cooldown', Date.now() + ENRICH_COOLDOWN);
          stopped = ret;
          break;
        }
      }
      await new Promise(r2 => setTimeout(r2, ENRICH_GAP));
    }
  } finally {
    enriching = false;
  }
  return { done, tried: todo.length, stopped };
}

/** 自己的店铺昵称/头像：with_id === 自己 的会话用它兜底 */
let meCache = null;
async function myProfile() {
  if (meCache) return meCache;
  try {
    // 真实响应是 { module: { base: { displayName, avatar, ... } } }（mtop.idle.web.user.page.nav）
    const r = await api.me();
    const base = (r && r.module && r.module.base) || r.data || r || {};
    const av = base.avatar;
    meCache = {
      userId: String((await Promise.resolve(api.selfUnb && api.selfUnb())) || cfg.accountId || ''),
      nick: base.displayName || base.shopName || base.nick || '',
      avatar: typeof av === 'string' ? av : (av && (av.avatar || av.url)) || '',
      city: base.ipLocation || '',
    };
  } catch (e) {
    meCache = { userId: String(cfg.accountId), nick: '', avatar: '', city: '' };
  }
  return meCache;
}

// ---------------------------------------------------------------- HTTP
const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
};

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  // 24MB：条款 PDF/docx 走 base64 上传，8MB 不够
  req.on('data', c => { size += c.length; if (size > 24e6) { reject(new Error('body too large')); req.destroy(); } chunks.push(c); });
  req.on('end', () => {
    const txt = Buffer.concat(chunks).toString('utf8');
    if (!txt) return resolve({});
    try { resolve(JSON.parse(txt)); } catch (_) { resolve({}); }
  });
  req.on('error', reject);
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(DIST)) {
    return json(res, 404, { error: 'web/dist 不存在，先在 web/ 里 pnpm build' });
  }
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.join(DIST, rel);
  if (rel === '' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html'); // SPA 回落
  }
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = u.pathname;
  if (req.method === 'OPTIONS') return json(res, 204, {});

  try {
    // 文件消息下载：拿 OSS 临时凭证 → 本地签名 → 服务端转发（不把凭证发给浏览器）
    if (p === '/api/file/download') {
      const sessionId = Number(u.searchParams.get('sessionId') || 0);
      const fileKey = u.searchParams.get('fileKey') || '';
      const name = u.searchParams.get('name') || path.basename(fileKey);
      const sessionType = Number(u.searchParams.get('sessionType') || 1);
      if (!sessionId || !fileKey) return json(res, 400, { error: 'sessionId / fileKey 必填' });
      const { url } = await api.fileLink(sessionId, fileKey, sessionType);
      const up = await new Promise((resolve, reject) => {
        const r = require('https').get(url, (rr) => resolve(rr));
        r.on('error', reject);
      });
      if (up.statusCode !== 200) {
        up.resume();
        return json(res, 502, { error: 'OSS ' + up.statusCode });
      }
      res.writeHead(200, {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Content-Length': up.headers['content-length'] || undefined,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      });
      up.pipe(res);
      return;
    }

    if (p === '/api/file/link') {
      const sessionId = Number(u.searchParams.get('sessionId') || 0);
      const fileKey = u.searchParams.get('fileKey') || '';
      if (!sessionId || !fileKey) return json(res, 400, { error: 'sessionId / fileKey 必填' });
      const r = await api.fileLink(sessionId, fileKey, Number(u.searchParams.get('sessionType') || 1));
      return json(res, 200, { url: r.url, expiresAt: r.expiresAt });
    }

    if (p === '/api/health') {
      return json(res, 200, {
        ok: true, account: cfg.accountId, sellerId: cfg.sellerId, hasCookie: bound.hasCookie,
        dbFile: cfg.dbFile, dryRun: cfg.dryRun, wsEnv: cfg.wsEnv, lastSync,
        cookieItems: Object.keys(mtop.getJar ? mtop.getJar() : {}).length,
        cookieAuto: {
          enabled: cookieState.enabled,
          everyMin: cookieState.everyMin,
          lastAt: cookieState.lastAt,
          lastOk: cookieState.lastOk,
          msg: cookieState.lastMsg,
          refreshed: cookieState.count,
          failures: cookieState.failures,
        },
      });
    }

    // 手动触发一次 Cookie 续期（页面/脚本都能调）
    if (p === '/api/cookie/refresh') {
      const r = await refreshCookieOnce('manual');
      const { timer, ...state } = cookieState;
      return json(res, r.ok ? 200 : 500, { ok: !!r.ok, unb: r.unb || '', count: r.count || 0, reloaded: !!r.reloaded, msg: r.msg || '', state });
    }
    if (p === '/api/accounts') return json(res, 200, { current: cfg.accountId, accounts: listAccounts() });

    if (p === '/api/sync/status') {
      let rows = [];
      try {
        rows = fs.existsSync(SYNC_LOG)
          ? fs.readFileSync(SYNC_LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-30).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          : [];
      } catch (e) {
        rows = [];
      }
      const last = rows[rows.length - 1] || null;
      return json(res, 200, {
        ok: true,
        running: syncing,
        lastSync,
        sinceLast: lastSync ? Math.round((Date.now() - lastSync) / 1000) : null,
        pollInterval: cfg.pollInterval,
        last,
        recent: rows.slice(-20).reverse(),
        cookieAuto: {
          enabled: cookieState.enabled,
          everyMin: cookieState.everyMin,
          port: cookieState.port,
          lastAt: cookieState.lastAt,
          lastOk: cookieState.lastOk,
          msg: cookieState.lastMsg,
          refreshed: cookieState.count,
          failures: cookieState.failures,
        },
      });
    }

    if (p === '/api/dbstat') {
      const one = sql => store.db.prepare(sql).get();
      return json(res, 200, {
        dbFile: cfg.dbFile,
        sessions: one('SELECT COUNT(*) AS c FROM sessions').c,
        messages: one('SELECT COUNT(*) AS c FROM messages').c,
        junk: one("SELECT COUNT(*) AS c FROM messages WHERE id LIKE '%:%'").c,
      });
    }

    if (p === '/api/sessions') {
      const limit = Number(u.searchParams.get('limit') || 50);
      const selfId = String(api.selfUnb() || cfg.accountId || '');
      // 交易状态气泡的兜底来源：该会话最近一单的订单状态
      // （mtop session.sync 的 summary.redReminder 只有 mtop 那批会话才有，官方 IMPaaS 会话要靠订单推）
      const ORDER_TO_TRADE = {
        trade_success: { text: '交易成功', style: 10 },
        buyer_to_confirm: { text: '等待买家收货', style: 1 },
        seller_to_send: { text: '等待卖家发货', style: 1 },
        refund_by_buyer: { text: '买家申请退款', style: 1 },
        refund_by_seller: { text: '退款中', style: 1 },
        refund_success: { text: '交易关闭', style: 11 },
        trade_closed: { text: '交易关闭', style: 11 },
        closed: { text: '交易关闭', style: 11 },
      };
      const lastOrderBySession = new Map();
      // 也按买家维度取最近一单：同一个买家可能换过会话，订单状态才是「交易状态」的真实来源
      const lastOrderByBuyer = new Map();
      try {
        for (const o of store.raw().prepare(`
          SELECT session_id, status, status_text FROM (
            SELECT session_id, status, status_text,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY CAST(create_time AS TEXT) DESC) AS rn
              FROM orders WHERE COALESCE(session_id,'') <> ''
          ) WHERE rn = 1`).all()) {
          lastOrderBySession.set(String(o.session_id), o);
        }
        for (const o of store.raw().prepare(`
          SELECT buyer_id, status, status_text, create_time FROM (
            SELECT buyer_id, status, status_text, create_time,
                   ROW_NUMBER() OVER (PARTITION BY buyer_id ORDER BY CAST(create_time AS TEXT) DESC) AS rn
              FROM orders WHERE COALESCE(buyer_id,'') <> ''
          ) WHERE rn = 1`).all()) {
          lastOrderByBuyer.set(String(o.buyer_id), o);
        }
      } catch (_) {}
      // 同一个客户在 mtop 会话里可能带交易气泡（官方 IMPaaS 会话不带），按 with_id 兜底一次
      const tradeByCustomer = new Map();
      try {
        for (const t of store.raw().prepare(`
          SELECT with_id, trade_text, trade_style FROM sessions
           WHERE COALESCE(trade_text,'') <> '' AND COALESCE(with_id,'') <> ''
           ORDER BY COALESCE(order_ts, last_ts) DESC`).all()) {
          const k = String(t.with_id);
          if (!tradeByCustomer.has(k)) tradeByCustomer.set(k, t);
        }
      } catch (_) {}
      // 昵称/头像：customers 表（user.page.head 抓来的）优先，其次会话 orign 里的 userInfo
      const me0 = await myProfile();
      const rows = store.listSessionsWithCustomer(limit).map(r => {
        let nick = r.nick || '';
        let logo = r.avatar || '';
        let city = '';
        let withId = String(r.with_id || '');
        // 客户来咨询的商品（官方会话自带主图；mtop 老会话从 orign.itemInfo 里捞）
        let itemId = r.item_id || '';
        let itemPic = r.item_pic || '';
        let itemTitle = r.item_title || '';
        try {
          const o = JSON.parse(r.orign || '{}');
          const ui = (o.session || {}).userInfo || {};
          if (!nick) nick = ui.fishNick || ui.nick || '';
          if (!logo) logo = ui.logo || '';
          if (!itemPic && o.item) {
            itemId = itemId || o.item.itemId || '';
            itemPic = o.item.pic || '';
            itemTitle = itemTitle || o.item.title || '';
          }
          const ii = (o.session || {}).itemInfo || (o.lastMessage || {}).itemInfo || {};
          if (!itemPic && ii) {
            itemId = itemId || ii.itemId || '';
            itemPic = itemPic || ii.mainPic || '';
            itemTitle = itemTitle || ii.title || ii.itemTitle || '';
          }
          // IMPaaS 里单聊的对端就是会话对象上的 pair；群聊 with_id 存的是群成员，这里不当客户
          if (Number(o.session && o.session.sessionType) === 30) {
            withId = '';
            nick = ((o.session || {}).title || nick) || '';
          }
        } catch (_) {}
        // 自己的号不该被当成客户；系统会话（mtop 里 userInfo 错写成卖家的那种）单独标一下
        if (withId && withId === selfId) {
          withId = '';
          nick = '系统会话';
        }
        if (Number(r.type) === 30 && !nick) nick = '群聊';
        // 「买家已拍下，待付款」这类交易提醒不是人名，宁可留空也不显示错名字
        if (nick && !looksLikeName(nick)) nick = '';
        if (!nick) nick = withId ? fallbackName(withId) : '未知会话';
        // 交易状态气泡：订单状态（按买家取最近一单，每轮都会刷新）优先，
        // 没有订单才用 session.sync / IMPaaS 的 redReminder（那个是平台推的，可能过期）
        let tradeText = '';
        let tradeStyle = null;
        if (withId) {
          const ob = lastOrderByBuyer.get(String(withId));
          if (ob) {
            const m = ORDER_TO_TRADE[ob.status];
            tradeText = (m && m.text) || ob.status_text || '';
            tradeStyle = m ? m.style : 1;
          }
        }
        if (!tradeText) {
          tradeText = r.trade_text || '';
          tradeStyle = r.trade_style == null ? null : Number(r.trade_style);
        }
        if (!tradeText && withId) {
          const byCust = tradeByCustomer.get(String(withId));
          if (byCust) {
            tradeText = byCust.trade_text;
            tradeStyle = byCust.trade_style == null ? null : Number(byCust.trade_style);
          }
        }
        if (!tradeText) {
          const lo = lastOrderBySession.get(String(r.id));
          if (lo) {
            const m = ORDER_TO_TRADE[lo.status];
            tradeText = (m && m.text) || lo.status_text || '';
            tradeStyle = m ? m.style : 1;
          }
        }
        // style → 颜色：10 绿（交易成功）、11 灰（交易关闭）、1 橙（等待中）
        const tradeTone = !tradeText ? '' : tradeStyle === 10 ? 'ok' : tradeStyle === 11 ? 'muted' : 'warn';
        return {
          id: r.id, type: r.type, withWho: withId, nickname: nick, logo, city,
          abstractContent: r.abstract, lastMsgTs: r.last_ts, unread: r.unread, syncedAt: r.updated_at,
          pinned: !!r.pinned, pinRank: r.pin_rank == null ? null : Number(r.pin_rank),
          orderTs: r.order_ts || r.last_ts,
          itemId, itemPic, itemTitle,
          tradeText, tradeTone,
        };
      });
      if (rows.some(r => r.withWho && !r.nickname)) enrichCustomers(3); // 后台慢速补，不阻塞响应
      return json(res, 200, { sessions: rows, count: rows.length, lastSync });
    }

    if (p === '/api/enrich') {
      const limit = Number(u.searchParams.get('limit') || 40);
      const r = await enrichCustomers(limit);
      return json(res, 200, r);
    }

    // 运行日志用它：把「客户真实消息流」和「AI/规则的决策」按会话+时间对齐，
    // 这样即使某个会话不在白名单、没有产生决策记录，客户说了什么也看得见。
    if (p === '/api/runlog') {
      const limit = Math.min(Number(u.searchParams.get('limit') || 60), 300);
      const only = String(u.searchParams.get('sessionId') || '').trim();
      const rows = store.raw()
        .prepare(
          `SELECT m.session_id AS sid, m.ts, m.from_self AS fromSelf, m.ctype, COALESCE(m.text,'') AS text,
                  COALESCE(c.nick, s.with_id, '') AS nick
             FROM messages m
             LEFT JOIN sessions s ON s.id = m.session_id
             LEFT JOIN customers c ON c.user_id = s.with_id
            WHERE m.from_self = 0 AND m.ctype IN (1,2,3,5) ${only ? 'AND m.session_id = ?' : ''}
            ORDER BY m.ts DESC
            LIMIT ?`
        )
        .all(...(only ? [only, limit * 3] : [limit * 3]));

      // 决策记录（jsonl）→ 按 sessionId 建索引，取时间最近的一条
      const decisions = [];
      try {
        if (fs.existsSync(SHADOW_FILE)) {
          const lines = fs.readFileSync(SHADOW_FILE, 'utf8').trim().split('\n').filter(Boolean);
          for (const l of lines.slice(-800)) {
            try {
              const r = JSON.parse(l);
              decisions.push({ ...r, ms: Date.parse(r.at) || 0 });
            } catch {
              /* 单行坏了跳过 */
            }
          }
        }
      } catch {
        /* 日志不可读不影响消息流 */
      }

      const seen = new Set();
      const items = [];
      for (const r of rows) {
        const key = r.sid + '|' + String(r.text).slice(0, 40) + '|' + r.ts;
        if (seen.has(key)) continue;
        seen.add(key);
        const ts = Number(r.ts) || 0;
        const near = decisions
          .filter((d) => String(d.sessionId) === String(r.sid) && String(d.text || '').trim() === String(r.text).trim())
          .sort((a, b) => Math.abs(a.ms - ts) - Math.abs(b.ms - ts))[0];
        items.push({
          ts,
          sessionId: r.sid,
          nick: r.nick || r.sid,
          ctype: r.ctype,
          text: r.text,
          action: near ? near.action : '',
          source: near ? near.source : '',
          reason: near ? near.reason || '' : '',
          reply: near ? near.reply || '' : '',
          sent: near ? Boolean(near.sent) : false,
          mode: near ? near.mode || '' : '',
        });
        if (items.length >= limit) break;
      }
      const counts = items.reduce((a, x) => { const k = x.action || 'none'; a[k] = (a[k] || 0) + 1; return a; }, {});
      return json(res, 200, { ok: true, count: items.length, counts, items });
    }

    if (p === '/api/autoreply/shadow') {
      const limit = Math.min(Number(u.searchParams.get('limit') || 100), 500);
      const action = String(u.searchParams.get('action') || '');
      let rows = [];
      try {
        if (fs.existsSync(SHADOW_FILE)) {
          const lines = fs.readFileSync(SHADOW_FILE, 'utf8').trim().split('\n').filter(Boolean);
          rows = lines
            .slice(-Math.max(limit * 3, 300))
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .filter((r) => (action ? r.action === action : true))
            .slice(-limit)
            .reverse();
        }
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
      return json(res, 200, { ok: true, count: rows.length, file: SHADOW_FILE, records: rows });
    }

    if (p === '/api/autoreply/config' && req.method === 'POST') {
      const body = await readBody(req);
      const next = { mode: AUTO_MODE, whitelist: AUTO_WHITE, ...(body || {}) };
      if (next.mode !== 'live') next.mode = 'shadow';
      next.whitelist = (Array.isArray(next.whitelist) ? next.whitelist : String(next.whitelist || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      AUTO_MODE = next.mode;
      AUTO_WHITE = next.whitelist;
      try {
        fs.mkdirSync(path.dirname(AUTO_CONF), { recursive: true });
        fs.writeFileSync(AUTO_CONF, JSON.stringify({ mode: AUTO_MODE, whitelist: AUTO_WHITE }, null, 1), 'utf8');
      } catch (e) {
        return json(res, 500, { ok: false, error: '写配置失败：' + e.message });
      }
      return json(res, 200, { ok: true, mode: AUTO_MODE, whitelist: AUTO_WHITE });
    }

    if (p === '/api/autoreply/state') {
      const aiconf = require('./core/aiconf');
      const ac = aiconf.load();
      const pend = store.pendingEvents(200).length;
      let shadow = [];
      try {
        if (fs.existsSync(SHADOW_FILE)) {
          const lines = fs.readFileSync(SHADOW_FILE, 'utf8').trim().split('\n').filter(Boolean);
          shadow = lines.slice(-20).map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          }).filter(Boolean);
        }
      } catch (e) {
        shadow = [];
      }
      return json(res, 200, {
        mode: AUTO_MODE,
        whitelist: AUTO_WHITE,
        enabled: Boolean(ac.enabled),
        model: ac.model,
        hasKey: Boolean(ac.apiKey),
        dailyLimit: ac.dailyLimit,
        usedToday: autoreply.usageToday(),
        pending: pend,
        running: autoRunning,
        shadowFile: SHADOW_FILE,
        shadow,
      });
    }

    if (p === '/api/autoreply/tick' && req.method === 'POST') {
      return json(res, 200, await autoReplyTick());
    }

    if (p === '/api/mtop' && req.method === 'POST') {
      // 调试透传：直接调 mtop（用服务进程里已登录的 jar，令牌会自动续）
      const body = await readBody(req);
      const api = String(body.api || '');
      if (!api) return json(res, 400, { error: 'api required' });
      try {
        const r = await withTimeout(mtop.call(api, String(body.v || '1.0'), body.data || {}), 45000, 'mtop');
        return json(res, 200, { ok: true, api, result: r });
      } catch (e) {
        return json(res, 502, { ok: false, api, error: e.ret || e.message, kind: e.kind || null });
      }
    }

    if (p === '/api/live') {
      // 训练/调试专用：绕开 doSync，直接从 IMPaaS 拉「当前最新会话」或「某会话最新消息」
      const sessionId = u.searchParams.get('sessionId');
      const want = Math.min(Number(u.searchParams.get('want') || 8), 30);
      const debug = u.searchParams.get('debug') === '1';
      try {
        if (sessionId) {
          const msgs = await withTimeout(
            api.impaasMessages(String(sessionId), { want, maxPages: 1 }),
            40000,
            'impaasMessages'
          );
          const rows = (msgs.messages || msgs.list || []).map((m) => ({
            id: m.id, ts: m.ts, fromSelf: !!m.fromSelf, text: m.text, contentType: m.contentType,
            senderId: m.senderId, senderName: m.senderName,
          }));
          return json(res, 200, { ok: true, sessionId, count: rows.length, messages: rows });
        }
        const list = await withTimeout(api.impaasSessions({ pages: 1, pageSize: 20, withTop: true }), 40000, 'impaasSessions');
        // impaasSessions 返回 {list, pages, hasMore}（不是 sessions，早期这里读错 → 永远 count 0）
        const convs = list.list || list.sessions || [];
        const rows = convs.map((s) => ({
          sid: s.sid || s.id, title: s.title, ts: s.ts, pinned: !!s.pinned,
          peerId: s.peerId, lastText: s.lastText || s.text, unread: s.unread,
        }));
        if (debug) {
          return json(res, 200, {
            ok: true, self: api.selfUnb(), count: rows.length, sessions: rows,
            debug: { pages: list.pages, hasMore: list.hasMore, sample: convs[0] },
          });
        }
        return json(res, 200, { ok: true, count: rows.length, sessions: rows });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.ret || e.message });
      }
    }

    if (p === '/api/messages') {
      const sessionId = u.searchParams.get('sessionId');
      if (!sessionId) return json(res, 400, { error: 'sessionId required' });
      const limit = Number(u.searchParams.get('limit') || 50);
      // 打开某个会话时顺手拉一次最新（IMPaaS 单会话 ~200ms），
      // 这样手机上刚发的消息点开会话就能看到，不用等后台轮询轮到这个会话。
      let fresh = null;
      const wantLive = String(u.searchParams.get('live') || '1') !== '0';
      const lastLive = liveAt.get(String(sessionId)) || 0;
      if (wantLive && Date.now() - lastLive > 4000) {
        liveAt.set(String(sessionId), Date.now());
        try {
          const prev = store.getCursor('imsg:' + sessionId);
          const msgs = await api.fetchSinceImpaas(String(sessionId), prev ? Number(prev) : 0, { maxPages: 1, pageSize: 30 });
          if (msgs.length) {
            fresh = store.saveMessages(String(sessionId), msgs);
            store.setCursor('imsg:' + sessionId, Math.max(Number(prev) || 0, ...msgs.map(m => m.ts)));
          }
        } catch (e) { fresh = null; }
      }
      const rows = store.listMessages(String(sessionId), limit).map(r => ({
        id: r.id, ts: r.ts, contentType: r.ctype, text: r.text,
        senderId: r.sender_id, fromSelf: !!r.from_self,
        media: mcontent.describe(r.raw, r.text),
      })).reverse(); // 库里是 DESC，翻成时间正序
      return json(res, 200, { sessionId, messages: rows, count: rows.length, fresh });
    }

    if (p === '/api/me') {
      // 我自己：昵称/头像用于聊天框右侧气泡（myProfile 已缓存，不会重复打 mtop）
      const me = await myProfile();
      return json(res, 200, { me, accountId: String(api.selfUnb() || cfg.accountId || '') });
    }

    if (p === '/api/overview') {
      const days = Math.min(Number(u.searchParams.get('days') || 7), 30);
      return json(res, 200, store.overviewStats({ days, self: api.selfUnb() }));
    }

    if (p === '/api/ai/style') {
      // 风格卡：从自己发过的历史消息里统计出来的说话方式
      const ai = require('./core/ai');
      const aiconf = require('./core/aiconf');
      const ac = aiconf.load();
      const st = ai.loadStyle(store);
      return json(res, 200, {
        profile: st.profile,
        card: st.card,
        pairs: st.pairs.length,
        hasKey: Boolean(ac.apiKey),
        model: ac.model,
      });
    }

    if (p === '/api/ai/config') {
      const aiconf = require('./core/aiconf');
      if (req.method === 'GET') {
        const autoreply = require('./core/autoreply');
        return json(res, 200, { ...aiconf.view(), ready: aiconf.ready(), usedToday: autoreply.usageToday() });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const next = aiconf.save(body || {});
        return json(res, 200, { ok: true, config: { ...aiconf.view(), ready: aiconf.ready() }, saved: Boolean(next) });
      }
      return json(res, 405, { error: 'GET/POST only' });
    }

    if (p === '/api/ai/models' && req.method === 'POST') {
      // 「填 Key + URL → 获取模型」：先按 OpenAI 的 GET {root}/models 取，不行再试 Anthropic 的 /v1/models
      const body = await readBody(req);
      const aiconf = require('./core/aiconf');
      const cur = aiconf.load();
      const key = String(body.apiKey || '').trim() || cur.apiKey || aiconf.harnessKey();
      let base = String(body.baseUrl || cur.baseUrl || '').trim();
      if (!key) return json(res, 400, { ok: false, error: '先填 API Key' });
      if (!base) return json(res, 400, { ok: false, error: '先填 Base URL' });
      if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
      base = base.replace(/\/+$/, '');

      const roots = [];
      if (/\/anthropic$/i.test(base)) roots.push({ root: base.replace(/\/anthropic$/i, '') + '/v1', style: 'openai' });
      if (/\/v\d+$/i.test(base)) roots.push({ root: base, style: 'openai' });
      roots.push({ root: base + '/v1', style: 'openai' });
      if (!/\/v\d+$/.test(base)) roots.push({ root: base + '/v1', style: 'anthropic' });
      const seen = new Set();
      const cands = roots.filter((r) => (seen.has(r.root + '|' + r.style) ? false : seen.add(r.root + '|' + r.style)));

      const tries = [];
      for (const c of cands) {
        const url = c.root + '/models';
        try {
          const headers = c.style === 'anthropic'
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : { authorization: 'Bearer ' + key };
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 15000);
          const res2 = await fetch(url, { headers, signal: ac.signal }).finally(() => clearTimeout(timer));
          const txt = await res2.text();
          tries.push({ url, status: res2.status });
          if (!res2.ok) continue;
          let j;
          try { j = JSON.parse(txt); } catch (_) { continue; }
          const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : null;
          if (!arr) continue;
          const models = arr
            .map((m) => (typeof m === 'string' ? { id: m } : m))
            .filter((m) => m && (m.id || m.name))
            .map((m) => ({
              id: String(m.id || m.name),
              name: m.name || m.display_name || String(m.id || ''),
              context: m.context_window || m.context_length || m.max_input_tokens || null,
              maxOutput: m.max_output_tokens || m.max_tokens || null,
            }));
          return json(res, 200, { ok: true, endpoint: url, protocol: c.style, count: models.length, models, tries });
        } catch (e) {
          tries.push({ url, error: e.message });
        }
      }
      return json(res, 502, {
        ok: false,
        error: '拿不到模型列表：' + (tries.map((t) => t.url + ' → ' + (t.status || t.error)).join('；') || '无可用端点'),
        tries,
      });
    }

    if (p === '/api/mail/config') {
      const mailer = require('./lib/mailer');
      if (req.method === 'GET') return json(res, 200, mailer.view());
      if (req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, { ok: true, config: mailer.save(body || {}) });
      }
      return json(res, 405, { error: 'GET/POST only' });
    }

    if (p === '/api/train/ask' && req.method === 'POST') {
      const train = require('./core/train');
      const body = await readBody(req);
      try {
        const r = await train.ask(body || {});
        return json(res, 200, r);
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (p === '/api/train/label' && req.method === 'POST') {
      const train = require('./core/train');
      const body = await readBody(req);
      try {
        return json(res, 200, { ok: true, item: train.label(body || {}) });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    if (p === '/api/train/list' && req.method === 'GET') {
      const train = require('./core/train');
      const u = new URL(req.url, 'http://x');
      return json(res, 200, {
        items: train.list({ limit: Number(u.searchParams.get('limit') || 50), verdict: u.searchParams.get('verdict') || undefined }),
        stats: train.stats(),
      });
    }

    // 训练台的「商品上下文」：已绑定保险方案的商品 + 可选会话
    if (p === '/api/train/contexts' && req.method === 'GET') {
      const rows = store.listBindings();
      const items = rows.map((b) => {
        const plan = store.getPlan(b.plan_code);
        return {
          itemId: String(b.item_id),
          itemTitle: b.item_title || (plan ? plan.nick : '') || '',
          planCode: b.plan_code,
          planName: b.plan_name || (plan ? plan.nick || plan.name : '') || '',
          company: b.company || '',
          className: b.class_name || '',
          boundAt: b.bound_at,
        };
      });
      return json(res, 200, { items, count: items.length });
    }

    if (p === '/api/train/distill' && req.method === 'POST') {      const train = require('./core/train');
      try {
        return json(res, 200, train.distill({}));
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (p === '/api/train/apply' && req.method === 'POST') {
      const train = require('./core/train');
      const body = await readBody(req);
      try {
        return json(res, 200, train.apply(body.drafts || body.rules || []));
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    if (p === '/api/mail/presets' && req.method === 'GET') {
      const mailer = require('./lib/mailer');
      const list = Object.entries(mailer.PRESETS).map(([key, v]) => ({
        key,
        host: v.host,
        port: v.port,
        secure: v.secure,
        note: v.note,
      }));
      return json(res, 200, { presets: list });
    }

    if (p === '/api/mail/verify' && req.method === 'POST') {
      const mailer = require('./lib/mailer');
      try {
        const r = await mailer.verify();
        return json(res, 200, r);
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (p === '/api/mail/test' && req.method === 'POST') {
      // 发一封测试信给自己
      const mailer = require('./lib/mailer');
      const body = await readBody(req);
      const to = String(body.to || mailer.load().fromAddr || '');
      if (!to) return json(res, 400, { ok: false, error: '没有收件人（也没有 fromAddr）' });
      try {
        const r = await mailer.send({
          to,
          subject: body.subject || '【闲鱼客服工作台】邮件通道测试',
          text: `这是一封测试邮件。\r\n发送时间：${new Date().toLocaleString('zh-CN')}\r\n如果收到了，说明 SMTP 配置可用。\r\n`,
        });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (p === '/api/mail/send' && req.method === 'POST') {
      const mailer = require('./lib/mailer');
      const body = await readBody(req);
      try {
        const r = await mailer.send({
          to: body.to,
          subject: body.subject,
          text: body.text,
          html: body.html,
          attachments: body.attachments || [],
        });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (p === '/api/mail/send-policy' && req.method === 'POST') {
      // 出单后把保单 PDF 发给客户
      const notify = require('./core/notify');
      const body = await readBody(req);
      try {
        // 没给 to 时从会话聊天里找客户留的邮箱
        if (!body.to && body.sessionId) {
          const hit = notify.findBuyerEmail(String(body.sessionId), { store });
          if (!hit) return json(res, 400, { ok: false, error: '这个会话里没找到客户留的邮箱，请手动填 to' });
          body.to = hit.email;
          body.emailFrom = 'chat';
        }
        const r = await notify.sendPolicy(body || {});
        return json(res, 200, r);
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (p === '/api/ai/test' && req.method === 'POST') {
      // 连通性测试：发一句最短的话看模型回不回
      const ai = require('./core/ai');
      const r = await ai.chat([
        { role: 'system', content: '你是一个测试助手，只回四个字。' },
        { role: 'user', content: '在吗' },
      ]);
      return json(res, r.ok ? 200 : 502, r);
    }

    if (p === '/api/rules') {
      const rulesCore = require('./core/rules');
      const fs = require('fs');
      if (req.method === 'GET') {
        const conf = rulesCore.load();
        return json(res, 200, { ...conf, file: cfg.rulesFile, exists: fs.existsSync(cfg.rulesFile) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const conf = rulesCore.load();
        const next = {
          cooldown: Number(body.cooldown != null ? body.cooldown : conf.cooldown),
          maxPerSession: Number(body.maxPerSession != null ? body.maxPerSession : conf.maxPerSession),
          minLength: Number(body.minLength != null ? body.minLength : conf.minLength),
          rules: Array.isArray(body.rules) ? body.rules : conf.rules,
        };
        for (const r of next.rules) {
          if (!r.id) return json(res, 400, { error: '每条规则都要有 id' });
          if (r.match && r.match.regex) {
            try { new RegExp(r.match.regex, 'i'); } catch (e) {
              return json(res, 400, { error: `规则 ${r.id} 的正则写错了：${e.message}` });
            }
          }
          if (!r.reply && !r.ai && !r.handoff) {
            return json(res, 400, { error: `规则 ${r.id} 需要有 reply / ai / handoff 之一` });
          }
        }
        fs.mkdirSync(require('path').dirname(cfg.rulesFile), { recursive: true });
        fs.writeFileSync(cfg.rulesFile, JSON.stringify(next, null, 2), 'utf8');
        return json(res, 200, { ok: true, ...rulesCore.load() });
      }
      return json(res, 405, { error: 'GET/POST only' });
    }

    // ---------------------------------------------------------- 保险方案（旅云保）
    if (p === '/api/plans' && req.method === 'GET') {
      const kw = (u.searchParams.get('q') || '').trim().toLowerCase();
      const company = (u.searchParams.get('company') || '').trim();
      const cls = (u.searchParams.get('class') || u.searchParams.get('cls') || '').trim();
      const limit = Number(u.searchParams.get('limit') || 300);
      let rows = store.listPlans();
      if (company) rows = rows.filter((x) => String(x.company) === company);
      if (cls) rows = rows.filter((x) => String(x.className) === cls);
      if (kw) {
        rows = rows.filter(
          (x) =>
            String(x.name).toLowerCase().includes(kw) ||
            String(x.company).toLowerCase().includes(kw) ||
            String(x.planCode).toLowerCase().includes(kw) ||
            String(x.className).toLowerCase().includes(kw)
        );
      }
      const bindings = store.listBindings();
      const byPlan = new Map();
      const byProduct = new Map();
      for (const b of bindings) {
        byPlan.set(b.plan_code, (byPlan.get(b.plan_code) || 0) + 1);
        const prod = b.product_code || String(b.plan_code || '').slice(0, 9);
        byProduct.set(prod, (byProduct.get(prod) || 0) + 1);
      }

      // 产品维度：planCode 前两段相同即同一款产品的不同保额档（畅享亚洲 - 计划一/二/三…）
      const groups = new Map();
      for (const x of rows) {
        const key = String(x.planCode).split('-').slice(0, 2).join('-');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(x);
      }

      const commonPrefix = (names) => {
        if (!names.length) return '';
        let p = names[0];
        for (const n of names) {
          let i = 0;
          while (i < p.length && i < n.length && p[i] === n[i]) i += 1;
          p = p.slice(0, i);
        }
        return p;
      };

      const products = [];
      for (const [key, list] of groups) {
        const names = list.map((x) => String(x.name || ''));
        let base = commonPrefix(names).replace(/[\s\-—_·:：]+$/, '');
        base = base.replace(/[\s\-—_·:：]*计划[\s\S]*$/, '').replace(/[\s\-—_·:：]+$/, '');
        base = base.replace(/[（(【\[]\s*$/, '').trim();
        if (!base || base.length < 2) base = names[0].replace(/[\s\-—_·:：]*计划[\s\S]*$/, '').trim() || names[0];

        const plans = list
          .slice()
          .sort((a, b) => String(a.planCode).localeCompare(String(b.planCode)))
          .map((x) => {
            const tail = String(x.name).slice(base.length).replace(/^[\s\-—_·:：]+/, '').trim();
            // 报价 = 标准保费（客户看到的价）；成本 = 标准 × REALPERCENT
            const rp = Number(x.realPercent || 0);
            const quote = Number(x.basePrice || 0);
            const cost = rp > 0 ? Math.round(quote * rp * 100) / 100 : 0;
            return {
              planCode: x.planCode,
              name: x.name,
              level: tail || String(x.name),
              basePrice: quote,
              quotePrice: quote,
              costPrice: cost,
              realPercent: rp,
              minAge: x.minAge,
              maxAge: x.maxAge,
              coverageCount: (x.coverage || []).length,
              noticeChars: (x.notice || '').length,
              clauseChars: (x.clause || '').length,
              boundItems: byPlan.get(x.planCode) || 0,
            };
          });

        products.push({
          key,
          name: base,
          company: list[0].company,
          className: list[0].className,
          minAge: Math.min(...plans.map((p) => p.minAge || 0)),
          maxAge: Math.max(...plans.map((p) => p.maxAge || 0)),
          basePrice: Math.min(...plans.map((p) => p.basePrice || 0).filter((n) => n > 0)),
          quotePrice: Math.min(...plans.map((p) => p.quotePrice || 0).filter((n) => n > 0)),
          costPrice: Math.min(...plans.map((p) => p.costPrice || 0).filter((n) => n > 0)),
          levels: plans.length,
          boundItems: byProduct.get(key) || 0,
          plans,
        });
      }
      products.sort((a, b) => a.company.localeCompare(b.company) || b.levels - a.levels);

      const all = rows.map((x) => ({
        planCode: x.planCode,
        name: x.name,
        company: x.company,
        className: x.className,
        minAge: x.minAge,
        maxAge: x.maxAge,
        basePrice: x.basePrice,
        coverageCount: (x.coverage || []).length,
        noticeChars: (x.notice || '').length,
        clauseChars: (x.clause || '').length,
        syncedAt: x.syncedAt,
        boundItems: byPlan.get(x.planCode) || 0,
      }));

      const facets = (() => {
        const src = store.listPlans();
        const c = new Map();
        const k = new Map();
        for (const x of src) {
          c.set(x.company, (c.get(x.company) || 0) + 1);
          k.set(x.className, (k.get(x.className) || 0) + 1);
        }
        return {
          companies: [...c.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
          classes: [...k.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
        };
      })();

      return json(res, 200, {
        total: rows.length,
        count: store.planCount(),
        products: products.slice(0, limit),
        plans: all.slice(0, limit),
        facets,
      });
    }

    if (p === '/api/plans/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const plansCore = require('./core/plans');
      if (body.code) {
        const one = await plansCore.syncDetail(store, String(body.code));
        return json(res, 200, { ok: true, plan: one.planCode, coverage: one.coverage.length });
      }
      const cat = await plansCore.syncCatalog(store);
      let ok = 0;
      const limit = Math.min(Number(body.limit || 0) || cat.total, 200);
      const all = store.listPlans().slice(0, limit);
      if (body.detail !== false) {
        for (const x of all) {
          try { await plansCore.syncDetail(store, x.planCode); ok += 1; } catch (_) {}
        }
      }
      return json(res, 200, { ok: true, catalog: cat.total, errors: cat.errors, detailSynced: ok, count: store.planCount() });
    }

    if (p === '/api/plan' && req.method === 'GET') {
      const code = String(u.searchParams.get('code') || '');
      const plan = store.getPlan(code);
      if (!plan) return json(res, 404, { error: '没有这个方案，先同步' });
      const bindings = store.bindingsOfPlan(code);
      return json(res, 200, { plan, bindings });
    }

    if (p === '/api/plan/bind' && req.method === 'POST') {
      const body = await readBody(req);
      const itemId = String(body.itemId || '').trim();
      let planCode = String(body.planCode || '').trim();
      const productCode = String(body.productCode || '').trim();
      if (!itemId) return json(res, 400, { error: 'itemId 必填' });
      // 按「方案」绑定时只给 productCode（如 0018-0580），默认档取该方案的第一档（计划一）
      if (!planCode && productCode) {
        const tiers = store.raw().prepare('SELECT plan_code FROM plans WHERE substr(plan_code,1,9)=? ORDER BY plan_code').all(productCode);
        if (!tiers.length) return json(res, 404, { error: '这个方案还没有同步到本地：' + productCode });
        planCode = tiers[0].plan_code;
      }
      if (!planCode) return json(res, 400, { error: 'planCode 或 productCode 必填' });
      store.bindItemPlan(itemId, planCode, String(body.itemTitle || ''));
      return json(res, 200, { ok: true, ...store.planForItem(itemId) });
    }

    if (p === '/api/plan/unbind' && req.method === 'POST') {
      const body = await readBody(req);
      store.unbindItemPlan(String(body.itemId || ''));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/bindings' && req.method === 'GET') {
      return json(res, 200, { bindings: store.listBindings() });
    }

    if (p === '/api/ai/answer' && req.method === 'POST') {
      // 完整管线试跑：敏感词 → 规则 → AI → 自检（默认不发送）
      const body = await readBody(req);
      const autoreply = require('./core/autoreply');
      const out = await autoreply.answer({
        store,
        sessionId: String(body.sessionId || ''),
        text: String(body.text || ''),
        live: body.live !== false,
      });
      if (body.send === true || body.send === '1') {
        const sent = await autoreply.respondAndSend({
          store, api, sessionId: String(body.sessionId || ''),
          text: String(body.text || ''), force: true,
        });
        return json(res, 200, { decision: out, sent });
      }
      return json(res, 200, { decision: out });
    }

    if (p === '/api/orders/tabs') {
      // 订单 tab 计数：全部 / 待付款 / 待发货 / 退款中 / 已发货 / 待评价 / 赔付单
      const counts = store.orderTabCounts();
      return json(res, 200, {
        counts,
        coolingDown: ordersCore().isCoolingDown(),
        cooldownUntil: ordersCore().cooldownUntil() || 0,
        known: Object.values(counts).reduce((a, b) => a + (b || 0), 0) > 0,
      });
    }

    if (p === '/api/orders/list') {
      const tab = String(u.searchParams.get('tab') || 'all');
      const limit = Math.min(Number(u.searchParams.get('limit') || 100), 500);
      const rows = store.listOrders(tab, limit);
      return json(res, 200, { tab, orders: rows, count: rows.length, counts: store.orderTabCounts() });
    }

    if (p === '/api/products') {
      const prod = require('./core/products');
      return json(res, 200, { products: prod.listProducts(store, { self: api.selfUnb() }) });
    }

    if (p === '/api/product') {
      const prod = require('./core/products');
      const itemId = String(u.searchParams.get('itemId') || '');
      if (!itemId) return json(res, 400, { error: 'itemId required' });
      return json(res, 200, prod.getProduct(store, itemId));
    }

    if (p === '/api/product/qa') {
      // 条款问答探测：给问题，返回命中的条款片段（用于验证文档喂对了没）
      const prod = require('./core/products');
      const itemId = String(u.searchParams.get('itemId') || '');
      const q = String(u.searchParams.get('q') || '');
      if (!itemId || !q) return json(res, 400, { error: 'itemId 与 q 必填' });
      const hits = prod.searchClauses(store, itemId, q, Number(u.searchParams.get('k') || 4));
      return json(res, 200, { itemId, q, hits, count: hits.length });
    }

    if (p === '/api/product/doc' && req.method === 'POST') {
      // 上传条款：{ itemId, name, contentBase64 } 走文件；或 { itemId, name, text } 直接粘贴
      const prod = require('./core/products');
      const body = await readBody(req);
      const itemId = String(body.itemId || '').trim();
      if (!itemId) return json(res, 400, { error: 'itemId 必填' });
      let buf = null;
      if (body.contentBase64) buf = Buffer.from(String(body.contentBase64), 'base64');
      const r = prod.saveDoc(store, {
        itemId,
        name: String(body.name || ''),
        buffer: buf,
        text: body.text ? String(body.text) : '',
      });
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/product/doc' && req.method === 'DELETE') {
      const prod = require('./core/products');
      const id = Number(u.searchParams.get('id') || 0);
      const r = prod.deleteDoc(store, id);
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/ai/preview' && req.method === 'POST') {
      // 建议回复：风格卡 + 检索样例 + 红线自检。没配 XY_AI_KEY 时只回 prompt（不发出去、不改库）
      const body = await readBody(req);
      const live = String(body.live || '') === '1' || body.live === true;
      const ai = require('./core/ai');
      const out = await ai.suggestForSession({
        store,
        sessionId: body.sessionId,
        query: body.text,
        live,
      });
      return json(res, out.ok ? 200 : 400, out);
    }

    if (p === '/api/ai/send' && req.method === 'POST') {
      // 确认发送：把人工看过的建议文本走正常发送链路
      const body = await readBody(req);
      const sid = String(body.sessionId || '');
      const text = String(body.text || '').trim();
      if (!sid || !text) return json(res, 400, { error: 'sessionId 与 text 必填' });
      const guard = require('./core/rules');
      if (!guard.canReply(sid)) return json(res, 429, { error: '这个会话刚回过，冷却中' });
      await api.sendText(sid, text);
      guard.markReplied(sid);
      store.saveMessages(sid, [
        { id: 'local-' + Date.now(), ts: Date.now(), ctype: 1, text, fromSelf: true, senderId: api.selfUnb() },
      ]);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/orders/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await ordersCore().syncOrders({
        limit: Number(body.limit || 20),
        gap: Number(body.gap || 900),
        sessionId: body.sessionId || '',
      });
      return json(res, 200, r);
    }

    if (p === '/api/order/consign-dummy' && req.method === 'POST') {
      // 无需物流发货：订单直接进 buyer_to_confirm（等待见面交易）
      const body = await readBody(req);
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return json(res, 400, { error: 'orderId required' });
      try {
        const r = await api.consignDummy(orderId);
        // 立刻回读最新状态并落库
        let fresh = null;
        try {
          const rr = await api.orderBrief(orderId);
          const it = (rr.items || [])[0];
          if (it) {
            fresh = api.normalizeOrder(it, orderId);
            store.saveOrder(fresh);
          }
        } catch (_) {}
        return json(res, 200, { ok: true, orderId, result: r, order: fresh });
      } catch (e) {
        const msg = String(e.message || e);
        const code = /ALREADY_DELIVERY/.test(msg) ? 'ALREADY' : e.kind === 'AUTH' ? 'AUTH' : 'FAIL';
        return json(res, code === 'ALREADY' ? 200 : 500, { ok: code === 'ALREADY', code, error: msg });
      }
    }

    if (p === '/api/order/price') {
      // 订单金额拆分（现金 + 闲鱼币）：网页 order-detail 页面同款接口，一次一单
      const orderId = String(u.searchParams.get('orderId') || '').trim();
      if (!orderId) return json(res, 400, { error: 'orderId required' });
      const force = u.searchParams.get('refresh') === '1';
      // 6 小时内查过就用库里的，别每次开页面都打一次 detail
      const cached = store.getOrder(orderId);
      if (!force && cached && cached.priceAt && Date.now() - Number(cached.priceAt) < 6 * 3600 * 1000) {
        return json(res, 200, {
          ok: true, from: 'db',
          price: {
            orderId,
            cashAmount: cached.cashAmount,
            coinAmount: cached.coinAmount,
            coinCount: cached.coinCount,
            goodsTotal: cached.goodsTotal,
            invoiceTotal: cached.invoiceTotal,
            coinsReceiving: cached.coinsReceiving,
            smartDeduct: cached.smartDeduct,
            payTime: cached.payTime,
            alipayNo: cached.alipayNo,
            address: cached.address,
          },
          line: orderPrice.moneyLine({
            cashAmount: cached.cashAmount,
            coinCount: cached.coinCount,
          }),
        });
      }
      try {
        const price = await orderPrice.fetchOrderPrice(orderId);
        try { store.saveOrderPrice(price); } catch (_) {}
        const { raw, ...clean } = price;
        return json(res, 200, { ok: true, from: 'mtop', price: clean, line: orderPrice.moneyLine(clean) });
      } catch (e) {
        const msg = String(e.message || e);
        // 拉不到别让页面报错，退回本地价（只有实付）
        return json(res, 200, {
          ok: false, error: msg,
          price: cached
            ? { orderId, cashAmount: Number(cached.price) || null, coinCount: null, invoiceTotal: Number(cached.price) || null }
            : null,
          line: cached ? `金额：¥${cached.price}` : '',
        });
      }
    }

    if (p === '/api/orders') {
      // 单个会话的买家订单：优先读本地订单库（同步过就不用再打 sold.get）
      const sessionId = u.searchParams.get('sessionId');
      if (!sessionId) return json(res, 400, { error: 'sessionId required' });
      const limit = Math.min(Number(u.searchParams.get('limit') || 50), 100);

      const sess = store.getSession(String(sessionId));
      const peer = (sess && sess.with_id) || '';

      // 有买家 id → 用「本店最近订单」按 buyer 归会话（sold.get 的 peerUserId 参数其实无效），60 秒节流
      if (peer) {
        const key = 'recent-orders';
        const hit = orderCache.get(key) || { at: 0 };
        if (Date.now() - hit.at > 60 * 1000) {
          try {
            await api.syncRecentOrders(store, { pageSize: 10 });
            orderCache.set(key, { at: Date.now() });
          } catch (e) {
            orderCache.set(key, { at: Date.now() - 45 * 1000 }); // 失败 15s 后重试
          }
        }
        const byBuyer = store.listOrdersByBuyer(peer, limit);
        if (byBuyer.length) return json(res, 200, { sessionId, orders: byBuyer, count: byBuyer.length, from: 'buyer' });
      }

      const local = store.listOrdersBySession(String(sessionId), limit);
      if (local.length) {
        // 本地有单也要保鲜：同一会话 45s 内只刷一次最新 3 单，避免每次打开都打 sold.get
        const feed = orderCache.get('feed:' + sessionId) || { at: 0 };
        if (Date.now() - feed.at > 45 * 1000) {
          orderCache.set('feed:' + sessionId, { at: Date.now() });
          const ids = api.orderIdsFromMessages(store, String(sessionId), 5).slice(0, 3);
          try {
            const fresh = await api.ordersDetail(ids, { gap: 900 });
            for (const o of fresh) {
              if (o && o.orderId && !o.error) store.saveOrder({ ...o, sessionId: String(sessionId) });
            }
          } catch (_) {}
        }
        const rows = store.listOrdersBySession(String(sessionId), limit);
        return json(res, 200, { sessionId, orders: rows, count: rows.length, from: 'db' });
      }

      const hit = orderCache.get(sessionId);
      if (hit && Date.now() - hit.at < 120 * 1000) return json(res, 200, hit.data);
      const ids = api.orderIdsFromMessages(store, String(sessionId), limit);
      let orders = [];
      let error = '';
      try {
        orders = await api.ordersDetail(ids, { gap: 400 });
        for (const o of orders) {
          if (o && o.orderId && !o.error) store.saveOrder({ ...o, sessionId: String(sessionId) });
        }
      } catch (e) {
        error = e.message;
      }
      const data = { sessionId, orderIds: ids, orders, count: orders.length, from: 'live', error: error || undefined };
      orderCache.set(sessionId, { at: Date.now(), data });
      return json(res, 200, data);
    }

    if (p === '/api/customer') {
      const sessionId = u.searchParams.get('sessionId');
      if (!sessionId) return json(res, 400, { error: 'sessionId required' });
      return json(res, 200, await doCustomer(sessionId));
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await doSync(!!body.full));
    }

    if (p === '/api/plans/job' && req.method === 'GET') {
      return json(res, 200, planjob.view());
    }

    if (p === '/api/plans/job' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.runNow) {
        const r = await planjob.run({ detail: body.detail != null ? !!body.detail : true });
        return json(res, 200, { ...planjob.view(), run: r });
      }
      const conf = planjob.saveConf(body);
      return json(res, 200, { ...planjob.view(), conf });
    }

    if (p === '/api/send' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.sessionId || !body.text) return json(res, 400, { error: 'sessionId + text required' });
      if (!rules.canReply(String(body.sessionId), rules.load())) {
        return json(res, 429, { error: 'cooldown', message: '该会话刚回过，冷却中' });
      }
      const r = await api.sendText(String(body.sessionId), String(body.text));
      store.outboxAdd(r.uuid, String(body.sessionId), { contentType: 1, text: { text: body.text } });
      store.outboxDone(r.uuid, 'ok', r.raw);
      store.saveMessages(String(body.sessionId), [{
        messageId: r.localId || r.messageId || r.uuid,
        ts: r.createAt || Date.now(),
        contentType: 1,
        text: String(body.text),
        senderId: api.selfUnb(),
        fromSelf: true,
        raw: r.raw,
      }]);
      rules.markReplied(String(body.sessionId));
      return json(res, 200, { ok: true, localId: r.uuid, messageId: r.messageId, dryRun: !!cfg.dryRun });
    }

    if (p === '/api/read' && req.method === 'POST') {
      const body = await readBody(req);
      const sid = String(body.sessionId || '');
      if (!sid) return json(res, 400, { error: 'sessionId required' });
      // 1) 立即清本地未读（徽标马上消失，不依赖服务端）
      const cleared = store.clearUnread(sid);
      store.setCursor('read:' + sid, Date.now());
      // 2) 尽力而为发已读回执（IMPaaS /r/MessageStatus/read），失败不影响体验
      let receipt = null;
      try { receipt = await api.impaasMarkRead(sid); } catch (e) { receipt = { ok: false, reason: e.message }; }
      // 3) 系统会话额外走 mtop 清服务端未读
      let sys = null;
      try { sys = await api.clearSystemUnread(sid); } catch (e) { sys = { ret: [String(e.message)] }; }
      return json(res, 200, { ok: true, cleared, receipt, raw: sys });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'no such api', path: p });
    return serveStatic(req, res, p);
  } catch (e) {
    const code = e && e.kind === 'AUTH' ? 401 : e && e.kind === 'RISK' ? 418 : 500;
    return json(res, code, { error: e.message, ret: e.ret || null, kind: e.kind || null, hint: e.hint || mtop.hintFor(e.ret) });
  }
});

// —— Cookie 保活 ——
const cookieState = {
  enabled: true,
  port: Number(process.env.XY_CDP_PORT || 9315),
  everyMin: Number(process.env.XY_COOKIE_REFRESH_MIN || 30),
  lastAt: 0,
  lastOk: null,
  lastMsg: '',
  count: 0,
  failures: 0,
  timer: null,
};

async function refreshCookieOnce(reason = 'timer') {
  if (!cookieState.enabled) return { ok: false, msg: 'disabled' };
  const keeper = require('./lib/cookiekeeper');
  const r = await keeper.refresh({ port: cookieState.port });
  cookieState.lastAt = Date.now();
  cookieState.lastOk = r.ok;
  cookieState.lastMsg = `${reason}：${r.msg || ''}`;
  if (r.ok) {
    cookieState.count++;
    cookieState.failures = 0;
    // 换了 Cookie 立刻补一轮同步，别等下一个 tick
    setTimeout(() => doSync(false).catch(() => {}), 800);
  } else {
    cookieState.failures++;
  }
  return r;
}

function startCookieKeeper() {
  if (cookieState.timer) clearInterval(cookieState.timer);
  if (!cookieState.everyMin) return;
  // 启动后先不要抢首轮同步，30 秒后再续一次（Cookie 看着新也刷一下，成本很低）
  setTimeout(() => { refreshCookieOnce('startup').catch(() => {}); }, 30000);
  cookieState.timer = setInterval(() => {
    refreshCookieOnce('timer').catch(() => {});
  }, cookieState.everyMin * 60 * 1000);
  console.log(`[cookie] 每 ${cookieState.everyMin} 分钟从 127.0.0.1:${cookieState.port} 刷新一次`);
}

// 兜底：任何未捕获异常都不要让进程退出（否则页面直接「崩溃」= 连不上后端）
function crashLog(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${(e && (e.stack || e.message)) || e}\n`;
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'data', 'server.err.log'), line);
  } catch {
    /* 忽略写日志失败 */
  }
  console.error(line.trim());
}
process.on('uncaughtException', (e) => crashLog('uncaughtException', e));
process.on('unhandledRejection', (e) => crashLog('unhandledRejection', e));

server.listen(PORT, '127.0.0.1', () => {  const banner = [
    `[api] http://127.0.0.1:${PORT}`,
    `[api] account=${cfg.accountId || '(none)'} cookie=${bound.hasCookie ? 'OK' : 'MISSING'}`,
    `[api] db=${cfg.dbFile}`,
    `[api] dist=${fs.existsSync(DIST) ? DIST : '(未构建)'}`,
  ].join('\n');
  console.log(banner);
  // 后台轮询：无 WS 时的兜底同步。
  // 首次 full=true（顺便把 mtop 的历史会话并进来），之后只跑官方列表 + 增量消息，
  // 避免每 30s 打一次 mtop session.sync（那是唯一还在走风控签名的接口）。
  if (bound.hasCookie && cfg.pollInterval > 0 && process.env.XY_NO_POLL !== '1') {
    let first = true;
    // 启动即同步一次（否则首次数据要等一个 pollInterval）
    setTimeout(() => { doSync(first).catch(() => {}); first = false; }, 400);
    setInterval(() => {
      doSync(first)
        .then(() => autoReplyTick())
        .catch(() => {});
      first = false;
    }, cfg.pollInterval * 1000);
  }

  // Cookie 保活：定时从「带调试端口的 Chrome」续一次登录态（默认 30 分钟，XY_COOKIE_REFRESH_MIN 可调）
  startCookieKeeper();

  // 方案库每天自动刷新（开关在保险平台页面；配置 data/plan-sync.json）
  setTimeout(() => { planjob.tick(); }, 20 * 1000);
  setInterval(() => { planjob.tick(); }, 60 * 1000);

  // 自动回复：默认影子模式（只记录不发送）
  setTimeout(() => { autoReplyTick().catch(() => {}); }, 5000);
});

module.exports = { server, doSync, autoReplyTick };
