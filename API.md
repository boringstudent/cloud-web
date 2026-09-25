# Cloud EO 边缘函数 API 文档

`eo.js` 是 cloud-web 的全站一体 EdgeOne 边缘函数：网盘前端页面、静态资源、认证用户 API、GitHub 代理与下载中转全部由它同源提供。本文档列出其全部 HTTP 接口。

## 基础说明

| 项目 | 说明 |
|---|---|
| Base URL | 当前边缘函数绑定的域名（页面与 API 同源） |
| 请求方式 | GET（query 传参）或 POST/PUT/DELETE（JSON body） |
| 返回格式 | API 统一返回 JSON，支持 CORS 跨域 |
| 密码传输 | **只接受前端计算好的 SHA-512 哈希（128 位十六进制），明文一律不传输**，传非哈希值返回 400 |
| 密码存储 | 用户数据存于 GitHub 私有仓库 `user.json`，仅存 SHA-512 哈希，不可逆 |
| 密钥安全 | **GitHub key 只保存在边缘函数内，永不下发**；所有 GitHub 读写、下载中转均由函数在服务端注入 key 代理完成，客户端无任何后端凭据 |
| 响应安全 | 所有接口均不返回密码哈希；用户列表中的密码字段脱敏为 `***`；用户数据仓库被代理白名单永久拒绝（403），任何后端数据无法经本函数泄漏到用户端 |
| 密码规则 | 长度 > 8，必须含大小写字母和数字（由前端校验；服务端只收到哈希，无法校验强度） |
| 存储读写 | Contents API 实时读写；写操作仅变更目标字段，409 冲突自动重读重试（最多 3 次）；鉴权读有 60 秒实例级缓存，写后即时刷新 |

## 页面路由（非 API）

| 路径 | 说明 |
|---|---|
| `GET /` 及任意未命中子路径 | 网盘主页面（SPA 兜底，路径即目录），带 CSP 安全头，不缓存 |
| `GET /static/app.js` / `/static/style.css` | 前端资源（构建时嵌入，`?v=` 版本戳，`Cache-Control: immutable` 长缓存） |
| `GET /favicon.ico` | 站点图标 |

## 公开接口

### `GET/POST /api/hash`

对任意字符串做 SHA-512 哈希（可用于客户端自行计算密码哈希）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `password` 或 `key` |
| `value` | 是 | 要加密的原文 |

```
GET /api/hash?type=password&value=xxx
→ { "type": "password", "value_sha512": "0c71b3..." }
```

### `GET/HEAD /api/my-ip`（别名 `/ip`）

查询**服务器自身**的出口 IP 及归属地信息（数据源 cip.cc，8 秒超时，失败返回 502）。`HEAD` 立即返回 200，用于前端 RTT 测量。

```
GET /api/my-ip
→ { "ip": "1.2.3.4", "location": "...", "isp": "...", "data2": "...", "data3": "..." }
```

### `GET/HEAD /api/proxies`

外部多代理下载的公共 ghproxy 镜像候选。默认逐个并发探测连通性（3.5 秒超时，返回 <500 即视为可用），**只返回当前可用的**；探测结果实例级缓存 5 分钟。`?all=1` 跳过探测返回完整候选列表（不触网）。`?probe=api` 服务端逐个 ping 候选存活（6 秒超时，能连上且返回 <500 即正常），**返回含失败站点的全量结果**（前端"Git 外部"服务检测用；浏览器直连代理会触发 CORS 预检被 403），同样缓存 5 分钟。`HEAD` 立即返回 200。

```
GET /api/proxies
→ { "proxies": ["https://ghproxy.felicity.land/", "https://gh-proxy.com/", ...] }

GET /api/proxies?all=1
→ { "proxies": [全部 30 个候选，未探测] }

GET /api/proxies?probe=api
→ { "results": [{ "site": "https://ghproxy.felicity.land/", "ok": true, "rtt": 820 },
               { "site": "https://gh-proxy.com/", "ok": false, "rtt": 6000 }, ...] }
```

### `GET /api/gitkey`

获取 GitHub 写 key（**仅 admin**），用于管理员开启"外部代理上传通道"后在外部 ghproxy 镜像上直传 blob（外部代理不注入鉴权）。鉴权方式与代理写操作一致（请求头 `X-Auth-User` / `X-Auth-Pass`），且账号 role 必须为 `admin`：未登录 401、哈希非法 400、非管理员 403。key 只应保存在客户端内存中；引用类操作（提交/删除）仍必须走 EO 代理。

```
GET /api/gitkey        （带 X-Auth-User / X-Auth-Pass 头，admin）
→ { "key": "<GitHub 写 key>" }
```

### `GET/POST /api/login`

用户登录。密码必须传 SHA-512 哈希，与存储哈希实时比对（登录强制实时读取，无缓存）；成功响应**只含角色信息**，不再返回任何 key 或 key 哈希。

| 参数 | 必填 | 说明 |
|---|---|---|
| `username` | 是 | 用户名 |
| `password` | 是 | 密码的 SHA-512 哈希（128 位 hex，前端计算） |

```
GET /api/login?username=fx&password=<sha512哈希>
→ { "success": true, "username": "fx", "role": "user", "avatar": "https://..." }
```

`avatar` 为可选头像 URL（存放在 user.json 与密码同一记录），未设置时为空字符串。

### `POST /api/change-password`

用户自助修改自己的密码。旧密码与新密码均传 SHA-512 哈希；新密码强度规则由前端校验。响应不返回新密码哈希。

```json
{ "username": "fx", "password": "<旧密码sha512>", "new_password": "<新密码sha512>" }
→ { "success": true, "username": "fx" }
```

### `POST /api/change-avatar`

用户自助修改自己的头像 URL（http/https，最长 300 字符；空字符串表示清除自定义头像）。

```json
{ "username": "fx", "password": "<sha512>", "avatar": "https://example.com/a.jpg" }
→ { "success": true, "username": "fx", "avatar": "https://example.com/a.jpg" }
```

### `POST /api/delete-account`

用户自助注销自己的账户（验证密码哈希后永久删除，不可恢复）。

```json
{ "username": "fx", "password": "<sha512>" }
→ { "success": true, "deleted": "fx" }
```

### `GET /api/bg`

页面背景图中转（上游随机图接口，跟随 302 重定向，仅放行 `image/*`，10 秒超时，短缓存 300s）。失败返回 502，页面自动以纯色背景兜底。

## Admin 接口（需 `admin_user` + `admin_pass` 哈希）

GET 从 query 读取，其余方法从 body 读取；`admin_pass` 为管理员密码的 SHA-512 哈希，逐请求实时校验。

### `GET /api/users`

查看全部用户（密码字段脱敏为 `***`）。

```
GET /api/users?admin_user=boss&admin_pass=<sha512哈希>
→ { "users": { "boss": { "password": "***", "role": "admin", "avatar": "https://..." } } }
```

### `POST /api/users`

添加用户。新用户密码传 SHA-512 哈希，服务端直接存储；`avatar` 可选。

```json
{ "admin_user": "boss", "admin_pass": "<sha512>", "username": "fx", "password": "<sha512>", "role": "user", "avatar": "https://..." }
→ { "success": true, "username": "fx", "role": "user" }
```

### `PUT/PATCH /api/users/:username`

修改指定用户的密码、角色和/或头像（至少传一项；`avatar` 传空字符串表示清除）。

```json
{ "admin_user": "boss", "admin_pass": "<sha512>", "password": "<新sha512>", "role": "admin", "avatar": "https://..." }
→ { "success": true, "username": "fx", "role": "admin" }
```

### `DELETE /api/users/:username`

删除指定用户（参数放 body）。

```json
{ "admin_user": "boss", "admin_pass": "<sha512>" }
→ { "success": true, "deleted": "fx" }
```

## GitHub 代理 / 下载中转

网盘的一切 GitHub 请求（目录列表、读写、下载、媒体流式预览）都经以下路径代理。**读操作公开**（GET/HEAD），**写操作（PUT/DELETE/POST/PATCH）必须在请求头携带登录凭据**：

```
X-Auth-User: <用户名>
X-Auth-Pass: <密码的SHA-512哈希>
```

- 仅放行白名单存储仓库（`STORAGE_REPOS`）；其余仓库一律 403，用户数据仓库永久 403。
- `Authorization: Bearer <key>` 由函数在服务端注入，客户端永远不接触 key。
- 仅转发 `Content-Type / Accept / If-None-Match / If-Modified-Since / Range / Cache-Control / Pragma` 必要头；状态码、ETag、Content-Range 原样透传（304 条件请求、206 断点分段可用），响应流式透传不落地。

### `* /api.github.com/repos/<owner>/<repo>/<path>`

GitHub REST API 代理（contents 列表与读写、git trees 等）。

```
GET /api.github.com/repos/<owner>/<repo>/contents/<path>
PUT /api.github.com/repos/<owner>/<repo>/contents/<path>
    头: X-Auth-User: fx   X-Auth-Pass: <sha512哈希>
```

### `GET /raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`

raw 下载中转：单文件下载、分片合并下载、媒体 Range 分段流式预览均走此路径，支持 206 断点续传。

### `GET /github.com/<owner>/<repo>/archive/<ref>.zip`

整仓打包下载中转，自动跟随 codeload 重定向。

## 错误格式

所有 API 错误统一返回 JSON：

```json
{ "error": "错误描述（英文，前端映射为中文提示）" }
```

常见状态码：400 参数/哈希格式错误 · 401 凭据缺失或错误 · 403 权限不足/仓库禁止 · 404 用户不存在/路径未知 · 405 方法不允许 · 409 用户已存在 · 502 上游（GitHub/cip.cc/图床）请求失败。
