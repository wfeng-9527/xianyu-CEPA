/**
 * 阿里云 OSS V4 签名（query 模式，配合 STS 临时凭证）
 *
 * 来源：闲管家主进程 `ipcRenderer.invoke('generateSignedUrl', [{fileKey, originalkey, fileName}], token)`
 * 内部就是 ali-oss 的 signV4；bucket / region 从主进程内存里取到：
 *   bucket = xy-im-file, region = cn-hangzhou
 *
 * 凭证由 mtop.taobao.idlemessage.file.token.v1 下发：
 *   {accessKeyId, accessKeySecret, securityToken, expiration}
 */
const crypto = require('crypto');

const BUCKET = process.env.XY_OSS_BUCKET || 'xy-im-file';
const REGION = process.env.XY_OSS_REGION || 'cn-hangzhou';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * @param {object} creds {accessKeyId, accessKeySecret, securityToken}
 * @param {string} fileKey OSS object key，例如 "69050400022/2216.../1793...-xxxx.xls"
 * @param {number} expires 有效期秒数，默认 900（OSS 上传/下载链接够用）
 * @returns {{url:string, expiresAt:number, canonicalRequest:string, signature:string}}
 */
function signedUrl(creds, fileKey, expires = 900) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${REGION}/oss/aliyun_v4_request`;
  const credential = `${creds.accessKeyId}/${scope}`;

  const params = [
    ['x-oss-credential', credential],
    ['x-oss-date', amzDate],
    ['x-oss-expires', String(expires)],
    ['x-oss-security-token', creds.securityToken],
    ['x-oss-signature-version', 'OSS4-HMAC-SHA256'],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalQuery = params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const canonicalUri = `/${BUCKET}/${fileKey}`;
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, '', '', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['OSS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac('aliyun_v4' + creds.accessKeySecret, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, 'oss');
  const kSigning = hmac(kService, 'aliyun_v4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const url = `https://${BUCKET}.oss-${REGION}.aliyuncs.com/${fileKey}?${canonicalQuery}&x-oss-signature=${signature}`;
  return { url, expiresAt: Date.now() + expires * 1000, canonicalRequest, signature };
}

module.exports = { signedUrl, BUCKET, REGION };
