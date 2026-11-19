#!/usr/bin/env node
'use strict';
/**
 * 添加账号：拉起一个独立 Chrome 配置 → 你扫码登录闲鱼 → 自动抓 Cookie 落盘 → 关窗
 *
 *   node scripts/add_account.js                    # 交互式，扫码
 *   node scripts/add_account.js --name shop2       # 复用/新建指定配置目录
 *   node scripts/add_account.js --headless         # 无窗口（已登录过的配置可复用）
 *   node scripts/add_account.js --timeout 600      # 等待时长（秒，默认 300）
 *   node scripts/add_account.js --no-close         # 抓完不关浏览器
 *
 * 产物：data/accounts/<unb>.cookie + <unb>.json
 * 依赖：系统已装 Chrome 或 Edge；本脚本零 npm 依赖（手写 CDP WebSocket 客户端）
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { encodeFrame, createParser } = require('../src/lib/ws');

const ROOT = path.resolve(__dirname, '..');
const ACCOUNTS = path.join(ROOT, 'data', 'accounts');

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const NAME = opt('name', 'default');
const PORT = Number(opt('port', 9315));
const TIMEOUT = Number(opt('timeout', 300)) * 1000;
const HEADLESS = !!opt('headless', false);
const NO_CLOSE = !!opt('no-close', false);
const PROFILE = path.join(ROOT, 'data', 'chrome', String(NAME));
// 起始页默认是 IM 页；想刷新 mtop 会话（拿 _m_h5_tk）就传 --url https://www.goofish.com/
const START_URL = String(opt('url', 'https://www.goofish.com/im'));

// ------------------------------------------------------------------ 找浏览器
function findBrowser() {
  const explicit = opt('browser', process.env.CHROME_PATH);
  if (explicit && typeof explicit === 'string' && fs.existsSync(explicit)) return explicit;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env['LocalAppData'] || '';
  const cands = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  throw new Error('没找到 Chrome/Edge，用 --browser "路径" 指定');
}

// ------------------------------------------------------------------ 极简 WS 客户端（CDP 用）
function wsConnect(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
    let headDone = false;
    let buf = Buffer.alloc(0);
    const handlers = [];
    const parser = createParser(m => handlers.forEach(f => f(m)));

    const api = {
      send: obj => sock.write(encodeFrame(0x1, JSON.stringify(obj))),
      on: f => handlers.push(f),
      close: () => sock.destroy(),
    };

    sock.on('connect', () => {
      const req =
        'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n';
      sock.write(req);
    });
    sock.on('data', d => {
      if (!headDone) {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        if (!/ 101 /.test(head)) return reject(new Error('WS 握手失败: ' + head.split('\r\n')[0]));
        headDone = true;
        const rest = buf.slice(i + 4);
        buf = null;
        resolve(api);
        if (rest.length) parser(rest);
        return;
      }
      if (process.env.XY_DEBUG) console.log('[ws] recv', d.length, 'bytes', d.slice(0, 40).toString('hex'));
      parser(d);
    });
    sock.on('error', e => { if (!headDone) reject(e); });
    sock.on('close', () => { if (!headDone) reject(new Error('CDP 连接被关闭')); });

    // 收到 ping 回 pong，避免 CDP 长连接被掐
    handlers.push(m => { if (m.op === 'ping') sock.write(encodeFrame(0xa, m.payload)); });
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1500 }, res => {
      let s = '';
      res.on('data', c => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ 主流程
async function main() {
  fs.mkdirSync(ACCOUNTS, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const exe = findBrowser();
  const args = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--new-window',
  ];
  if (HEADLESS) args.push('--headless=new');
  args.push(START_URL);

  console.log('浏览器: ' + path.basename(exe));
  console.log('配置目录: ' + PROFILE);
  if (!HEADLESS) console.log('→ 在弹出的窗口里扫码登录闲鱼（登录后本脚本自动保存 Cookie）\n');

  const child = spawn(exe, args, { detached: !HEADLESS, stdio: 'ignore' });
  child.unref && child.unref();

  // 等 CDP 端口就绪
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJson('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (_) { await sleep(500); }
  }
  if (!version) throw new Error('CDP 没起来（端口 ' + PORT + '）。可能浏览器已在运行且占用了该端口');

  // 连浏览器级 CDP：页面 target 在导航提交时会被重建，用 browser 端点 + attach 更稳
  const ws = await wsConnect(version.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.on(m => {
    if (m.op !== 'text') return;
    let msg;
    try { msg = JSON.parse(m.payload.toString()); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(id, { resolve, reject });
    ws.send(msg);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 8000);
  });

  // 找页面 target 并 attach（flatten 模式）
  let targetId = null;
  for (let i = 0; i < 40 && !targetId; i++) {
    const r = await cdp('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const pages = (r.targetInfos || []).filter(t => t.type === 'page');
    const hit = pages.find(t => /goofish/.test(t.url)) || pages[0];
    if (hit) targetId = hit.targetId; else await sleep(500);
  }
  if (!targetId) throw new Error('没找到页面 target');

  const attached = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attached.sessionId;

  let enabled = false;
  for (let i = 0; i < 5 && !enabled; i++) {
    try { await cdp('Network.enable', {}, sessionId); enabled = true; } catch (_) { await sleep(400); }
  }
  if (!enabled) throw new Error('CDP Network.enable 无响应');

  // 自检：注入假 Cookie 走通「检测→落盘」路径（不联网、不登录）
  if (opt('selftest', false)) {
    await cdp('Network.setCookie', { name: 'unb', value: '999999999', url: START_URL }, sessionId);
    await cdp('Network.setCookie', { name: 'cookie2', value: 'selftest', url: START_URL }, sessionId);
  }

  const started = Date.now();
  let lastTip = 0;
  let saved = null;
  let lastCount = 0;

  while (Date.now() - started < TIMEOUT) {
    let cookies = [];
    try { cookies = (await cdp('Network.getAllCookies', {}, sessionId)).cookies || []; } catch (_) { /* 页面导航中 */ }
    const g = cookies.filter(c => /(^|\.)goofish\.com$/.test(c.domain) && c.name && c.value !== undefined);
    const map = new Map(g.map(c => [c.name, c.value]));
    if (map.has('unb') && map.has('cookie2')) {
      saved = map;
      break;
    }
    lastCount = g.length;
    const waited = Math.round((Date.now() - started) / 1000);
    if (!HEADLESS && waited - lastTip >= 15) {
      lastTip = waited;
      console.log('等待扫码… ' + waited + 's（当前 goofish Cookie ' + g.length + ' 项）');
    }
    await sleep(2500);
  }

  ws.close();

  if (!saved) {
    if (!NO_CLOSE) killTree(child.pid);
    throw new Error('超时没等到登录（unb+cookie2，当前 goofish Cookie ' + lastCount + ' 项）。换 --timeout 更长，或检查是否卡在滑块');
  }

  const unb = String(saved.get('unb'));
  const order = ['unb', 'cookie2', '_m_h5_tk', '_m_h5_tk_enc', 'sgcookie', '_tb_token_', 'cna', 'tracknick', 't', 'tfstk', 'xlly_s', 'dnk', 'lgc'];
  const names = order.filter(n => saved.has(n)).concat([...saved.keys()].filter(n => order.indexOf(n) < 0));
  const header = names.map(n => n + '=' + saved.get(n)).join('; ');

  const cookiePath = path.join(ACCOUNTS, unb + '.cookie');
  fs.writeFileSync(cookiePath, header, 'utf8');
  fs.writeFileSync(path.join(ACCOUNTS, unb + '.json'), JSON.stringify({
    unb,
    savedAt: Date.now(),
    savedAtText: new Date().toLocaleString(),
    browser: path.basename(exe),
    profile: PROFILE,
    cookieCount: names.length,
    hasToken: saved.has('_m_h5_tk'),
  }, null, 2), 'utf8');

  console.log('\n已保存账号 ' + unb);
  console.log('  Cookie  ' + names.length + ' 项 → ' + cookiePath);
  if (!saved.has('_m_h5_tk')) console.log('  注：暂无 _m_h5_tk，首次请求会自动领');

  if (!NO_CLOSE) {
    killTree(child.pid);
    console.log('  浏览器已关闭（配置目录保留，下次同 --name 可免扫码）');
  }
  console.log('\n下一步： node src/index.js me --account=' + unb);
}

function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
}

main().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
