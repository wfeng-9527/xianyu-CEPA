/**
 * 方案库刷新任务：把旅云保 85 个保额档的保障内容 / 须知 / 条款全部重拉一遍
 *
 * 两个触发方式：
 *   1) 定时：data/plan-sync.json 里 enabled=true，每天到点跑一次（默认 03:00）
 *   2) 手动：保险平台页面上的「立即刷新」/ POST /api/plans/job {runNow:true}
 *
 * 状态放内存（state），配置落盘（conf），两者一起由 GET /api/plans/job 返回。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONF_FILE = path.join(__dirname, '..', '..', 'data', 'plan-sync.json');
const DEFAULTS = { enabled: false, hour: 3, detail: true, lastRunDay: '', lastRunAt: 0, lastResult: '', lastOk: 0, lastFail: 0 };

const state = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  done: 0,
  total: 0,
  ok: 0,
  fail: 0,
  current: '',
  lastError: '',
};

function loadConf() {
  try {
    if (!fs.existsSync(CONF_FILE)) return { ...DEFAULTS };
    const j = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
    return { ...DEFAULTS, ...j };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveConf(patch = {}) {
  const cur = loadConf();
  const next = { ...cur };
  if (patch.enabled != null) next.enabled = !!patch.enabled;
  if (patch.hour != null) {
    const h = Number(patch.hour);
    if (Number.isFinite(h) && h >= 0 && h <= 23) next.hour = Math.floor(h);
  }
  if (patch.detail != null) next.detail = !!patch.detail;
  fs.writeFileSync(CONF_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 跑一轮刷新（detail=true 会连须知/条款一起拉，85 档约 3~6 分钟） */
async function run({ detail = true } = {}) {
  if (state.running) return { ok: false, error: '正在刷新中，别急' };
  const store = require('../lib/store');
  const plans = require('./plans');

  const all = store.listPlans(9999) || [];
  state.running = true;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.done = 0;
  state.ok = 0;
  state.fail = 0;
  state.total = all.length;
  state.current = '';
  state.lastError = '';

  let firstErr = '';
  try {
    for (const p of all) {
      state.current = p.planCode;
      try {
        await plans.syncDetail(store, p.planCode, { clausePdf: detail, force: !!detail });
        state.ok++;
      } catch (e) {
        state.fail++;
        if (!firstErr) firstErr = `${p.planCode}: ${e.message}`;
        state.lastError = firstErr;
      }
      state.done++;
    }
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
    const conf = loadConf();
    saveConf({
      enabled: conf.enabled,
      hour: conf.hour,
      detail: conf.detail,
      lastRunDay: dayKey(),
      lastRunAt: state.finishedAt,
      lastResult: `成功 ${state.ok} / 失败 ${state.fail} / 共 ${state.total}`,
      lastOk: state.ok,
      lastFail: state.fail,
    });
  }
  return { ok: true, okCount: state.ok, fail: state.fail, total: state.total, ms: state.finishedAt - state.startedAt };
}

/** 每分钟被 server 调一次：判断该不该跑 */
function tick() {
  const conf = loadConf();
  if (!conf.enabled || state.running) return null;
  const now = new Date();
  if (now.getHours() < conf.hour) return null;
  if (conf.lastRunDay === dayKey(now)) return null;
  return run({ detail: conf.detail !== false });
}

function view() {
  const conf = loadConf();
  return {
    ...conf,
    running: state.running,
    done: state.done,
    total: state.total,
    ok: state.ok,
    fail: state.fail,
    current: state.current,
    lastError: state.lastError,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    file: CONF_FILE,
  };
}

module.exports = { loadConf, saveConf, run, tick, view, CONF_FILE };
