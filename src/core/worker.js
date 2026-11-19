'use strict';
/**
 * Worker：同步 → 落库 → 出事件 → 规则判定 → 发送
 * 这是自动化系统的「主干」。上层（AI、任务调度、后台）都挂在这条主干上。
 */
const { cfg } = require('../config');
const mtop = require('../lib/mtop');
const store = require('../lib/store');
const api = require('./api');
const rules = require('./rules');
const { GpushClient, buildUdid } = require('../lib/ws');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class Worker {
  constructor(opts = {}) {
    this.opts = Object.assign({ autoReply: true, ai: null }, opts);
    this.ws = null;
    this.timers = [];
    this.syncing = false;
    this.pendingSync = false;
  }

  // -------------------------------------------------------------- 同步
  async syncSessions() {
    const list = await api.getAllSessions();
    store.saveSessions(list);
    return list;
  }

  /** 单个会话增量拉消息，落库并产生事件 */
  async syncMessages(sessionId, { pageSize = cfg.msgPageSize } = {}) {
    const key = `msg:${sessionId}`;
    const since = Number(store.getCursor(key) || 0);
    const msgs = await api.fetchSince(sessionId, since, { pageSize });
    if (!msgs.length) return 0;

    const added = store.saveMessages(sessionId, msgs);
    const maxV = Math.max(...msgs.map(m => m.version || 0));
    if (maxV) store.setCursor(key, maxV);

    for (const m of msgs) {
      if (m.fromSelf) continue;
      store.pushEvent('message', {
        sessionId, messageId: m.messageId, ts: m.ts,
        text: m.text, ctype: m.contentType, senderId: m.senderId,
      });
    }
    if (added) log(`  + ${sessionId} 新增 ${added} 条（截至 ${new Date(maxV).toLocaleString()}）`);
    return added;
  }

  async syncAll({ limit = 30 } = {}) {
    if (this.syncing) { this.pendingSync = true; return 0; }
    this.syncing = true;
    let total = 0;
    try {
      const sessions = await this.syncSessions();
      log(`会话 ${sessions.length} 个`);
      for (const s of sessions.slice(0, limit)) {
        try {
          total += await this.syncMessages(s.id);
        } catch (e) {
          log(`  ! ${s.id} 同步失败: ${e.message.split('\n')[0]}`);
        }
        await new Promise(r => setTimeout(r, 120)); // 会话间微延迟，控频
      }
    } finally {
      this.syncing = false;
      if (this.pendingSync) { this.pendingSync = false; setTimeout(() => this.syncAll({ limit }), 1000); }
    }
    return total;
  }

  // -------------------------------------------------------------- 处理事件
  async processEvents(limit = 20, conf = rules.load()) {
    const evts = store.pendingEvents(limit);
    let replied = 0;
    for (const ev of evts) {
      let p;
      try { p = JSON.parse(ev.payload); } catch (_) { store.markHandled(ev.id); continue; }
      if (ev.kind !== 'message') { store.markHandled(ev.id); continue; }

      const ctx = {
        sessionId: p.sessionId,
        text: p.text,
        senderId: p.senderId,
        session: store.getSession(p.sessionId),
      };
      // 决策统一走 autoreply：敏感词 → 规则 → AI → 自检
      const autoreply = require('./autoreply');
      let st;
      try {
        st = await autoreply.answer({ store, sessionId: p.sessionId, text: p.text, live: true });
      } catch (e) {
        log(`[决策失败] ${e.message} → 转人工`);
        store.pushEvent('handoff', { sessionId: p.sessionId, text: p.text, reason: e.message });
        store.markHandled(ev.id);
        continue;
      }

      if (st.action === 'ignore') { store.markHandled(ev.id); continue; }

      if (st.action === 'handoff' || !st.text) {
        log(`[转人工] ${p.sessionId} 「${(p.text || '').slice(0, 30)}」 ${st.source || ''} ${st.reason || ''}`);
        store.pushEvent('handoff', { sessionId: p.sessionId, text: p.text, source: st.source, reason: st.reason });
        store.markHandled(ev.id);
        continue;
      }

      if (!this.opts.autoReply) {
        // 只看不发：留一条建议给工作台
        store.pushEvent('suggest', { sessionId: p.sessionId, text: p.text, suggest: st.text, source: st.source });
        log(`[建议] ${p.sessionId} → ${st.text.slice(0, 40)}`);
        store.markHandled(ev.id);
        continue;
      }

      const text = st.text;

      const outId = api.newUuid(p.sessionId);
      store.outboxAdd(outId, p.sessionId, { contentType: 1, text: { text } });
      try {
        const r = await api.sendText(p.sessionId, text);
        store.outboxDone(outId, 'sent', r.data);
        rules.markReplied(p.sessionId);
        replied++;
        log(`[已回复] ${p.sessionId} → ${text.slice(0, 40)}`);
        // 回写自己的消息，避免下轮当成新消息
        store.saveMessages(p.sessionId, [{
          messageId: r.localId, version: Date.now(), ts: Date.now(),
          contentType: 1, text, senderId: cfg.accountId, fromSelf: true, raw: { synthetic: true },
        }]);
      } catch (e) {
        store.outboxDone(outId, 'failed', { error: e.message });
        log(`[发送失败] ${p.sessionId}: ${e.message.split('\n')[0]}`);
      }
      store.markHandled(ev.id);
      await new Promise(r => setTimeout(r, 400)); // 发送间隔
    }
    return replied;
  }

  /** 跑一轮：同步 + 处理 */
  async tick() {
    await this.syncAll();
    await this.processEvents();
  }

  // -------------------------------------------------------------- 守护
  startWs() {
    if (!cfg.accessToken || !cfg.accountId) {
      log('无 accessToken/accountId，跳过 WS，使用轮询模式');
      return;
    }
    const udid = buildUdid(cfg.accountId, cfg.udid);
    this.ws = new GpushClient({
      accessToken: cfg.accessToken,
      userId: cfg.accountId,
      sellerId: cfg.sellerId || cfg.accountId,
      udid,
      wsType: cfg.wsType,
    });
    this.ws.on('log', m => log('[ws]', m));
    this.ws.on('open', () => log('[ws] 已连接'));
    this.ws.on('error', e => log('[ws] 错误', e.message));
    this.ws.on('fatal', e => log('[ws] 致命', e.message));
    let debounce = null;
    this.ws.on('push', frame => {
      const d = frame.data || {};
      log(`[push] type=${d.pushType} id=${d.pushId || '-'}`);
      // 21620：客服接入请求，需应答
      if (d.pushType === 21620 && d.data) {
        this.ws.send({
          msgId: frame.msgId, mtime: Date.now(), mt: 100004,
          payload: { type: 21621, data: {
            code: 1, msg: '-', time: d.data.time,
            agentId: d.data.agentId, userId: d.data.userId,
            relationId: d.data.relationId, action: d.data.action,
          } },
        });
      }
      clearTimeout(debounce);
      debounce = setTimeout(() => this.tick().catch(e => log('[tick]', e.message)), 1500);
    });
    this.ws.connect();
  }

  start() {
    const poll = Math.max(10, cfg.pollInterval) * 1000;
    this.startWs();
    this.tick().catch(e => log('[tick]', e.message));
    this.timers.push(setInterval(() => this.tick().catch(e => log('[tick]', e.message)), poll));
    log(`守护已启动：轮询 ${poll / 1000}s，自动回复=${this.opts.autoReply}，dryRun=${cfg.dryRun}`);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.ws) this.ws.close();
  }
}

module.exports = Worker;
