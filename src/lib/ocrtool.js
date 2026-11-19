// PDF 渲染 + OCR 兜底（Windows 自带 WinRT：Windows.Data.Pdf + Windows.Media.Ocr）
// 用途：有些条款 PDF 的字体没有 ToUnicode（子集字体 + Mac Roman cmap + post format 3），
//       文本层完全不可还原，只能渲染成图再识别。
// 依赖：Windows 10/11 自带的中文 OCR 语言包（zh-Hans-CN），无需 npm 包。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'pdf_ocr.ps1');

/** OCR 会在汉字之间插空格、把中文引号识别成英文引号，这里统一收一下 */
function tidy(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/([\u4e00-\u9fa5，。；：、（）【】《》])\s+(?=[\u4e00-\u9fa5，。；：、（）【】《》])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function runPs(args, { timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** OCR 引擎是否可用（缓存结果） */
let _caps = null;
function caps() {
  if (_caps) return _caps;
  const script = path.join(__dirname, '..', '..', 'scripts', 'ocr_caps.ps1');
  try {
    const out = require('child_process').execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30000, windowsHide: true });
    const j = JSON.parse(String(out).trim());
    _caps = { ok: !!j.ok, langs: j.langs || [] };
  } catch (e) {
    _caps = { ok: false, langs: [], error: String(e.message || e).slice(0, 200) };
  }
  return _caps;
}

/**
 * 把 PDF 的指定页渲染成图并 OCR
 * @param {string} pdfPath 本地 PDF 路径
 * @param {number[]} pages 1-based 页码
 * @param {{dpi?:number, lang?:string, keepPng?:string}} opts
 */
async function ocrPdf(pdfPath, pages, opts = {}) {
  const dpi = Number(opts.dpi || 300);
  const list = (pages || []).map(Number).filter((n) => n >= 1);
  if (!list.length) return { ok: true, result: [] };
  // WinRT 的 GetFileFromPathAsync 只认绝对路径
  const abs = path.resolve(pdfPath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'PDF 不存在：' + abs };

  const outJson = path.join(os.tmpdir(), 'ocr-' + process.pid + '-' + Date.now() + '.json');
  const args = ['-Pdf', abs, '-Pages', list.join(','), '-Dpi', String(dpi), '-OutJson', outJson];
  if (opts.lang) args.push('-Lang', opts.lang);
  if (opts.keepPng) args.push('-OutDir', opts.keepPng);

  const r = await runPs(args);
  let payload = null;
  try {
    if (fs.existsSync(outJson)) payload = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  } catch (e) {
    /* ignore */
  }
  fs.promises.unlink(outJson).catch(() => {});
  if (!payload) {
    return { ok: false, error: (r.stderr || r.err && r.err.message || 'OCR 无输出').toString().slice(0, 400) };
  }
  if (!payload.ok) return { ok: false, error: payload.error || 'OCR 失败' };

  const result = (payload.result || []).map((x) => ({
    page: Number(x.page),
    chars: Number(x.chars || 0),
    text: tidy(x.text),
  }));
  return { ok: true, dpi, pages: payload.pages, result };
}

module.exports = { ocrPdf, caps, tidy, PS, SCRIPT };
