'use strict';
/**
 * 自动客服管线：一条客户消息 → 走完「敏感词 → 规则 → AI → 自检」→ 产出该发的回复
 *
 *   answer()          纯决策，不发送；返回 { action, text, source, check, meta }
 *   respondAndSend()  决策 + 真发（受 aiconf.enabled / cfg.dryRun 控制）
 *
 * action 语义：
 *   reply   规则里写死的标准答案，直接发
 *   ai      模型按人设+店铺规则+条款事实生成的回复
 *   handoff 转人工（不回或只回一句「我确认下」）
 *   ignore  没必要回（太短 / 命中静默规则 / 节流）
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../config');
const rules = require('./rules');
const aiconf = require('./aiconf');
const ai = require('./ai');

const USAGE_FILE = path.join(ROOT, 'data', 'ai-usage.json');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) { return {}; }
}

function bumpUsage(n = 1) {
  const u = readUsage();
  const k = today();
  u[k] = (u[k] || 0) + n;
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2), 'utf8');
  return u[k];
}

function usageToday() {
  return readUsage()[today()] || 0;
}

/** 店铺规则文本：rules.json 里的标准答法 + 配置里手写的常识 */
function shopRules(cfg) {
  const out = [];
  const rc = rules.load();
  for (const r of rc.rules || []) {
    if (r.enabled === false) continue;
    if (r.reply) out.push(`${r.name || r.id}：${r.reply}`);
  }
  for (const k of cfg.knowledge || []) {
    if (k && String(k).trim()) out.push(String(k).trim());
  }
  return out;
}

/** 敏感/必须人工的话题（优先于一切规则） */
function needsHuman(text, cfg) {
  const t = String(text || '');
  for (const w of cfg.handoffWhen || []) {
    if (w && t.includes(w)) return w;
  }
  return '';
}

async function answer({ store, sessionId, text, live = true, useRules = true, itemId = '' }) {
  const cfg = aiconf.load();
  const said = String(text || '').trim();

  // 商品上下文：会话里带的商品（规则/条款都按商品走）
  let iid = itemId ? String(itemId) : '';
  if (!iid && sessionId && store) {
    try {
      const row = store.raw().prepare('SELECT item_id AS itemId FROM sessions WHERE id = ?').get(String(sessionId));
      if (row && row.itemId) iid = String(row.itemId);
    } catch (e) {
      /* 会话取不到不影响 */
    }
  }

  // 1) 必须人工
  const hit = needsHuman(said, cfg);
  if (hit) {
    return { action: 'handoff', source: 'handoff-word', reason: `命中敏感词「${hit}」，交给人工`, query: said };
  }

  // 2) 规则
  let decision = { action: 'ignore' };
  if (useRules) {
    const rc = rules.load();
    decision = rules.decide(said, { sessionId, itemId: iid }, rc);
    if (decision.action === 'reply') {
      return { action: 'reply', source: 'rule:' + (decision.rule.id || ''), text: decision.text, query: said };
    }
    if (decision.action === 'handoff') {
      return { action: 'handoff', source: 'rule:' + (decision.rule.id || ''), reason: '规则要求转人工', query: said };
    }
    if (decision.action === 'ignore') {
      if (decision.reason === 'silent') {
        return { action: 'ignore', source: 'rule:' + (decision.rule.id || ''), reason: '客套话/无信息量，不回', query: said };
      }
      if (!decision.rule) {
        return { action: 'ignore', source: 'rule:none', reason: '没有规则命中，且没有兜底 AI 规则', query: said };
      }
      return { action: 'ignore', source: 'rule:' + (decision.rule.id || ''), reason: '节流：' + (decision.reason || 'cooldown'), query: said };
    }
  }

  // 3) AI
  const gate = rules.canReply(sessionId, rules.load());
  if (!gate.ok) {
    return { action: 'ignore', source: 'throttle', reason: gate.why === 'cooldown' ? '冷却中' : '本小时配额用完', query: said };
  }

  const out = await ai.suggestForSession({
    store,
    sessionId,
    query: said,
    live,
    rules: shopRules(cfg),
    persona: cfg.persona,
    maxLen: cfg.maxLen,
  });

  if (out.mode === 'preview') {
    return { action: 'ai', mode: 'preview', source: 'ai:preview', query: said, prompt: out.messages, note: out.note };
  }
  if (out.mode === 'error') {
    return { action: 'handoff', source: 'ai:error', reason: '模型调用失败：' + out.error, query: said };
  }

  // 4) 自检不过就重写（最多 retryOnCheckFail 次）
  let text2 = out.suggestion;
  let check = out.check;
  let tries = 0;
  while (!check.ok && tries < (cfg.retryOnCheckFail || 0)) {
    tries += 1;
    const again = await ai.chat(
      out.messages.concat([
        { role: 'assistant', content: text2 },
        { role: 'user', content: `这条回复有问题：${check.issues.join('；')}。请重写一句话，别踩这些，别解释。` },
      ])
    );
    if (!again.ok) break;
    text2 = again.text;
    check = ai.selfCheck(text2, { maxLen: cfg.maxLen });
  }

  if (!check.ok) {
    return { action: 'handoff', source: 'ai:check', reason: '自检不过：' + check.issues.join('；'), text: text2, check, query: said };
  }

  const used = usageToday();
  if (cfg.dailyLimit && used >= cfg.dailyLimit) {
    return { action: 'handoff', source: 'ai:quota', reason: `今日自动回复已达上限 ${cfg.dailyLimit}`, text: text2, check, query: said };
  }

  return { action: 'ai', mode: 'live', source: 'ai', text: text2, check, query: said, model: out.model, tries };
}

/** 决策 + 真发（工作台/worker 用） */
async function respondAndSend({ store, api, sessionId, text, session, force = false }) {
  const cfg = aiconf.load();
  const st = await answer({ store, sessionId, text, live: true });
  const sendable = st.action === 'reply' || (st.action === 'ai' && st.text);
  if (!sendable) {
    if (st.action === 'ai' && st.text) {
      return { ...st, sent: false, why: 'ai 未启用' };
    }
    return { ...st, sent: false };
  }
  if (!cfg.enabled && !force) return { ...st, sent: false, why: '自动回复总开关未开（可先在工作台点发送）' };
  if (cfg.dryRun) return { ...st, sent: false, why: 'dryRun' };

  const r = await api.sendText(sessionId, st.text);
  rules.markReplied(sessionId);
  if (st.action === 'ai') bumpUsage(1);
  try {
    // 本地落库的 id 必须和「同步回来那条」一致：平台侧真实 id 是 extJson 里的 hash，
    // 用 `<数字>.PNM` 会和同步记录对不上，界面上就出现两条一样的气泡
    store.saveMessages(sessionId, [{
      messageId: r.localId || r.messageId,
      ts: r.createAt || Date.now(),
      ctype: 1,
      text: st.text,
      senderId: api.selfUnb ? api.selfUnb() : '',
      fromSelf: true,
      raw: r.raw || null,
    }]);
  } catch (_) {}
  return { ...st, sent: true, messageId: r.messageId };
}

module.exports = { answer, respondAndSend, shopRules, needsHuman, usageToday, bumpUsage, USAGE_FILE };
