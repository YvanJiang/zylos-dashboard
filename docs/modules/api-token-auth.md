# API Token 认证 — 实现方案

Issue: #140

## 概述

为 dashboard 新增一种**外部只读访问身份**：API Key + Session Token 两层认证，支持外部 Agent 通过 API 接入 SSE 数据流和查询接口，不依赖浏览器 cookie 登录。

这是现有 UI cookie session（`AuthGate`）之外的独立认证通道，两者并存互不干扰：
- **Cookie session**: 浏览器用户通过密码登录，可访问所有端点（包括 actions 写操作）
- **API token**: 外部 Agent 通过 API Key 换取 session token，仅可访问只读端点

## 认证模型

```
调用方                        Dashboard
  │                              │
  │  POST /api/auth/token        │
  │  Authorization: Bearer       │
  │    zylos_ak_<api-key>        │
  │  ───────────────────────►    │
  │                              │  验证 API Key hash
  │  ◄───────────────────────    │  签发 Session Token
  │  { token: zylos_st_...,      │
  │    expires_at, ttl: 86400 }  │
  │                              │
  │  GET /api/state              │
  │  Authorization: Bearer       │
  │    zylos_st_<session-token>  │
  │  ───────────────────────►    │  验证 token + TTL
  │  ◄───────────────────────    │
  │  { state data }              │
```

两层的意义：API Key 只在换 token 时传输一次（而非每个请求都带），降低了高频请求中长期凭据的暴露面。session token 被截获后 24h 失效，损失可控。

**传输安全说明**: 两层模型减少 API Key 的传输频率，但不能替代传输加密。外部 Agent 接入推荐 HTTPS。明文 HTTP 环境下，API Key 在 token exchange 时仍有被截获的风险，用户需接受此风险或配置 HTTPS。

## 数据库变更

新增两张表（incremental migration）：

```sql
-- api_keys: 长期 API Key
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,           -- uuid
  name TEXT NOT NULL UNIQUE,     -- 人类可读名称，如 "agent-beta"
  key_hash TEXT NOT NULL,        -- scrypt hash of zylos_ak_*
  scope TEXT NOT NULL DEFAULT 'read',  -- 'read' 或 'admin'
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER             -- 非空表示已撤销
);

-- api_sessions: 短期 Session Token
CREATE TABLE api_sessions (
  token_hash TEXT PRIMARY KEY,   -- scrypt hash of zylos_st_*
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
- `hooks/configure.js` — 新增 `--generate-api-key <name>` 和 `--revoke-api-key <name>` 子命令

API Key 生成：
```js
const raw = `zylos_ak_${crypto.randomBytes(24).toString('base64url')}`;
// 返回明文给用户，DB 只存 scrypt hash
```

CLI 交互：
```bash
zylos configure dashboard --generate-api-key agent-beta --scope read
# → API Key: zylos_ak_f8a3kQ...  (scope: read, 只显示一次，请妥善保存)

zylos configure dashboard --generate-api-key ops-admin --scope admin
# → API Key: zylos_ak_j9b2xR...  (scope: admin, 只显示一次，请妥善保存)

zylos configure dashboard --revoke-api-key agent-beta
# → Revoked API key "agent-beta"

zylos configure dashboard --list-api-keys
# → agent-beta  scope: read   created: 2026-06-04  last_used: 2026-06-04  status: active
# → ops-admin   scope: admin  created: 2026-06-04  last_used: never       status: active
```

不指定 `--scope` 时默认为 `read`。

### Step 2: Token 交换端点

文件变更：
- `src/lib/auth.js` — 新增 `handleApiTokenExchange()` 方法
- `src/index.js` — 注册 `POST /api/auth/token` 路由（在 auth gate 之前）

端点逻辑：
```
POST /api/auth/token
Authorization: Bearer zylos_ak_<key>

1. 从 header 提取 API Key
2. 遍历 api_keys 表未撤销的记录，scrypt 验证
3. 验证通过 → 更新 last_used_at
4. 生成 session token: zylos_st_<random>
5. 存入 api_sessions（hash, api_key_id, created_at, expires_at）
6. 返回 { token, expires_at, ttl_seconds: 86400, scope: "read"|"admin" }

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
2. scrypt hash 后查 api_sessions 表
3. 检查 expires_at > now（TTL 失效）
4. 检查关联的 api_key 未被 revoked（撤销立即生效，不等 TTL）
5. 读取关联 api_key 的 scope
6. 更新 last_used_at
7. 检查 scope 是否覆盖目标端点（见下方权限矩阵）
8. 通过 → 放行请求
```

### Step 4: SSE 流支持

文件变更：
- `src/index.js` — `/api/stream` 路由允许 Bearer token 认证

SSE 特殊处理：
- 连接建立时验证一次 token，之后不再验证
- Token 过期不主动断开已建立的 SSE 连接（避免数据中断）
- 客户端断连后需要用 API Key 重新换 token 再连接

### Step 5: 过期清理

文件变更：
- `src/lib/auth.js` — 在现有 session cleanup interval 中增加 api_sessions 清理

清理逻辑：
```js
// 每 5 分钟清理过期的 api_sessions
DELETE FROM api_sessions WHERE expires_at < ?
```

## 权限模型

### Scope 定义

| Scope | 覆盖范围 | 典型用途 |
|-------|---------|---------|
| `read` | 只读数据端点 + SSE 流 | 外部 Agent 接入、监控面板聚合 |
| `admin` | read 的全部 + actions 写操作 | 远程运维（切 runtime、改 model、重启 session、升级） |

### 端点访问矩阵

| 端点 | 方法 | read | admin | cookie (UI) | 说明 |
|------|------|------|-------|-------------|------|
| `/api/state` | GET | ✓ | ✓ | ✓ | 当前 agent 状态 |
| `/api/metrics/{name}` | GET | ✓ | ✓ | ✓ | 单指标查询 |
| `/api/stream` | GET | ✓ | ✓ | ✓ | SSE 事件流 |
| `/api/health` | GET | ✓ | ✓ | ✓ | 服务健康（已公开） |
| `/api/timeline` | GET | ✓ | ✓ | ✓ | 运行时事件时间线 |
| `/api/communication` | GET | ✓ | ✓ | ✓ | 通信渠道统计 |
| `/api/metrics/aggregate` | GET | ✓ | ✓ | ✓ | 聚合指标查询 |
| `/api/actions/*` | POST | ✗ | ✓ | ✓ | 写操作（runtime switch 等） |
| `/api/ingest` | POST | ✗ | ✗ | ✗ | 本地 hook 写入（loopback only） |
| `/api/ingest/statusline` | POST | ✗ | ✗ | ✗ | 本地 statusline 写入 |
| `/login` | POST | — | — | ✓ | 密码登录 |
| `/api/auth/token` | POST | — | — | — | Token 交换（API Key） |

`/api/ingest*` 是本地写入通道，任何认证方式都不能从外部访问（loopback + reject proxied）。

## 安全考量

1. **API Key 哈希存储** — 和密码一样用 scrypt，DB 泄露不暴露明文
2. **Rate limiting** — token 交换端点复用现有限流机制
3. **Scope 隔离** — read scope 的 token 不能访问 actions 端点，403 拒绝；admin scope 可以
4. **Token 前缀** — `zylos_ak_` / `zylos_st_` 前缀区分类型，防止混用
5. **撤销传播** — 撤销 API Key 后，该 key 签发的 session token 在验证时也会被拒绝（检查关联 key 的 revoked_at）
6. **最小权限原则** — 默认 scope 为 read，admin 需显式指定

## 测试计划

- API Key 管理：生成 / hash-only 存储 / 明文只显示一次 / 撤销 / list
- Token exchange：成功换 token / API Key 错误拒绝 / 已撤销 key 拒绝 / rate limit
- Session token 认证：有效 token 访问 /api/state 和 /api/stream / 过期 token 拒绝
- 撤销传播：撤销 API Key 后，已签发的 session token 在下一次请求时立即被拒绝
- 端点隔离：Bearer token 不能访问 /api/ingest* / /api/actions/* / write endpoints
- Cookie 不回归：现有密码登录 + cookie session 流程不受影响
- Caddy 兼容：base path / X-Forwarded-Prefix 下 SSE 仍可连接
