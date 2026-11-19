'use strict';
/**
 * 旅云保（www.lyybao.cn）只读客户端：登录 + 拉产品目录 + 计划详情 + 价目
 * 只做「拿资料」，不做出单/退保（那些在 scripts/l yybao 工具里，这里不需要）。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { ROOT, readJson } = require('../config');

const HOST = 'www.lyybao.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const CONF_FILE = path.join(ROOT, 'data', 'lyybao.json');

const jar = new Map();
let sid = '';

function conf() {
  const j = readJson(CONF_FILE, {});
  return {
    username: process.env.LY_USER || j.username || '',
    password: process.env.LY_PASS || j.password || '',
  };
}

function saveConf(patch) {
  const cur = readJson(CONF_FILE, {});
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(CONF_FILE), { recursive: true });
  fs.writeFileSync(CONF_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(setCookie) {
  for (const line of setCookie || []) {
    const [pair] = String(line).split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

function raw(method, p, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p.startsWith('http') ? p : 'https://' + HOST + p);
    const data = body == null ? null : Buffer.from(body, 'utf8');
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method,
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: 'https://' + HOST + '/',
          cookie: cookieHeader(),
          ...(data ? { 'content-type': 'application/json;charset=UTF-8', 'content-length': data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        absorb(res.headers['set-cookie']);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { /* 可能是纯文本 sid */ }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(username, password) {
  const u = username || conf().username;
  const p = password || conf().password;
  if (!u || !p) throw new Error('没配置旅云保账号（data/lyybao.json 里的 username/password）');
  const r = await raw(
    'GET',
    '/ins/web/rest/common/login?username=' + encodeURIComponent(u) + '&password=' + encodeURIComponent(p)
  );
  if (r.status !== 200) throw new Error(`登录失败 HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  sid = r.json ? String(r.json) : r.text.trim().replace(/^"|"$/g, '');
  if (!/^[0-9A-F]{20,}$/i.test(sid)) throw new Error('登录返回不像 session：' + r.text.slice(0, 80));
  jar.set('JSESSIONID', sid);
  return sid;
}

async function ensure() {
  if (!sid) {
    const c = conf();
    if (!c.username) throw new Error('没配置旅云保账号');
    await login(c.username, c.password);
  }
}

async function get(p) {
  await ensure();
  let r = await raw('GET', p);
  if (r.status === 401 || r.status === 500 || /未登录|SESSION/i.test(r.text || '')) {
    sid = '';
    await ensure();
    r = await raw('GET', p);
  }
  if (r.status !== 200) throw new Error(`GET ${p} → HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  return r.json != null ? r.json : r.text;
}

// ---- 只读接口 -------------------------------------------------------------
const userInfo = () => get('/ins/web/rest/common/commonDatas');
const certTypes = (companyId) => get(`/ins/business/rest/systemParameters/companyCerttypeList/${companyId}`);
const custPlans = (custId, companyId, classId, productId = '') =>
  get(`/ins/business/rest/common/select/custplan/${custId}/${companyId}/${classId}?productId=${productId || ''}`);
const planDetail = (planCode) => get(`/ins/business/rest/product/serachProgram/${planCode}`);
const planFee = (planCode) => get(`/ins/business/rest/product/plan/fee/query/${planCode}`);
const timeRange = (planCode) => get(`/ins/business/rest/common/select/timerange/${planCode}`);

/** 产品线：companyId × classId（来自后台菜单） */
const LINES = [
  { companyId: 18, company: '平安', classId: '10001001', cls: '境内旅行' },
  { companyId: 20, company: '人保财险', classId: '10001001', cls: '境内旅行' },
  { companyId: 1, company: '京东安联', classId: '10001002', cls: '出境旅行' },
  { companyId: 5, company: '大地', classId: '10001002', cls: '出境旅行' },
  { companyId: 18, company: '平安', classId: '10001002', cls: '出境旅行' },
  { companyId: 1, company: '京东安联', classId: '10001006', cls: '签证' },
  { companyId: 5, company: '大地', classId: '10001006', cls: '签证' },
  { companyId: 18, company: '平安', classId: '10001007', cls: '邮轮' },
  { companyId: 28, company: '泰康', classId: '10001004', cls: '火车航空' },
  { companyId: 1, company: '京东安联', classId: '10001010', cls: '户外运动' },
];

/** 下载二进制（条款 PDF 之类） */
function fetchBuffer(p, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p.startsWith('http') ? p : 'https://' + HOST + p);
    const req = https.get(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        headers: { 'user-agent': UA, referer: 'https://' + HOST + '/', cookie: cookieHeader() },
      },
      (res) => {
        absorb(res.headers['set-cookie']);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), type: res.headers['content-type'] }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

module.exports = {
  HOST, CONF_FILE, LINES, conf, saveConf, login, ensure, get, userInfo, certTypes,
  custPlans, planDetail, planFee, timeRange, cookieHeader, fetchBuffer,
};
