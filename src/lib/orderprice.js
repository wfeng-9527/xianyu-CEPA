'use strict';
/**
 * 订单金额拆分：现金 + 闲鱼币
 *
 * 为什么需要它：`mtop.taobao.idle.trade.sold.get` 只给 `priceInfo{auctionPriceDesc,buyAmount,price}`，
 * 拿到的是「实付款」（支付宝担保账户里的现金），**不含买家用的闲鱼币抵扣**。
 * 真要开票/对账时必须用 `mtop.idle.web.trade.order.detail`（网页 order-detail 页面在用的接口）：
 *
 *   POST /h5/mtop.idle.web.trade.order.detail/1.0/  data={"tid":"<orderId>"}   ← 参数名是 tid！
 *   响应是扁平对象（没有 ret/data 包装），价格在 components[i].data.priceInfo：
 *     amount       { title:'成交价', value:'15.70' }            ← 现金
 *     billList     [ {code:'ITEM_TOTAL_FEE', title:'商品总价', value:'16.00'},
 *                    {code:'POST_FEE', title:'运费', value:'0.00'},
 *                    {title:'闲鱼币抵扣', value:'-0.30'} ]
 *     idleCoin     { title:'待收闲鱼币', value:'1600' }          ← 含平台奖励，不等于买家支付的部分
 *     xybYoutuiDeduction { title:'闲鱼币智能抵扣', value:'-1.30' }
 *
 * 币率：1000 闲鱼币 = 1 元（用 1600 = 300 + 1300 与用户举例「18.00 + 2000 币 = 开票 20」双向印证）
 * 开票口径：开票金额 = 成交价 + 买家闲鱼币抵扣 = 商品总价（15.70 + 0.30 = 16.00）
 */
const mtop = require('./mtop');

const COIN_PER_YUAN = 1000;

const pick = (arr, pred) => (Array.isArray(arr) ? arr.find(pred) : null);
const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/** 从 order.detail 的扁平响应里拆出金额；找不到返回 null */
function parseOrderDetail(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const comps = Array.isArray(resp.components) ? resp.components : [];
  let priceInfo = null;
  for (const c of comps) {
    const d = c && c.data;
    if (d && d.priceInfo) { priceInfo = d.priceInfo; break; }
  }
  if (!priceInfo) return null;

  const cash = toNum(priceInfo.amount && priceInfo.amount.value);
  const bills = priceInfo.billList || [];
  const goodsTotal = toNum((pick(bills, (b) => b.code === 'ITEM_TOTAL_FEE') || {}).value);
  const postFee = toNum((pick(bills, (b) => b.code === 'POST_FEE') || {}).value);
  const coinBill = pick(bills, (b) => String(b.title || '').includes('闲鱼币'));
  const coinAmount = coinBill ? Math.abs(toNum(coinBill.value) || 0) : 0;
  const coinCount = Math.round(coinAmount * COIN_PER_YUAN);
  const coinsReceiving = toNum(priceInfo.idleCoin && priceInfo.idleCoin.value);
  const smartDeduct = Math.abs(toNum(priceInfo.xybYoutuiDeduction && priceInfo.xybYoutuiDeduction.value) || 0) || 0;

  // 开票金额：优先商品总价；没有就算 现金 + 闲鱼币抵扣
  const invoiceTotal = goodsTotal != null ? goodsTotal : round2((cash || 0) + coinAmount);

  // orderInfoList 里挑出付款时间 / 支付宝交易号 / 收货地址
  const infos = Array.isArray(resp.components)
    ? comps.flatMap((c) => (c && c.data && Array.isArray(c.data.orderInfoList) ? c.data.orderInfoList : []))
    : [];
  const infoOf = (label) => {
    for (const it of infos) {
      if (Array.isArray(it)) {
        const hit = it.find((x) => x && x.title && String(x.title).includes(label));
        if (hit) return hit.value || '';
      } else if (it && it.title && String(it.title).includes(label)) {
        return it.value || '';
      }
    }
    return '';
  };

  return {
    orderId: String(resp.orderId || ''),
    cashAmount: cash,
    coinAmount: round2(coinAmount),
    coinCount,
    goodsTotal,
    invoiceTotal,
    postFee,
    coinsReceiving,
    smartDeduct: round2(smartDeduct) || null,
    payTime: infoOf('付款时间'),
    alipayNo: infoOf('支付宝交易号'),
    address: infoOf('收货地址'),
    raw: resp,
  };
}

/** 直接拉某个订单的金额拆分（失败抛错，调用方自己兜） */
async function fetchOrderPrice(orderId) {
  const id = String(orderId || '').trim();
  if (!/^\d{10,25}$/.test(id)) throw new Error('orderId 不合法：' + id);
  const resp = await mtop.call('mtop.idle.web.trade.order.detail', '1.0', { tid: id }, { retries: 1 });
  const parsed = parseOrderDetail(resp);
  if (!parsed) throw new Error('订单详情里没有 priceInfo');
  // ⚠️ 响应里的 orderId 是 JSON number，19 位会丢精度（…026435 变成 …027000），一律用入参覆盖
  parsed.orderId = id;
  return parsed;
}

/** 给前端显示的一句话：金额：¥15.70+（闲鱼币）300 */
function moneyLine(p) {
  if (!p) return '';
  const cash = p.cashAmount == null ? '' : `¥${p.cashAmount.toFixed(2)}`;
  if (!p.coinCount) return `金额：${cash}`;
  return `金额：${cash}+（闲鱼币）${p.coinCount}`;
}

module.exports = { COIN_PER_YUAN, parseOrderDetail, fetchOrderPrice, moneyLine };
