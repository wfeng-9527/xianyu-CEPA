// AI 回复层：风格卡 + 历史样例检索 + 硬性红线自检
// 与 LLM 之间的接口走 OpenAI 兼容的 /chat/completions（env: XY_AI_BASE_URL / XY_AI_KEY / XY_AI_MODEL）
// 没配 key 时只产出 prompt（preview 模式），不会瞎编一个回复。

const fs = require('fs');
const path = require('path');
const style = require('./style');
const aiconf = require('./aiconf');

const ROOT = path.resolve(__dirname, '../..');
const STYLE_FILE = path.join(ROOT, 'data/style.json');

let cache = null;
function loadStyle(store, { maxAgeMs = 6 * 3600 * 1000 } = {}) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  let profile = null;
  let card = '';
  let pairs = [];
  if (store) {
    pairs = style.collectPairs(store, { limit: 4000 });
    profile = style.buildProfile(pairs);
    card = style.styleCard(profile);
  } else if (fs.existsSync(STYLE_FILE)) {
    const j = JSON.parse(fs.readFileSync(STYLE_FILE, 'utf8'));
    profile = j.profile;
    card = j.card;
    pairs = j.pairsData || [];
  }
  cache = { at: Date.now(), profile, card, pairs };
  return cache;
}
function invalidate() {
  cache = null;
}

/** 禁止出现的东西：平台禁忌 + 我这个店的事实约束 */
const BANNED = [
  { re: /(微信|VX|vx|QQ|加我|私聊)/, why: '引导站外联系方式，闲鱼会处罚' },
  { re: /(保证|一定|包赔|百分百|绝对)/, why: '绝对化承诺，保险类话术风险高' },
  { re: /(http|www\.|https)/, why: '消息里不要放外链' },
  { re: /(退款|返现|补偿)/, why: '涉及钱的承诺必须人工确认' },
];

function selfCheck(text, { maxLen = 120 } = {}) {
  const issues = [];
  if (!text || !text.trim()) issues.push('空回复');
  const len = text.replace(/\s/g, '').length;
  if (len > maxLen) issues.push(`太长（${len} 字 > ${maxLen}）`);
  for (const b of BANNED) if (b.re.test(text)) issues.push(b.why);
  if (/[?？]$/.test(text.trim())) issues.push('用问句结尾，可能让客户反问');
  return { ok: issues.length === 0, issues, len };
}

function buildSystemPrompt({ card, rules, facts, persona }) {
  const parts = [];
  parts.push(persona && persona.trim()
    ? persona.trim()
    : '你是闲鱼店铺的客服，替店主回复买家消息。你要模仿店主的说话方式，不要像机器人。');
  parts.push(card || '');
  if (rules && rules.length) {
    const fmt = (r) => {
      if (typeof r === 'string') return '- ' + r;
      if (!r || typeof r !== 'object') return '';
      const kw = (r.match && Array.isArray(r.match.keywords) ? r.match.keywords : []).slice(0, 6).join('/');
      const when = kw ? `客户说「${kw}」时` : r.name ? r.name : '固定话术';
      if (r.handoff) return `- ${when} → 转人工，别自己答`;
      if (r.silent) return `- ${when} → 不用回`;
      if (r.reply) return `- ${when} → 回「${String(r.reply).replace(/\s+/g, ' ').slice(0, 120)}」`;
      return `- ${when}`;
    };
    parts.push(
      '【必须遵守的店铺规则（命中这些就用给定话术，别自己组织）】\n' +
        rules.slice(0, 30).map(fmt).filter(Boolean).join('\n')
    );
  }
  if (facts && facts.length) {
    parts.push(
      '【已知事实（只能依据这些回答）】\n' +
        facts.map((f) => '- ' + f).join('\n') +
        '\n如果事实里没有答案，就说「这个我确认下」，不要自己编条款、保额、责任范围。'
    );
  }
  parts.push(
    [
      '【硬性红线】',
      '- 不主动引导加微信/QQ/站外交易',
      '- 不说「保证/一定/包赔/百分百」这类绝对化承诺',
      '- 不发链接',
      '- 涉及退款、赔付、议价，一律回「这个我问下」或走人工，不自己答应',
      '- 只输出回复正文，不要解释、不要加引号、不要自称 AI',
    ].join('\n')
  );
  return parts.join('\n\n');
}

/** 组装最终的 messages 数组 */
function buildPrompt({ card, examples, history, query, rules, facts, persona }) {
  const system = buildSystemPrompt({ card, rules, facts, persona });
  const user = [];
  if (examples && examples.length) {
    user.push('【我以前遇到类似问题的回复，照这个语气写】');
    for (const ex of examples) {
      user.push(`客户：${ex.q}\n我：${ex.a}`);
    }
    user.push('');
  }
  if (history && history.length) {
    user.push('【当前对话最近的几条】');
    for (const h of history) user.push(`${h.fromSelf ? '我' : '客户'}：${h.text}`);
    user.push('');
  }
  user.push('【现在客户说】');
  user.push(query);
  user.push('');
  user.push('直接写出我该回的那句话（可以 1-2 条，用换行分隔，不要编号）。');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user.join('\n') },
  ];
}

/**
 * 调模型。conf.protocol：
 *   'anthropic' —— POST {base}/v1/messages（harness 的 DeepSeek 卡片默认走这条：https://api.deepseek.com/anthropic）
 *   'openai'    —— POST {base}/chat/completions
 * messages 里如果有 role=system，anthropic 需要挪到顶层 system 字段。
 */
async function chat(messages, { timeoutMs = 30000 } = {}) {
  const conf = aiconf.load();
  if (conf.mock) {
    return { ok: true, text: '好的，我这边看下马上回您', model: 'mock' };
  }
  const key = conf.apiKey;
  if (!key) {
    return {
      skipped: true,
      reason: conf.source === 'harness'
        ? 'harness 凭据里没找到 DEEPSEEK_API_KEY（' + aiconf.harnessInfo().credFile + '）'
        : '未配置 API Key（AI 页或 data/ai-config.json）',
    };
  }
  const base = (conf.baseUrl || aiconf.HARNESS.baseUrl).replace(/\/$/, '');
  const model = conf.model || 'deepseek-chat';
  const protocol = conf.protocol === 'openai' ? 'openai' : 'anthropic';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let url;
    let headers;
    let body;
    if (protocol === 'anthropic') {
      const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const rest = messages.filter((m) => m.role !== 'system');
      url = base + '/v1/messages';
      headers = {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      };
      body = {
        model,
        max_tokens: conf.maxTokens || 300,
        temperature: conf.temperature,
        ...(sys ? { system: sys } : {}),
        messages: rest.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      };
    } else {
      url = base + '/chat/completions';
      headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
      body = { model, messages, temperature: conf.temperature, max_tokens: conf.maxTokens };
    }

    const res = await fetch(url, { method: 'POST', signal: ac.signal, headers, body: JSON.stringify(body) });
    const txt = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 300)}`, protocol, url };
    const j = JSON.parse(txt);
    let text = '';
    if (protocol === 'anthropic') {
      text = Array.isArray(j.content)
        ? j.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        : '';
    } else {
      text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    }
    return { ok: true, text: String(text).trim(), model: j.model || model, protocol, usage: j.usage };
  } catch (e) {
    return { ok: false, error: e.message, protocol };
  } finally {
    clearTimeout(timer);
  }
}

/** 给定会话，产出「建议回复」 */
async function suggestForSession({ store, sessionId, query, historyLimit = 8, k = 5, live = false, rules: ruleList = [], persona = '', maxLen = 120, itemId = '', itemTitle = '' }) {
  const st = loadStyle(store);
  const db = store.raw();

  const rows = db
    .prepare('SELECT session_id, ctype, text, from_self, ts FROM messages WHERE session_id = ? ORDER BY ts DESC LIMIT 40')
    .all(String(sessionId))
    .reverse()
    .filter((r) => Number(r.ctype) === 1 && String(r.text || '').trim());

  const last = rows[rows.length - 1];
  const said = (query || (last ? last.text : '')).trim();
  if (!said) return { ok: false, error: '这个会话还没有可读的文本消息' };

  const history = rows.slice(-historyLimit).map((r) => ({ fromSelf: Number(r.from_self) === 1, text: r.text }));
  const examples = style.retrieve(st.pairs, said, k);

  // 事实：商品名 + 绑定的方案（保障内容/须知/条款）+ 该商品条款文件的摘录
  const sessRow =
    db.prepare('SELECT item_id AS itemId, item_title AS title, with_id FROM sessions WHERE id = ?').get(String(sessionId)) || {};
  // 训练台等场景可以显式指定商品（会话里没有商品信息时也能按商品答）
  const sess = itemId
    ? { ...sessRow, itemId: String(itemId), title: itemTitle || sessRow.title || '' }
    : sessRow;
  const facts = [];
  if (sess.title) facts.push('客户问的商品是「' + sess.title + '」');

  // 商品 → 保险方案（工作台「保险平台」里绑定的那一个）
  let plan = null;
  try {
    if (sess.itemId) {
      plan = store.planForItem(sess.itemId);
      if (plan) {
        const kw = said.replace(/[，。？！、,?!\s]/g, '');
        const hitCount = (s) => {
          let n = 0;
          for (const ch of new Set(kw)) if (String(s).includes(ch)) n += 1;
          return n;
        };
        // 保障内容做成「项目：保额」的短表，按相关性排序取前 12 条
        const cov = (plan.coverage || []).map((c) => ({
          line: `${c.name}：${c.value}`,
          s: hitCount(c.name) * 2 + (c.name.length <= 12 ? 1 : 0),
        }));
        cov.sort((a, b) => b.s - a.s);
        const covText = cov.slice(0, 12).map((x) => '· ' + x.line).join('\n');

        const tierCount = plan.tiers ? plan.tiers.length : 0;
        const prodName = tierCount
          ? String(plan.tiers[0].name || plan.name).replace(/[\s\-—_·:：]*计划[\s\S]*$/, '').trim() || plan.name
          : plan.name;
        const lines = [
          `这个商品绑定的保险方案是「${prodName}」（${plan.company || ''}，方案编码 ${plan.productCode || plan.planCode}）。`,
          tierCount > 1
            ? `该方案有 ${tierCount} 个保额档（${plan.tiers.map((t) => String(t.name).replace(/^.*?计划/, '计划')).slice(0, 8).join('、')}），客户拍的是哪一档看订单规格；保障项目各档相同，只是保额不同。`
            : '',
          `承保年龄：出生满 ${plan.minAge || 0} 天 ~ ${plan.maxAge || 0} 周岁；基准价 ${plan.basePrice || 0} 元起。`,
          covText ? '保障内容（节选）：\n' + covText : '',
          Array.isArray(plan.clauseSections) && plan.clauseSections.length
            ? `条款依据：这个方案的条款集共 ${plan.clausePages || '?'} 页，装了 ${plan.clauseSections.length} 个条款——` +
              plan.clauseSections.map((s) => `《${s.name}》`).join('、') +
              (Array.isArray(plan.clauseGarbled) && plan.clauseGarbled.length
                ? `（其中第 ${plan.clauseGarbled.join('、')} 页是扫描/字体异常页，已用 OCR 还原，个别字可能不准）`
                : '') +
              (plan.clauseOcr && Array.isArray(plan.clauseOcr.pages) && plan.clauseOcr.pages.length
                ? `（第 ${plan.clauseOcr.pages.join('、')} 页是 OCR 识别来的，可以据此回答，但涉及时效/费率/免责细节时加一句「以保单条款为准」）`
                : '') +
              '。回答保障范围/免责时点明依据，例如「按《附加旅行住院津贴保险》」。'
            : '',
          '涉及保障范围、保额、年龄、免责的回答，只能以这个方案为准，不确定就说「这个我确认下」。',
        ].filter(Boolean);
        facts.push(lines.join('\n'));

        // 须知：按问题相关性挑行（不再死取前 40 行），保证「摩托→自驾/机动车」这类能捞到
        if (plan.notice) {
          let terms = [];
          try {
            terms = require('./products').candidateTerms(said).filter((t) => t.length >= 2).slice(0, 40);
          } catch (e) {
            terms = [];
          }
          const noticeLines = String(plan.notice).split('\n').map((l) => l.trim()).filter(Boolean);
          const rank = (line) => {
            const t = line.toLowerCase();
            let s = 0;
            for (const term of terms) if (t.includes(term)) s += term.length >= 3 ? 2 : 1;
            return s;
          };
          const scored = noticeLines.map((line, i) => ({ line, i, s: rank(line) }));
          const hitLines = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
          // 命中的放前面，再补几条开头（整体须知通常就千把字，够用）
          const picked = [
            ...hitLines.sort((a, b) => a.i - b.i).map((x) => x.line),
            ...scored.filter((x) => !hitLines.includes(x)).slice(0, 18).map((x) => x.line),
          ].join('\n');
          facts.push('投保须知（按问题挑出的相关条目在前）：\n' + picked);
        }
      }
    }
  } catch (e) {
    /* 方案模块不可用不影响主流程 */
  }

  try {
    const prod = require('./products');
    if (sess.itemId) {
      const hits = prod.searchClauses(store, sess.itemId, said, 3);
      for (const h of hits) facts.push('保险条款原文（' + h.score + '）：' + h.text);
      if (hits.length) facts.push('以上条款摘录来自该商品绑定的条款文件，回答「保不保」必须以此为准');
      facts.push(
        '判断口径（重要）：条款基本不会逐字写「摩托车 / 电动车 / 自行车 / 自驾」这类具体交通工具，' +
          '遇到这类问题就按条款里「机动车 / 驾驶 / 行驶证 / 驾驶证 / 酒后驾车」的表述判断，**直接给结论、不要反问**：' +
          '① 摩托车、汽车、自驾 → 属于保障范围，需持有效驾驶证、车辆有有效行驶证；酒后驾驶、无证驾驶、车辆无有效行驶证期间不保；' +
          '② 电动自行车这类非机动车 → 按普通意外处理，不要求驾驶证/行驶证（除非条款明写）；' +
          '③ 只有条款里完全没有相关表述时，才说「这个我确认下」。'
      );
    }
  } catch (e) {
    /* 条款模块不可用不影响主流程 */
  }

  const messages = buildPrompt({ card: st.card, examples, history, query: said, rules: ruleList, facts, persona });

  let out = { ok: true, mode: 'preview', sessionId: String(sessionId), query: said, examples, messages };
  if (live) {
    const r = await chat(messages);
    if (r.skipped) out = { ...out, mode: 'preview', note: r.reason };
    else if (!r.ok) out = { ...out, mode: 'error', error: r.error };
    else {
      out = { ...out, mode: 'live', suggestion: r.text, check: selfCheck(r.text, { maxLen }), model: r.model };
    }
  }
  return out;
}

module.exports = { loadStyle, invalidate, selfCheck, buildSystemPrompt, buildPrompt, chat, suggestForSession, BANNED };
