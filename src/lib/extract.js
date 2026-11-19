// 文档 → 纯文本。.docx 用 zip+XML；.pdf 自写解析（含 ToUnicode CMap）；.txt/.md/.csv 直读
const zlib = require('zlib');
const unzip = require('./unzip');

function stripXml(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function docxToText(buf) {
  const entries = unzip.listEntries(buf);
  const parts = [];
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('docx 里没有 word/document.xml');
  parts.push(stripXml(unzip.readEntry(buf, doc).toString('utf8')));
  for (const e of entries) {
    if (/^word\/(header|footer)\d*\.xml$/.test(e.name)) {
      const t = stripXml(unzip.readEntry(buf, e).toString('utf8'));
      if (t) parts.push(t);
    }
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * PDF：自己解析对象表 → 找 /ToUnicode CMap → 按字体解码内容流里的字串
 * 中文 PDF 基本都是 CID 字体，字串是 <00A1> 这种字形码，
 * 不做 CMap 映射就会抽出乱码（这是第一版失败的原因）
 * ------------------------------------------------------------------ */

function inflate(buf) {
  if (!buf || !buf.length) return null;
  try {
    return zlib.inflateSync(buf);
  } catch {
    /* 继续尝试 */
  }
  try {
    return zlib.inflateRawSync(buf);
  } catch {
    /* 未压缩 */
  }
  try {
    return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch {
    return null;
  }
}

function parseObjects(raw) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const endIdx = raw.indexOf('endobj', start);
    if (endIdx < 0) continue;
    const body = raw.slice(start, endIdx);
    const sIdx = body.indexOf('stream');
    let dict = body;
    let stream = null;
    if (sIdx >= 0) {
      dict = body.slice(0, sIdx);
      let p = sIdx + 6;
      if (body[p] === '\r') p++;
      if (body[p] === '\n') p++;
      const e = body.indexOf('endstream', p);
      if (e > p) stream = Buffer.from(body.slice(p, e), 'latin1');
    }
    objs.set(num, { num, dict, stream });
  }
  return objs;
}

/** CMap 目标串：>=4 位十六进制一律按 UTF-16BE 解（<4E27> = 丧），2 位当单字节 */
function hexToText(hex) {
  const h = String(hex).replace(/\s+/g, '');
  if (!h) return '';
  const bytes = Buffer.from(h, 'hex');
  if (h.length >= 4) {
    const even = bytes.length % 2 === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(1)]);
    return Buffer.from(even).swap16().toString('utf16le');
  }
  return bytes.toString('latin1');
}

function incCodePoint(str, delta) {
  if (!str) return '';
  const cps = [...str];
  cps[cps.length - 1] = String.fromCodePoint(cps[cps.length - 1].codePointAt(0) + delta);
  return cps.join('');
}

function parseCMap(text) {
  const map = new Map();
  let m;
  const bc = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bc.exec(text))) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let t;
    while ((t = re.exec(m[1]))) map.set(t[1].toUpperCase(), hexToText(t[2]));
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = br.exec(text))) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let t;
    while ((t = re.exec(m[1]))) {
      const lo = parseInt(t[1], 16);
      const hi = parseInt(t[2], 16);
      const width = t[1].length;
      if (t[3]) {
        const base = hexToText(t[3]);
        const n = Math.min(hi - lo, 65535);
        for (let i = 0; i <= n; i++) {
          map.set((lo + i).toString(16).toUpperCase().padStart(width, '0'), incCodePoint(base, i));
        }
      } else if (t[4]) {
        const arr = [...t[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToText(x[1]));
        for (let i = 0; i < arr.length; i++) {
          map.set((lo + i).toString(16).toUpperCase().padStart(width, '0'), arr[i]);
        }
      }
    }
  }
  return map;
}

/** 用 CMap 解一段字形码；没有 CMap 时按 UTF-16BE / latin1 兜底 */
function decodeGlyphs(hex, cmap) {
  const h = String(hex).replace(/\s+/g, '');
  if (!cmap || !cmap.size) {
    const bytes = Buffer.from(h, 'hex');
    return bytes.length >= 2 && bytes.length % 2 === 0 ? bytes.swap16().toString('utf16le') : bytes.toString('latin1');
  }
  // CMap 的键长度决定每字几个字节（Identity-H 是 4 位 = 2 字节）
  let keyLen = 4;
  for (const k of cmap.keys()) {
    keyLen = k.length;
    break;
  }
  let out = '';
  for (let i = 0; i + keyLen <= h.length; i += keyLen) {
    const code = h.slice(i, i + keyLen).toUpperCase();
    const mapped = cmap.get(code);
    if (mapped !== undefined) out += mapped;
    else if (keyLen === 4) out += ' '; // 未知字形：给个分隔，避免整段粘连
  }
  return out;
}

function decodeLiteral(s) {
  return s
    .slice(1, -1)
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, '\t')
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/** 内容流 → 文本；跟踪 /F1 12 Tf 切字体 CMap */
function contentToText(stream, nameToCmap, fallbackCmap) {
  let out = '';
  let cmap = fallbackCmap;
  const re = /\/([A-Za-z0-9.+_-]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>|\bT[dDm*]\b|\bET\b/g;
  let m;
  while ((m = re.exec(stream))) {
    const tok = m[0];
    if (tok.endsWith('Tf')) {
      const name = m[1];
      cmap = nameToCmap.get(name) || fallbackCmap;
    } else if (m[2] !== undefined) {
      out += decodeGlyphs(m[2], cmap);
    } else if (tok.startsWith('(')) {
      out += decodeLiteral(tok);
    } else {
      // Td / TD / T* / ET → 换行
      out += '\n';
    }
  }
  return out;
}

function pdfToText(buf) {
  const raw = buf.toString('latin1');
  const objs = parseObjects(raw);
  if (!objs.size) throw new Error('PDF 对象解析失败（可能加密）');

  // 1) 所有字体的 ToUnicode 映射：objNum(字体的) → Map
  const fontCmaps = new Map();
  const globalCmap = new Map();
  for (const o of objs.values()) {
    const ref = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(o.dict);
    if (!ref) continue;
    const cmapObj = objs.get(Number(ref[1]));
    if (!cmapObj || !cmapObj.stream) continue;
    const text = (inflate(cmapObj.stream) || cmapObj.stream).toString('latin1');
    const map = parseCMap(text);
    if (!map.size) continue;
    fontCmaps.set(o.num, map);
    for (const [k, v] of map) if (!globalCmap.has(k)) globalCmap.set(k, v);
  }

  // 2) 页 → /Resources /Font 名字映射
  const pages = [];
  for (const o of objs.values()) {
    if (!/\/Type\s*\/Page[^s]/.test(o.dict)) continue;
    pages.push(o);
  }

  const resolveDict = (dict, key) => {
    // /Resources 可能是内联字典，也可能是 n 0 R
    const inline = new RegExp('/' + key + '\\s*<<([\\s\\S]*?)>>').exec(dict);
    if (inline) return inline[1];
    const ref = new RegExp('/' + key + '\\s+(\\d+)\\s+0\\s+R').exec(dict);
    if (ref) {
      const t = objs.get(Number(ref[1]));
      if (t) {
        const m = /<<([\s\S]*?)>>/.exec(t.dict + (t.stream ? '' : ''));
        return m ? m[1] : t.dict;
      }
    }
    return '';
  };

  const texts = [];
  const targets = pages.length ? pages : [...objs.values()];

  /** 取这一页的 /Font 名字表：/Font 可能内联 << >>，也可能是 n 0 R 再套一层 */
  const fontTableOf = (pageDict) => {
    const res = resolveDict(pageDict, 'Resources') || pageDict;
    const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(res);
    if (inline) return inline[1];
    const ref = /\/Font\s+(\d+)\s+0\s+R/.exec(res) || /\/Font\s+(\d+)\s+0\s+R/.exec(pageDict);
    if (ref) {
      const fo = objs.get(Number(ref[1]));
      if (fo) {
        const m = /<<([\s\S]*?)>>/.exec(fo.dict);
        if (m) return m[1];
        return fo.dict;
      }
    }
    return '';
  };

  for (const page of targets) {
    const fontDictRaw = fontTableOf(page.dict);
    const nameToCmap = new Map();
    if (fontDictRaw) {
      const re = /\/([A-Za-z0-9.+_-]+)\s+(\d+)\s+0\s+R/g;
      let m;
      while ((m = re.exec(fontDictRaw))) {
        const cm = fontCmaps.get(Number(m[2]));
        if (cm) nameToCmap.set(m[1], cm);
      }
    }
    // 这一页声明了字体却一个 CMap 都没解析出来 → 不要拿全局兜底（会串字变成乱码）
    const cmapFallback = nameToCmap.size ? null : globalCmap;

    // 内容流：/Contents 单个或多个
    const contentNums = [];
    const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(page.dict);
    if (arr) {
      for (const t of arr[1].matchAll(/(\d+)\s+0\s+R/g)) contentNums.push(Number(t[1]));
    } else {
      const one = /\/Contents\s+(\d+)\s+0\s+R/.exec(page.dict);
      if (one) contentNums.push(Number(one[1]));
    }
    for (const n of contentNums) {
      const c = objs.get(n);
      if (!c || !c.stream) continue;
      const stream = (inflate(c.stream) || c.stream).toString('latin1');
      texts.push(contentToText(stream, nameToCmap, cmapFallback));
    }
  }

  const out = texts
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 内容流里夹带的标记语言（BDC 属性里的 /Lang (en-US)、纯点线、MACID 之类）不是正文
  const noise = /^(en-US|en-GB|zh-CN|\.{2,}|-{3,}|_{3,}|.{0,2})$/;
  const kept = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !noise.test(l));
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} name 文件名（用扩展名判断）
 * @param {Buffer} buf
 * @returns {{text:string, kind:string, note?:string}}
 */
function extractText(name, buf) {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext === 'docx') {
    const text = docxToText(buf);
    return { text, kind: 'docx' };
  }
  if (['txt', 'md', 'markdown', 'csv', 'json'].includes(ext)) {
    return { text: buf.toString('utf8'), kind: ext };
  }
  if (ext === 'pdf') {
    const text = pdfToText(buf);
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const ok = text.replace(/\s/g, '').length > 40 && (cjk >= 20 || !/[\u4e00-\u9fff]/.test(name));
    return {
      text,
      kind: 'pdf',
      note: ok ? undefined : 'PDF 里没抽出足够文字（可能是扫描件/加密/字体没带 ToUnicode），建议把条款正文粘贴进来',
    };
  }
  if (ext === 'doc') {
    return { text: '', kind: 'doc', note: '旧版 .doc 读不了，另存为 .docx 或直接粘贴正文' };
  }
  const text = buf.toString('utf8');
  const printable = text.replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff]/g, '').length;
  return {
    text,
    kind: ext || 'bin',
    note: printable / Math.max(text.length, 1) > 0.9 ? undefined : '二进制文件，建议转成 docx/txt 或直接粘贴正文',
  };
}

module.exports = { extractText, docxToText, pdfToText, stripXml, parseCMap, parseObjects };
