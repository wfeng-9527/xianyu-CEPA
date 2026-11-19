/**
 * 训练台：提问 → 模型答 → 人工判定/修正 → 归纳成规则 → 再测
 *
 * 数据落在主库的 train_items 表，规则草稿写 rules/rules.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', '..', 'rules', 'rules.json');

function S() {
  return require('../lib/store');
}

function ensure() {
  const db = S().raw();
  db.exec(`
    CREATE TABLE IF NOT EXISTS train_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT,
      model TEXT,
      source TEXT,
      selfcheck TEXT,
      session_id TEXT,
      item_id TEXT,
      item_title TEXT,
      verdict TEXT,
      corrected TEXT,
      tags TEXT,
      note TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_train_verdict ON train_items(verdict);
  `);
  // 老库补列（商品维度是后加的）
  const cols = db.prepare('PRAGMA table_info(train_items)').all().map((c) => c.name);
  for (const [name, type] of [
    ['item_id', 'TEXT'],
    ['item_title', 'TEXT'],
  ]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE train_items ADD COLUMN ${name} ${type}`);
  }
}

const now = () => Date.now();

/** 问一句，拿模型的答（真调用模型，但不发送给客户） */
async function ask({ sessionId, text, itemId, itemTitle }) {
  ensure();
  const q = String(text || '').trim();
  if (!q) throw new Error('问题不能为空');

  const ai = require('./ai');
  const rules = require('./rules');
  const aiconf = require('./aiconf');
  const conf = aiconf.load();
  const ruleConf = rules.load();

  // 商品上下文：优先用显式传入的 itemId，其次从会话里取
  let iid = itemId ? String(itemId) : '';
  let ititle = itemTitle ? String(itemTitle) : '';
  if (!iid && sessionId) {
    const row = S()
      .raw()
      .prepare('SELECT item_id AS itemId, item_title AS title FROM sessions WHERE id = ?')
      .get(String(sessionId));
    if (row && row.itemId) {
      iid = String(row.itemId);
      ititle = row.title || '';
    }
  }

  const r = await ai.suggestForSession({
    store: S(),
    sessionId: sessionId || '__train__',
    query: q,
    itemId: iid,
    itemTitle: ititle,
    k: 5,
    live: true,
    rules: ruleConf.rules || [],
    persona: conf.persona || '',
    maxLen: Number(conf.maxLen) || 120,
  });

  const answer = (r && r.suggestion) || '';
  const check = r && r.check && typeof r.check === 'object' ? JSON.stringify(r.check) : '';
  const item = {
    question: q,
    answer: answer || '',
    model: (r && r.model) || conf.model || '',
    source: (r && r.mode) || '',
    selfcheck: check,
    session_id: sessionId || '',
    item_id: iid,
    item_title: ititle,
    verdict: null,
    corrected: null,
    tags: null,
    note: r && r.error ? String(r.error).slice(0, 500) : r && r.note ? String(r.note).slice(0, 300) : null,
    created_at: now(),
    updated_at: now(),
  };

  const db = S().raw();
  const info = db
    .prepare(
      `INSERT INTO train_items (question,answer,model,source,selfcheck,session_id,item_id,item_title,verdict,corrected,tags,note,created_at,updated_at)
       VALUES (@question,@answer,@model,@source,@selfcheck,@session_id,@item_id,@item_title,@verdict,@corrected,@tags,@note,@created_at,@updated_at)`
    )
    .run(item);
  return { ok: Boolean(answer), id: Number(info.lastInsertRowid), ...item, raw: r };
}

/** 人工判定：好 / 要改 */
function label({ id, verdict, corrected, tags, note }) {
  ensure();
  if (!id) throw new Error('缺少 id');
  const v = verdict === 'good' || verdict === 'bad' ? verdict : null;
  const db = S().raw();
  db.prepare(
    `UPDATE train_items SET verdict=?, corrected=?, tags=?, note=COALESCE(?, note), updated_at=? WHERE id=?`
  ).run(v, corrected ?? null, tags ? JSON.stringify(tags) : null, note ?? null, now(), Number(id));
  return get(id);
}

function get(id) {
  ensure();
  return S().raw().prepare('SELECT * FROM train_items WHERE id=?').get(Number(id)) || null;
}

function list({ limit = 50, verdict } = {}) {
  ensure();
  const db = S().raw();
  if (verdict) {
    return db
      .prepare('SELECT * FROM train_items WHERE verdict=? ORDER BY id DESC LIMIT ?')
      .all(verdict, Number(limit));
  }
  return db.prepare('SELECT * FROM train_items ORDER BY id DESC LIMIT ?').all(Number(limit));
}

function stats() {
  ensure();
  const db = S().raw();
  const total = db.prepare('SELECT COUNT(*) n FROM train_items').get().n;
  const good = db.prepare("SELECT COUNT(*) n FROM train_items WHERE verdict='good'").get().n;
  const bad = db.prepare("SELECT COUNT(*) n FROM train_items WHERE verdict='bad'").get().n;
  const unlabeled = db.prepare('SELECT COUNT(*) n FROM train_items WHERE verdict IS NULL').get().n;
  const fixed = db
    .prepare("SELECT COUNT(*) n FROM train_items WHERE verdict='bad' AND COALESCE(corrected,'')<>''")
    .get().n;
  return { total, good, bad, unlabeled, fixed, rate: total ? Math.round(((good / total) * 1000)) / 10 : 0 };
}

/** 去掉客套与标点，抽出可用于匹配的词 */
const STOP = new Set([
  '你好','您好','在吗','在么','好的','谢谢','嗯','哦','请问','麻烦','一下','这个','那个','你们','我们','可以','吗','呢','啊','吧','么',
]);

function keywords(text) {
  const t = String(text || '').replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
  const parts = t.split(/\s+/).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (p.length < 2) continue;
    if (STOP.has(p)) continue;
    // 中文按 2-4 字滑窗
    if (/[\u4e00-\u9fa5]/.test(p)) {
      for (let n = 2; n <= 4 && n <= p.length; n++) {
        for (let i = 0; i + n <= p.length; i++) out.add(p.slice(i, i + n));
      }
    } else if (p.length >= 2) {
      out.add(p.toLowerCase());
    }
  }
  for (const s of STOP) out.delete(s);
  return [...out];
}

/** 把「判错且有修正」的样本聚成规则草稿 */
function distill({ min = 1 } = {}) {
  ensure();
  const rows = S()
    .raw()
    .prepare("SELECT * FROM train_items WHERE verdict='bad' AND COALESCE(corrected,'')<>'' ORDER BY id ASC")
    .all();

  const groups = new Map();
  for (const r of rows) {
    const kws = keywords(r.question).slice(0, 40);
    // 同一条商品 + 同一条修正答案视为同一类（不同商品的答案本来就可能不同）
    const iid = r.item_id ? String(r.item_id) : '';
    const key = iid + '\u0000' + r.corrected.trim();
    const g = groups.get(key) || { reply: r.corrected.trim(), ids: [], questions: [], kw: new Map(), itemId: iid, itemTitle: r.item_title || '' };
    g.ids.push(r.id);
    g.questions.push(r.question);
    if (!g.itemTitle && r.item_title) g.itemTitle = r.item_title;
    for (const k of kws) g.kw.set(k, (g.kw.get(k) || 0) + 1);
    groups.set(key, g);
  }

  const drafts = [];
  for (const [, g] of groups) {
    if (g.ids.length < min) continue;
    const reply = g.reply;
    // 取出现在半数以上样本里的词作为触发词，最多 6 个
    const need = Math.max(1, Math.ceil(g.ids.length / 2));
    const words = [...g.kw.entries()]
      .filter(([w, n]) => n >= need && w.length >= 2 && !/^[这那个的是了么吗呢啊吧哦哈我你他她]/.test(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([w]) => w);
    const trigger = words.length ? words : keywords(g.questions[0]).slice(0, 3);
    const idBase = (words[0] ? words[0].replace(/[^\w\u4e00-\u9fa5]/g, '') : String(g.ids[0])) || 'x';
    drafts.push({
      id: 'train-' + idBase + (g.itemId ? '-' + String(g.itemId).slice(-6) : ''),
      name: '训练归纳：' + (g.itemTitle ? g.itemTitle.slice(0, 10) + ' · ' : '') + g.questions[0].slice(0, 12),
      priority: 195,
      when: g.itemId ? { itemId: g.itemId, itemTitle: g.itemTitle } : undefined,
      match: { keywords: trigger },
      handoff: false,
      ai: false,
      reply,
      samples: g.ids.length,
      itemId: g.itemId || '',
      itemTitle: g.itemTitle || '',
      questions: g.questions.slice(0, 5),
      trainIds: g.ids,
    });
  }
  drafts.sort((a, b) => b.samples - a.samples);
  return { ok: true, total: rows.length, groups: drafts.length, drafts };
}

/** 把选中的草稿写进 rules/rules.json（同 id 覆盖） */
function apply(drafts) {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('没有要应用的规则');
  const raw = fs.readFileSync(RULES_FILE, 'utf8');
  const conf = JSON.parse(raw);
  const rules = Array.isArray(conf.rules) ? conf.rules : [];
  const existing = new Map(rules.map((r, i) => [r.id, i]));
  let added = 0;
  let updated = 0;
  for (const d of drafts) {
    const rule = {
      id: String(d.id || '').trim() || 'train-' + Date.now(),
      name: String(d.name || '训练归纳').slice(0, 60),
      priority: Number(d.priority) || 120,
      match: d.match && d.match.keywords && d.match.keywords.length ? { keywords: d.match.keywords } : d.match || {},
      handoff: Boolean(d.handoff),
      ai: Boolean(d.ai),
      reply: String(d.reply || '').slice(0, 600),
      source: 'train',
    };
    // 商品维度规则：只对绑定该商品的会话生效
    const wid = d.when && d.when.itemId ? String(d.when.itemId) : d.itemId ? String(d.itemId) : '';
    if (wid) rule.when = { itemId: wid, itemTitle: (d.when && d.when.itemTitle) || d.itemTitle || '' };
    if (existing.has(rule.id)) {
      rules[existing.get(rule.id)] = { ...rules[existing.get(rule.id)], ...rule };
      updated++;
    } else {
      rules.push(rule);
      existing.set(rule.id, rules.length - 1);
      added++;
    }
  }
  rules.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  conf.rules = rules;
  fs.writeFileSync(RULES_FILE, JSON.stringify(conf, null, 2) + '\n', 'utf8');
  require('./rules').load(); // 触发重新读取
  return { ok: true, added, updated, total: rules.length };
}

module.exports = { ensure, ask, label, get, list, stats, distill, apply, keywords, RULES_FILE };
