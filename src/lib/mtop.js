'use strict';
/**
 * mtop 网关客户端：签名、令牌自重试、错误分类。
 * 逆向依据：闲管家 background.js（dump）+ im.js module 59，见 ../闲管家-im-接口文档.md
 */
const https = require('https');
const crypto = require('crypto');
const { cfg, loadCookie } = require('../config');

const HOST = 'h5api.m.goofish.com';
const APP_KEY = process.env.XY_APP_KEY || '34839810';
const MTOP_FULL = process.env.XY_MTOP_FULL !== '0';
const JSV = '2.7.2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const enc = encodeURIComponent;

let COOKIE = '';
let jar = {};

function setCookie(header) {
  COOKIE = header || '';
  jar = {};
  for (const kv of COOKIE.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}

function initCookie(account) {
  setCookie(loadCookie(account));
  if (!COOKIE) throw new Error('缺少 Cookie：先跑 node scripts/add_account.js 或设置 GOOFISH_COOKIE');
  return Object.keys(jar).length;
}

const getJar = () => jar;

function absorb(setCookieArr) {
  if (!setCookieArr || !setCookieArr.length) return false;
  let changed = false;
  for (const line of setCookieArr) {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (jar[k] !== v) { jar[k] = v; changed = true; }
  }
  if (changed) COOKIE = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return changed;
}

function httpsRequest({ host, method = 'GET', path, headers = {}, body = null, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, method, path, headers, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('mtop 请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function once(api, v, data) {
  const dataStr = JSON.stringify(data || {});
  const t = String(Date.now());
  const token = (jar['_m_h5_tk'] || '').split('_')[0];
  const sign = md5(`${token}&${t}&${APP_KEY}&${dataStr}`);

  const qsBase = [
    ['jsv', JSV], ['appKey', APP_KEY], ['t', t], ['sign', sign],
    ['v', v], ['type', 'originaljson'], ['dataType', 'json'], ['api', api],
  ];
  const qsFull = qsBase.concat([['accountSite', 'xianyu'], ['timeout', '20000'], ['sessionOption', 'AutoLoginOnly'], ['spm_cnt', 'a21ybx.im.0.0']]);
  const qs = (MTOP_FULL ? qsFull : qsBase).map(([k, val]) => `${k}=${enc(val)}`).join('&');

  const body = `data=${enc(dataStr)}`;
  const res = await httpsRequest({
    host: HOST,
    method: 'POST',
    path: `/h5/${api.toLowerCase()}/${v.toLowerCase()}/?${qs}`,
    headers: {
      Host: HOST,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Accept-Encoding': 'identity',
      'User-Agent': UA,
      Referer: 'https://www.goofish.com/',
      Origin: 'https://www.goofish.com',
      Cookie: COOKIE,
    },
    body,
  });

  absorb(res.headers['set-cookie']);
  try {
    return JSON.parse(res.text);
  } catch (_) {
    throw new Error(`非 JSON 响应 HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
}

const isTokenIssue = json =>
  /FAIL_SYS_TOKEN_(EMPTY|EXOIRED|INVALID)|令牌为空|令牌已过期/i.test((json.ret && json.ret[0]) || '');

function hintFor(ret) {
  if (/FAIL_SYS_SESSION_EXPIRED/.test(ret)) return '登录态失效：重新跑 scripts/build_cookie.py 或换浏览器 Cookie';
  if (/FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_TOKEN_EXOIRED/i.test(ret)) return '_m_h5_tk 缺失/过期：清掉 _m_h5_tk 与 _m_h5_tk_enc 后重试';
  if (/FAIL_SYS_ILLEGAL_SIGN|FAIL_SYS_ILLEGAL_ACCESS/.test(ret)) return '签名/来源校验失败：检查 _m_h5_tk 与 appKey 是否同源';
  if (/FAIL_SYS_USER_VALIDATE|RGV587/.test(ret)) return '触发风控滑块：需人工在网页过滑块，Cookie 带上新标记';
  if (/FAIL_SYS_TRAFFIC_LIMIT|FLOW_LIMIT/.test(ret)) return '被限流：降频（建议单账号 ≤1 req/s，消息类 ≤20/min）';
  return '';
}

class MtopError extends Error {
  constructor(api, ret, raw) {
    super(`${api} 失败: ${ret}${hintFor(ret) ? '\n  ↳ ' + hintFor(ret) : ''}`);
    this.name = 'MtopError';
    this.api = api;
    this.ret = ret;
    this.raw = raw;
    this.kind = /SESSION_EXPIRED/.test(ret) ? 'AUTH'
      : /TOKEN/.test(ret) ? 'TOKEN'
      : /USER_VALIDATE|RGV587/.test(ret) ? 'RISK'
      : /TRAFFIC|FLOW_LIMIT/.test(ret) ? 'RATE'
      : 'BIZ';
  }
}

/** 令牌过期时把旧 token 从 jar 里删掉，下一次请求网关会下发新的 _m_h5_tk */
function dropToken() {
  delete jar['_m_h5_tk'];
  delete jar['_m_h5_tk_enc'];
  COOKIE = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 带令牌自愈的调用：TOKEN_EMPTY / TOKEN_EXOIRED 时清掉旧令牌重试（网关会下发新的 _m_h5_tk） */
async function call(api, v, data, { retries = 4 } = {}) {
  let json;
  for (let i = 0; i <= retries; i++) {
    const before = jar['_m_h5_tk'];
    json = await once(api, v, data);
    if (!isTokenIssue(json)) break;
    // 网关通常会在响应里下发新的 _m_h5_tk（已被 absorb 收下）；
    // 只有它没下发、或下发的和服务端认定的仍是同一枚过期 token 时，才清掉旧 token 重试。
    if (!jar['_m_h5_tk'] || jar['_m_h5_tk'] === before) dropToken();
    await new Promise(r => setTimeout(r, 200 * (i + 1)));
  }
  const ret = (json.ret && json.ret[0]) || '';
  if (!/^SUCCESS/.test(ret)) throw new MtopError(api, ret, json);
  return json.data || {};
}

/** 简单节流：保证 >= minGapMs 间隔（默认 250ms ≈ 4 req/s 上限） */
let lastAt = 0;
let minGap = 250;
function setRate(ms) { minGap = ms; }
async function throttle() {
  const wait = lastAt + minGap - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastAt = Date.now();
}

module.exports = {
  initCookie, setCookie, getJar, call, httpsRequest, md5, enc,
  MtopError, hintFor, throttle, setRate, HOST, APP_KEY,
};
