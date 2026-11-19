// 消息 content → 可渲染结构（图片/语音/文件/表情/商品卡/转账…）
// 输入是 messages.raw 的 JSON 字符串（或已解析对象）；不抛异常，认不出来就当文本。

const MAX_PICS = 9;

function b64json(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    const txt = Buffer.from(s, 'base64').toString('utf8');
    if (!txt.trim().startsWith('{')) return null;
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** 把 content 摊平成 {type,text,images,audio,file,emoji,item,...} */
function describeContent(content, fallbackText) {
  const out = { type: 'text', text: fallbackText || '' };
  if (!content || typeof content !== 'object') return out;

  let ct = Number(content.contentType) || 0;
  // 101 = custom 包装，真正的内容在 base64 里
  if (ct === 101 && content.custom) {
    const inner = b64json(content.custom.data);
    if (inner) {
      const r = describeContent(inner, content.custom.summary || fallbackText);
      if (!r.text) r.text = content.custom.summary || '';
      return r;
    }
    return { type: 'other', text: content.custom.summary || fallbackText || '[消息]' };
  }

  if (ct === 1) {
    const t = (content.text && content.text.text) || '';
    return { type: 'text', text: t || fallbackText || '' };
  }

  if (ct === 2 && content.image) {
    const pics = (content.image.pics || [])
      .filter((p) => p && p.url)
      .slice(0, MAX_PICS)
      .map((p) => ({ url: String(p.url), width: Number(p.width) || 0, height: Number(p.height) || 0 }));
    return { type: 'image', text: fallbackText || '[图片]', images: pics };
  }

  if (ct === 3 && content.audio) {
    return {
      type: 'audio',
      text: fallbackText || '[语音]',
      audio: {
        url: String(content.audio.url || ''),
        duration: Number(content.audio.duration) || 0,
        size: Number(content.audio.sizeBytes) || 0,
      },
    };
  }

  if (ct === 5 && content.expression) {
    const e = content.expression;
    return {
      type: 'emoji',
      text: fallbackText || '[动画表情]',
      emoji: {
        name: e.name || '',
        url: String(e.url || e.peerIconUrl || e.selfIconUrl || ''),
        lotie: String(e.lotieUrl || ''),
      },
    };
  }

  if (ct === 7 && content.itemCard) {
    const it = (content.itemCard.item || {}).item || content.itemCard.item || {};
    return {
      type: 'item',
      text: fallbackText || '[商品卡]',
      item: {
        itemId: String(it.itemId || ''),
        title: String(it.title || ''),
        pic: String(it.mainPic || ''),
        price: String(it.price || ''),
      },
    };
  }

  if (ct === 33 && content.file) {
    const f = content.file;
    return {
      type: 'file',
      text: fallbackText || '[文件]',
      file: {
        name: String(f.displayName || ''),
        size: Number(f.fileSize) || 0,
        ext: String(f.fileType || ''),
        key: String(f.fileKey || ''),
      },
    };
  }

  if (ct === 17 && content.transfer) {
    const t = content.transfer;
    return {
      type: 'transfer',
      text: t.title || '[转账]',
      transfer: { title: String(t.title || ''), content: String(t.content || ''), pic: String(t.mediaUrl || '') },
    };
  }

  if (ct === 18 && content.rtc) {
    const r = content.rtc;
    let detail = '';
    try {
      const m = JSON.parse(r.content || '{}');
      detail = Object.values(m).join(' / ');
    } catch {
      detail = String(r.content || '');
    }
    return {
      type: 'rtc',
      text: r.text || '[语音通话]',
      rtc: { duration: Number(r.duration) || 0, detail },
    };
  }

  if (ct === 27 && content.withdrawTip) {
    const w = content.withdrawTip;
    const origin = w.originContent ? describeContent(w.originContent, '') : null;
    return {
      type: 'withdraw',
      text: w.withdrawText || '撤回了一条消息',
      withdraw: { originText: (origin && origin.text) || '' },
    };
  }

  if (content.dxCard) {
    // 25 / 26 / 32：营销卡、评价卡、动态操作卡
    const item = content.dxCard.item || {};
    const main = item.main || {};
    const ex = main.exContent || {};
    const btn = ex.button || {};
    const title = ex.titleText || ex.title || main.title || '';
    const desc = ex.desc || ex.content || '';
    return {
      type: 'card',
      text: fallbackText || title || '[卡片]',
      card: {
        title: String(title || ''),
        desc: String(desc || ''),
        pic: String(ex.bgPic || ex.picUrl || main.pic || ''),
        button: String(btn.text || ''),
        url: String((btn.clickParam && btn.clickParam.args && btn.clickParam.args.targetUrl) || btn.targetUrl || ''),
      },
    };
  }

  // 其它：尽量留一句人话
  const label = fallbackText || `[type ${ct}]`;
  return { type: 'other', text: label, contentType: ct };
}

/** @param {string|object} raw messages.raw */
function describe(raw, fallbackText) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { type: 'text', text: fallbackText || raw || '' };
    }
  }
  if (!obj || typeof obj !== 'object') return { type: 'text', text: fallbackText || '' };
  // 历史消息是 {content:{...}}；推送帧是 {extension:{reminderContent}} 没有 content
  if (obj.content) {
    const r = describeContent(obj.content, fallbackText);
    if (!r.text) r.text = fallbackText || '';
    return r;
  }
  const ext = obj.extension || {};
  return { type: 'text', text: fallbackText || ext.reminderContent || ext.detailNotice || '' };
}

function humanSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

module.exports = { describe, describeContent, b64json, humanSize };
