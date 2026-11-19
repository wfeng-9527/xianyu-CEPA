// 商品（item）+ 保险条款文件 → 可检索的知识
// 表：product_docs（一商品多文档）、product_chunks（切片，用于检索）
const { extractText } = require('../lib/extract');

const CHUNK = 380; // 每片目标字数（条款按「条」整块进，太小会切断上下文）
const OVERLAP = 80;

function ensure(store) {
  const db = store.raw();
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT,
      chars INTEGER DEFAULT 0,
      text TEXT,
      note TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS product_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_item ON product_docs(item_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_item ON product_chunks(item_id);
  `);
}

/** 按句号/分号切，控制每片长度，带 overlap */
function chunkText(text) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[。；！？\n])/);
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= CHUNK) {
      buf += p;
      continue;
    }
    if (buf.trim()) chunks.push(buf.trim());
    buf = (chunks.length ? buf.slice(-OVERLAP) : '') + p;
    while (buf.length > CHUNK * 1.6) {
      chunks.push(buf.slice(0, CHUNK).trim());
      buf = buf.slice(CHUNK - OVERLAP);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length > 8);
}

/** 商品列表：只列「我发布的商品」（按 item_seller_id 过滤），附带文档数与会话数 */
function listProducts(store, opts = {}) {
  ensure(store);
  const db = store.raw();
  const self = String(opts.self || '');
  const rows = db
    .prepare(
      `SELECT s.item_id AS itemId,
              MAX(s.item_title) AS title,
              MAX(s.item_pic) AS pic,
              COUNT(*) AS sessions,
              MAX(COALESCE(s.order_ts, s.last_ts)) AS lastTs
         FROM sessions s
        WHERE COALESCE(s.item_id,'') <> ''
          -- 只列「我发布的商品」：
          --   卖家明确是自己 → 是我的商品
          --   卖家未知（早期 mtop 会话没有商品归属）→ 只有产生过成交（orders 来自 sold 列表）才算我的
          --   卖家是别人（我在买家那边咨询/购买的商品）→ 不列
          AND ( COALESCE(s.item_seller_id,'') = ?
                OR ( COALESCE(s.item_seller_id,'') = ''
                     AND s.item_id IN (SELECT item_id FROM orders) ) )
        GROUP BY s.item_id
        ORDER BY lastTs DESC`
    )
    .all(self);
  const orderAgg = db
    .prepare(
      `SELECT item_id AS itemId, COUNT(*) AS orders, COALESCE(SUM(CAST(price AS REAL)),0) AS amount
         FROM orders GROUP BY item_id`
    )
    .all();
  const docAgg = db.prepare('SELECT item_id AS itemId, COUNT(*) AS docs, SUM(chars) AS chars FROM product_docs GROUP BY item_id').all();
  const om = new Map(orderAgg.map((r) => [String(r.itemId), r]));
  const dm = new Map(docAgg.map((r) => [String(r.itemId), r]));
  return rows.map((r) => ({
    itemId: String(r.itemId),
    title: r.title || '',
    pic: r.pic || '',
    sessions: r.sessions,
    lastTs: r.lastTs,
    orders: (om.get(String(r.itemId)) || {}).orders || 0,
    amount: Math.round(((om.get(String(r.itemId)) || {}).amount || 0) * 100) / 100,
    docs: (dm.get(String(r.itemId)) || {}).docs || 0,
    docChars: (dm.get(String(r.itemId)) || {}).chars || 0,
  }));
}

function getProduct(store, itemId) {
  ensure(store);
  const db = store.raw();
  const base = db
    .prepare(
      `SELECT item_id AS itemId, MAX(item_title) AS title, MAX(item_pic) AS pic,
              COUNT(*) AS sessions, MAX(COALESCE(order_ts,last_ts)) AS lastTs
         FROM sessions WHERE item_id = ?`
    )
    .get(String(itemId));
  const docs = db
    .prepare('SELECT id, name, kind, chars, note, created_at AS createdAt FROM product_docs WHERE item_id = ? ORDER BY id DESC')
    .all(String(itemId));
  const o = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CAST(price AS REAL)),0) AS amount FROM orders WHERE item_id = ?')
    .get(String(itemId));
  return {
    itemId: String(itemId),
    title: (base && base.title) || '',
    pic: (base && base.pic) || '',
    sessions: (base && base.sessions) || 0,
    lastTs: (base && base.lastTs) || 0,
    orders: o.n,
    amount: Math.round(o.amount * 100) / 100,
    docs,
  };
}

/** 保存文档：提取文字 → 切片入库 */
function saveDoc(store, { itemId, name, buffer, text }) {
  ensure(store);
  const db = store.raw();
  let content = text || '';
  let kind = text ? 'text' : 'text';
  let note = null;
  if (!text) {
    const r = extractText(name, buffer);
    content = r.text;
    kind = r.kind;
    note = r.note || null;
  }
  content = String(content || '').replace(/\r/g, '').trim();
  if (content.length < 10) {
    return { ok: false, error: note || '没抽到文字，试试粘贴正文' };
  }
  // 同名文件重复上传 = 重新绑定（不堆重复行）
  const same = db
    .prepare('SELECT id FROM product_docs WHERE item_id = ? AND name = ?')
    .all(String(itemId), String(name || '未命名'));
  let replaced = 0;
  for (const row of same) {
    db.prepare('DELETE FROM product_chunks WHERE doc_id = ?').run(row.id);
    db.prepare('DELETE FROM product_docs WHERE id = ?').run(row.id);
    replaced++;
  }
  const info = db
    .prepare('INSERT INTO product_docs (item_id, name, kind, chars, text, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(String(itemId), String(name || '未命名'), kind, content.length, content, note, Date.now());
  const docId = Number(info.lastInsertRowid);
  const chunks = chunkText(content);
  const ins = db.prepare('INSERT INTO product_chunks (item_id, doc_id, seq, text) VALUES (?,?,?,?)');
  chunks.forEach((c, i) => ins.run(String(itemId), docId, i, c));
  const doc = {
    id: docId,
    itemId: String(itemId),
    name: String(name || '未命名'),
    kind,
    chars: content.length,
    chunks: chunks.length,
    note,
    createdAt: Date.now(),
  };
  // doc 是给前端的完整对象；docId/chars/chunks/note 平铺一份，方便命令行/脚本直接用
  return { ok: true, docId, kind, chars: content.length, chunks: chunks.length, note, replaced, doc };
}

function deleteDoc(store, id) {
  ensure(store);
  const db = store.raw();
  const row = db.prepare('SELECT id, item_id AS itemId FROM product_docs WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: '文档不存在' };
  db.prepare('DELETE FROM product_chunks WHERE doc_id = ?').run(Number(id));
  db.prepare('DELETE FROM product_docs WHERE id = ?').run(Number(id));
  return { ok: true, itemId: String(row.itemId) };
}

/** 客户口语 → 条款用词（没有这层，问「保不保」永远搜不到「保险责任」） */
const SYN = {
  保不保: ['保险责任', '承保', '不予承保', '责任免除', '不承担'],
  赔不赔: ['给付', '保险金', '理赔', '责任免除'],
  保什么: ['保障范围', '保险责任', '包括'],
  不保什么: ['责任免除', '不承担', '不包含'],
  多少钱: ['保费', '保险金额', '元/人'],
  价格: ['保费', '保险金额'],
  便宜: ['保费'],
  优惠: ['保费'],
  多少岁: ['周岁', '年龄'],
  年龄: ['周岁', '年龄'],
  几岁: ['周岁', '年龄'],
  多大: ['周岁', '年龄'],
  免赔: ['免赔额'],
  免赔额: ['免赔额'],
  报销: ['报销', '医疗费用', '发票'],
  医院: ['医院', '公立医院', '二级及以上', '普通部'],
  私立: ['私立医院', '特需', '国际医疗部'],
  急诊: ['急诊', '医院'],
  发票: ['发票', '报销', '税号'],
  保单: ['保单', '电子保单'],
  生效: ['生效', '保险期间', '次日零时'],
  什么时候生效: ['生效', '保险期间'],
  职业: ['职业类别', '1-3类', '不予承保'],
  高空: ['高空作业', '2米'],
  意外: ['意外伤害', '意外事故'],
  猝死: ['猝死', '疾病'],
  住院: ['住院', '医疗'],
  报案: ['报案', '95511'],
  退保: ['退保', '不支持退保'],
  未成年人: ['未成年人', '16周岁'],
  退休: ['退休人员', '不予承保'],
  几个人: ['团体投保人数', '人数不少于', '不少于5人'],
  起投: ['团体投保人数', '不少于5人'],
  人数: ['团体投保人数', '不少于5人'],
  赔付比例: ['赔付比例', '80%'],
  医疗: ['意外医疗', '医疗费用', '社保范围'],
  // 交通工具类：条款里几乎不写「摩托车」「电动车」，都归到「机动车 / 驾驶 / 行驶证」这一组表述
  摩托: ['机动车', '驾驶', '行驶证', '驾驶证', '自驾'],
  摩托车: ['机动车', '驾驶', '行驶证', '驾驶证'],
  电动车: ['机动车', '非机动车', '驾驶', '行驶证'],
  电瓶车: ['非机动车', '驾驶', '行驶证'],
  骑车: ['驾驶', '机动车', '非机动车'],
  自驾: ['自驾', '驾驶', '机动车'],
  开车: ['驾驶', '机动车', '驾驶证'],
  驾车: ['驾驶', '机动车', '驾驶证'],
  无证: ['无有效驾驶证', '驾驶证'],
  酒驾: ['酒后驾车', '酒精含量'],
  驾照: ['驾驶证', '准驾车型'],
  行驶证: ['行驶证', '号牌'],
  违章: ['交通违法', '责任免除'],
};

/** 中文二元组 */
function grams(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）~～…·\-—,.:;!?"'()]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 把问题扩成检索候选词：2-4 字滑窗 + 同义词表（不引分词器，靠"出现了才算"过滤） */
function candidateTerms(query) {
  const q = String(query || '').toLowerCase();
  const flat = q.replace(/[\s，。！？、；：""''（）~～…·\-—,.:;!?"'()]/g, '');
  const out = new Set();
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= flat.length; i++) out.add(flat.slice(i, i + n));
  }
  for (const [k, vals] of Object.entries(SYN)) {
    if (q.includes(k)) for (const v of vals) out.add(String(v).toLowerCase());
  }
  for (const n of q.match(/\d+/g) || []) out.add(n);
  if (/岁/.test(q)) ['周岁', '年龄', '投保范围'].forEach((t) => out.add(t));
  if (/买|投保|购买|参保/.test(q)) ['承保', '投保范围', '不予承保'].forEach((t) => out.add(t));
  return [...out].filter((t) => t.length >= 2 && !/^\d+$/.test(t));
}

/** 条款检索：子串命中 + IDF 加权（中文不切词，用整词出现与否打分） */
function searchClauses(store, itemId, query, k = 4) {
  ensure(store);
  const db = store.raw();
  const rows = db.prepare('SELECT doc_id AS docId, seq, text FROM product_chunks WHERE item_id = ?').all(String(itemId));
  if (!rows.length) return [];
  const terms = candidateTerms(query);
  if (!terms.length) return [];
  const N = rows.length;
  const lower = rows.map((r) => ({ ...r, t: String(r.text).toLowerCase() }));

  // 每个候选词的文档频率（出现在几片里）
  const df = new Map();
  for (const term of terms) {
    let n = 0;
    for (const r of lower) if (r.t.includes(term)) n++;
    if (n) df.set(term, n);
  }
  if (!df.size) return [];

  const scored = [];
  for (const r of lower) {
    let score = 0;
    let hits = 0;
    const matched = [];
    for (const [term, n] of df) {
      if (!r.t.includes(term)) continue;
      const idf = Math.log(1 + N / n);
      // 词越长越可信：2 字 ×1、3 字 ×1.6、4 字 ×2.2
      score += idf * (1 + (term.length - 2) * 0.6);
      hits++;
      if (term.length >= 3) matched.push(term);
    }
    if (!hits) continue;
    score = score / Math.sqrt(String(r.text).length / 100 + 1);
    scored.push({ docId: r.docId, seq: r.seq, score: Math.round(score * 10000) / 10000, hits, matched: matched.slice(0, 6), text: r.text });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  return scored
    .filter((r) => r.score >= Math.max(best * 0.5, 0.15))
    .slice(0, k)
    .map(({ text, docId, seq, score, hits, matched }) => ({ docId, seq, score, hits, matched, text }));
}

module.exports = { ensure, chunkText, listProducts, getProduct, saveDoc, deleteDoc, searchClauses, grams, candidateTerms, SYN };
