'use strict';
/**
 * 业务 API 层：会话 / 消息 / 发送 / 上传 / 商品与订单只读信息
 * 依据：《闲管家-im-接口文档.md》第 3-8 节
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { call, httpsRequest, md5, throttle } = require('../lib/mtop');
const { cfg } = require('../config');

// ---------------------------------------------------------------- 会话列表
async function getSessions({ types = cfg.sessionTypes, fetchNum = cfg.fetchNum, sortIndex = null, sessionId = null } = {}) {
  await throttle();
  return call('mtop.taobao.idlemessage.pc.session.sync', '3.0', {
    sessionTypes: JSON.stringify(types),
    fetchNum,
    sortIndex,
    sessionId,
  });
}

function normalizeSessions(page) {
  return (page.sessions || []).map(item => {
    const s = item.session || {};
    const sum = (item.message || {}).summary || {};
    return {
      id: String(s.sessionId),
      type: s.sessionType,
      abstractContent: sum.summary,
      unread: sum.unread,
      lastMsgTs: sum.ts,
      topRank: sum.sortIndex,
      memberFlags: item.memberFlags,
      withWho: s.userInfo ? { id: s.userInfo.userId, type: s.userInfo.type } : null,
      orignJson: JSON.stringify(item),
      // 交易状态气泡（会话列表里昵称右边那个）：由 session.sync 的 summary.redReminder 提供
      // style 实测：10=交易成功(绿)、11=交易关闭(灰)、1=等待买家收货/等待卖家发货/等待买家付款/买家申请退款(橙)
      tradeText: sum.redReminder || '',
      tradeStyle: sum.redReminderStyle,
    };
  });
}

/** 全量翻页拉会话（带最大页数保护） */
async function getAllSessions({ types = cfg.sessionTypes, maxPages = 20 } = {}) {
  let out = [];
  let sortIndex = null;
  let sessionId = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await getSessions({ types, sortIndex, sessionId });
    const list = normalizeSessions(page);
    out = out.concat(list);
    if (!page.hasMore || !list.length) break;
    const last = list[list.length - 1];
    sortIndex = last.topRank;
    sessionId = last.id;
  }
  return out;
}

// ---------------------------------------------------------------- 消息
/**
 * 拉一页消息。实测：version 传 0 会返回空列表，首页必须传 null；
 * 之后再传上一次响应的最小 version 继续往旧翻。
 */
async function getMessages(sessionId, { count = cfg.msgPageSize, cursor = 0 } = {}) {
  await throttle();
  return call('mtop.taobao.idlemessage.pc.message.sync', '1.0', {
    req: JSON.stringify({
      type: 1,
      fetchs: count,
      sessionId: String(sessionId),
      version: cursor || null,
      start: 0,
      includeRequestMsg: true,
    }),
  });
}

function renderText(c) {
  if (!c) return '';
  switch (c.contentType) {
    case 1: return (c.text && c.text.text) || '';
    case 2: return '[图片] ' + ((((c.image || {}).pics) || [])[0] || {}).url;
    case 3: return '[语音] ' + (((c.audio || {}).duration) || '') + 's';
    case 4: return '[视频] ' + (c.video || {}).url;
    case 5: return '[表情] ' + (((c.expression || {}).name) || '');
    case 6: return '[文本卡]';
    case 7: case 21: { const it = (c.itemCard || {}).item || {}; return `[商品卡] ${it.title || ''} ¥${it.price || ''}`; }
    case 8: return '[图片卡]';
    case 9: return '[用户卡]';
    case 10: return '[动作卡]';
    case 11: return '[回复]';
    case 14: return '[提示] ' + JSON.stringify(c.tip || {});
    case 18: return '[通话]';
    case 20: return (c.text && c.text.text) || '';
    case 25: case 26: case 28: return '[营销卡]';
    case 29: return '[建议卡]';
    case 30: return '[位置]';
    case 32: return '[动态操作]';
    case 33: return '[文件] ' + (((c.file || {}).name) || '');
    default: return `[type ${c.contentType}]`;
  }
}

function normalizeMessages(page, selfId) {
  const list = (page.messages || []).map(m => {
    let messageId = '';
    try { messageId = m.extJson ? JSON.parse(m.extJson).messageId || '' : ''; } catch (_) {}
    const senderId = m.senderInfo && String(m.senderInfo.userId);
    // mtop 会把 userId 打码成 "2***3"，所以不能直接比 accountId；
    // 同一条消息里 ownerInfo.userId 就是卖家（我们自己）的打码 id。
    const ownerId = ((m.sessionInfo || {}).ownerInfo || {}).userId;
    const fromSelf = senderId && ownerId ? senderId === String(ownerId) : undefined;
    // 一条消息里就带着会话对端（客户）的资料：sessionInfo.userInfo —— fishNick 未打码，
    // 比 user.page.head 省一次请求，也不触发风控。
    const peer = (m.sessionInfo || {}).userInfo || {};
    return {
      messageId: messageId || m.messageUuid || '',
      version: m.version,
      ts: m.timeStamp || m.version,
      contentType: m.content && m.content.contentType,
      content: m.content,
      text: renderText(m.content),
      senderId,
      fromSelf,
      sessionId: (m.sessionInfo || {}).sessionId,
      peer: {
        userId: peer.userId ? String(peer.userId) : '',
        nick: peer.fishNick || peer.nick || '',
        avatar: peer.logo || '',
      },
      raw: m,
    };
  });
  const versions = list.map(x => x.version).filter(v => typeof v === 'number');
  return {
    hasMore: !!page.hasMore,
    nextCursor: versions.length ? Math.min(...versions) : null,
    messages: list.sort((a, b) => a.version - b.version),
  };
}

/** 从游标开始向后拉（增量） */
async function fetchSince(sessionId, sinceVersion, { maxPages = 5, pageSize = cfg.msgPageSize } = {}) {
  const got = [];
  let cursor = sinceVersion || 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await getMessages(sessionId, { count: pageSize, cursor });
    const norm = normalizeMessages(page, cfg.accountId);
    // message.sync 从新往旧翻：保留 > since 的
    const fresh = norm.messages.filter(m => !sinceVersion || m.version > sinceVersion);
    got.push(...fresh);
    if (!page.hasMore || !norm.messages.length) break;
    if (!fresh.length) break;                     // 已追平
    cursor = norm.nextCursor;
    if (!cursor) break;
  }
  const uniq = new Map();
  for (const m of got) uniq.set(m.messageId || `${m.version}`, m);
  return [...uniq.values()].sort((a, b) => a.version - b.version);
}

// ---------------------------------------------------------------- 发送
function newUuid(sessionId) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return md5(s + sessionId + Date.now());
}

async function sendContent(sessionId, content) {
  // mtop 的 message.send 在这个 appKey 下不存在（FAIL_SYS_API_NOT_FOUNDED），
  // 统一走 IMPaaS LWP（网页版同一条链路），content 用 101 custom 包装。
  const info = await impaasConvInfo(sessionId);
  return impaasSendContent(sessionId, content, info);
}

const sendText = (sessionId, text) => sendContent(sessionId, { contentType: 1, text: { text } });

const sendImage = (sessionId, url, width, height) => sendContent(sessionId, {
  contentType: 2,
  image: { pics: [{ url, width: width || 0, height: height || 0, type: 0 }], summary: '' },
});

const sendItemCard = (sessionId, item, itemTip = '我想要') => sendContent(sessionId, {
  contentType: 7,
  itemCard: { item, itemTip },
});

/** 图片上传（multipart，字段名 file） */
async function uploadFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const boundary = '----xy' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n', 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buf, tail]);
  const res = await httpsRequest({
    host: 'stream-upload.goofish.com',
    method: 'POST',
    path: '/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      'Accept-Encoding': 'identity',
      Cookie: require('../lib/mtop').getJar
        ? Object.entries(require('../lib/mtop').getJar()).map(([k, v]) => `${k}=${v}`).join('; ')
        : '',
    },
    body,
  });
  const json = JSON.parse(res.text);
  const obj = json.object || {};
  const pix = String(obj.pix || '').split('x').map(Number);
  return { url: obj.url, width: pix[0] || 0, height: pix[1] || 0, raw: json };
}

// ---------------------------------------------------------------- 文件下载
/**
 * 文件消息的 OSS 临时凭证。
 * 逆向自闲管家渲染层 8261.*.js：getFileOssToken(sessionId, sessionType)
 *   → mtop.taobao.idlemessage.file.token.v1 {sessionId, sessionType}
 * 返回 {accessKeyId, accessKeySecret, securityToken, expiration}
 */
const fileToken = (sessionId, sessionType = 1) =>
  call('mtop.taobao.idlemessage.file.token.v1', '1.0', {
    sessionId: Number(sessionId),
    sessionType: Number(sessionType) || 1,
  });

/** 一次拿齐：凭证 + 直链（链接 15 分钟有效） */
async function fileLink(sessionId, fileKey, sessionType = 1, expires = 900) {
  const creds = await fileToken(sessionId, sessionType);
  const { url, expiresAt } = require('../lib/oss').signedUrl(creds, fileKey, expires);
  return { url, expiresAt, creds: { expiration: creds.expiration } };
}

// ---------------------------------------------------------------- 只读业务
const clearSystemUnread = sessionId =>
  call('mtop.taobao.idlemessage.pc.systems.unread.clean', '1.0', { sessionId: String(sessionId) });

const me = () => call('mtop.idle.web.user.page.nav', '1.0', {});

const userDetail = userId => call('mtop.idle.web.user.page.head', '1.0', { userId: String(userId), self: 'false' });

/**
 * 客户昵称/头像/城市 —— user.page.head 的响应是多层嵌套，这里收敛成扁平结构。
 * 实测结构：{ baseInfo:{kcUserId}, module:{ base:{ displayName, avatar:{avatar}, ipLocation }, social:{...} } }
 */
async function userHead(userId) {
  const raw = await userDetail(userId);
  const mod = raw.module || {};
  const base = mod.base || {};
  const info = raw.baseInfo || {};
  const nick = base.displayName || base.nick || '';
  const avatar = (base.avatar && (base.avatar.avatar || base.avatar.url)) || '';
  return {
    userId: String(userId),
    nick,
    avatar,
    city: base.ipLocation || '',
    kcUserId: info.kcUserId || '',
    raw,
  };
}

/**
 * 会话里的「对方」资料 —— 网页版 /im 就是这么拿头像的（一次并发 8 个，不触发风控）。
 * api=mtop.taobao.idlemessage.pc.user.query  v=4.0
 * data={ type:0, sessionType:1, sessionId, isOwner:false }
 * 回 { userInfo:{ fishNick, logo, nick(打码), type } }
 */
async function sessionUser(sessionId, sessionType = 1) {
  const r = await call('mtop.taobao.idlemessage.pc.user.query', '4.0', {
    type: 0,
    sessionType: Number(sessionType) || 1,
    sessionId: String(sessionId),
    isOwner: false,
  });
  const u = (r && r.userInfo) || {};
  return {
    userId: String(u.userId || u.userid || '') || '',
    nick: u.fishNick || '',
    avatar: u.logo || '',
    masked: u.nick || '',
    raw: r,
  };
}

// ---------------------------------------------------------------- IMPaaS（双向消息通道）
// mtop 的 message.sync 对很多会话只回「我发出去的」那部分，客户回的消息拿不到。
// 网页版 /im 的聊天记录走 DingTalk IMPaaS 的 LWP（/r/MessageManager/listUserMessages），双向齐全。
const { ImpaasClient, APP_KEY: IM_APP_KEY } = require('../lib/impaas');

let _imClient = null;
let _imTokenAt = 0;

/**
 * 设备号：<UUID>-<unb>（IMPaaS 用来标识设备）。
 * 关键事实（实测）：**IM 的频率限制（400600001 The request has been flow controled）
 * 是按设备号记的**。同一个 did 被限流后，换一个新 did 立刻就好了 —— 所以这里
 * 既不写死也不每次随机：落盘在 data/did-<unb>.txt 里复用，被限流时由
 * rotateDeviceId() 换一个新的并重建连接。
 */
function didFile() {
  const id = String(selfUnb() || cfg.accountId || '0');
  return path.join(cfg.dataDir || path.join(__dirname, '..', '..', 'data'), `did-${id}.txt`);
}

function newDid() {
  const id = String(selfUnb() || cfg.accountId || '0');
  const rnd = crypto.randomBytes(16).toString('hex');
  const u = `${rnd.slice(0, 8)}-${rnd.slice(8, 12)}-4${rnd.slice(13, 16)}-a${rnd.slice(17, 20)}-${rnd.slice(20, 32)}`;
  return `${u}-${id}`;
}

function imDeviceId() {
  if (process.env.XY_DID) return process.env.XY_DID;
  const f = didFile();
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (v && v.length > 20) return v;
  } catch (_) {
    /* 没文件就生成 */
  }
  const did = newDid();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, did);
  } catch (_) {
    /* 写不了就只用内存里的 */
  }
  return did;
}

/** 被限流时换设备号：删掉落盘的 did、断掉旧连接，下一次 impaas() 就是新身份 */
function rotateDeviceId() {
  if (process.env.XY_DID) return false; // 外部指定的不动
  try {
    fs.rmSync(didFile(), { force: true });
  } catch (_) {
    /* 忽略 */
  }
  if (_imClient) {
    try {
      _imClient.close();
    } catch (_) {
      /* 忽略 */
    }
    _imClient = null;
  }
  return true;
}

/** 取（并复用）IMPaaS 连接：先换 oauth token，再 /reg 注册 */
async function impaas({ force = false } = {}) {
  if (!force && _imClient && _imClient.connected) return _imClient;
  if (_imClient) { try { _imClient.close(); } catch (_) {} _imClient = null; }

  const did = imDeviceId();
  // 直接 require 会拿到同一个 jar；没初始化 Cookie 时先自动装一份
  const mtopLib = require('../lib/mtop');
  if (!Object.keys(mtopLib.getJar() || {}).length) mtopLib.initCookie();
  const tok = await call('mtop.taobao.idlemessage.pc.login.token', '1.0', { appKey: IM_APP_KEY, deviceId: did });
  if (!tok || !tok.accessToken) throw new Error('拿不到 IMPaaS token（login.token 无 accessToken）');
  _imTokenAt = Date.now();

  const cli = new ImpaasClient({ token: tok.accessToken, did });
  cli.on('close', () => { if (_imClient === cli) _imClient = null; });
  await cli.connect();
  await cli.register();
  _imClient = cli;
  return cli;
}

/**
 * IMPaaS 长连接空闲会被服务端踢，请求可能正好撞上。
 * 统一在这里做一次「重连 + 重试」，调用方不用管。
 */
async function withImpaas(fn) {
  try {
    return await fn(await impaas());
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (!/连接已关闭|未连接|LWP 超时|socket hang up|ECONNRESET/i.test(msg)) throw e;
    return await fn(await impaas({ force: true }));
  }
}

/** 自己的 unb（判断消息方向用）。以 Cookie 里的 unb 为准，避开 cfg.accountId 可能是店铺/卖家 id 的坑。 */let _selfUnb = '';
function selfUnb() {
  if (_selfUnb) return _selfUnb;
  const { unbFromCookie, loadCookie } = require('../config');
  let unb = '';
  try { unb = unbFromCookie(loadCookie()) || ''; } catch (_) {}
  _selfUnb = String(unb || cfg.accountId || '');
  return _selfUnb;
}

/** IMPaaS 单条 → 本项目的消息结构（方向用 senderId 与自己的 unb 直接比，不会打码） */
function normalizeImpaas(list) {
  const selfId = selfUnb();
  return list.map(m => ({
    messageId: m.id || m.messageId,
    version: m.ts,
    ts: m.ts,
    contentType: m.contentType,
    content: m.content,
    text: m.text,
    senderId: m.senderId,
    senderName: m.senderName || '',
    fromSelf: String(m.senderId) === selfId,
    sessionId: m.sid,
    raw: m.raw,
  }));
}

/** 拉某会话最近 want 条（双向）；cursor 从最新往前翻 */
async function impaasMessages(sessionId, { want = cfg.msgPageSize, maxPages = 6 } = {}) {
  const got = await withImpaas(cli => cli.listMessagesDeep(sessionId, want, maxPages));
  return normalizeImpaas(got);
}

/**
 * 增量：只要 ts > sinceTs 的（IMPaaS 用时间戳做游标）。
 *
 * 省流量 + 不漏消息的关键：
 *   1. 每页只请求 pageSize 条（默认 5），空闲会话就是 5 条的成本；
 *   2. 若这一页里最老的一条**仍然比 sinceTs 新**，说明中间还有没拉到的消息，
 *      就继续用 nextCursor 往前翻，直到接上旧游标或翻满 maxPages。
 *   这样「客户一口气发 20 条」也只是多翻几页，不会只拿到最新的 5 条。
 */
async function fetchSinceImpaas(sessionId, sinceTs = 0, { maxPages = 12, pageSize = cfg.msgPageSize || 5 } = {}) {
  const CURSOR_MAX = 9007199254740991;
  const limit = Math.max(1, Math.min(50, Number(pageSize) || 5));
  const pagesLimit = Math.max(1, Math.min(30, Number(maxPages) || 12));
  const collected = await withImpaas(async (cli) => {
    let cursor = CURSOR_MAX;
    const out = [];
    for (let i = 0; i < pagesLimit; i++) {
      const { nextCursor, messages } = await cli.listMessages(sessionId, cursor, limit);
      if (!messages || !messages.length) break;
      out.push(...messages);
      const oldest = messages.reduce((min, m) => Math.min(min, Number(m.ts) || 0), Number.MAX_SAFE_INTEGER);
      if (sinceTs > 0 && oldest <= sinceTs) break; // 已接上旧游标，更早的都是已入库的
      if (!nextCursor || nextCursor >= cursor) break; // 没有更多历史
      cursor = nextCursor;
    }
    return out;
  });
  const norm = normalizeImpaas(collected);
  return norm.filter(m => !sinceTs || m.ts > sinceTs).sort((a, b) => a.ts - b.ts);
}

/**
 * 用 IMPaaS 的 LWP 发消息（网页版 /im 走的就是这条）。
 * 关键：content 必须是 contentType:101 的 custom 包装，data 是 base64(JSON(内层 content))；
 * 直接发 contentType:1 会被服务端回 500 "callback sys error"。
 * @param {string} sessionId
 * @param {object} content 内层 content，如 {contentType:1,text:{text:'你好'}}
 * @param {{sessionType?:number, peerId?:string}} opt
 */
async function impaasSendContent(sessionId, content, { sessionType = 1, peerId = '' } = {}) {
  const sid = String(sessionId).split('@')[0];
  const uuid = '-' + Date.now() + Math.floor(Math.random() * 900 + 100);
  const inner = Buffer.from(JSON.stringify(content), 'utf8').toString('base64');
  const receivers = [];
  if (peerId) receivers.push(`${String(peerId).split('@')[0]}@goofish`);
  if (cfg.dryRun) return { ok: true, dryRun: true, uuid, content };

  const primary = Number(sessionType) === 1 ? 1 : 2;
  // 会话类型猜错时服务端只回一句 "conversation not exist"，所以两种都试一遍
  const order = primary === 1 ? [1, 2] : [2, 1];
  let lastErr = null;
  for (const ct of order) {
    const model = {
      uuid,
      cid: `${sid}@goofish`,
      conversationType: ct,
      content: { contentType: 101, custom: { data: inner } },
      redPointPolicy: 1,
      extension: {},
      ctx: {},
      mtags: {},
      msgReadStatusSetting: 1,
    };
    await throttle();
    let res;
    try {
      res = await withImpaas(cli => cli.request('/r/MessageSend/sendByReceiverScope', [model, { actualReceivers: receivers }]));
    } catch (e) {
      lastErr = e;
      if (/连接已关闭|未连接|LWP 超时/i.test(String(e.message))) continue;
      throw e;
    }
    const body = res.body || {};
    if (res.code === 200 && body.messageId) {
      // 本地落库要和「拉回来的消息」用同一个 id，否则同一条会显示两次：
      // 拉回来的是 extJson 里的 messageId（hash），不是这里的 PNM 号。
      let localId = '';
      try {
        const ext = JSON.parse((body.extension && body.extension.extJson) || '{}');
        localId = ext.messageId || '';
      } catch (_) {}
      return {
        ok: true,
        uuid,
        localId: localId || uuid,
        messageId: body.messageId,
        createAt: body.createAt,
        sessionType: (body.extension && body.extension.sessionType) || String(sessionType),
        conversationType: ct,
        raw: body,
      };
    }
    const err = new Error('发送失败: ' + (body.reason || body.developerMessage || res.code));
    err.kind = /USER_VALIDATE|RISK|风控/.test(JSON.stringify(body)) ? 'RISK' : 'BIZ';
    err.raw = body;
    lastErr = err;
    const reason = String(body.reason || body.developerMessage || '');
    if (!/conversation not exist|conversation.*not/i.test(reason)) throw err;
  }
  throw lastErr || new Error('发送失败');
}

/** 文本消息（IMPaaS） */
const sendTextImpaas = (sessionId, text, opt) => impaasSendContent(sessionId, { contentType: 1, text: { text } }, opt);

/** 会话类型/对端：发送前查一次，避免把单聊当群聊发 *//** 会话类型/对端：发送前查一次，避免把单聊当群聊发 */
async function impaasConvInfo(sessionId) {
  const sid = String(sessionId).split('@')[0];
  try {
    const { convs } = await impaasConversations(100);
    const c = convs.find(x => String(x.sid) === sid);
    if (c) return { sessionType: c.sessionType || 1, peerId: c.peerId || '' };
  } catch (_) {}
  // 不在前 100 条里：按 cid 直接问一次（群聊/通知会话经常落在后面）
  try {
    const { parseConv } = require('../lib/impaas');
    const r = await withImpaas(cli => cli.request('/r/Conversation/getByCids', [[`${sid}@goofish`]]));
    const body = (r && r.body) || {};
    const arr = body.userConvs || body.convs || body.data || [];
    if (Array.isArray(arr) && arr.length) {
      const c = parseConv(arr[0], { self: selfUnb() });
      return { sessionType: c.sessionType || 1, peerId: c.peerId || '' };
    }
  } catch (_) {}
  return { sessionType: 1, peerId: '' };
}

/**
 * 把会话标为已读（服务端已读回执，尽力而为）。
 * LWP `/r/MessageStatus/read` 的 body 必须是 [[messageId...]]（嵌套数组），
 * 且只认 hash 形式 messageId（`<数字>.PNM` 会被当成空）。
 */
async function impaasMarkRead(sessionId) {
  const sid = String(sessionId).split('@')[0];
  const ids = [];
  try {
    const rows = require('../lib/store').listMessages(sid, 10);
    for (const r of rows) {
      const id = String(r.id || '');
      if (!id || /^\d+\.PNM$/.test(id)) continue;
      ids.push(id);
      if (ids.length >= 5) break;
    }
  } catch (_) {}
  if (!ids.length) return { ok: false, reason: 'no message id' };
  try {
    const r = await withImpaas(cli => cli.request('/r/MessageStatus/read', [ids]));
    return { ok: r.code === 200, code: r.code, ids, body: r.body };
  } catch (e) {
    return { ok: false, reason: e.message, ids };
  }
}
/** 会话列表（IMPaaS 版，带正确的最后一条消息与未读数） */async function impaasConversations(limit = 50) {
  const { convs, nextCursor, hasMore } = await withImpaas(cli => cli.listConversations(limit, undefined, selfUnb()));
  return { convs, nextCursor, hasMore };
}

/**
 * 官方会话列表（这才是网页版/App 里客户列表的真实来源与真实顺序）。
 * 置顶会话在前（listTop 的顺序），其余按最后一条消息时间倒序（服务端已排好）。
 * @returns {Promise<{list: Array, pages: number, hasMore: boolean}>}
 */
async function impaasSessions({ pages = 8, pageSize = 50, withTop = true } = {}) {
  return withImpaas(async (cli) => {
  const out = [];
  const seen = new Set();

  if (withTop) {
    // 限流时 listTop 也会失败，不能吞掉（否则只剩「看起来没有置顶会话」）
    const top = await cli.listTop(2000, selfUnb());
    for (const c of top.convs) {
      if (!c.sid || seen.has(c.sid)) continue;
      seen.add(c.sid);
      out.push({ ...c, pinned: true, pinRank: c.pinRank == null ? out.length : c.pinRank });
    }
  }

  let cursor = 9007199254740991;
  let fetched = 0;
  let hasMore = false;
  for (let i = 0; i < pages; i++) {
    const r = await cli.listConversations(pageSize, cursor, selfUnb());
    for (const c of r.convs) {
      if (!c.sid || seen.has(c.sid)) continue;
      seen.add(c.sid);
      out.push({ ...c, pinned: false, pinRank: null });
    }
    fetched++;
    hasMore = !!r.hasMore;
    if (!r.hasMore || !r.nextCursor || r.nextCursor >= cursor) break;
    cursor = r.nextCursor;
  }
  return { list: out, pages: fetched, hasMore };
  });
}

/** 只要排序快照（{sid, ts, pinned, pinRank}）时用它，比 impaasSessions 轻 */
async function impaasOrder({ pages = 4, pageSize = 50 } = {}) {
  const { list, hasMore } = await impaasSessions({ pages, pageSize });
  return {
    list: list.map(c => ({ sid: c.sid, ts: c.ts, pinned: c.pinned, pinRank: c.pinRank })),
    topCount: list.filter(c => c.pinned).length,
    scanned: list.length,
    hasMore,
  };
}

/** 把官方会话列表（含置顶/顺序/最后一条消息/未读）写进 sessions 表 */
async function syncOfficialSessions(store, { pages = 8, pageSize = 50 } = {}) {
  const { list, hasMore } = await impaasSessions({ pages, pageSize });
  const n = store.saveImpaasSessions
    ? store.saveImpaasSessions(list, { self: selfUnb() })
    : 0;
  return { saved: n, scanned: list.length, hasMore, topCount: list.filter(c => c.pinned).length };
}

/* ---------------- 官方排序（客服列表） ---------------- */

/** 按官方顺序写回 sessions.order_ts / pinned / pin_rank */
async function refreshOfficialOrder(store, opts) {
  const { list, topCount } = await impaasOrder(opts);
  const n = store.saveOrdering ? store.saveOrdering(list) : 0;
  return { updated: n, topCount, scanned: list.length };
}

function closeImpaas() {
  if (_imClient) { try { _imClient.close(); } catch (_) {} _imClient = null; }
}

const orderBrief = orderIds => call('mtop.taobao.idle.trade.sold.get', '6.0', { orderIds });

// 商品详情：版本号包内未确认，报错时按网页端抓包替换
const itemDetail = itemId => call('mtop.taobao.idle.pc.detail', '1.0', { itemId: String(itemId) });

/* ---------------------------------------------------------------- 买家订单
   订单号不在会话/消息的 JSON 字段里，而是藏在消息卡片（dxCard）的跳转 URL 上：
     fleamarket://order_detail?id=<订单号>
     https://h5.m.goofish.com/wow/.../tradeExperience?...&orderId=<订单号>
   所以按 session 从库里的 messages.raw 正则捞订单号，再喂给 sold.get 拿详情。 */
const ORDER_RE = /(?:[?&]orderId=|order_detail\?id=|"orderIdStr"\s*:\s*")(\d{15,22})/g;

function orderIdsFromMessages(store, sessionId, limit = 5) {
  if (!store || !store.db || !sessionId) return [];
  const rows = store.db
    .prepare('SELECT raw FROM messages WHERE session_id=? AND raw LIKE ? ORDER BY ts DESC LIMIT 60')
    .all(String(sessionId), '%order%');
  const out = [];
  for (const r of rows) {
    ORDER_RE.lastIndex = 0;
    let m;
    while ((m = ORDER_RE.exec(String(r.raw || '')))) {
      if (!out.includes(m[1])) out.push(m[1]);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** sold.get 一次只认一个 orderId（传数组/逗号串都会 FAIL），这里串行+限速 */
async function ordersDetail(ids, { gap = 400 } = {}) {
  const list = [];
  for (const id of ids) {
    try {
      const r = await orderBrief(String(id));
      const it = (r.items || [])[0];
      if (it) list.push(normalizeOrder(it, String(id)));
    } catch (e) {
      list.push({ orderId: String(id), error: e.message });
    }
    if (gap) await new Promise(res => setTimeout(res, gap));
  }
  return list;
}

/**
 * 某个买家在本店的全部订单（这就是闲管家「客户信息 → 买家订单」真正的数据源）。
 * 同一个 sold.get 接口，换成 {sellerId, peerUserId, pageSize, pageNum} 就变成了列表查询。
 * 注意：分页参数实测无效（pageNum/start/startRow/lastEndRow 都返回同一批），服务端固定回最近 10 条。
 */
async function ordersByBuyer(peerUserId, { sellerId = '', pageSize = 10, pageNum = 1 } = {}) {
  const sid = sellerId || selfUnb();
  const r = await call('mtop.taobao.idle.trade.sold.get', '6.0', {
    sellerId: String(sid), peerUserId: String(peerUserId), pageSize: String(pageSize), pageNum: String(pageNum),
  });
  const items = r.items || [];
  return items.map(it => normalizeOrder(it, (it.commonData || {}).orderIdStr)).filter(o => o.orderId);
}

/** 把某买家的订单批量落到 orders 表（面板读库即可，避免每次打开都打接口） */
async function syncBuyerOrders(store, sessionId, peerUserId, { pageSize = 10 } = {}) {
  const list = await ordersByBuyer(peerUserId, { pageSize });
  let saved = 0;
  for (const o of list) {
    if (!o || !o.orderId) continue;
    // 注意：sold.get 的 peerUserId 参数其实被服务端忽略，返回的是全店最近 N 单，
    // 所以归属必须以每条订单自己的 buyer.userId 为准，不能信入参。
    const buyerId = (o.buyer && o.buyer.userId) || peerUserId;
    const srow = store.findSessionByPeer ? store.findSessionByPeer(buyerId) : null;
    store.saveOrder({ ...o, sessionId: (srow && srow.id) || String(sessionId) });
    saved++;
  }
  return { saved, count: list.length, orders: list };
}

/**
 * 拉「本店最近 N 单」并按每条订单的 buyer 归到对应会话。
 * 这是闲管家客户面板里买家订单的真正来源：sold.get v6.0 只传 {sellerId, pageSize}，
 * 服务端固定回最近 10 条（peerUserId / pageNum / start 等参数都会被忽略）。
 */
async function syncRecentOrders(store, { pageSize = 10 } = {}) {
  const list = await ordersByBuyer('', { pageSize });
  let saved = 0;
  for (const o of list) {
    if (!o || !o.orderId) continue;
    const buyerId = (o.buyer && o.buyer.userId) || '';
    const srow = buyerId && store.findSessionByPeer ? store.findSessionByPeer(buyerId) : null;
    store.saveOrder({ ...o, sessionId: (srow && srow.id) || null });
    saved++;
  }
  return { saved, count: list.length };
}

function normalizeOrder(it, fallbackId) {
  const cd = it.commonData || {};
  const head = (it.head && it.head.data) || {};
  const tail = (it.tail && it.tail.data) || {};
  const d = (it.content && it.content.data) || {};
  const detail = d.detailInfo || {};
  const price = d.priceInfo || {};
  const buyer = head.userInfo || {};
  return {
    orderId: cd.orderIdStr || String(cd.orderId || fallbackId),
    status: cd.tradeStatusEnum || '',
    statusText: head.statusViewMsg || '',
    createTime: head.createTime || '',
    itemId: String(cd.itemId || ''),
    title: detail.auctionTitle || '',
    pic: detail.auctionPic || '',
    sku: detail.skuInfo || '',
    amount: price.buyAmount == null ? null : Number(price.buyAmount),
    priceLabel: price.auctionPriceDesc || '',
    price: price.price || '',
    tags: (detail.orderTags || []).map(t => t.text).filter(Boolean),
    buyer: { userId: String(buyer.userId || cd.peerUserId || ''), nick: buyer.userNick || '', avatar: buyer.userIcon || '' },
    actions: (tail.btnList || []).map(b => ({
      name: b.name || b.tradeAction || '',
      action: b.tradeAction || '',
      // 平台自己的深链（fleamarket://…）：Web 里点不动，只能复制到 App 打开
      url: (b.clickEvent && b.clickEvent.data && b.clickEvent.data.url) || '',
      disabled: !!b.buttonDisable,
    })).filter(a => a.name),
  };
}

/**
 * 无需物流/无需寄件发货：直接把订单推进到 buyer_to_confirm（等待见面交易）。
 * 实测：mtop.taobao.idle.logistic.consign.dummy v1.0 只认 { orderId }，
 * 已发货的单会返回 ORDER_ALREADY_DELIVERY::已发货成功，请刷新页面~
 */
async function consignDummy(orderId) {
  const id = String(orderId || '').trim();
  if (!/^\d{10,25}$/.test(id)) throw new Error('orderId 不合法: ' + id);
  if (cfg.dryRun) return { dryRun: true, orderId: id };
  const r = await call('mtop.taobao.idle.logistic.consign.dummy', '1.0', { orderId: id });
  return { ok: true, orderId: id, raw: r };
}

module.exports = {
  getSessions, normalizeSessions, getAllSessions,
  getMessages, normalizeMessages, fetchSince, renderText,
  sendContent, sendText, sendImage, sendItemCard, uploadFile,
  clearSystemUnread, me, userDetail, userHead, sessionUser, orderBrief, itemDetail, newUuid,
  // 买家订单（会话维度）
  orderIdsFromMessages, ordersDetail, normalizeOrder, consignDummy, ordersByBuyer, syncBuyerOrders, syncRecentOrders,
  // IMPaaS（双向消息）
  impaas, impaasMessages, fetchSinceImpaas, impaasConversations, normalizeImpaas,
  closeImpaas, imDeviceId, rotateDeviceId, selfUnb, impaasSendContent, sendTextImpaas, impaasConvInfo, impaasMarkRead,
  // 官方排序
  impaasOrder, refreshOfficialOrder, impaasSessions, syncOfficialSessions,
  // 文件下载
  fileToken, fileLink,
};
