'use strict';
/**
 * IMPaaS 客户端（闲鱼网页版 /im 真正在用的消息通道）
 *
 * 与 mtop 的 message.sync 不同，这个通道能拿到**双向**聊天记录：
 *   - 握手：wss://wss-goofish.dingtalk.com/  发送 /reg（app-key + oauth_k1 token + did）
 *   - 拉历史：/r/MessageManager/listUserMessages  body = [cid, false, cursor, limit, false]
 *   - 会话列表：/r/Conversation/listNewestPagination body = [maxRank, limit]
 * 证据：data/im-hist2.json（从 www.goofish.com/im 页面抓的真实帧）
 */
const { looksLikeName } = require('./names');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const IMPAAS_HOST = 'wss-goofish.dingtalk.com';
const APP_KEY = '444e9908a51d1cb236a27862abc769c9';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/156.0.0.0 Safari/537.36 DingTalk(2.2.0) OS(Windows/10) Browser(Chrome/156.0.0.0) ' +
  'DingWeb/2.2.0 IMPaaS DingWeb/2.2.0';
const MAX_CURSOR = 9007199254740991;

/* ---------------- WebSocket 底层（客户端帧需掩码） ---------------- */

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** 服务端帧解析：文本/二进制/分片/ping/pong/close */
function createParser(onFrame) {
  let buf = Buffer.alloc(0);
  let frag = [];
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const m = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]));
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x9) { onFrame({ op: 'ping', payload }); continue; }
      if (opcode === 0xa) { onFrame({ op: 'pong', payload }); continue; }
      if (opcode === 0x8) { onFrame({ op: 'close', payload }); continue; }
      if (opcode === 0x1 || opcode === 0x2) {
        frag = [];
        if (fin) onFrame({ op: 'text', payload });
        else frag = [payload];
        continue;
      }
      if (opcode === 0x0) {
        frag.push(payload);
        if (fin) { onFrame({ op: 'text', payload: Buffer.concat(frag) }); frag = []; }
      }
    }
  };
}

/* ---------------- IMPaaS 主体 ---------------- */

class ImpaasClient extends EventEmitter {
  constructor({ token, did, ua = UA, host = IMPAAS_HOST }) {
    super();
    this.token = token;            // oauth_k1:...
    this.did = did;                // <uuid>-<unb>
    this.ua = ua;
    this.host = host;
    this.socket = null;
    this.connected = false;
    this.seq = 1;
    this.pending = new Map();      // mid -> {resolve, reject, timer}
    this.closedByUser = false;
  }

  mid() {
    const n = Date.now() * 100 + (this.seq++ % 100);
    return `${n} ${this.seq}`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req =
        `GET / HTTP/1.1\r\nHost: ${this.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Origin: https://www.goofish.com\r\nUser-Agent: ${this.ua}\r\n\r\n`;

      const sock = tls.connect({ host: this.host, port: 443, servername: this.host }, () => sock.write(req));
      this.socket = sock;
      let handshook = false;
      let head = Buffer.alloc(0);
      const parser = createParser(frame => this._onFrame(frame));

      sock.setTimeout(120000, () => {});
      sock.on('data', chunk => {
        if (handshook) return parser(chunk);
        head = Buffer.concat([head, chunk]);
        const idx = head.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const text = head.subarray(0, idx).toString('utf8');
        if (!/^HTTP\/1\.1 101/.test(text)) {
          sock.destroy();
          return reject(new Error('WS 握手失败: ' + text.split('\r\n')[0]));
        }
        handshook = true;
        this.connected = true;
        this._startKeepalive();
        const rest = head.subarray(idx + 4);
        if (rest.length) parser(rest);
        resolve();
      });
      sock.on('error', e => { this.emit('error', e); if (!handshook) reject(e); });
      sock.on('close', () => {
        this.connected = false;
        this._stopKeepalive();
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('连接已关闭')); }
        this.pending.clear();
        this.emit('close');
      });
    });
  }

  _onFrame(frame) {
    if (frame.op === 'ping') { this._raw(0xa, frame.payload); return; }
    if (frame.op === 'close') { this.emit('close'); try { this.socket.end(); } catch {} return; }
    if (frame.op !== 'text') return;
    const text = frame.payload.toString('utf8');
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    // 请求回包：带 headers.mid 且没有 lwp
    const mid = msg.headers && msg.headers.mid;
    if (mid && this.pending.has(mid)) {
      const p = this.pending.get(mid);
      clearTimeout(p.timer);
      this.pending.delete(mid);
      p.resolve(msg);
      return;
    }
    this.emit('push', msg);   // /s/sync、/s/vulcan 等服务端推送
  }

  _raw(opcode, payload) {
    if (this.connected) this.socket.write(encodeFrame(opcode, payload));
  }

  /** 心跳：IMPaaS 空闲 1~2 分钟就会踢连接，25s 一个 WS ping 保活 */
  _startKeepalive() {
    this._stopKeepalive();
    this._ka = setInterval(() => {
      if (!this.connected) return;
      try { this._raw(0x9, Buffer.from('ka')); } catch (_) {}
    }, 25000);
    if (this._ka.unref) this._ka.unref();
  }

  _stopKeepalive() {
    if (this._ka) { clearInterval(this._ka); this._ka = null; }
  }

  /** 连接是否还能用（api.impaas() 用它决定要不要重建） */
  isOpen() { return !!(this.connected && this.socket && !this.socket.destroyed && !this.closedByUser); }

  send(obj) {
    if (!this.connected) throw new Error('IMPAAS 未连接');
    this.socket.write(encodeFrame(0x1, JSON.stringify(obj)));
  }

  /** 发一条 LWP 请求并等回包 */
  request(lwp, body, headers = {}, timeoutMs = 20000) {
    const mid = this.mid();
    const frame = { lwp, headers: Object.assign({ mid }, headers) };
    if (body !== undefined) frame.body = body;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(mid);
        reject(new Error(`LWP 超时: ${lwp}`));
      }, timeoutMs);
      this.pending.set(mid, { resolve, reject, timer });
      this.send(frame);
    });
  }

  /** /reg 注册（拿到 200 才算握手成功） */
  async register() {
    const mid = this.mid();
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(mid); reject(new Error('/reg 超时')); }, 20000);
      this.pending.set(mid, { resolve, reject, timer });
      this.send({
        lwp: '/reg',
        headers: {
          'cache-header': 'app-key token ua wv',
          'app-key': APP_KEY,
          token: this.token,
          ua: this.ua,
          dt: 'j',
          wv: 'im:3,au:3,sy:6',
          sync: '0,0;0;0;',
          did: this.did,
          mid,
        },
      });
    });
    if (res.code !== 200) throw new Error('/reg 失败: ' + JSON.stringify(res).slice(0, 200));
    this.emit('registered', res.body || {});
    return res.body || {};
  }

  /* ---------------- 业务 API ---------------- */

  /**
   * LWP 的失败不会抛异常，而是把 {code, reason} 放在回包里（会话列表被限流时
   * code=400600001 reason="The request has been flow controled"，body 里没有 userConvs）。
   * 以前这里直接 body.userConvs || []，限流就变成一个「空列表」被当成真的没有会话 ——
   * 结果新会话永远进不来、顺序也不刷新，但表面看一切正常。所以统一在解析前判掉。
   */
  _assertBodyOk(res, lwp) {
    const body = (res && res.body) || {};
    const code = Number(body.code || res.code || 0);
    const bad = (code && code !== 200) || body.reason || body.developerMessage;
    if (bad) {
      const err = new Error(`${lwp} 失败 ${code || ''} ${body.reason || body.developerMessage || ''}`.trim());
      err.ret = `${code}:${body.reason || body.developerMessage || ''}`;
      err.flow = /flow|限流|400600001/i.test(err.ret);
      throw err;
    }
    return body;
  }

  /** 会话列表（最近 N 条）。返回 {nextCursor, convs:[{cid, title, text, ts, unread, pinned}]} */
  async listConversations(limit = 50, cursor = MAX_CURSOR, self = '') {
    const res = await this.request('/r/Conversation/listNewestPagination', [cursor, limit], {}, 30000);
    const body = this._assertBodyOk(res, 'listNewestPagination');
    const convs = (body.userConvs || []).map(u => parseConv(u, { self }));
    return { nextCursor: body.nextCursor, hasMore: !!body.hasMore, convs };
  }

  /** 置顶会话（官方把置顶排在最前，顺序即返回顺序） */
  async listTop(maxCount = 2000, self = '') {
    const res = await this.request('/r/Conversation/listTop', [{ topRank: MAX_CURSOR, maxCount }], {}, 30000);
    const body = this._assertBodyOk(res, 'listTop');
    const convs = (body.userConvs || []).map((u, i) => parseConv(u, { pinned: true, rank: i, self }));
    return { nextCursor: body.nextCursor, hasMore: !!body.hasMore, convs };
  }

  /**
   * 拉一页聊天记录。
   * @param {string} sid  会话 id（纯数字，不含 @goofish）
   * @param {number} cursor 时间戳游标，首页传 MAX_CURSOR，下一页用上次返回的 nextCursor
   */
  async listMessages(sid, cursor = MAX_CURSOR, limit = 20) {
    const cid = String(sid).includes('@') ? String(sid) : `${sid}@goofish`;
    const res = await this.request('/r/MessageManager/listUserMessages', [cid, false, cursor, limit, false], {}, 30000);
    const body = res.body || {};
    const list = (body.userMessageModels || []).map(parseMessage).filter(Boolean);
    return { nextCursor: body.nextCursor, messages: list, raw: body };
  }

  /**
   * 从最新往前翻到指定条数（maxPages 保护）
   * @param {number} want 总共想要的条数
   * @param {number} maxPages 最多翻几页
   * @param {number} pageLimit 每页请求多少条（页大小越小越省流量）
   */
  async listMessagesDeep(sid, want = 50, maxPages = 20, pageLimit = 20) {
    const limit = Math.max(1, Math.min(50, Number(pageLimit) || 20));
    let cursor = MAX_CURSOR;
    let out = [];
    for (let i = 0; i < maxPages; i++) {
      const { nextCursor, messages } = await this.listMessages(sid, cursor, limit);
      out = out.concat(messages);
      if (!messages.length || !nextCursor || nextCursor >= cursor) break;
      cursor = nextCursor;
      if (out.length >= want) break;
    }
    const seen = new Set();
    return out
      .filter(m => (seen.has(m.id) ? false : seen.add(m.id)))
      .sort((a, b) => a.ts - b.ts);
  }

  close() {
    this.closedByUser = true;
    try { this.socket.end(); } catch {}
  }
}

/* ---------------- 解析 ---------------- */

function b64Json(s) {
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; }
}

function parseConv(u, opts) {
  // 官方列表里单聊与群聊混排：singleChatUserConversation / groupChatUserConversation
  const single = u.singleChatUserConversation || u.singleChatConversation;
  const group = u.groupChatUserConversation;
  const c = single || group || u;
  const inner = c.groupChatConversation || c.singleChatConversation || c;
  const msg = (c.lastMessage && c.lastMessage.message) || {};
  const ext = msg.extension || {};
  const content = b64Json((msg.content && msg.content.custom && msg.content.custom.data) || '') || {};
  const text =
    (content.text && content.text.text) ||
    (msg.content && msg.content.custom && msg.content.custom.summary) ||
    ext.reminderContent || '';

  // cid：group 在 inner.cid，单聊在 reminderUrl 的 sid 参数里（对象本身不带 cid）
  let cid = msg.cid || inner.cid || c.cid || '';
  if (!cid) {
    const m = /[?&]sid=(\d+)/.exec(ext.reminderUrl || '');
    if (m) cid = m[1] + '@goofish';
  }

  // 对端 userId：单聊的 inner.pairFirst / pairSecond 才是可靠的两个人，
  // reminderUrl 里的 peerUserId 是「相对发送者」的对端 —— 我发最后一条时它就等于我自己，
  // 早期就是踩了这个坑，导致一批会话的 with_id 变成自己的号、标题变成自己的昵称。
  const self = String((opts && opts.self) || '');
  const pairFirst = String(inner.pairFirst || '').split('@')[0];
  const pairSecond = String(inner.pairSecond || '').split('@')[0];
  const pairM = /[?&]peerUserId=(\d+)/.exec(ext.reminderUrl || '');
  let peerId = '';
  if (!group) {
    if (self && (pairFirst === self || pairSecond === self)) {
      peerId = pairFirst === self ? pairSecond : pairFirst;
    } else if (pairFirst && pairSecond) {
      peerId = pairFirst; // 不知道哪个是自己时的兜底（下一步会被 customers / head 校正）
    } else if (pairM) {
      peerId = pairM[1];
    }
  }

  // 标题：群聊用 inner.title 的 {"def":"群名"}；单聊的 reminderTitle 是**发送者**昵称，
  // 只有当最后一条是对方发的才等于对端名字，否则会写成我自己的昵称。
  const senderId = String(ext.senderUserId || '').replace(/@goofish$/, '');
  let title = '';
  if (group) {
    const rawTitle = inner.title;
    if (rawTitle) {
      const t = b64Json(rawTitle) || (() => { try { return JSON.parse(rawTitle); } catch { return null; } })();
      title = (t && (t.def || t.title)) || '';
    }
    if (!title) title = ext.reminderTitle || '';
  } else if (!peerId || !senderId || senderId === peerId) {
    // 最后一条是对方发的（或对端未知）→ reminderTitle 就是对方的昵称
    title = ext.reminderTitle || '';
  }
  // 交易提醒也会被塞进 reminderTitle（「交易消息」「[记得及时发货]」），当昵称用就是错的
  if (title && !looksLikeName(title)) title = '';

  // 商品：id 在 reminderUrl / inner.extension，主图与标题在 inner.extension
  const itemM = /[?&]itemId=(\d+)/.exec(ext.reminderUrl || '');
  const ie = inner.extension || {};
  const itemId = (itemM && itemM[1]) || String(ie.itemId || '');
  const itemPic = String(ie.itemMainPic || '');
  const ownerId = String(ie.ownerUserId || ie.itemSellerId || '');
  const itemTitle = String(ie.itemTitle || (ownerId ? ie['squadName_' + ownerId] : '') || '');

  // 交易状态气泡（昵称右边那个）：会话对象上的 user_extension 是 snake_case 的
  // { redReminder: '等待卖家发货', redReminderStyle: '1' }
  // style：1=橙（等待中）、10=绿（交易成功）、11=灰（交易关闭）
  const ue = (single && single.user_extension) || c.user_extension || u.user_extension || {};
  const tradeText = String(ue.redReminder || '');

  return {
    cid,
    sid: String(cid).split('@')[0],
    peerId,
    itemId,
    itemPic,
    itemTitle,
    tradeText,
    tradeStyle: ue.redReminderStyle === undefined ? null : Number(ue.redReminderStyle),
    // 这个商品是谁在卖：等于自己 = 我发布的商品；不等于自己 = 我在买家那边问的商品
    itemSellerId: ownerId,
    title,
    text,
    ts: Number(msg.createAt || c.modifyTime || 0),
    unread: Number((c.lastMessage && c.lastMessage.unreadCount) || c.redPoint || 0),
    contentType: content.contentType || (msg.content && msg.content.contentType) || 0,
    group: !!group,
    sessionType: Number(ext.sessionType || (group ? 30 : 1)),
    pinned: !!(opts && opts.pinned),
    pinRank: opts && opts.rank != null ? Number(opts.rank) : null,
  };
}

function parseMessage(m) {
  const msg = m.message || m;
  if (!msg || !msg.cid) return null;
  const ext = msg.extension || {};
  const custom = (msg.content && msg.content.custom) || {};
  const content = b64Json(custom.data || '') || {};
  let text = (content.text && content.text.text) || custom.summary || '';
  if (!text && content.image && content.image.pics && content.image.pics[0]) text = '[图片]';
  else if (!text && content.contentType === 7) text = '[商品卡]';
  else if (!text && content.contentType) text = `[消息${content.contentType}]`;
  let extJson = null;
  try { extJson = JSON.parse(ext.extJson || 'null'); } catch {}
  return {
    id: (extJson && extJson.messageId) || msg.messageId || '',
    messageId: msg.messageId || '',
    sid: String(msg.cid).split('@')[0],
    senderId: ext.senderUserId || (msg.sender && String(msg.sender.uid || '').split('@')[0]) || '',
    senderName: ext.reminderTitle || '',
    ts: Number(msg.createAt || 0),
    contentType: content.contentType || (msg.content && msg.content.contentType) || 0,
    text,
    content,
    sessionType: Number(ext.sessionType || 1),
    raw: msg,
  };
}

module.exports = {
  ImpaasClient,
  APP_KEY,
  UA,
  MAX_CURSOR,
  IMPAAS_HOST,
  parseConv,
  parseMessage,
  b64Json,
};
