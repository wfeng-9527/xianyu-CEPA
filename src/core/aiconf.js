'use strict';
/**
 * 模型接入配置：data/ai-config.json
 *
 * 两种取值来源：
 *   source: 'harness' —— 直接复用 DeepSeek Harness 的模型配置（默认）
 *      · key 读 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY（就是 harness 模型页在用的那把）
 *      · 端点默认 https://api.deepseek.com/anthropic（Anthropic Messages，harness 的 DeepSeek 卡片默认值）
 *      · 可用 DEEPSEEK_BASE_URL 覆盖，与 harness 行为一致
 *   source: 'manual'  —— 自己填 baseUrl/apiKey/model（老行为，给其它服务商用）
 *
 * 优先级：环境变量（XY_AI_*）> ai-config.json > harness 凭据 > 内置默认
 */
const fs = require('fs');
const path = require('path');
const { ROOT, readJson } = require('../config');

const FILE = path.join(ROOT, 'data', 'ai-config.json');

const HARNESS_HOME = process.env.DSH_HOME || 'C:\\Users\\Administrator\\.dsh';
const CRED_FILE = path.join(HARNESS_HOME, '.credentials.yaml');

const HARNESS = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  protocol: 'anthropic',
  model: 'deepseek-chat',
  keyRef: 'DEEPSEEK_API_KEY',
};

const DEFAULTS = {
  source: 'manual',               // manual | harness（harness 仅供无 key 时兜底，界面默认手动）
  enabled: false,                 // 总开关：关掉就只给建议，不自动回
  protocol: 'auto',               // auto | anthropic | openai
  baseUrl: HARNESS.baseUrl,
  apiKey: '',
  model: HARNESS.model,
  temperature: 0.6,
  maxTokens: 300,
  persona: '',                    // 人设/口吻，一句话
  knowledge: [],                  // 店铺常识（可手写）：发货、时效、退改、发票…
  handoffWhen: ['退款', '退钱', '投诉', '赔付', '仲裁', '工商', '报警'],
  maxLen: 120,                    // 单条回复字数上限
  dailyLimit: 300,                // 每天自动回复上限（防跑飞）
  retryOnCheckFail: 1,            // 红线自检不过时重写几次
};

/** 直接从 harness 的凭据文件里取密钥（yaml 的 refs 段，形如 `  DEEPSEEK_API_KEY: sk-xxx`） */
function harnessKey(ref = HARNESS.keyRef) {
  try {
    if (!fs.existsSync(CRED_FILE)) return '';
    const txt = fs.readFileSync(CRED_FILE, 'utf8');
    const re = new RegExp('^\\s*' + ref + ':\\s*(\\S+)\\s*$', 'm');
    const m = txt.match(re);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function harnessInfo() {
  const key = harnessKey();
  return {
    home: HARNESS_HOME,
    credFile: CRED_FILE,
    credExists: fs.existsSync(CRED_FILE),
    keyRef: HARNESS.keyRef,
    hasKey: Boolean(key),
    keyMasked: key ? key.slice(0, 6) + '****' + key.slice(-4) : '',
    defaultBaseUrl: process.env.DEEPSEEK_BASE_URL || HARNESS.baseUrl,
    defaultModel: HARNESS.model,
  };
}

function envOverride(c) {
  const out = { ...c };
  if (process.env.XY_AI_KEY) {
    out.apiKey = process.env.XY_AI_KEY;
    out.source = 'manual';
  }
  if (process.env.XY_AI_BASE_URL) out.baseUrl = process.env.XY_AI_BASE_URL;
  if (process.env.XY_AI_MODEL) out.model = process.env.XY_AI_MODEL;
  if (process.env.XY_AI_PROTOCOL) out.protocol = process.env.XY_AI_PROTOCOL;
  if (process.env.XY_AI_ENABLED) out.enabled = process.env.XY_AI_ENABLED === '1';
  if (process.env.XY_AI_MOCK) out.mock = process.env.XY_AI_MOCK === '1';
  return out;
}

function load() {
  const raw = readJson(FILE, {});
  const conf = { ...DEFAULTS, ...raw };
  conf.knowledge = Array.isArray(conf.knowledge) ? conf.knowledge : [];
  conf.handoffWhen = Array.isArray(conf.handoffWhen) ? conf.handoffWhen : DEFAULTS.handoffWhen;
  conf.baseUrl = String(conf.baseUrl || '').replace(/\/$/, '');

  // 协议：auto 时按端点判断（含 /anthropic 走 Messages，否则 OpenAI 兼容）
  if (!conf.protocol || conf.protocol === 'auto') {
    conf.protocol = /\/anthropic(\/|$)/i.test(conf.baseUrl) ? 'anthropic' : 'openai';
  }

  // 没填 Key 时才回落到 harness 凭据（界面上仍然要求手填）
  if (!conf.apiKey) {
    const hk = process.env.XY_AI_KEY || harnessKey();
    if (hk) {
      conf.apiKey = hk;
      conf.keySource = 'harness:' + HARNESS.keyRef;
    }
  } else {
    conf.keySource = conf.source === 'manual' ? 'file' : 'harness:' + HARNESS.keyRef;
  }
  if (conf.source === 'manual' && !raw.apiKey && !process.env.XY_AI_KEY) conf.keySource = 'harness:' + HARNESS.keyRef;
  return envOverride(conf);
}

/** 保存（只合并白名单字段，避免把乱七八糟的东西写进配置） */
function save(patch = {}) {
  const cur = readJson(FILE, {});
  const next = { ...DEFAULTS, ...cur };
  const keys = Object.keys(DEFAULTS).concat(['mock']);
  for (const k of keys) {
    if (patch[k] === undefined) continue;
    if (k === 'apiKey' && (patch[k] === '' || patch[k] === null)) continue; // 空值不覆盖（避免误清）
    next[k] = patch[k];
  }
  next.source = next.source === 'harness' ? 'harness' : 'manual';
  next.protocol = ['anthropic', 'openai'].includes(next.protocol) ? next.protocol : 'auto';
  next.temperature = Math.min(Math.max(Number(next.temperature) || 0.6, 0), 2);
  next.maxTokens = Math.min(Math.max(Number(next.maxTokens) || 300, 32), 4096);
  next.maxLen = Math.min(Math.max(Number(next.maxLen) || 120, 20), 800);
  next.dailyLimit = Math.min(Math.max(Number(next.dailyLimit) || 300, 0), 5000);
  // harness 模式不落盘密钥
  if (next.source === 'harness') next.apiKey = '';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return load();
}

/** 给前端的视图：密钥打码，附带 harness 探测结果 */
function view() {
  const c = load();
  const key = c.apiKey || '';
  return {
    ...c,
    apiKey: '',
    apiKeyMasked: key ? key.slice(0, 4) + '****' + key.slice(-4) : '',
    hasKey: Boolean(key),
    keySource: c.keySource || '',
    harness: harnessInfo(),
    file: FILE,
  };
}

function ready() {
  const c = load();
  if (c.mock) return { ok: true, reason: 'mock' };
  if (!c.apiKey) {
    return {
      ok: false,
      reason: c.source === 'harness'
        ? `harness 凭据里没有 ${HARNESS.keyRef}（${CRED_FILE}），或在 AI 页切到「手动填 Key」`
        : '未配置 API Key',
    };
  }
  if (!c.baseUrl) return { ok: false, reason: '未配置 baseUrl' };
  return { ok: true, source: c.source, model: c.model };
}

module.exports = { FILE, DEFAULTS, HARNESS, load, save, view, ready, harnessKey, harnessInfo };
