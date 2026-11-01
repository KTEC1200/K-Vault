# K-Vault 云端部署手册(Telegram 图床 · Cloudflare Pages Git 集成 + 反代 Worker)

> **2026-11-01 完成部署并于同日切换为 Git 集成,push 到 main 自动部署。** 以下为实际生效的部署记录。
> 适用场景:国内网络无法直连 `api.telegram.org`,通过 Cloudflare Worker 反代中转 Bot API。

## 实际部署信息(2026-11-01)

| 项 | 值 |
| --- | --- |
| 图床地址 | **https://k-vault-69q.pages.dev** |
| 部署方式 | **Git 集成**(push 到 `KTEC1200/K-Vault` main → 自动构建) |
| 管理后台 | https://k-vault-69q.pages.dev/admin.html (admin / 见 .env 的 BASIC_PASS) |
| 反代 Worker | https://kvault-tg-proxy.2702577921.workers.dev (源码: `C:\Users\27025\Desktop\kv\tg-api-proxy`) |
| Worker 防护 | 密钥前缀 + **BOT_ID_ALLOWLIST 白名单**(仅放行 8473954193 = @ktec0230_bot,前缀公开也安全) |
| KV namespace | `img_url` → `3168e827d4d94a019d3887d914b7f8fd`(绑定声明在仓库 `wrangler.toml`) |
| Telegram Bot | @ktec0230_bot → 频道 ktec (@KTEC120, id `-1004442931304`) |
| Webhook | 已注册: bot 在频道收到文件后自动回复直链 (`/api/telegram/webhook`) |
| Secrets | `TG_Bot_Token`、`BASIC_PASS`(CF Pages Secrets,不在仓库) |
| wrangler.toml [vars] | `TG_Chat_ID`、`CUSTOM_BOT_API_URL`、`BASIC_USER`(随仓库分发,Worker 白名单兜底) |

已验证链路:登录 → 上传 → TG 存储 → 直链回源 (字节一致) → 删除;webhook 回链 ok。

## ⚠️ Git 集成 + wrangler.toml 的重要坑(本机踩过)

仓库根目录存在声明 `pages_build_output_dir` 的 `wrangler.toml` 时,**每次构建以该文件为配置事实源,
后台(Dashboard/API)配置的普通环境变量会被忽略**(Secrets 不受影响)。表现为:
- `TG_Bot_Token` Secret 生效但 `TG_Chat_ID` 缺失 → 上传报 TG `chat not found`
- `BASIC_USER` 缺失 → `/api/auth/login` 返回"无需登录"

结论:**普通变量一律写进 `wrangler.toml [vars]` 并 push;Secrets 用后台/CLI 配。**

## 手动触发部署(push 事件偶发丢失时)

```bash
OAUTH=$(grep -oP 'oauth_token\s*=\s*"\K[^"]+' "C:/Users/27025/AppData/Roaming/xdg.config/.wrangler/config/default.toml")
ACCT=e6b30ead6d77503bf917f65907e60c9f
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/pages/projects/k-vault/deployments" \
  -H "Authorization: Bearer $OAUTH" -H "Content-Type: application/json" -d '{}'
```

## 更换 Bot Token

1. @BotFather `/revoke` 得到新 token
2. 更新本机 `.env`(留档)
3. `npx wrangler pages secret put TG_Bot_Token --project-name k-vault`(在任意目录)
4. 如换了新 bot,同步更新 tg-api-proxy 的 `BOT_ID_ALLOWLIST` 并 `npx wrangler deploy`

## 架构

```
浏览器 / API 客户端
      │
      ▼
K-Vault (Cloudflare Pages, functions/ 目录)
      │  CUSTOM_BOT_API_URL = https://kvault-tg-proxy.<账号>.workers.dev/<PROXY_SECRET>
      ▼
tg-api-proxy (Cloudflare Worker 反代, 仓库外 C:\Users\27025\Desktop\kv\tg-api-proxy)
      │  去掉密钥前缀, 原样转发
      ▼
https://api.telegram.org  (Bot API: sendDocument / getFile / file 下载 / deleteMessage)
      │
      ▼
Telegram 频道(私有频道存文件, bot 为管理员)
```

- 文件元数据存 Pages KV(绑定名 `img_url`)
- 直链 `/file/<id>` 由 Pages Function 服务端经反代从 TG 拉流回源
- `TG_Bot_Token` 等敏感值用 Pages Secrets 存储,不写入代码/静态资源

## 已完成的准备

1. **反代 Worker 已写好**:`C:\Users\27025\Desktop\kv\tg-api-proxy`
   - `src/worker.js`:密钥前缀校验(`/kvpx_.../bot...` 才放行)+ 仅放行 `/bot` `/file/bot` 路径 + 流式透传(支持 Range)
   - `wrangler.toml`:`PROXY_SECRET = kvpx_7f3a9c2e51b84d06af1e`
   - 本地 wrangler dev 已验证:无密钥 403 / 非 bot 路径 403(中转逻辑为标准透传,线上验证)
   - 本地 workerd 出站 fetch 受系统代理(127.0.0.1:6234)影响无法直测,线上边缘网络无此问题
2. **`.env` 模板已建**(仓库根目录,已在 .gitignore):填 `TG_BOT_TOKEN`、`TG_CHAT_ID`、`BASIC_PASS`
3. **本机代理已确认**:`http://127.0.0.1:18788` 可通 api.telegram.org(xeno HTTP 口;系统代理口 6234)
4. **Pages 代码链路已确认**:上传、直链、webhook 全部走 `CUSTOM_BOT_API_URL`,一个变量接通反代

## 部署步骤(需要 Cloudflare 账号)

### 1. 登录 wrangler(浏览器授权一次)

```bash
cd C:\Users\27025\Desktop\kv\tg-api-proxy
npx wrangler login     # 浏览器弹出 → Allow
```

### 2. 部署反代 Worker

```bash
cd C:\Users\27025\Desktop\kv\tg-api-proxy
npx wrangler deploy
# 输出形如: https://kvault-tg-proxy.<你的子域>.workers.dev
```

验证(应返回 TG 的 401 JSON,说明反代+上游通):

```bash
curl -s "https://kvault-tg-proxy.<子域>.workers.dev/kvpx_7f3a9c2e51b84d06af1e/bot000:invalid/getMe"
```

### 3. 创建 KV 并部署 Pages

```bash
cd C:\Users\27025\Desktop\kv\K-Vault
npx wrangler pages project create k-vault --production-branch main
npx wrangler pages kv namespace create img_url --project-name k-vault
# 记下输出里的 namespace id,填入下方 deploy 时生成的 wrangler.toml
```

用干净树部署(避免 node_modules/.env/data 被当静态资源上传):

```bash
git archive --format=tar -o /tmp/kvault-deploy.tar HEAD
mkdir -p /tmp/kvault-deploy && tar -xf /tmp/kvault-deploy.tar -C /tmp/kvault-deploy
```

在 `/tmp/kvault-deploy` 写入 `wrangler.toml`:

```toml
name = "k-vault"
pages_build_output_dir = "."
compatibility_date = "2026-05-03"

[[kv_namespaces]]
binding = "img_url"
id = "<上一步的 namespace id>"

[vars]
TG_Chat_ID = "<你的频道ID>"
CUSTOM_BOT_API_URL = "https://kvault-tg-proxy.<子域>.workers.dev/kvpx_7f3a9c2e51b84d06af1e"
BASIC_USER = "admin"
```

> Pages 的 wrangler.toml `[vars]` 会注入 Functions 的 env;密钥类变量改用 secret(下一步)。

### 4. 配置密钥(交互输入,不落盘)

```bash
cd /tmp/kvault-deploy
npx wrangler pages secret put TG_Bot_Token --project-name k-vault
npx wrangler pages secret put BASIC_PASS --project-name k-vault
```

### 5. 部署 Pages

```bash
cd /tmp/kvault-deploy
npx wrangler pages deploy . --project-name k-vault --branch main
# 输出: https://k-vault.pages.dev (或带 hash 的预览地址)
```

### 6. 端到端验证

```bash
# 上传(本机直连 *.pages.dev;不通则走 127.0.0.1:18788)
curl -s -F "file=@某张图.png" "https://k-vault.pages.dev/upload"

# 用返回的直链拉图(应 200 且为图片字节)
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "https://k-vault.pages.dev/file/<返回的id>"
```

### 7. (可选)Telegram Webhook 回链

bot 在频道收到文件后自动回复直链。K-Vault 后台/`/api/status` 提供 webhook 状态;
需要 `PUBLIC_BASE_URL` 指向 `https://k-vault.pages.dev` 并注册 webhook(管理后台存储设置里有入口)。

## 日常更新代码后重新部署

```bash
cd C:\Users\27025\Desktop\kv\K-Vault && git pull
# 重复第 3 步的 archive/解包/部署(密钥与绑定保留,无需重设)
```

若改用 GitHub 集成(自动部署),在 CF Dashboard 把 Pages 项目切到连接 `KTEC1200/K-Vault` 仓库,
构建命令留空即可;`.github/workflows/pages-deploy.yml` 亦已随仓库提供。

## 故障速查

| 现象 | 原因/处理 |
| --- | --- |
| 上传 502,Workers 日志见 `Proxy upstream error` | 反代到 TG 断流,查 Worker 日志 `npx wrangler tail` |
| 403 `missing proxy secret prefix` | `CUSTOM_BOT_API_URL` 少了 `/kvpx_...` 前缀 |
| 401 `Unauthorized: invalid token` | `TG_Bot_Token` 填错(注意别把反代密钥当 token) |
| 直链 404 | KV `img_url` 绑定丢失,或文件元数据不在该 namespace |
| `telegram` 状态 `Not configured` | Secrets 未生效,重新 `pages secret put` 并重部署 |
