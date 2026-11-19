'use strict';
/**
 * 订单索引同步：消息卡片里捞到订单号 → sold.get 详情 → 落库。
 *
 * 平台对 sold.get 的风控很敏感：实测 260ms 间隔拉 30 个左右就 FAIL_SYS_USER_VALIDATE，
 * 所以这里默认 900ms 一个，命中风控就停并写 30 分钟冷却。
 */
const api = require('./api');
// store 必须懒加载：模块加载时它就会打开 cfg.dbFile，而 cfg.dbFile 要等 server bind() 才定稿
const S = () => require('../lib/store');

const COOLDOWN_KEY = 'orders:cooldown';
const COOLDOWN_MS = 30 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cooldownUntil() {
  const row = S().getCursor(COOLDOWN_KEY);
  return row ? Number(row) || 0 : 0;
}

function isCoolingDown() {
  return cooldownUntil() > Date.now();
}

async function syncOrders(opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 200));
  const gap = Math.max(300, Number(opts.gap) || 900);
  const sessionId = opts.sessionId ? String(opts.sessionId) : '';

  const out = { tried: 0, saved: 0, skipped: 0, errors: [], cooldownUntil: 0, done: false };
  if (isCoolingDown()) {
    out.cooldownUntil = cooldownUntil();
    out.done = true;
    return out;
  }

  const known = S().knownOrderIds();
  let cands = S().orderIdsFromDb(800);
  if (sessionId) cands = cands.filter(c => c.sessionId === sessionId);
  cands = cands.filter(c => !known.has(String(c.orderId))).slice(0, limit);

  for (const c of cands) {
    out.tried++;
    try {
      const r = await api.orderBrief(String(c.orderId));
      const it = (r && r.items && r.items[0]) || r;
      const n = api.normalizeOrder(it, c.orderId);
      if (!n || !n.status) {
        out.skipped++;
      } else {
        S().saveOrder({ ...n, sessionId: c.sessionId });
        out.saved++;
      }
      if (opts.onEach) opts.onEach(n, c);
    } catch (e) {
      const msg = String(e.message || e);
      out.errors.push({ orderId: c.orderId, error: msg });
      if (/USER_VALIDATE|RISK|滑块/.test(msg)) {
        S().setCursor(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS));
        out.cooldownUntil = Date.now() + COOLDOWN_MS;
        out.done = true;
        break;
      }
    }
    await sleep(gap);
  }
  out.done = out.done || cands.length < limit;
  return out;
}

module.exports = { syncOrders, isCoolingDown, cooldownUntil, COOLDOWN_MS };
