# VLESS2CLASH · 折流

在浏览器中把 VLESS、VMess、Trojan、Shadowsocks 节点链接转换为 Mihomo（Clash Meta）配置。粘贴链接即可在本地解析、检查并预览 YAML，也可以把生成的配置发布为 HTTPS 订阅地址，供客户端直接拉取。

在线测试：<https://v2c.alexcheungxian.top/>（可供测试）

> 面向 Mihomo 及 Clash Verge Rev 等基于 Mihomo 内核的客户端。传统 Clash 内核不支持 VLESS / Reality，无法保证兼容。

## 功能

- **多协议转换**：支持 VLESS、VMess、Trojan、Shadowsocks 节点链接，覆盖 TCP、WebSocket、gRPC、TLS、Reality 等常见传输与安全选项。
- **浏览器本地解析**：原始节点链接只在浏览器内处理；点击“发布订阅”前不会上传原始链接，也不会保存输入。
- **预览与导出**：转换后查看节点列表和完整 YAML，可复制或下载 `.yaml` 文件。
- **智能路由**：内置中国内地直连、局域网直连和广告拦截规则，可分别开关；其余流量进入手动选择的代理组。
- **订阅托管**：主动发布后生成 HTTPS 订阅地址，配置保存在 Cloudflare Worker + KV 中。
- **订阅管理**：创建时提供独立管理令牌，可在同一地址更新配置、删除订阅，或凭订阅 ID 和管理令牌恢复管理入口。
- **明确的错误提示**：逐行报告无法解析的链接及原因，不会静默丢弃不支持的字段；有效行仍会保留转换结果。

## 支持的协议

| 协议 | 主要支持项 |
| --- | --- |
| VLESS | UUID、TCP / WS / gRPC、TLS、Reality、SNI、ALPN、证书校验、指纹、WS Host / Path、gRPC Service Name、`xtls-rprx-vision` |
| VMess | Base64 JSON、`add` / `port` / `id` / `ps` / `aid` / `scy`、TCP / WS / gRPC、TLS、SNI、ALPN、指纹、证书校验 |
| Trojan | 密码、TCP / WS / gRPC、TLS、SNI / `peer`、ALPN、指纹、证书校验、WS Host / Path、gRPC Service Name |
| Shadowsocks | SIP002 与旧式 Base64、IPv4 / 域名 / IPv6、URL 编码凭据、`v2ray-plugin` WebSocket、`simple-obfs` / `obfs-local` HTTP 或 TLS 模式 |

无法识别的查询字段、插件、加密方式或传输组合会作为错误提示，而不是忽略后继续生成配置。输入上限为 500 条非空链接、单条 8,192 字符、总计 500,000 字符。

## 生成的路由

生成的配置使用 Mihomo 规则模式，规则按以下顺序匹配：

1. 广告域名 → `REJECT`（可关闭）
2. 私网域名 → `DIRECT`
3. 私有 / 局域网 CIDR → `DIRECT`
4. 中国内地域名 → `DIRECT`（可关闭）
5. 中国内地 IP → `DIRECT`（可关闭）
6. 其余流量 → `PROXY`

规则集来自 `MetaCubeX/meta-rules-dat` 的 `.mrs` 资源，由客户端每 24 小时更新一次。生成 YAML 不会下载或应用任何规则；规则覆盖范围与客户端实际更新结果无法由本工具保证，也不承诺完整的地域识别或广告过滤。

## 本机运行

需要 Node.js 20.19+ 或 22.12+（Vite 7 的运行要求）及 npm。

```sh
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:5173>。前端由 Vite 提供，订阅 API 监听 `127.0.0.1:8787`，按 `Ctrl-C` 同时停止。

本机模式下，订阅数据保存在 `.local-data/subscriptions.json`（已加入 Git 忽略规则），订阅地址只能由本机访问，服务关闭后客户端无法拉取。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动前端与本机订阅 API |
| `npm run build` | 构建静态文件到 `dist/` |
| `npm test` | 运行单元测试 |
| `npm run dev:worker` | 本地启动 Cloudflare Worker（默认端口 `8787`，与 `npm run dev` 冲突） |
| `npm run deploy:dry-run` | 构建并检查 Worker 打包结果 |
| `npm run deploy` | 构建并部署到 Cloudflare |

`npm run dev:worker`、`npm run deploy:dry-run` 和 `npm run deploy` 都依赖 `wrangler.jsonc`，请先按下一节复制模板并填写；只做浏览器本地转换时无需该文件。

## 部署到 Cloudflare

线上订阅功能使用 Cloudflare Worker 提供静态页面和订阅 API，并用 KV 保存已发布的 YAML（配置模板 `wrangler.example.jsonc` 已包含 `ASSETS`、`SUBSCRIPTIONS` 和每小时孤儿记录清理任务）。

1. 安装依赖并登录 Cloudflare：

   ```sh
   npm ci
   npm run wrangler:login
   npm run wrangler:whoami
   ```

2. 创建 KV namespace：

   ```sh
   npx wrangler kv namespace create vless2clash-subscriptions
   ```

3. 复制配置模板并填写自己的信息：

   ```sh
   cp wrangler.example.jsonc wrangler.jsonc
   ```

   然后编辑 `wrangler.jsonc`：

   - 将 `kv_namespaces[0].id` 替换为上一步返回的 namespace ID；
   - 将 `account_id` 改为你的 Cloudflare 账号 ID，或删除该字段以使用当前登录账号；
   - 如 Worker 名称已被占用，可修改 `name`。

   `wrangler.jsonc` 含账号相关配置，已加入 `.gitignore`，不要提交到仓库。

4. 检查并部署：

   ```sh
   npm run deploy:dry-run
   npm run deploy
   ```

部署完成后，Cloudflare 会提供 `https://<worker-name>.<子域>.workers.dev` 地址；也可以在 Cloudflare 控制台为 Worker 绑定自定义域名。需要在本地调试 Worker 时，可运行 `npm run dev:worker`（默认监听 `127.0.0.1:8787`，与 `npm run dev` 不能同时使用；可用 `npm run dev:worker -- --port 8788` 更换端口）。

## 使用流程

1. 每行粘贴一条 `vless://`、`vmess://`、`trojan://` 或 `ss://` 链接。
2. 点击“生成预览”，检查节点列表、错误行和 YAML。
3. 按需设置配置名称，以及“中国内地直连”“拦截广告请求”开关。
4. 选择下载 YAML，或点击“发布订阅”，将生成后的配置托管到服务器。
5. 保存页面返回的订阅地址和管理凭据；管理令牌只显示一次，无法找回。
6. 在客户端中添加订阅地址并手动更新。

发布后的配置是静态 YAML：修改或更换节点后，需要重新生成并发布。客户端拉取订阅与规则集更新由客户端设置独立控制。

## 数据与安全

- 原始节点链接只在浏览器内解析；只有点击“发布订阅”后，生成后的 YAML 才会上传。YAML 包含节点地址、UUID、密码等凭据。
- 取得订阅地址的人即可读取完整 YAML，请把订阅地址视为敏感信息。
- 管理令牌在创建订阅时单独生成，不会拼入订阅地址。系统不提供账号、找回或重置，令牌丢失后无法更新或删除原订阅。
- 删除订阅会写入撤销标记并移除记录，但 KV 变更可能存在传播延迟；删除不会清除客户端已下载的配置，也不会使节点 UUID、密码或服务端账号失效。
- 本机开发模式的订阅数据仅保存在本机 `.local-data/` 中，不会上传到云端。

## 兼容性与限制

- 目标客户端为 Mihomo / Clash Verge Rev；传统 Clash 不支持 VLESS、Reality 等特性，可能出现无法导入或无法连接的情况。
- “配置可被解析”不等于“节点真实可连通”，也不等于所有 GUI 客户端都能导入。
- 规则集为外部资源，可能更新或不可达，实际分流与广告拦截效果取决于客户端规则版本。
- 在线测试实例仅供测试，可能随时调整、限流或停止，请勿依赖其长期可用性。
