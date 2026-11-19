# 闲鱼客服工作台 · AI 接手指南

这是单账号客服工作台，覆盖会话和消息、订单、商品、人工回复、AI 回复与训练、保险方案和保单邮件。首次接手先看入口和本地健康状态，再沿对应业务模块定位。

| 要找什么 | 入口 |
| --- | --- |
| 本地 HTTP API、同步调度、静态资源 | [src/server.js](src/server.js)、[src/config.js](src/config.js) |
| SQLite 表结构、迁移与查询 | [src/lib/store.js](src/lib/store.js) |
| 会话、消息和账号连接 | [src/core/api.js](src/core/api.js)、[src/lib/impaas.js](src/lib/impaas.js)、[src/lib/cookiekeeper.js](src/lib/cookiekeeper.js) |
| 订单和金额拆分 | [src/core/orders.js](src/core/orders.js)、[src/lib/orderprice.js](src/lib/orderprice.js) |
| 保险方案与邮件 | [src/core/plans.js](src/core/plans.js)、[src/core/notify.js](src/core/notify.js)、[src/lib/mailer.js](src/lib/mailer.js) |
| AI、自动回复与训练 | [src/core/aiconf.js](src/core/aiconf.js)、[src/core/autoreply.js](src/core/autoreply.js)、[src/core/train.js](src/core/train.js) |
| React 前端和 API 类型 | [web/src/features](web/src/features)、[web/src/routes](web/src/routes)、[web/src/lib/im.ts](web/src/lib/im.ts) |
| Windows 启动、监控和自愈 | [start-backend.cmd](start-backend.cmd)、[scripts/guard.cjs](scripts/guard.cjs)、[scripts/watch.cjs](scripts/watch.cjs) |

## 本地运行与核验

- 后端使用支持 `node:sqlite` 的 Node.js，建议 Node.js 22.13+。前端在 `web/` 运行 `pnpm install --frozen-lockfile` 和 `pnpm exec vite build`，构建产物在 `web/dist/`。
- Windows 可用 `start-backend.cmd` 启动看门狗。开发时先确认端口 `5175` 是否已有实例。运行中的应用从 `data/` 和本地配置加载账号与业务数据。
- 检查 `http://127.0.0.1:5175/api/health` 和 `/api/sync/status`，同时看最近一轮错误数和 Cookie 续期状态。心跳更新不等于消息拉取成功。
- 一进程绑定一个账号。业务模块避免在绑定账号前初始化 SQLite，否则可能误开 `data/xianyu.db`。订单号和会话 ID 按字符串处理。超过单轮分页上限时，同步补齐仍需单独验证。
- 联调优先用离线夹具、模拟数据及 shadow 模式。发送消息、发货、出单、退保和发邮件会修改实际业务状态。工作台和浏览器调试端口只对可信本地环境开放。

## 仓库内的运行数据

[data/](data/) 以明文形式纳入版本管理，用于在私有仓库内整体接管和迁移。当前包含：

| 路径 | 内容 |
| --- | --- |
| [data/xianyu-2214811203163.db](data/xianyu-2214811203163.db) | 主库快照：会话、聊天原文、客户、订单、保险方案、训练记录 |
| [data/xianyu.db](data/xianyu.db) | 早期库，含少量会话、消息和订单 |
| `data/xianyu-*.db-wal` | SQLite 预写日志，与对应的 `.db` 一起才能读到最新提交 |
| `data/accounts/*.cookie` | 闲鱼登录 Cookie，可直接用于同步和续期 |
| [data/policies/](data/policies/) | 已出单的电子保单 PDF |
| `data/files/`、`data/inbox/` | 聊天附件与入站文件 |
| `data/*.log`、`data/*.jsonl` | 同步心跳、Cookie 续期、看门狗与自动回复记录 |
| `data/im-hist*.json`、`data/im-ws.json` | IM 抓包导出，含会话历史原始报文 |

以下内容不入库：Chrome 浏览器配置（`data/chrome/`，数百 MB 缓存）、运行锁（`*.pid`）、`*.db-shm` 共享内存文件，以及 `config.json`、`.env`、`*.key` 等机器级密钥。`data/ai-config.json`、`data/mail.json`、`data/lyybao.json` 也在仓库内，恢复后可直接复用平台对接配置。

克隆后可直接启动：SQLite 是文件库，`data/` 原样存在即可读到历史会话与订单。注意 `.db` 与 `.db-wal` 必须同版本，单独拷 `.db` 会丢最近的未检查点事务。Cookie 会过期，长时间未运行后先确认 `/api/health` 里的续期状态。拿到本仓库即等同于拿到一个可登录的客服账号，不要把仓库内容复制到公开位置、工单或第三方 AI 会话中。
