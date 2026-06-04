# API Token 认证 — 实现方案

Issue: #140

## 概述

为 dashboard 新增一种**外部只读访问身份**：API Key + Session Token 两层认证，支持外部 Agent 通过 API 接入 SSE 数据流和只读查询接口，不依赖浏览器 cookie 登录。

本 issue 范围限定为 **read-only 接入**。远程管理操作（admin scope、actions 端点暴露）涉及不同的安全边界和设计要求，将在单独 issue 中设计。

这是现有 UI cookie session（`AuthGate`）之外的独立认证通道，两者并存互不干扰：
- **Cookie session**: 浏览器用户通过密码登录，可访问所有端点（包括 actions 写操作）
- **API token**: 外部 Agent 通过 API Key 换取 session token，**仅可访问只读数据端点**

## 认证模型

```
调用方                        Dashboard
  │                              │
  │  POST /api/auth/token        │
  │  Authorization: Bearer       │
  │    zylos_ak_<api-key>        │
  │  ───────────────────────►    │
  │                              │  遍历 api_keys, scrypt 验证
  │  ◄───────────────────────    │  签发 Session Token
  │  { token: zylos_st_...,      │
  │    expires_at, ttl: 86400 }  │
  │                              │
  │  GET /api/state              │
  │  Authorization: Bearer       │
  │    zylos_st_<session-token>  │
  │  ───────────────────────►    │  SHA-256(token) 查表 + TTL + revoke 检查
  │  ◄───────────────────────    │
  │  { state data }              │
```

两层的意义：API Key 只在换 token 时传输一次（而非每个请求都带），降低了高频请求中长期凭据的暴露面。session token 被截获后 24h 失效，损失可控。

**传输安全说明**: 两层模型减少 API Key 的传输频率，但不能替代传输加密。外部 Agent 接入推荐 HTTPS。明文 HTTP 环境下，API Key 在 token exchange 时仍有被截获的风险，用户需接受此风险或配置 HTTPS。Dashboard 默认监听 localhost，外部访问通过 Caddy 反代（已有 HTTPS）。

## 凭据哈希策略

两种凭据使用不同的哈希方式：

| 凭据类型 | 哈希方式 | 原因 |
|---------|---------|------|
| API Key (`zylos_ak_*`) | scrypt (随机 salt) | 密码类凭据，低频使用（仅 token exchange），验证时遍历匹配 |
| Session Token (`zylos_st_*`) | SHA-256 (deterministic) | 高频使用（每个请求），需按 hash 直接查表。与现有 cookie session 机制一致 (`auth.js:65-82`) |

## 数据库变更

新增两张表（incremental migration）：

```sql
-- api_keys: 长期 API Key (scrypt hash, 不可直接查找)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,           -- uuid
  name TEXT NOT NULL UNIQUE,     -- 人类可读名称，如 "agent-beta"
  key_hash TEXT NOT NULL,        -- scrypt hash of zylos_ak_* (带随机 salt)
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER             -- 非空表示已撤销
);

-- api_sessions: 短期 Session Token (SHA-256 hash, 可直接查找)
CREATE TABLE api_sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256(zylos_st_*), deterministic
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- created_at + 86400s
  last_used_at INTEGER
);
CREATE INDEX idx_api_sessions_expires ON api_sessions(expires_at);
```

## 实现拆分

### Step 1: DB schema + API Key 管理

文件变更：
- `src/lib/store.js` — 新增 migration (api_keys + api_sessions 表)，CRUD prepared statements
- `hooks/api-keys.js` — 独立脚本，管理 API Key 生命周期

API Key 生成：
```js
const raw = `zylos_ak_${crypto.randomBytes(24).toString('base64url')}`;
// 返回明文给用户，DB 只存 scrypt hash（带随机 salt）
```

管理入口（独立脚本，不依赖 configure hook 的 flag 机制）：
```bash
node hooks/api-keys.js generate --name agent-beta
# → API Key: zylos_ak_f8a3kQ...  (只显示一次，请妥善保存)

node hooks/api-keys.js revoke --name agent-beta
# → Revoked API key "agent-beta"

node hooks/api-keys.js list
# → agent-beta  created: 2026-06-04  last_used: 2026-06-04  status: active
# → agent-gamma created: 2026-06-04  last_used: never       status: revoked
```

脚本需要知道 data dir 路径以打开 SQLite DB，通过环境变量 `ZYLOS_DIR` 或默认 `~/zylos` 解析。

### Step 2: Token 交换端点

文件变更：
- `src/lib/auth.js` — 新增 `handleApiTokenExchange()` 方法
- `src/index.js` — 注册 `POST /api/auth/token` 路由（在 auth gate 之前）

端点逻辑：
```
POST /api/auth/token
Authorization: Bearer zylos_ak_<key>

1. 从 header 提取 API Key
2. 遍历 api_keys 表未撤销的记录，scrypt 验证（低频操作，遍历可接受）
3. 验证通过 → 更新 last_used_at
4. 生成 session token: zylos_st_<random>
5. 存入 api_sessions（SHA-256(token), api_key_id, created_at, expires_at）
6. 返回 { token, expires_at, ttl_seconds: 86400 }

失败 → 401 + rate limit（复用现有 failedAttempts 机制）
```

### Step 3: Session Token 认证中间件

文件变更：
- `src/lib/auth.js` — 扩展 `handle()` 方法，在 cookie 认证之前先检查 Bearer token

认证优先级：
```
1. 检查 Authorization: Bearer zylos_st_* → API session token 认证
2. 检查 cookie (__Host-zylos_dashboard_session) → 浏览器 session 认证
3. 都没有 → 重定向到 login 页面（仅 HTML 请求）或返回 401（API 请求）
```

API session token 验证：
```
1. 从 header 提取 token
2. SHA-256(token) 后按 hash 直接查 api_sessions 表（O(1)，与 cookie session 一致）
3. 检查 expires_at > now（TTL 失效 → 401）
4. JOIN api_keys 检查 revoked_at IS NULL（撤销立即生效 → 401）
5. 更新 last_used_at
6. 检查目标端点是否在只读 allowlist 中（见端点矩阵，不在列表中 → 403）
7. 通过 → 放行请求
```

### Step 4: SSE 流支持

文件变更：
- `src/index.js` — `/api/stream` 路由允许 Bearer token 认证
- `src/lib/sse.js` — SSE client 记录 session 元数据，周期性验证

SSE 连接管理：
- 连接建立时验证 token，记录 `{ token_hash, api_key_id, expires_at }` 到 SSE client 对象
- **周期性验证**: 在每次 keepalive 或 broadcast 前，对 API token 连接做轻量检查：
  - `expires_at > now`?
  - `api_keys.revoked_at IS NULL`? (按 api_key_id 查)
  - 任一不满足 → 关闭 SSE 连接，发送 `event: auth_expired` 后断开
- **可测试行为**: API Key 撤销后，已建立的 SSE 连接在下一个 keepalive 周期（15s）内断开
- 客户端断连后需要用 API Key 重新换 token 再连接

### Step 5: 过期清理

文件变更：
- `src/lib/auth.js` — 在现有 session cleanup interval 中增加 api_sessions 清理

清理逻辑：
```js
// 每 5 分钟清理过期的 api_sessions
DELETE FROM api_sessions WHERE expires_at < ?
```

## 端点访问矩阵（完整 explicit allowlist）

### API Token 可访问（read-only allowlist）

| 端点 | 方法 | API Token | Cookie (UI) | 说明 |
|------|------|-----------|-------------|------|
| `/api/state` | GET | ✓ | ✓ | 当前 agent 状态 |
| `/api/metrics/{name}` | GET | ✓ | ✓ | 单指标查询 |
| `/api/metrics/aggregate` | GET | ✓ | ✓ | 聚合指标查询 |
| `/api/metrics/series` | GET | ✓ | ✓ | 时序指标 |
| `/api/metrics/history/*` | GET | ✓ | ✓ | 历史指标 |
| `/api/stream` | GET | ✓ | ✓ | SSE 事件流 |
| `/api/health` | GET | ✓ | ✓ | 服务健康（已公开，无需认证） |
| `/api/timeline` | GET | ✓ | ✓ | 运行时事件时间线 |
| `/api/communication` | GET | ✓ | ✓ | 通信渠道统计 |
| `/api/system` | GET | ✓ | ✓ | 系统资源指标 |
| `/api/summary` | GET | ✓ | ✓ | 摘要数据 |

### API Token 不可访问（显式排除）

| 端点 | 方法 | API Token | Cookie (UI) | 说明 |
|------|------|-----------|-------------|------|
| `/api/actions/*` | POST | ✗ (403) | ✓ | 写操作，仅浏览器 session |
| `/api/actions/meta` | GET | ✗ (403) | ✓ | Actions 元数据，属于管理面 |
| `/api/settings` | GET | ✗ (403) | ✓ | Dashboard 配置，属于管理面 |
| `/api/ingest` | POST | ✗ | ✗ | 本地 hook 写入（loopback only） |
| `/api/ingest/statusline` | POST | ✗ | ✗ | 本地 statusline 写入 |
| `/login` | POST | — | ✓ | 密码登录 |
| `/api/auth/token` | POST | — | — | Token 交换（API Key） |

### 默认策略

**未列入上述矩阵的 `/api/*` 端点对 API token 一律返回 403。** 授权由一张 allowlist 表驱动，不靠路由散落判断。实现时用一个 `API_TOKEN_ALLOWED_PATHS` Set 维护，中间件查 Set 决定放行或拒绝。

## 安全考量

1. **API Key scrypt 哈希** — 密码级保护，DB 泄露不暴露明文
2. **Session Token SHA-256** — deterministic digest，高频可查找，与现有 cookie session 一致
3. **Rate limiting** — token 交换端点复用现有限流机制
4. **只读权限** — API token 仅可访问 read-only allowlist 端点
5. **撤销传播** — 撤销 API Key 后，REST 请求在下一次验证时立即拒绝，SSE 连接在 15s 内断开
6. **Token 前缀** — `zylos_ak_` / `zylos_st_` 前缀区分类型，防止混用
7. **Allowlist 默认拒绝** — 未列入矩阵的端点对 API token 返回 403

## 测试计划

- API Key 管理：生成 / scrypt hash 存储 / 明文只显示一次 / 撤销 / list
- Token exchange：成功换 token（返回 SHA-256 可查找的 session）/ API Key 错误拒绝 / 已撤销 key 拒绝 / rate limit
- Session token 认证：有效 token 访问 /api/state 和 /api/stream / 过期 token 返回 401
- 撤销传播 (REST)：撤销 API Key 后，已签发 session token 的下一次 REST 请求返回 401
- 撤销传播 (SSE)：撤销 API Key 后，已建立 SSE 连接在 15s keepalive 内断开
- Allowlist 端点：API token 可访问所有 allowlist 内的端点
- Denylist 端点：API token 访问 /api/actions/*、/api/actions/meta、/api/settings 返回 403
- Ingest 隔离：API token（以及任何外部请求）不能访问 /api/ingest*
- 未列入端点：新增的未知 /api/* 对 API token 默认 403
- Cookie 不回归：现有密码登录 + cookie session 流程不受影响
- Caddy 兼容：base path / X-Forwarded-Prefix 下 SSE 仍可连接
- CLI 入口：hooks/api-keys.js generate/revoke/list 功能验证
