/**
 * 零依赖 SMTP 发信（保单/条款这类带 PDF 附件的邮件够用）
 *
 * 支持：
 *   - 465 隐式 TLS（QQ/163/腾讯企业邮都走这个）
 *   - 587 STARTTLS
 *   - AUTH LOGIN / AUTH PLAIN
 *   - multipart/mixed：正文（utf-8 base64）+ 多个附件
 *
 * 配置在 data/mail.json：
 *   { host, port, secure, user, pass, fromName, fromAddr, replyTo, dailyLimit }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

const CONF_FILE = path.join(__dirname, '..', '..', 'data', 'mail.json');

const PRESETS = {
  qq: { host: 'smtp.qq.com', port: 465, secure: true, note: 'QQ 邮箱（用「授权码」当密码）' },
  foxmail: { host: 'smtp.qq.com', port: 465, secure: true, note: 'Foxmail 同 QQ' },
  '163': { host: 'smtp.163.com', port: 465, secure: true, note: '网易 163（授权码）' },
  '126': { host: 'smtp.126.com', port: 465, secure: true, note: '网易 126（授权码）' },
  sina: { host: 'smtp.sina.com', port: 465, secure: true, note: '新浪邮箱（授权码）' },
  sohu: { host: 'smtp.sohu.com', port: 465, secure: true, note: '搜狐邮箱' },
  aliyun: { host: 'smtp.aliyun.com', port: 465, secure: true, note: '阿里邮箱个人版' },
  exmail: { host: 'smtp.exmail.qq.com', port: 465, secure: true, note: '腾讯企业邮（自有域名）' },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true, note: 'Gmail（要应用专用密码，大陆直连不通）' },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false, note: 'Outlook（已禁基本认证，需 OAuth2）' },
  '139': { host: 'smtp.139.com', port: 465, secure: true, note: '移动 139 邮箱' },
  '189': { host: 'smtp.189.cn', port: 465, secure: true, note: '电信 189 邮箱' },
};

const DEFAULTS = {
  host: '',
  port: 465,
  secure: true,
  user: '',
  pass: '',
  fromName: '伴游旅途',
  fromAddr: '',
  replyTo: '',
  dailyLimit: 200,
  sentToday: 0,
  sentDate: '',
};

function load() {
  let conf = { ...DEFAULTS };
  try {
    if (fs.existsSync(CONF_FILE)) conf = { ...conf, ...JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')) };
  } catch (_) {}
  // 环境变量覆盖（CI / 临时测试用）
  if (process.env.XY_SMTP_HOST) conf.host = process.env.XY_SMTP_HOST;
  if (process.env.XY_SMTP_PORT) conf.port = Number(process.env.XY_SMTP_PORT);
  if (process.env.XY_SMTP_USER) conf.user = process.env.XY_SMTP_USER;
  if (process.env.XY_SMTP_PASS) conf.pass = process.env.XY_SMTP_PASS;
  if (process.env.XY_SMTP_FROM) conf.fromAddr = process.env.XY_SMTP_FROM;
  conf.fromAddr = conf.fromAddr || conf.user;
  conf.ready = Boolean(conf.host && conf.user && conf.pass);
  return conf;
}

function save(patch) {
  const conf = load();
  const allow = ['host', 'port', 'secure', 'user', 'pass', 'fromName', 'fromAddr', 'replyTo', 'dailyLimit'];
  for (const k of allow) {
    if (patch[k] === undefined) continue;
    if (k === 'pass' && (patch[k] === '' || patch[k] === null)) continue; // 空密码不覆盖
    conf[k] = patch[k];
  }
  if (patch.preset && PRESETS[patch.preset]) {
    conf.host = PRESETS[patch.preset].host;
    conf.port = PRESETS[patch.preset].port;
    conf.secure = PRESETS[patch.preset].secure;
  }
  if (!conf.fromAddr) conf.fromAddr = conf.user;
  const out = { ...conf };
  delete out.ready;
  fs.writeFileSync(CONF_FILE, JSON.stringify(out, null, 2), 'utf8');
  return load();
}

function view() {
  const c = load();
  return {
    ...c,
    pass: undefined,
    hasPass: Boolean(c.pass),
    passMasked: c.pass ? c.pass.slice(0, 3) + '****' + c.pass.slice(-2) : '',
    presets: PRESETS,
  };
}

/* ------------------------------ SMTP 传输 ------------------------------ */

function makeConn({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => resolve(sock))
      : net.connect({ host, port }, () => resolve(sock));
    sock.setTimeout(25000, () => reject(new Error('SMTP 连接超时')));
    sock.once('error', reject);
  });
}

class Smtp {
  constructor(sock) {
    this.sock = sock;
    this.buf = '';
    this.waiters = [];
    this.queue = [];
    this.attach(sock);
  }

  attach(sock) {
    this.sock = sock;
    sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        this.queue.push(line);
        // SMTP 多行响应：'250-' 继续，'250 ' 结束
        const done = /^\d{3} /.test(line);
        if (done && this.waiters.length) this.waiters.shift()(this.flush());
      }
    });
  }

  flush() {
    const lines = this.queue.slice();
    this.queue.length = 0;
    const code = Number((lines[lines.length - 1] || '0').slice(0, 3));
    return { code, lines, text: lines.join('\n') };
  }

  read() {
    return new Promise((resolve, reject) => {
      if (this.queue.length) return resolve(this.flush());
      const t = setTimeout(() => reject(new Error('SMTP 等待响应超时')), 25000);
      this.waiters.push((r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  async cmd(line, expect) {
    if (line != null) this.sock.write(line + '\r\n');
    const r = await this.read();
    if (expect && !expect.includes(r.code)) {
      throw new Error(`SMTP ${line ? line.split(' ')[0] : 'reply'} 返回 ${r.code}: ${r.text}`);
    }
    return r;
  }

  async startTls(host) {
    await this.cmd('STARTTLS', [220]);
    const secureSock = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: this.sock, servername: host, rejectUnauthorized: false }, () => resolve(s));
      s.once('error', reject);
    });
    this.buf = '';
    this.queue.length = 0;
    this.waiters.length = 0;
    this.attach(secureSock);
  }
}

/* ------------------------------ 报文拼装 ------------------------------ */

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const wrap76 = (s) => (s.match(/.{1,76}/g) || []).join('\r\n');
const encWord = (s) => `=?UTF-8?B?${b64(s)}?=`;

function buildMessage({ from, fromName, to, subject, text, html, attachments = [], replyTo }) {
  const domain = String(from).split('@')[1] || 'localhost';
  const boundary = 'xy_' + crypto.randomBytes(12).toString('hex');
  const msgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@${domain}>`;
  const head = [
    `From: ${fromName ? encWord(fromName) + ' ' : ''}<${from}>`,
    `To: <${to}>`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [];
  parts.push(
    [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(text || '')),
    ].join('\r\n')
  );
  if (html) {
    parts.push(
      [
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(b64(html)),
      ].join('\r\n')
    );
  }
  for (const a of attachments) {
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content), 'base64');
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${encWord(a.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${encWord(a.filename)}"`,
        '',
        wrap76(content.toString('base64')),
      ].join('\r\n')
    );
  }
  parts.push(`--${boundary}--`, '');
  return head.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 发一封邮件。attachments: [{filename, content(Buffer|base64字符串), contentType}]
 */
async function send(opts) {
  const conf = load();
  if (!conf.ready) throw new Error('邮件未配置：先填 host / user / pass（QQ 用授权码）');
  if (!opts || !opts.to) throw new Error('缺少收件人 to');
  if (Array.isArray(opts.to)) return sendMany(conf, opts);

  const sock = await makeConn(conf);
  const smtp = new Smtp(sock);
  try {
    const banner = await smtp.read();
    if (banner.code !== 220) throw new Error('SMTP 握手失败：' + banner.text);
    let ehlo = await smtp.cmd(`EHLO ${conf.fromAddr.split('@')[1] || 'localhost'}`, [250]);
    if (!conf.secure && /STARTTLS/i.test(ehlo.text)) {
      await smtp.startTls(conf.host);
      ehlo = await smtp.cmd(`EHLO ${conf.fromAddr.split('@')[1] || 'localhost'}`, [250]);
    }
    const authLine = /AUTH[^\n]*PLAIN/i.test(ehlo.text) ? 'AUTH PLAIN' : 'AUTH LOGIN';
    if (authLine === 'AUTH PLAIN') {
      await smtp.cmd('AUTH PLAIN ' + b64('\u0000' + conf.user + '\u0000' + conf.pass), [235]);
    } else {
      await smtp.cmd('AUTH LOGIN', [334]);
      await smtp.cmd(b64(conf.user), [334]);
      await smtp.cmd(b64(conf.pass), [235]);
    }
    await smtp.cmd(`MAIL FROM:<${conf.fromAddr}>`, [250]);
    await smtp.cmd(`RCPT TO:<${opts.to}>`, [250, 251]);
    await smtp.cmd('DATA', [354]);
    const raw = buildMessage({
      from: conf.fromAddr,
      fromName: opts.fromName || conf.fromName,
      to: opts.to,
      subject: opts.subject || '(无主题)',
      text: opts.text,
      html: opts.html,
      replyTo: conf.replyTo,
      attachments: opts.attachments || [],
    });
    // 逐点转义，避免正文里单独一行 "." 提前结束 DATA
    const safe = raw.replace(/\r\n\./g, '\r\n..');
    const done = await smtp.cmd(safe + '\r\n.', [250]);
    await smtp.cmd('QUIT', [221]).catch(() => {});
    return { ok: true, to: opts.to, subject: opts.subject, size: Buffer.byteLength(raw), reply: done.text };
  } finally {
    try { sock.destroy(); } catch (_) {}
  }
}

async function sendMany(conf, opts) {
  const out = [];
  for (const to of opts.to) {
    try {
      out.push(await send({ ...opts, to }));
    } catch (e) {
      out.push({ ok: false, to, error: e.message });
    }
  }
  return { ok: out.every((x) => x.ok), results: out };
}

/** 只测连通 + 登录，不发信 */
async function verify() {
  const conf = load();
  if (!conf.host) throw new Error('没填 SMTP 主机');
  const sock = await makeConn(conf);
  const smtp = new Smtp(sock);
  try {
    const banner = await smtp.read();
    const host = conf.fromAddr && conf.fromAddr.includes('@') ? conf.fromAddr.split('@')[1] : 'localhost';
    let ehlo = await smtp.cmd(`EHLO ${host}`, [250]);
    if (!conf.secure && /STARTTLS/i.test(ehlo.text)) {
      await smtp.startTls(conf.host);
      ehlo = await smtp.cmd(`EHLO ${host}`, [250]);
    }
    const caps = ehlo.lines.map((l) => l.slice(4).trim()).filter(Boolean);
    let auth = 'skip';
    if (conf.user && conf.pass) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
        await smtp.cmd('AUTH PLAIN ' + b64('\u0000' + conf.user + '\u0000' + conf.pass), [235]);
      } else {
        await smtp.cmd('AUTH LOGIN', [334]);
        await smtp.cmd(b64(conf.user), [334]);
        await smtp.cmd(b64(conf.pass), [235]);
      }
      auth = 'ok';
    }
    await smtp.cmd('QUIT', [221]).catch(() => {});
    return { ok: true, host: conf.host, port: conf.port, secure: conf.secure, auth, caps };
  } finally {
    try { sock.destroy(); } catch (_) {}
  }
}

module.exports = { load, save, view, send, sendMany, verify, buildMessage, PRESETS, CONF_FILE };
