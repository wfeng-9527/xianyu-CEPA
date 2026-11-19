// 守护进程：server.js 退出就自动拉起（崩溃/被杀都能恢复）
// 用法：node scripts/watch.cjs            （默认端口 5175）
//       node scripts/watch.cjs --port 5175
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'data', 'watch.log');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? args[portIdx + 1] : '5175';

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(LOG, s);
  } catch {}
  process.stdout.write(s);
}

let child = null;
let restarting = false;
let startedAt = 0;

function start() {
  startedAt = Date.now();
  child = spawn(process.execPath, ['src/server.js', '--port', port], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (b) => process.stdout.write(b));
  child.stderr.on('data', (b) => {
    process.stderr.write(b);
    try {
      fs.appendFileSync(path.join(ROOT, 'data', 'server.err.log'), b);
    } catch {}
  });
  child.on('exit', (code, sig) => {
    const lived = Math.round((Date.now() - startedAt) / 1000);
    log(`server 退出 code=${code} sig=${sig} 存活 ${lived}s`);
    if (restarting) return;
    // 1 分钟内连续崩溃时退避，避免疯狂重启
    const delay = lived < 60 ? 5000 : 1000;
    log(`${delay}ms 后重启`);
    setTimeout(start, delay);
  });
  log(`server 已启动（pid ${child.pid}，端口 ${port}）`);
}

process.on('SIGINT', () => {
  restarting = true;
  log('收到 SIGINT，停止守护');
  if (child) child.kill();
  process.exit(0);
});

start();
