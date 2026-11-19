// 风格学习：从本地库里「我发过的消息」反向学出话术风格 + 可检索的问答样本
// 只读库，不发任何网络请求。

const PUNCT = /[\s，。！？、；：""''（）~～…·\-—]/g;

/** 中文二元组集合，用于相似度 */
function bigrams(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(PUNCT, '')
    .replace(/\[[^\]]*\]/g, ''); // 去掉 [表情] 这类占位
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (t.length === 1) set.add(t);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 从库里拉「客户问 → 我答」配对 */
function collectPairs(store, { limit = 4000 } = {}) {
  const db = store.raw();
  if (!db) throw new Error('store 没暴露 raw db');
  const rows = db
    .prepare(
      `SELECT session_id AS sid, ts, text, from_self
         FROM messages
        WHERE COALESCE(text,'') <> '' AND ctype = 1
        ORDER BY session_id, ts ASC`
    )
    .all();
  const pairs = [];
  let lastPeer = null;
  let lastSid = null;
  for (const r of rows) {
    if (r.sid !== lastSid) {
      lastPeer = null;
      lastSid = r.sid;
    }
    if (Number(r.from_self) === 0) {
      lastPeer = r;
      continue;
    }
    if (lastPeer && Number(r.ts) - Number(lastPeer.ts) < 30 * 60 * 1000) {
      pairs.push({
        sid: r.sid,
        q: String(lastPeer.text).trim(),
        a: String(r.text).trim(),
        ts: Number(r.ts),
        gap: Number(r.ts) - Number(lastPeer.ts),
      });
    }
    lastPeer = null;
    if (pairs.length >= limit) break;
  }
  return pairs;
}

/** 统计风格 */
function buildProfile(pairs) {
  const answers = pairs.map((p) => p.a);
  const n = answers.length || 1;
  const len = answers.map((a) => a.replace(PUNCT, '').length).sort((x, y) => x - y);
  const median = len.length ? len[Math.floor(len.length / 2)] : 0;
  const avg = len.length ? Math.round(len.reduce((s, x) => s + x, 0) / len.length) : 0;

  const count = (pred) => answers.filter(pred).length;
  const rate = (k) => Math.round((k / n) * 1000) / 10; // 百分比，一位小数

  const starters = new Map();
  for (const a of answers) {
    const head = a.slice(0, 2);
    starters.set(head, (starters.get(head) || 0) + 1);
  }
  const topStarters = [...starters.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([k, v]) => ({ k, n: v, pct: rate(v) }));

  // 完整重复句（他的模板）
  const exact = new Map();
  for (const a of answers) exact.set(a, (exact.get(a) || 0) + 1);
  const templates = [...exact.entries()]
    .filter(([, c]) => c >= 3)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([text, n2]) => ({ text, n: n2 }));

  const tones = {
    亲: rate(count((a) => a.includes('亲'))),
    哦: rate(count((a) => a.includes('哦'))),
    哈: rate(count((a) => a.includes('哈'))),
    呢: rate(count((a) => a.includes('呢'))),
    波浪号: rate(count((a) => a.includes('~') || a.includes('～'))),
    感叹号: rate(count((a) => a.includes('!') || a.includes('！'))),
    问句: rate(count((a) => /[?？]/.test(a))),
    表情占位: rate(count((a) => /\[[^\]]{1,6}\]/.test(a))),
  };

  return {
    samples: answers.length,
    medianLen: median,
    avgLen: avg,
    maxLen: len.length ? len[len.length - 1] : 0,
    p90Len: len.length ? len[Math.floor(len.length * 0.9)] : 0,
    topStarters,
    templates,
    tones,
  };
}

/** 检索相似历史问答 */
function retrieve(pairs, query, k = 5) {
  const q = bigrams(query);
  if (!q.size) return [];
  const scored = [];
  for (const p of pairs) {
    const s = jaccard(q, bigrams(p.q));
    if (s > 0.12) scored.push({ ...p, score: Math.round(s * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score || b.ts - a.ts);
  // 同一条答案只留最高分，避免 few-shot 里三条一模一样
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (seen.has(s.a)) continue;
    seen.add(s.a);
    out.push(s);
    if (out.length >= k) break;
  }
  return out;
}

/** 生成自然语言风格卡（直接进 system prompt） */
function styleCard(profile) {
  const t = profile.tones;
  const lines = [];
  lines.push('【我的回复风格（从 ' + profile.samples + ' 条历史回复统计）】');
  lines.push(`- 长度：中位数 ${profile.medianLen} 字，90% 在 ${profile.p90Len} 字以内。说清就停，不寒暄不废话。`);
  lines.push(`- 称呼：${t.亲 > 30 ? '常用「亲」开头' : '不主动叫「亲」'}；${t.问句 > 30 ? '经常用问句引导客户补充信息' : '少用问句，直接给结论'}。`);
  lines.push(`- 语气词：哦 ${t.哦}%、哈 ${t.哈}%、呢 ${t.呢}%、波浪号 ${t.波浪号}%、感叹号 ${t.感叹号}%。`);
  if (profile.topStarters.length) {
    lines.push('- 常见开头：' + profile.topStarters.map((s) => `「${s.k}」${s.pct}%`).join('、') + '。');
  }
  if (profile.templates.length) {
    lines.push('- 我的标准话术（可直接复用）：');
    for (const tpl of profile.templates.slice(0, 5)) lines.push(`  · ${tpl.text}`);
  }
  return lines.join('\n');
}

module.exports = { collectPairs, buildProfile, retrieve, styleCard, bigrams, jaccard };
