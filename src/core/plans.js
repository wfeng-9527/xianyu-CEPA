'use strict';
/**
 * 保险方案同步：把旅云保的后台产品目录拉成本地结构，供「商品 ↔ 方案」绑定与 AI 条款检索使用。
 *
 * 两级：
 *   syncCatalog()  只拉目录（planCode / 名称 / 公司 / 险种 / 年龄 / 条款文件名 / 基准价），快
 *   syncDetail()   逐个拉方案内容（coverage 表）+ 投保须知 + 条款文本 + 价目表，慢
 */
const ly = require('../lib/lyybao');
const { pdfToText } = require('../lib/extract');
const fs = require('fs');
const os = require('os');
const path = require('path');

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&yen;/g, '¥')
    .replace(/&nbsp;/g, ' ');
}

/** HTML → 纯文本（保留段落断行，去掉 style/script） */
function htmlToText(html) {
  let s = decodeEntities(html);
  s = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h\d)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '· ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&[a-z]+;/gi, '');
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 条款集清洗 + 分节。
 * 旅云保的「条款文件」不是单一条款，而是一本**条款集**（如 平安旅意险特惠升级版 = 34 页，
 * 里面装了主险 + 8 个附加险，每个附加险各自有银保监注册号）。
 * 这里做两件事：
 *   1) 找出识别失败的页（CID 字体没有 ToUnicode 时抽出来是控制字符/乱码），替换成标记，
 *      避免模型把乱码当条款内容；
 *   2) 按「XX保险（互联网版）条款 注册号：C0000…」切成小节，供回答时指明是哪个条款。
 * @returns {{text:string, sections:{name:string,regNo:string,chars:number}[], garbledPages:number[], pages:number}}
 */
/** 条款标题 + 银保监注册号（各家的排版不统一：有的写「条款 注册号：」，有的只有「注册编号：」） */
const CLAUSE_HEAD_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{4,60}?(?:保险|责任险))\s*[（(]?\s*互联网版\s*[）)]?\s*(?:条款)?\s*注册(?:编号|号)\s*[:：]?\s*[^\n]{0,12}?([A-Z0-9]{8,})/g;

function cleanClause(raw, opts = {}) {
  const ocrMap = opts.ocr || null; // { 页码: 识别出的正文 }
  const src = String(raw || '');
  const marks = [...src.matchAll(/(\d{1,2})\/(\d{1,2})(?!\d)/g)].filter((m) => Number(m[1]) <= 200 && Number(m[2]) <= 200);
  const total = marks.length ? Number(marks[marks.length - 1][2]) : 0;
  const out = [];
  const garbled = [];
  const ocrPages = [];
  if (!marks.length) {
    out.push(src);
  } else {
    out.push(src.slice(0, marks[0].index));
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
      let page = src.slice(start, end);
      const compact = page.replace(/\s+/g, '');
      const cjk = (compact.match(/[\u4e00-\u9fa5]/g) || []).length;
      const ratio = compact.length ? cjk / compact.length : 0;
      if (compact.length > 120 && ratio < 0.55) {
        const pageNo = Number(marks[i][1]);
        const ocrText = ocrMap && ocrMap[pageNo];
        if (ocrText && String(ocrText).trim().length > 20) {
          ocrPages.push(pageNo);
          page = `〔第 ${pageNo} 页 OCR 识别〕\n${String(ocrText).trim()}\n`;
        } else {
          garbled.push(pageNo);
          page = `〔第 ${marks[i][1]} 页文字识别失败，内容见原始 PDF〕`;
        }
      }
      out.push(page);
    }
  }
  let text = out.join('').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  text = tidyClause(text);

  const sections = [];
  // 目录区 = 第一页页码标记（「1/34」）之前的部分，形如
  //   「…保险\nC0000…」或「…保险\n1/34」（个别条款标题页印的是主险注册号）
  const firstMark = text.search(/\b1\s*\/\s*\d{1,3}\b/);
  const TOC_END = firstMark > 40 ? firstMark : 300;
  const tocBlock = text.slice(0, TOC_END);
  const toc = [];
  const nameRe = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{4,60}?(?:保险|责任险))(?:\s*\n\s*([A-Z0-9]{8,}))?/g;
  let m;
  nameRe.lastIndex = 0;
  while ((m = nameRe.exec(tocBlock))) {
    const name = m[1].trim().replace(/^.*?条款集/, '');
    if (name.length < 6) continue;
    if (!toc.some((x) => x.name === name)) toc.push({ name, regNo: m[2] || '' });
  }
  // 正文里带注册号的标题（目录漏掉的补进来）
  const reBody = new RegExp(CLAUSE_HEAD_RE.source, CLAUSE_HEAD_RE.flags);
  const bodyHits = [];
  reBody.lastIndex = 0;
  while ((m = reBody.exec(text))) bodyHits.push({ name: m[1].trim(), regNo: m[2], index: m.index });
  const shortName = (s) => String(s).replace(/^中国平安(财产)?保险股份有限公司/, '');
  for (const h of bodyHits) {
    const sn = shortName(h.name);
    if (!toc.some((x) => sn.includes(x.name) || x.name.includes(sn))) toc.push({ name: sn, regNo: h.regNo });
  }

  // 每个条款在正文里的起点：找不到就说明这段正文没进文本层（或该页 OCR 也没救回来）
  const positioned = toc.map((it) => {
    const sn = shortName(it.name);
    const needles = [
      it.name,
      sn,
      sn.replace(/[（(].*?[）)]/g, ''),
      sn.replace(/平安产险|附加/g, ''),
      sn.replace(/[（(].*?[）)]/g, '').slice(-8),
      sn.replace(/[（(].*?[）)]/g, '').slice(-6),
    ].filter((x) => x && x.length >= 5);
    let at = -1;
    for (const n of needles) {
      at = text.indexOf(n, TOC_END);
      if (at >= 0) break;
    }
    // 标题行缺失时，用条款里的特征词定位正文（如「住院津贴」「救护车」）
    if (at < 0) {
      const core = sn
        .replace(/平安产险|平安|附加|旅行|期间|意外伤害|保险|条款|[（）()]/g, ' ')
        .split(/\s+/)
        .filter((x) => x.length >= 3);
      for (const k of core) {
        const i2 = text.indexOf(k, TOC_END);
        if (i2 >= 0) {
          at = i2;
          break;
        }
      }
    }
    return { ...it, index: at, missing: at < 0 };
  });
  const found = positioned.filter((x) => !x.missing).sort((a, b) => a.index - b.index);
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].index : text.length;
    sections.push({ name: found[i].name, regNo: found[i].regNo, chars: end - found[i].index });
  }
  for (const x of positioned.filter((y) => y.missing)) {
    sections.push({ name: x.name, regNo: x.regNo, chars: 0, missing: true });
  }
  return { text, sections, garbledPages: garbled, ocrPages, pages: total };
}

/** OCR 出来的文字常带「字 与 字 之 间 的 空 格」，这里收掉；顺手全角引号统一 */
function tidyClause(text) {
  return String(text || '')
    .replace(/([\u4e00-\u9fa5，。；：、（）【】《》「」])\s+(?=[\u4e00-\u9fa5，。；：、（）【】《》「」])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/** 条款里出现过的「注册号 → 条款名」清单（用于向客户说明依据） */
function clauseList(clauseText) {
  const re = CLAUSE_HEAD_RE;
  const out = [];
  let m;
  while ((m = re.exec(String(clauseText || '')))) out.push({ name: m[1].trim(), regNo: m[2] });
  return out;
}

/**
 * 方案表（scheme）解析。旅云保的表是「保障项目 × 计划一~六」的矩阵：
 * 第一行是列名（保障内容 | 计划一 | 计划二 …），后面每行是项目名 + 各计划的值。
 * @returns {{columns: string[], rows: {group:string,name:string,values:string[]}[]}}
 */
function parseScheme(raw) {
  const html = decodeEntities(raw);
  if (!html) return { columns: [], rows: [] };
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const rows = [];
  let columns = [];
  let group = '';
  for (const tr of trs) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map((td) => htmlToText(td).trim());
    if (!cells.length) continue;

    const headIdx = cells.findIndex((c) => /^计划[一二三四五六七八九十\d]+$/.test(c));
    if (headIdx >= 0 && !columns.length) {
      columns = cells.slice(headIdx);
      continue;
    }
    if (cells.length === 1 || (cells.length === 2 && !cells[1])) {
      group = cells[0];
      continue;
    }
    const name = cells[0];
    if (!name || /^(保障内容|保险方案|保障项目)$/.test(name)) continue;
    rows.push({ group, name, values: cells.slice(1) });
  }
  return { columns, rows };
}

/** 计划名里的「计划几」→ 矩阵列下标（计划一=0） */
function planColumnIndex(planName) {
  const m = /计划([一二三四五六七八九十]|\d+)/.exec(String(planName || ''));
  if (!m) return 0;
  const cn = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 七: 6, 八: 7, 九: 8, 十: 9 };
  if (cn[m[1]] !== undefined) return cn[m[1]];
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n - 1 : 0;
}

/** 按计划选列，输出 [{group,name,value}] */
function pickColumn(scheme, planName) {
  const idx = planColumnIndex(planName);
  const cols = (scheme && scheme.columns) || [];
  const col = cols[idx] || '';
  const out = [];
  for (const r of (scheme && scheme.rows) || []) {
    const v = r.values[idx] || r.values[0] || '';
    if (!v || /^[-—/]+$/.test(v)) continue;
    out.push({ group: r.group || '', name: r.name, value: v, column: col });
  }
  return out;
}

/** 拉目录：companyId × classId 全跑一遍，按 planCode 去重 */
async function syncCatalog(store, { custId } = {}) {
  const info = await ly.userInfo().catch(() => null);
  const uid = custId || (info && info.userInfo && info.userInfo.userId) || 255753;

  const seen = new Map();
  const errors = [];
  for (const line of ly.LINES) {
    try {
      const list = await ly.custPlans(uid, line.companyId, line.classId);
      if (!Array.isArray(list)) continue;
      for (const p of list) {
        const code = String(p.PLANCODE || p.planCode || '');
        if (!code || seen.has(code)) continue;
        seen.set(code, {
          planCode: code,
          name: String(p.PLANNAME || ''),
          companyId: line.companyId,
          company: String(p.nickName || line.company),
          classId: line.classId,
          className: line.cls,
          nick: String(p.nickName || ''),
          minAge: Number(p.minAge || 0),
          maxAge: Number(p.maxAge || 0),
          clauseFile: String(p.INSCLAUSEFILE || ''),
          introFile: String(p.INTROFILE || ''),
          basePrice: Number(p.defaultPrice || p.price || 0) || 0,
          realPercent: Number(p.REALPERCENT || 0) || 0,
          priceTable: [],
          feeTable: [],
          coverage: [],
          notice: '',
          clause: '',
        });
      }
    } catch (e) {
      errors.push(`${line.company}/${line.cls}: ${e.message}`);
    }
  }

  const plans = [...seen.values()];
  for (const p of plans) store.savePlan(p);
  return { total: plans.length, errors, userId: uid };
}

/** 拉单个计划的详情：方案内容 + 须知 + 条款 + 价目 */
async function syncDetail(store, planCode, { clausePdf = true, ocr = true, force = false } = {}) {
  const base = store.getPlan(planCode) || { planCode };
  const out = { ...base, planCode: String(planCode) };

  const d = await ly.planDetail(planCode).catch(() => null);
  if (d) {
    const scheme = parseScheme(d.scheme);
    out.coverage = pickColumn(scheme, out.name || (base && base.name) || '');
    out.notice = htmlToText(d.attenions || d.attenions_c || '');
    out.clause = htmlToText(d.attenions_provisionc || '');
    if (d.introduction) out.intro = htmlToText(d.introduction);
  }

  // 条款正文：接口里通常为空，真条款在 PDF 里
  const clauseFile = out.clauseFile || (base && base.clauseFile) || '';
  if (clausePdf && (force || !out.clause || out.clause.length < 200) && clauseFile) {
    try {
      const r = await ly.fetchBuffer(clauseFile);
      if (r.status === 200 && r.buf && /%PDF-/.test(r.buf.slice(0, 8).toString('latin1'))) {
        const text = pdfToText(r.buf);
        if (text && text.trim().length > 100) {
          let clean = cleanClause(text);
          // 有页因为字体缺 ToUnicode 认不出来 → 渲染成图 OCR 补上
          if (ocr && clean.garbledPages && clean.garbledPages.length) {
            let tmp = '';
            try {
              const ocrtool = require('../lib/ocrtool');
              if (ocrtool.caps().ok) {
                tmp = path.join(os.tmpdir(), 'clause-' + String(planCode) + '-' + Date.now() + '.pdf');
                fs.writeFileSync(tmp, r.buf);
                const got = await ocrtool.ocrPdf(tmp, clean.garbledPages, { dpi: 300 });
                if (got.ok && got.result && got.result.length) {
                  const map = {};
                  for (const x of got.result) if (x.text && x.text.length > 20) map[x.page] = x.text;
                  if (Object.keys(map).length) {
                    clean = cleanClause(text, { ocr: map });
                    out.clauseOcr = { pages: clean.ocrPages, dpi: got.dpi, doneAt: Date.now() };
                  }
                }
              }
            } catch (_) {
              /* OCR 失败就保留原样（标记成识别失败），不影响其它页 */
            } finally {
              if (tmp) fs.unlink(tmp, () => {});
            }
          }
          out.clause = clean.text;
          out.clauseSections = clean.sections;
          out.clausePages = clean.pages;
          out.clauseGarbled = clean.garbledPages;
        }
      }
    } catch (_) { /* 条款拿不到不影响主流程 */ }
  }

  const fee = await ly.planFee(planCode).catch(() => null);
  if (Array.isArray(fee)) out.feeTable = fee.map((f) => ({
    start: Number(f.STARTNUMBER || 0),
    end: Number(f.ENDNUMBER || 0),
    price: Number(f.PRICE || 0),
    id: f.PRICEID,
  }));

  const tr = await ly.timeRange(planCode).catch(() => null);
  if (Array.isArray(tr)) {
    out.priceTable = tr.map((t) => ({ days: Number(t.INDEXVAL || 0), price: Number(t.BASEPRICE || 0) }));
    if (!out.basePrice && out.priceTable.length) out.basePrice = out.priceTable[0].price;
  }

  store.savePlan(out);
  return out;
}

/** 把方案的须知/条款文本拼成一段（喂 AI 用） */
function planText(plan) {
  if (!plan) return '';
  const parts = [];
  if (plan.name) parts.push('产品：' + plan.name);
  if (plan.company) parts.push('承保公司：' + plan.company);
  if (plan.minAge || plan.maxAge) parts.push(`承保年龄：出生满 ${plan.minAge || 0} 天 ~ ${plan.maxAge || 0} 周岁`);
  if (plan.coverage && plan.coverage.length) {
    parts.push('保障内容：\n' + plan.coverage.map((c) => `- ${c.group ? c.group + ' / ' : ''}${c.name}：${c.value}`).join('\n'));
  }
  if (plan.notice) parts.push('投保须知：\n' + plan.notice);
  if (plan.clause) parts.push('条款要点：\n' + plan.clause);
  return parts.join('\n\n');
}

module.exports = { syncCatalog, syncDetail, planText, parseScheme, pickColumn, planColumnIndex, htmlToText, cleanClause, clauseList };
