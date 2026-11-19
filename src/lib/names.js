/**
 * 昵称清洗。
 *
 * 闲鱼把「交易提醒」也塞进 message.extension.reminderTitle / session.userInfo.fishNick，
 * 于是会拿到「买家已拍下，待付款」「等待你发货」「快给ta一个评价吧～」这种根本不是人名的串。
 * 早期还把卖家自己的昵称当成客户名（会话里最后一条是我发的时候），
 * 所以这里统一做一次「像不像人名」的判断，凡是可疑的一律当没有名字。
 */

const SYSTEM_PATTERNS = [
  /买家已拍下/,
  /等待你发货/,
  /记得及时发货/,
  /我已付款/,
  /快给ta一个评价/,
  /我完成了评价/,
  /对方转账/,
  /关注我可享/,
  /需年满\s*\d+\s*周岁/,
  /请勿引导买家/,
  /^\s*\[.*\]\s*$/,          // [动画表情] / [送花] 这类占位
  /^(系统|官方|闲鱼)消息?$/,
  /^交易消息$/,
  /^消息提醒$/,
  /^客服(消息)?$/,
  /^(订单|交易|物流|退款)提醒$/,
  /^匿名(用户|买家|卖家)$/,
];

/** 这个串能不能当人昵称用 */
function looksLikeName(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (v.length > 32) return false;                 // 昵称不会这么长
  if (SYSTEM_PATTERNS.some(re => re.test(v))) return false;
  if (/^[\d\s.,:：+\-]+$/.test(v)) return false;    // 纯数字/时间
  return true;
}

/** 打码的昵称（x***3、吕***y、tbNick_xxx 之外的情况）：能显示但不完整 */
function isMasked(s) {
  return /\*{2,}/.test(String(s || ''));
}

/** 没有昵称时的占位：不暴露「客户 1063797519」这种裸 id 观感太差 */
function fallbackName(userId) {
  const id = String(userId || '');
  return id ? `客户 ${id.slice(-4)}` : '未知客户';
}

module.exports = { looksLikeName, isMasked, fallbackName };
