// 极简 zip 读取（docx/xlsx 都是 zip）。只支持 stored(0) 与 deflate(8)，够用。
const zlib = require('zlib');

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 列出 zip 条目
 * @returns {{name:string,method:number,compressedSize:number,size:number,offset:number}[]}
 */
function listEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    out.push({ name, method, compressedSize, size, offset: localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读某个条目的内容 */
function readEntry(buf, entry) {
  const off = entry.offset;
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('本地头损坏：' + entry.name);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式 ' + entry.method);
}

module.exports = { listEntries, readEntry };
