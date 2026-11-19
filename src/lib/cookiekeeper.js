/**
 * Cookie 保活：定时从「带调试端口的 Chrome」抓一次闲鱼登录态，覆盖账号库并热重载到进程内。
 *
 * 背景：mtop 的 cookie2 / _m_h5_tk 会过期，过期后同步会静默失败（进程在跑但一条数据不拉）。
 * 只要浏览器里 goofish.com 还是登录状态，就能直接续上，不需要重新扫码。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const LOG = path.join(ROOT, 'data', 'cookie.log');

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG, s); } catch {}
  return s;
}

function runRefresh(port = 9315, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'refresh_cookie.js'), '--port', String(port)],
      { cwd: ROOT, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

/** 抓一次并热重载；返回 {ok, unb, count, msg} */
async function refresh({ port = 9315, account = null } = {}) {
  const r = await runRefresh(port);
  const text = (r.stdout || '').trim();
  const m = /已刷新账号 (\d+)：(\d+) 条 Cookie/.exec(text);
  if (!r.ok || !m) {
    const reason = (r.stderr || text || '刷新失败').split('\n').filter(Boolean).slice(-2).join(' | ');
    log(`刷新失败（port ${port}）：${reason}`);
    return { ok: false, msg: reason };
  }
  const unb = m[1];
  const count = Number(m[2]);

  // 热重载到本进程：重新读账号文件，替换 mtop 的 cookie jar
  let reloaded = false;
  try {
    const mtop = require('../lib/mtop');
    const cfg = require('../config');
    const file = account || unb || cfg.accountId;
    mtop.initCookie(file);
    reloaded = true;
  } catch (e) {
    log(`热重载失败：${e.message}`);
  }

  log(`刷新成功：账号 ${unb}，${count} 条 Cookie，热重载=${reloaded ? '成功' : '失败'}`);
  return { ok: true, unb, count, reloaded, msg: text.split('\n')[0] };
}

module.exports = { refresh, log, LOG };
