'use strict';
/** 配置与 Cookie 加载（优先级：env > --account 指定 > 约定文件 > 账号库最新） */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return dflt || {}; }
}

const cfg = Object.assign({
  accountId: '',            // 卖家账号 id（unb），WS 用
  sellerId: '',             // 子账号/店铺 id，缺省同 accountId
  wsType: 2,
  wsEnv: 'LiveEnv',         // dev=TestEnv / pre=PreEnv / prod=LiveEnv
  version: '1.21.90',
  archIsX64: true,
  pollInterval: 60,         // 秒：无 WS 时的轮询间隔（60s + 空闲退避，流量约为 30s/20条 的 1/8）
  syncInterval: 300,        // 秒：会话列表全量同步间隔
  sessionTypes: [1],
  fetchNum: 30,
  msgPageSize: 5,           // 每会话每轮只拉 5 条（20 条实测 55.8KB/会话/轮，5 条约 17.7KB）
  dryRun: false,            // 只记录不发送
  dbFile: path.join(ROOT, 'data', 'xianyu.db'),
  rulesFile: path.join(ROOT, 'rules', 'rules.json'),
  cookieFile: path.join(ROOT, 'goofish-cookie.txt'),
  accountsDir: path.join(ROOT, 'data', 'accounts'),
  accessToken: '',          // gpush WS 用；没有则退化为轮询
}, readJson(path.join(ROOT, 'config.json'), {}));

Object.assign(cfg, {
  accountId: process.env.XY_ACCOUNT_ID || cfg.accountId,
  accessToken: process.env.XY_ACCESS_TOKEN || cfg.accessToken,
  dryRun: process.env.XY_DRY_RUN ? process.env.XY_DRY_RUN === '1' : cfg.dryRun,
});

// 允许用 XY_DB_FILE 直接指定库文件（之前只是被当成占位判断，不生效）
if (process.env.XY_DB_FILE) cfg.dbFile = path.resolve(process.env.XY_DB_FILE);

/** 账号库：data/accounts/<unb>.cookie，按保存时间倒序 */
function listAccounts() {
  const dir = cfg.accountsDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.cookie'))
    .map(f => {
      const unb = f.replace(/\.cookie$/, '');
      const meta = readJson(path.join(dir, unb + '.json'), {});
      return { unb, file: path.join(dir, f), savedAt: meta.savedAt || 0, savedAtText: meta.savedAtText || '', cookieCount: meta.cookieCount || 0 };
    })
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** 解析 Cookie 原文：env > 指定账号 > 账号库最新（扫码得到的完整登录态）> goofish-cookie.txt（老路子，常缺 cookie2） */
function resolveCookie(account) {
  if (process.env.GOOFISH_COOKIE) return process.env.GOOFISH_COOKIE;
  const accounts = listAccounts();
  if (account) {
    const hit = accounts.find(a => a.unb === String(account));
    if (!hit) throw new Error(`账号 ${account} 不在账号库，先跑 node scripts/add_account.js`);
    return fs.readFileSync(hit.file, 'utf8').trim();
  }
  if (accounts.length) return fs.readFileSync(accounts[0].file, 'utf8').trim();
  if (fs.existsSync(cfg.cookieFile)) return fs.readFileSync(cfg.cookieFile, 'utf8').trim();
  return '';
}

function loadCookie(account) {
  const raw = resolveCookie(account);
  if (!raw) return '';
  return raw.replace(/^Cookie:\s*/i, '');
}

/** 从 Cookie 串里取 unb → 自动补 cfg.accountId */
function unbFromCookie(raw) {
  const m = /(?:^|;\s*)unb=([^;]+)/.exec(raw || '');
  return m ? m[1] : '';
}

module.exports = {
  cfg,
  ROOT,
  readJson,
  loadCookie,
  resolveCookie,
  listAccounts,
  unbFromCookie,
  cookiePath: () => cfg.cookieFile,
};
