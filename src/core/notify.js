/**
 * 出单后给客户发保单邮件
 *
 * 链路：lyybao 取 PDF → 拼模板 → mailer 发信（附件）→ 结果落 outbox/events
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mailer = require('../lib/mailer');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'policies');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function ly() {
  return require('../lib/lyybao');
}

/** 按订单号取保单 PDF（Buffer）；订单已撤单时平台返回 0 字节 */
async function policyPdf(orderNo) {
  const lib = ly();
  await lib.ensure();
  const r = await lib.fetchBuffer(
    `/ins/business/rest/policyFileDownLoad/downPolicyByOrder.do?orderNo=${encodeURIComponent(orderNo)}`
  );
  // fetchBuffer 返回 { status, buf, type }
  const buf = r && r.buf ? r.buf : Buffer.isBuffer(r) ? r : Buffer.alloc(0);
  if (!buf.length) throw new Error(`保单 PDF 是空的（HTTP ${(r && r.status) || '?'}；可能已撤单或还没出单）`);
  if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('返回的不是 PDF：' + buf.slice(0, 60).toString('utf8'));
  return buf;
}

function savePdf(name, buf) {
  const file = path.join(OUT_DIR, name.replace(/[\\/:*?"<>|]/g, '_') + '.pdf');
  fs.writeFileSync(file, buf);
  return file;
}

/** 取条款集 PDF（按方案里记录的 clauseFile 路径） */
async function clausePdf(clauseFile) {
  if (!clauseFile) return null;
  const lib = ly();
  await lib.ensure();
  const p = String(clauseFile).startsWith('http') ? String(clauseFile) : String(clauseFile);
  const r = await lib.fetchBuffer(p);
  const buf = r && r.buf ? r.buf : Buffer.isBuffer(r) ? r : Buffer.alloc(0);
  if (!buf.length || buf.slice(0, 5).toString() !== '%PDF-') return null;
  return buf;
}

/** 从方案里取投保须知（保持原文条目顺序，去掉开头的「· 」） */
function noticeLines(notice) {
  return String(notice || '')
    .split('\n')
    .map((l) => l.replace(/^\s*[·•]\s*/, '').trim())
    .filter((l) => l.length > 4);
}

const SERVICE_FEE_NOTE = '保险费用由保费和服务费组成，服务期限为保障期结束或理赔结束为止。';

function policyText({ buyerName = '客户', orderNo, policyNo, startTime, endTime, planName, itemTitle, notice, pdfPassword, pdfCode, attachNote }) {
  const head = [
    `${buyerName}您好，`,
    '',
    attachNote || '这是您购买的保险电子保单与条款文件，请查收附件（共 2 个：电子保单、条款集）。',
    '',
    `保单号：${policyNo || '-'}`,
    planName ? `产品：${planName}` : null,
    itemTitle ? `订单商品：${itemTitle}` : null,
    orderNo ? `平台订单号：${orderNo}` : null,
    startTime && endTime ? `保障期间：${startTime} 至 ${endTime}` : null,
    pdfCode ? `保单验真码：${pdfCode}（保单文件可直接打开，无需密码；验真码可在平安产险官网核验保单真伪）` : null,
    !pdfCode && pdfPassword ? `保单文件打开密码：${pdfPassword}（首位被保险人的身份证后 6 位）` : null,
    '',
    '【投保须知】',
  ];
  const body = noticeLines(notice);
  // 服务费那条接在须知编号后面（须知一般 1–10 条，这条就是第 11 条）
  let nextNo = 0;
  for (const l of body) {
    const m = l.match(/^(\d{1,2})\s*[、.．]/);
    if (m) nextNo = Math.max(nextNo, Number(m[1]));
  }
  const feeLine = nextNo ? `${nextNo + 1}、${SERVICE_FEE_NOTE}` : SERVICE_FEE_NOTE;
  const tail = [
    '',
    feeLine,
    '',
    '请核对姓名、证件号与保障期间，如有问题直接回复这封邮件。',
    '',
    '伴游旅途 · 客服',
  ];
  return [...head, ...(body.length ? body : ['（须知以附件条款为准）']), ...tail]
    .filter((x) => x !== null)
    .join('\r\n');
}

/**
 * 发送保单邮件
 * @param {object} o {to, orderNo, policyNo, buyerName, planName, itemTitle, startTime, endTime, amount, attachPdf}
 */
async function sendPolicy(o) {
  if (!o || !o.to) throw new Error('缺少收件邮箱 to');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to)) throw new Error(`邮箱格式不对：${o.to}`);

  // 方案信息（须知正文、条款集路径）：优先用调用方传的，其次按 planCode / itemId 从库里补
  let notice = o.notice || '';
  let clauseFile = o.clauseFile || '';
  try {
    if (!notice || !clauseFile) {
      const S = require('../lib/store');
      let plan = null;
      if (o.planCode) plan = S.getPlan(String(o.planCode));
      if (!plan && o.itemId) {
        const pf = S.planForItem(String(o.itemId));
        const code = pf && ((pf.plan && pf.plan.planCode) || pf.planCode);
        if (code) plan = S.getPlan(String(code));
      }
      if (plan) {
        if (!notice) notice = plan.notice || '';
        if (!clauseFile) clauseFile = plan.clauseFile || '';
      }
    }
  } catch (e) {
    /* 方案模块不可用时只发保单 */
  }

  const attachments = [];
  let pdf = null;
  let pdfFile = '';
  if (o.orderNo && o.attachPdf !== false) {
    // 注意：旅云保下载 PDF 用的是「旅云保订单号」，不是闲鱼平台订单号
    pdf = await policyPdf(o.policyOrderNo || o.orderNo);
    pdfFile = savePdf(`保单-${o.policyNo || o.orderNo}`, pdf);
    attachments.push({
      filename: `电子保单-${o.policyNo || o.orderNo}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    });
  }
  let clauseBytes = 0;
  if (o.attachClause !== false) {
    try {
      const cb = await clausePdf(clauseFile);
      if (cb) {
        clauseBytes = cb.length;
        attachments.push({ filename: '平安旅意险条款集.pdf', content: cb, contentType: 'application/pdf' });
      }
    } catch (e) {
      /* 条款取不到不影响发保单 */
    }
  }

  const subject = o.subject || `您的电子保单（订单 ${o.orderNo || o.policyNo || ''}）`.replace(/\s+$/, '');
  const hasClause = clauseBytes > 0;
  const attachNote = hasClause
    ? '这是您购买的保险电子保单与条款文件，请查收附件（共 2 个：电子保单、条款集）。'
    : '这是您购买的保险电子保单，请查收附件（电子保单）。';
  const text = policyText({ ...o, notice, attachNote });
  const r = await mailer.send({ to: o.to, subject, text, attachments });

  return { ...r, pdfFile, bytes: pdf ? pdf.length : 0, clauseBytes, attachments: attachments.length };
}

/**
 * 一次给客户发多份保单（「一人一份」场景）
 * @param {object} o {
 *   to, buyerName, orderNo, planCode, itemId, itemTitle, planName, startTime, endTime,
 *   policies: [{name, insuredNames:[], policyNo, code, period:[起,止], pdfFile, policyOrderNo}],
 *   attachClause, subject
 * }
 */
async function sendPolicyBatch(o) {
  if (!o || !o.to) throw new Error('缺少收件邮箱 to');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to)) throw new Error(`邮箱格式不对：${o.to}`);
  const policies = Array.isArray(o.policies) ? o.policies.filter(Boolean) : [];
  if (!policies.length) throw new Error('没有要发送的保单');

  let notice = o.notice || '';
  let clauseFile = o.clauseFile || '';
  try {
    if (!notice || !clauseFile) {
      const S = require('../lib/store');
      let plan = null;
      if (o.planCode) plan = S.getPlan(String(o.planCode));
      if (!plan && o.itemId) {
        const pf = S.planForItem(String(o.itemId));
        const code = pf && ((pf.plan && pf.plan.planCode) || pf.planCode);
        if (code) plan = S.getPlan(String(code));
      }
      if (plan) {
        if (!notice) notice = plan.notice || '';
        if (!clauseFile) clauseFile = plan.clauseFile || '';
      }
    }
  } catch (e) {
    /* 方案模块不可用时只发保单 */
  }

  const attachments = [];
  const saved = [];
  for (const p of policies) {
    let buf = null;
    if (p.pdfFile && fs.existsSync(p.pdfFile)) {
      buf = fs.readFileSync(p.pdfFile);
    } else if (p.policyOrderNo || p.orderNo) {
      buf = await policyPdf(p.policyOrderNo || p.orderNo);
      p.pdfFile = savePdf(`保单-${p.policyNo || p.orderNo}`, buf);
    }
    if (!buf || buf.slice(0, 4).toString() !== '%PDF') {
      throw new Error(`保单 ${p.name || p.policyNo || ''} 的 PDF 读不到`);
    }
    saved.push({ ...p, file: p.pdfFile, bytes: buf.length });
    attachments.push({
      filename: `电子保单-${p.name || p.policyNo}-${p.policyNo || ''}.pdf`.replace(/-+\.pdf$/, '.pdf'),
      content: buf,
      contentType: 'application/pdf',
    });
  }

  let clauseBytes = 0;
  if (o.attachClause !== false) {
    try {
      const cb = await clausePdf(clauseFile);
      if (cb) {
        clauseBytes = cb.length;
        attachments.push({ filename: '平安旅意险条款集.pdf', content: cb, contentType: 'application/pdf' });
      }
    } catch (e) {
      /* 条款取不到不影响发保单 */
    }
  }

  const n = saved.length;
  const head = [
    `${o.buyerName || '客户'}您好，`,
    '',
    `按您的要求，已为每位孩子分别出具独立保单，共 ${n} 份${clauseBytes ? '，另有条款集 1 份' : ''}，请查收附件。`,
    '',
    '【保单清单】',
  ];
  const list = [];
  for (let i = 0; i < n; i++) {
    const p = saved[i];
    const who = Array.isArray(p.insuredNames) && p.insuredNames.length ? `（被保险人：${p.insuredNames.join('、')}）` : '';
    list.push(`${i + 1}. ${p.name || ''}${who}`);
    if (p.policyNo) list.push(`   保单号：${p.policyNo}${p.code ? `　验真码：${p.code}` : ''}`);
    const ps = Array.isArray(p.period) && p.period.length === 2 ? p.period : [];
    if (ps.length) list.push(`   保障期间：${ps[0]} 至 ${ps[1]}`);
  }
  const mid = [];
  if (o.orderNo) mid.push(`平台订单号：${o.orderNo}`);
  if (o.planName) mid.push(`产品：${o.planName}`);
  mid.push('保单文件可直接打开，无需密码；验真码可在平安产险官网核验保单真伪。');

  const body = noticeLines(notice);
  let nextNo = 0;
  for (const l of body) {
    const m = l.match(/^(\d{1,2})\s*[、.．]/);
    if (m) nextNo = Math.max(nextNo, Number(m[1]));
  }
  const feeLine = nextNo ? `${nextNo + 1}、${SERVICE_FEE_NOTE}` : SERVICE_FEE_NOTE;
  const tail = [
    '',
    feeLine,
    '',
    '请核对姓名、证件号与保障期间，如有问题直接回复这封邮件。',
    '',
    '伴游旅途 · 客服',
  ];
  const text = [...head, ...list, '', ...mid, '', '【投保须知】', ...(body.length ? body : ['（须知以附件条款为准）']), ...tail].join('\r\n');

  const subject = o.subject || `您的电子保单 ${n} 份（订单 ${o.orderNo || ''}）`.trim();
  const r = await mailer.send({ to: o.to, subject, text, attachments });
  return { ...r, count: n, attachments: attachments.length, clauseBytes, pdfs: saved, text };
}

/**
 * 从某个会话的聊天记录里找客户留的邮箱（最近一次出现的优先）
 * @returns {{email:string, ts:number, text:string}|null}
 */
function findBuyerEmail(sessionId, { store, limit = 200 } = {}) {
  const S = store || require('../lib/store');
  const rows = S.listMessages(sessionId, limit) || [];
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.from_self) continue;
    const m = String(r.text || '').match(re);
    if (m) return { email: m[0], ts: r.ts, text: r.text };
  }
  return null;
}

module.exports = { policyPdf, policyText, sendPolicy, sendPolicyBatch, savePdf, findBuyerEmail, OUT_DIR };
