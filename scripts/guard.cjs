// 看门狗：每分钟探一次 /api/health，发现「进程没了」或「lastSync 长时间不更新」就整组重启。
// 用法：node scripts/guard.cjs [--port 5175] [--stale 300] [--every 60]
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'data', 'guard.log');
const LOCK = path.join(ROOT, 'data', 'guard.pid');

// 单实例：pid 文件里的进程还活着就直接退出，避免被重复拉起后互相打架
try {
  const old = Number(String(fs.readFileSync(LOCK, 'utf8')).trim());
  if (old) {
    process.kill(old, 0); // 不抛异常 = 还活着
    console.log(`guard 已在运行（pid ${old}），退出`);
    process.exit(0);
  }
} catch (e) {
  // 进程不存在或读不到 pid，继续
}
try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
const releaseLock = () => {
  try {
    if (String(fs.readFileSync(LOCK, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(LOCK);
  } catch {}
};
process.on('exit', releaseLock);
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};const PORT = Number(arg('port', '5175'));
const STALE = Number(arg('stale', '300')); // lastSync 落后多少秒算卡死
const EVERY = Number(arg('every', '20'));

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(LOG, s); } catch {}
  process.stdout.write(s);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 8000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, json: JSON.parse(b) }); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

/** 找出本项目相关的 node 进程（watch.cjs / server.js），按 cmdline 过滤 */
function projPids() {
  const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const out = execFileSync(PS, [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*watch.cjs*' -or $_.CommandLine -like '*server.js*' } | Select-Object -ExpandProperty ProcessId",
    ], { encoding: 'utf8', timeout: 20000 });
    return out.split(/\r?\n/).map((x) => Number(x.trim())).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function killAll() {
  const pids = projPids();
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 }); log(`已结束 pid ${pid}`); } catch {}
  }
  return pids;
}

function startWatch() {
  const child = spawn(process.execPath, ['scripts/watch.cjs', '--port', String(PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(`已拉起 watch.cjs（pid ${child.pid}）`);
}

let fails = 0;
let graceUntil = Date.now() + 90000; // 首次启动/刚重启留出同步时间
let zeroSince = 0; // lastSync 一直是 0 的起始时刻（首次全量同步可能要好几分钟）

async function tick() {
  if (Date.now() < graceUntil) {
    log(`宽限期内（${Math.round((graceUntil - Date.now()) / 1000)}s 后开始判定）`);
    return;
  }
  const h = await health();
  if (!h.ok) {
    fails++;
    log(`health 不通（连续 ${fails} 次）`);
    log('重启整组进程');
    killAll();
    await new Promise((r) => setTimeout(r, 1500));
    startWatch();
    fails = 0;
    graceUntil = Date.now() + 90000;
    return;
  }
  fails = 0;
  const last = Number(h.json.lastSync || 0);
  if (!last) {
    if (!zeroSince) zeroSince = Date.now();
    const waited = Math.round((Date.now() - zeroSince) / 1000);
    if (waited > 600) {
      log(`lastSync 一直为 0 已 ${waited}s，重启`);
      zeroSince = 0;
      killAll();
      await new Promise((r) => setTimeout(r, 1500));
      startWatch();
      graceUntil = Date.now() + 90000;
      return;
    }
    log(`health 正常，首次同步进行中（lastSync 尚为 0，已等 ${waited}s）`);
    return;
  }
  zeroSince = 0;
  const age = Math.round((Date.now() - last) / 1000);
  const pids = projPids();
  if (age > STALE) {
    log(`lastSync 已 ${age}s 未更新（阈值 ${STALE}s），重启`);
    killAll();
    await new Promise((r) => setTimeout(r, 1500));
    startWatch();
    graceUntil = Date.now() + 90000;
    return;
  }
  if (!pids.length) {
    log('没发现 watch/server 进程，拉起');
    startWatch();
    graceUntil = Date.now() + 90000;
    return;
  }
  if (pids.length > 2) {
    log(`发现 ${pids.length} 个相关进程（重复），只保留一组`);
    killAll();
    await new Promise((r) => setTimeout(r, 1500));
    startWatch();
    graceUntil = Date.now() + 90000;
    return;
  }
  log(`ok：lastSync ${age}s 前，进程 ${pids.length} 个`);
}

log(`看门狗启动：端口 ${PORT}，每 ${EVERY}s 检查，lastSync 超过 ${STALE}s 视为卡死`);
tick();
setInterval(tick, EVERY * 1000);
