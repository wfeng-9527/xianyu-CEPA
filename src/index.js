#!/usr/bin/env node
'use strict';
const { cfg, ROOT, listAccounts, unbFromCookie } = require('./config');
const path = require('path');
const mtop = require('./lib/mtop');
let store, api, rules, Worker;
/** 延迟加载：账号确定后才能定下分库路径 */
function boot() {
  store = store || require('./lib/store');
  api = api || require('./core/api');
  rules = rules || require('./core/rules');
}

const HELP = `
xianyu-auto  闲鱼自动化系统骨架

  node scripts/add_account.js         加账号（扫码登录 → 自动存 Cookie）
  node src/index.js accounts          列出账号库
  node src/index.js selftest          离线自检（WS 帧编解码 + 规则引擎 + 存储）
  node src/index.js me                当前登录账号
  node src/index.js sessions [n]      会话列表（本地库）
  node src/index.js sync [n]          同步会话+消息（默认 30 个会话）
  node src/index.js dump <sessionId> [n]   打印某会话最近 n 条消息
  node src/index.js send <sessionId> "文本"
  node src/index.js daemon            常驻：WS/轮询 + 自动回复
  node src/index.js events [n]        查看待处理事件

通用参数： --account=<unb>   指定账号（默认账号库最新 / goofish-cookie.txt）
环境变量：GOOFISH_COOKIE / XY_ACCOUNT_ID / XY_ACCESS_TOKEN / XY_DRY_RUN=1
配置：config.json（见 config.example.json）
`;

function parseArgv(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { opts, rest };
}

function auth(account) {
  try {
    const n = mtop.initCookie(account);
    const unb = unbFromCookie(`unb=${mtop.getJar().unb || ''}`);
    if (!cfg.accountId) cfg.accountId = mtop.getJar().unb || '';
    // 每账号一个库，避免多账号会话互相污染
    const uid = cfg.accountId || account || 'default';
    if (!process.env.XY_DB_FILE) cfg.dbFile = path.join(ROOT, 'data', 'xianyu-' + uid + '.db');
    console.log(`Cookie OK（${n} 项${cfg.accountId ? `，accountId=${cfg.accountId}` : ''}）`);
  } catch (e) {
    console.error('! ' + e.message);
    process.exit(2);
  }
}

function showAccounts() {
  const list = listAccounts();
  if (!list.length) return console.log('账号库为空。跑 node scripts/add_account.js 添加第一个账号');
  console.log('unb'.padEnd(18) + 'cookie'.padEnd(8) + '保存时间');
  for (const a of list) {
    console.log(String(a.unb).padEnd(18) + String(a.cookieCount || '-').padEnd(8) + (a.savedAtText || '-'));
  }
  console.log(`\n共 ${list.length} 个账号，目录 ${cfg.accountsDir}`);
}

async function main() {
  const { opts, rest } = parseArgv(process.argv.slice(2));
  const [cmd, ...args] = rest;
  if (!cmd || cmd === 'help' || cmd === '-h') return console.log(HELP);

  if (cmd === 'selftest') return selftest();
  if (cmd === 'accounts') return showAccounts();

  auth(opts.account || process.env.XY_ACCOUNT);
  boot();
  switch (cmd) {
    case 'me': {
      console.log(JSON.stringify(await api.me(), null, 2));
      break;
    }
    case 'sessions': {
      const list = store.listSessions(Number(args[0] || 30));
      if (!list.length) return console.log('本地库为空，先跑 sync');
      for (const s of list) {
        console.log(`${s.id.padEnd(18)} type=${String(s.type).padEnd(3)} unread=${String(s.unread || 0).padEnd(3)} ` +
          `${new Date(s.last_ts || 0).toLocaleString()}  ${s.with_id || '-'}  ${s.abstract || ''}`);
      }
      break;
    }
    case 'sync': {
      Worker = Worker || require('./core/worker');
      const w = new Worker({ autoReply: false });
      const n = await w.syncAll({ limit: Number(args[0] || 30) });
      console.log(`本轮新增消息 ${n} 条`);
      break;
    }
    case 'dump': {
      if (!args[0]) throw new Error('用法: dump <sessionId> [n]');
      const rows = store.listMessages(args[0], Number(args[1] || 30));
      if (!rows.length) return console.log('本地库没有该会话消息');
      for (const m of rows.reverse()) {
        console.log(`${new Date(m.ts || 0).toLocaleString()} [${m.from_self ? '我' : m.sender_id}] ${m.text}`);
      }
      break;
    }
    case 'send': {
      if (!args[0] || args[1] === undefined) throw new Error('用法: send <sessionId> "文本"');
      const r = await api.sendText(args[0], args[1]);
      console.log('已发送', r.localId, JSON.stringify(r.data));
      break;
    }
    case 'events': {
      for (const e of store.pendingEvents(Number(args[0] || 20))) {
        console.log(e.id, e.kind, new Date(e.ts).toLocaleString(), e.payload.slice(0, 160));
      }
      break;
    }
    case 'daemon': {
      Worker = Worker || require('./core/worker');
      // 自动回复是否真发，看 AI 页的总开关（data/ai-config.json 的 enabled）
      const autoReply = require('./core/aiconf').load().enabled;
      const w = new Worker({ autoReply, ai: null });
      w.start();
      console.log(`自动回复总开关：${autoReply ? '开（会真的发出去）' : '关（只记录建议）'}`);
      process.on('SIGINT', () => { console.log('\n退出'); w.stop(); process.exit(0); });
      break;
    }
    default:
      console.log(HELP);
  }
}

// ------------------------------------------------------------------ 离线自检
function selftest() {
  const { encodeFrame, createParser } = require('./lib/ws');
  boot();
  const results = [];
  const ok = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);

  // 1) WS 帧：编码（客户端掩码）→ 去掩码 → 服务端帧 → 解析
  function stripClientMask(frame) {
    const len7 = frame[1] & 0x7f;
    let off = 2, len = len7;
    if (len7 === 126) { len = frame.readUInt16BE(2); off = 4; }
    else if (len7 === 127) { len = Number(frame.readBigUInt64BE(2)); off = 10; }
    const mask = frame.slice(off, off + 4);
    const body = frame.slice(off + 4, off + 4 + len);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = body[i] ^ mask[i % 4];
    return out;
  }
  for (const size of [5, 200, 70000]) {
    const payload = 'x'.repeat(size);
    const out = [];
    const parser = createParser(m => out.push(m));
    const body = stripClientMask(encodeFrame(0x1, payload));
    let header;
    if (size < 126) { header = Buffer.from([0x81, size]); }
    else if (size < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(size, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(size), 2); }
    // 分片喂入，验证粘包/半包处理
    const wire = Buffer.concat([header, body]);
    for (let i = 0; i < wire.length; i += 37) parser(wire.slice(i, i + 37));
    ok(`WS 帧往返 len=${size}`, out.length === 1 && out[0].payload.length === size && out[0].payload.toString() === payload,
      `got ${out.length} 帧`);
  }

  // 2) base64 下行帧解析
  const sample = Buffer.from(JSON.stringify({
    msgId: 7, udid: 'U1', accountId: '1', wsType: 2,
    data: { pushId: 'p', pushType: 21620, serverTime: 1, data: { time: 1 } },
  })).toString('base64');
  ok('下行 base64(JSON) 可解', JSON.parse(Buffer.from(sample, 'base64').toString('utf8')).data.pushType === 21620);

  // 3) 规则引擎
  const conf = rules.load();
  const a = rules.decide('这个多少钱', { sessionId: 't' }, conf);
  ok('规则命中: 价格', a.action === 'reply' && /实价/.test(a.text || ''), a.action);
  const b = rules.decide('我要退款', { sessionId: 't2' }, conf);
  ok('规则命中: 转人工', b.action === 'handoff');
  const c = rules.decide('今天天气不错适合钓鱼吗', { sessionId: 't3' }, conf);
  ok('规则未命中→AI 钩子', c.action === 'ai');
  const d = rules.decide('嗯', { sessionId: 't4' }, conf);
  ok('过短消息忽略', d.action === 'ignore');

  // 4) 存储
  const sid = 'S_' + Date.now();
  const mid = 'm_' + Date.now();
  store.saveSessions([{ id: sid, type: 1, abstractContent: 'hi', lastMsgTs: 1, unread: 0, withWho: { id: 'U9' }, orignJson: '{}' }]);
  ok('存储: 会话写入', !!store.getSession(sid));
  const added = store.saveMessages(sid, [{ messageId: mid, version: 100, ts: 100, contentType: 1, text: 'hi', senderId: 'U9' }]);
  ok('存储: 消息写入', added === 1, `added=${added}`);
  ok('存储: 重复消息去重', store.saveMessages(sid, [{ messageId: mid, version: 100, ts: 100, contentType: 1, text: 'hi', senderId: 'U9' }]) === 0);
  store.setCursor('msg:' + sid, 100);
  ok('存储: 游标', store.getCursor('msg:' + sid) === '100');

  const pad = results.map(r => `[${r[0]}] ${r[1]}${r[2] ? '  (' + r[2] + ')' : ''}`).join('\n');
  console.log(pad);
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
