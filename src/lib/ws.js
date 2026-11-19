'use strict';
/**
 * gpush WebSocket 客户端（手写 RFC6455 客户端帧，零依赖）
 * 逆向依据：闲管家主进程 XTWebSocket 类（dump 0x59c3600）
 *
 * 下行帧：base64(JSON) → {msgId, udid, mtime, accountId, wsType, data:{pushId,pushType,serverTime,data}}
 * 上行帧：明文 JSON 字符串（心跳 {"msgId":n,"mtime":ms,"mt":100000}）
 */
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { cfg } = require('../config');
const { md5 } = require('./mtop');

const WS_AUTH_KEY = '10706ee67df2089317125f7ebe506915'; // 常量表 prod.x64
const HOST = 'ws.goofish.pro';
const PORT = 8180;

function uuid() {
  return crypto.randomUUID();
}

/** udid 规则：UUID + '-' + md5(userId).slice(0,16).toUpperCase() */
function buildUdid(userId, base) {
  const b = base || cfg.udid || uuid();
  return `${b}-${md5(String(userId || cfg.accountId || '')).slice(0, 16).toUpperCase()}`;
}

function buildUrl({ accessToken, userId, sellerId, udid, wsType = 2 }) {
  const version = `${cfg.version}.${cfg.archIsX64 ? 1 : 2}`;
  const C = Date.now();
  const A = md5(`${accessToken}-${WS_AUTH_KEY}`);
  const D = md5([udid, wsType, userId, sellerId, A, C, version, WS_AUTH_KEY].join('-'));
  const data = {
    udid,
    wsType,
    wsEnv: cfg.wsEnv,
    accountId: String(userId),
    sellerId: String(sellerId),
    token: A,
    timestamp: C,
    version,
    sign: D,
  };
  return `wss://${HOST}:${PORT}/gpush/ws?data=${encodeURIComponent(JSON.stringify(data))}`;
}

/** 客户端帧 → Buffer（必须掩码） */
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

/** 解析服务端帧（服务端→客户端不加掩码），支持分片累积 */
function createParser(onMessage) {
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
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const m = buf.slice(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]));
      }
      buf = buf.slice(off + maskLen + len);

      if (opcode === 0x9) { onMessage({ op: 'ping', payload }); continue; }
      if (opcode === 0xa) { onMessage({ op: 'pong', payload }); continue; }
      if (opcode === 0x8) { onMessage({ op: 'close', payload }); continue; }
      if (opcode === 0x1 || opcode === 0x2) {
        frag = [payload];
        if (fin) { onMessage({ op: 'text', payload: Buffer.concat(frag) }); frag = []; }
        continue;
      }
      if (opcode === 0x0) {
        frag.push(payload);
        if (fin) { onMessage({ op: 'text', payload: Buffer.concat(frag) }); frag = []; }
      }
    }
  };
}

class GpushClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.socket = null;
    this.connected = false;
    this.sendMsgId = 1;
    this.heartbeatTimer = null;
    this.retry = 0;
    this.closedByUser = false;
  }

  get url() {
    const { accessToken, userId, sellerId, udid, wsType } = this.opts;
    return buildUrl({ accessToken, userId, sellerId, udid, wsType });
  }

  connect(urlOverride) {
    this.closedByUser = false;
    const url = new URL(urlOverride || this.url);
    const key = crypto.randomBytes(16).toString('base64');
    const req =
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      'User-Agent: goofish-im/1.21.90\r\n\r\n';

    const sock = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname }, () => {
      sock.write(req);
    });
    this.socket = sock;
    let handshook = false;
    let head = Buffer.alloc(0);
    const parser = createParser(msg => this._onFrame(msg));

    sock.on('data', chunk => {
      if (handshook) return parser(chunk);
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const headText = head.slice(0, idx).toString('utf8');
      if (!/^HTTP\/1\.1 101/.test(headText)) {
        this.emit('fatal', new Error('WS 握手失败: ' + headText.split('\r\n')[0]));
        sock.destroy();
        return;
      }
      handshook = true;
      this.connected = true;
      this.retry = 0;
      this.emit('open');
      this._startHeartbeat();
      const rest = head.slice(idx + 4);
      if (rest.length) parser(rest);
    });

    sock.on('error', e => this.emit('error', e));
    sock.on('close', () => {
      this.connected = false;
      this._stopHeartbeat();
      this.emit('close');
      if (!this.closedByUser) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    const delay = Math.min(60000, 1000 * Math.pow(2, Math.min(this.retry++, 6)));
    this.emit('log', `WS 断开，${delay / 1000}s 后重连`);
    setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay).unref?.();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ msgId: this.sendMsgId++, mtime: Date.now(), mt: 100000 });
    }, 30000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(obj) {
    if (!this.connected || !this.socket) return false;
    this.socket.write(encodeFrame(0x1, JSON.stringify(obj)));
    return true;
  }

  _onFrame(msg) {
    if (msg.op === 'ping') { this.socket.write(encodeFrame(0xa, msg.payload)); return; }
    if (msg.op === 'close') { this.socket.end(); return; }
    if (msg.op !== 'text') return;
    let frame;
    try {
      frame = JSON.parse(Buffer.from(msg.payload.toString('utf8'), 'base64').toString('utf8'));
    } catch (_) {
      return; // 非 base64 JSON 帧忽略
    }
    const { udid, accountId, wsType } = this.opts;
    if (frame.udid && udid && frame.udid !== udid) return;
    if (frame.accountId && accountId && String(frame.accountId) !== String(accountId)) return;
    if (frame.wsType !== undefined && wsType !== undefined && frame.wsType !== wsType) return;
    this.emit('push', frame);
  }

  close() {
    this.closedByUser = true;
    this._stopHeartbeat();
    if (this.socket) this.socket.end();
    this.socket = null;
  }
}

module.exports = { GpushClient, buildUrl, buildUdid, encodeFrame, createParser, WS_AUTH_KEY, HOST, PORT };
