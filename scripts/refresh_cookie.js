#!/usr/bin/env node
/**
 * 从正在运行的受控 Chrome（--remote-debugging-port）里把闲鱼 Cookie 抓出来，覆盖账号文件。
 * 用法：node scripts/refresh_cookie.js --port 9315 [--name main]
 *
 * 为什么要它：mtop 的登录态会过期（FAIL_SYS_SESSION_EXPIRED），
 * 只要浏览器里 goofish.com 还是登录状态，就能直接续上，不用重新扫码。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const WS = require('../src/lib/ws');

const ROOT = path.join(__dirname, '..');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  return def;
}

const PORT = Number(argOf('port', 9315));
const NAME = argOf('name', 'main');

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      const b = [];
      res.on('data', (c) => b.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout ' + p)));
  });
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const secure = u.protocol === 'wss:';
    const host = u.hostname;
    const port = Number(u.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString('base64');
    const req =
      `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

    const sock = secure
      ? tls.connect({ host, port, servername: host }, () => sock.write(req))
      : net.connect({ host, port }, () => sock.write(req));

    let head = Buffer.alloc(0);
    let open = false;
    const parser = WS.createParser((frame) => {
      if (frame.op !== 'text') return;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
      onMessage(msg);
    });

    let onMessage = () => {};

    sock.on('data', (chunk) => {
      if (open) return parser(chunk);
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      const text = head.subarray(0, i).toString('utf8');
      if (!/^HTTP\/1\.1 101/.test(text)) return reject(new Error(text.split('\r\n')[0]));
      open = true;
      const rest = head.subarray(i + 4);
      if (rest.length) parser(rest);
      resolve({
        send(obj) { sock.write(WS.encodeFrame(0x1, JSON.stringify(obj))); },
        setHandler(fn) { onMessage = fn; },
        close() { try { sock.destroy(); } catch (_) {} },
      });
    });
    sock.on('error', reject);
    sock.setTimeout(15000, () => reject(new Error('ws timeout')));
  });
}

(async () => {
  let version;
  try { version = await getJson('/json/version'); } catch (e) {
    console.error('连不上调试端口 ' + PORT + '：' + e.message);
    process.exit(2);
  }
  const wsUrl = version.webSocketDebuggerUrl;
  const ws = await connectWs(wsUrl);

  let id = 0;
  const waiters = new Map();
  ws.setHandler((msg) => {
    if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id);
      waiters.delete(msg.id);
      w(msg);
    }
  });
  const cmd = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      waiters.set(myId, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      ws.send({ id: myId, method, params: params || {} });
      setTimeout(() => {
        if (waiters.has(myId)) { waiters.delete(myId); reject(new Error('CDP 超时 ' + method)); }
      }, 15000);
    });

  // 浏览器级 target 不支持 Network 域，用 Storage.getCookies；老版本退回 Network.getAllCookies
  let cookies = [];
  try {
    const r = await cmd('Storage.getCookies', {});
    cookies = r.cookies || [];
  } catch (e) {
    const r2 = await cmd('Network.getAllCookies', {});
    cookies = r2.cookies || [];
  }
  ws.close();

  // 关键：`_m_h5_tk` 是 mtop 第一次调用时由页面「现场领」的 HttpOnly cookie，
  // 浏览器空闲久了会没有它 —— 少了这个，Node 侧所有 mtop 都报 SESSION_EXPIRED。
  // 所以抓之前先让 goofish 页面刷一次。
  let hasTk = cookies.some((c) => c.name === '_m_h5_tk' && String(c.value || '').length > 8);
  if (!hasTk) {
    try {
      const pages = await getJson('/json/list');
      const page = (pages || []).find((p) => p.type === 'page' && /goofish\.com/.test(p.url || ''));
      if (page) {
        const ws2 = await connectWs(page.webSocketDebuggerUrl);
        ws2.send({ id: 1, method: 'Page.reload', params: {} });
        ws2.close();
        console.log('页面没有 _m_h5_tk，已让 goofish 页面刷新一次，等 12s 再抓…');
        await new Promise((r) => setTimeout(r, 12000));
        const ws3 = await connectWs(wsUrl);
        let id2 = 0;
        const waiters2 = new Map();
        ws3.setHandler((m) => {
          if (m.id && waiters2.has(m.id)) { const w = waiters2.get(m.id); waiters2.delete(m.id); w(m); }
        });
        const cmd2 = (method, params) =>
          new Promise((res2) => {
            const myId = ++id2;
            waiters2.set(myId, (m) => res2(m.result || {}));
            ws3.send({ id: myId, method, params: params || {} });
          });
        const again = await cmd2('Storage.getCookies', {});
        cookies = again.cookies || cookies;
        ws3.close();
        hasTk = cookies.some((c) => c.name === '_m_h5_tk' && String(c.value || '').length > 8);
        console.log('刷新后 ' + (hasTk ? '已拿到 _m_h5_tk' : '仍然没有 _m_h5_tk（浏览器可能已登出）'));
      }
    } catch (e) {
      console.log('自动刷新页面失败：' + e.message);
    }
  }

  const mine = cookies.filter((c) => /(^|\.)goofish\.com$/.test(c.domain));
  if (!mine.length) {
    console.error('这个浏览器里没有 goofish.com 的 Cookie（' + cookies.length + ' 条总）→ 先在浏览器里登录闲鱼');
    process.exit(3);
  }
  const pick = {};
  for (const c of mine) {
    const old = pick[c.name];
    if (!old || String(c.value).length > String(old.value).length) pick[c.name] = c;
  }
  const order = ['unb', 'cookie2', '_m_h5_tk', '_m_h5_tk_enc', 'sgcookie', '_tb_token_', 'cna', 'tracknick', 't', 'tfstk', 'xlly_s', 'dnk', 'lgc'];
  const names = order.filter((n) => pick[n]).concat(Object.keys(pick).filter((n) => !order.includes(n)));
  const line = names.map((n) => `${n}=${pick[n].value}`).join('; ');

  if (!pick.unb) { console.error('缺 unb，可能没登录'); process.exit(4); }
  const dir = path.join(ROOT, 'data', 'accounts');
  fs.mkdirSync(dir, { recursive: true });
  const unb = pick.unb.value.replace(/[^\d]/g, '') || NAME;
  fs.writeFileSync(path.join(dir, unb + '.cookie'), line, 'utf8');
  fs.writeFileSync(
    path.join(dir, unb + '.json'),
    JSON.stringify({ unb, savedAt: Date.now(), savedAtText: new Date().toLocaleString(), source: 'cdp-refresh', profile: null, cookieCount: names.length, hasToken: !!pick._m_h5_tk }, null, 2),
    'utf8'
  );
  console.log(`已刷新账号 ${unb}：${names.length} 条 Cookie（cookie2=${pick.cookie2 ? '有' : '无'}，_tb_token_=${pick._tb_token_ ? '有' : '无'}）`);
  console.log('文件：' + path.join(dir, unb + '.cookie'));
})();
