'use strict';
/**
 * 规则引擎：决定「这条消息要不要回、回什么、还是转人工」
 * 设计原则：规则先命中优先，未命中交给 AI 钩子，AI 也不接就转人工并静默。
 */
const fs = require('fs');
const { cfg, readJson } = require('../config');

const DEFAULTS = {
  cooldown: 60,          // 同一会话两次自动回复的最小间隔（秒）
  maxPerSession: 3,      // 同一会话每小时自动回复上限
  minLength: 1,          // 太短的消息（"嗯""哦"）不回
  rules: [],
};

function load() {
  const raw = readJson(cfg.rulesFile, {});
  const conf = Object.assign({}, DEFAULTS, raw);
  conf.rules = (raw.rules || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return conf;
}

/** 每次进程内的回复节流状态 */
const state = new Map(); // sessionId -> {lastAt, count, windowStart}

function canReply(sessionId, conf) {
  const s = state.get(sessionId) || { lastAt: 0, count: 0, windowStart: 0 };
  const now = Date.now();
  if (now - s.lastAt < conf.cooldown * 1000) return { ok: false, why: 'cooldown' };
  if (now - s.windowStart > 3600 * 1000) { s.windowStart = now; s.count = 0; }
  if (s.count >= conf.maxPerSession) return { ok: false, why: 'quota' };
  return { ok: true, state: s };
}

function markReplied(sessionId) {
  const now = Date.now();
  const s = state.get(sessionId) || { lastAt: 0, count: 0, windowStart: now };
  if (now - s.windowStart > 3600 * 1000) { s.windowStart = now; s.count = 0; }
  s.lastAt = now;
  s.count += 1;
  state.set(sessionId, s);
}

function match(rule, text, ctx = {}) {
  // 商品维度：rule.when.itemId 只对该商品生效（训练台按商品归纳出来的规则）
  const w = rule.when || {};
  if (w.itemId && String(w.itemId) !== String(ctx.itemId || '')) return false;
  const m = rule.match || {};
  if (m.any) return true;
  if (m.keywords && m.keywords.some(k => text.includes(k))) return true;
  if (m.regex && new RegExp(m.regex, 'i').test(text)) return true;
  if (m.equals && m.equals === text.trim()) return true;
  return false;
}

/**
 * @returns {{action:'reply'|'handoff'|'ai'|'ignore', rule?:object, text?:string}}
 */
function decide(text, ctx = {}, conf = load()) {
  const s = (text || '').trim();
  if (s.length < conf.minLength) return { action: 'ignore' };

  for (const rule of conf.rules) {
    if (!match(rule, s, ctx)) continue;
    if (rule.silent) return { action: 'ignore', rule, reason: 'silent' };
    if (rule.handoff) return { action: 'handoff', rule };
    if (rule.ai) return { action: 'ai', rule };
    if (rule.reply) {
      const gate = canReply(ctx.sessionId, conf);
      if (!gate.ok) return { action: 'ignore', rule, reason: gate.why };
      return { action: 'reply', rule, text: typeof rule.reply === 'function' ? rule.reply(ctx) : rule.reply };
    }
  }
  return { action: 'ignore' };
}

module.exports = { load, decide, markReplied, canReply, match, state, DEFAULTS };
