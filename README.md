# 糖包

一个看起来像大模型对话应用的网站。模型名是 `tangbao-vme50-flash`，回复的人是糖包。

访客写下问题，糖包在后台亲手打字回复。他醒着的时候页面是白天，关灯之后整页转成夜色。人工身份写在小字、模型卡和关于页里。

这不是医疗、法律或危机援助服务。

## 目录

```text
src/                  站点逻辑和页面
  index.ts            Worker：接口、登录、后台和推送
  pages/              对话页、关于页、隐私页、后台页
  client/             页面脚本
public/               样式、字体、图标和公开图片
migrations/           D1 表结构
design/               设计稿和截图，不参与 Worker 运行
scripts/              本地预览、测试、截图和字体生成
wrangler.jsonc        Cloudflare 配置
.dev.vars.example     环境变量模板。真正的 .dev.vars 不进仓库
```

## 架构

- Cloudflare Workers 提供页面和 API
- D1 保存对话、模型、申请、举报等数据
- Workers KV 保存用户上传的图片
- Cloudflare Email Sending 发送邮箱验证和找回邮件，每日预算 200 封，无月度限制
- Cron 每分钟刷新首页在线状态并补偿可重试的邮件任务
- 可选：通过 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 使用 Turso

图片文件不写入 D1，数据库只保存图片 key。

## 本地运行

需要 Node.js 22 以上。

后续开发验证优先使用隔离入口（独立 D1/KV，自动生成测试凭据）：

```bash
npm ci
npm run local:verify
```

人工多人验收可使用 `local:prepare` / `local:dev` / `local:seed`，完整命令与身份地址见 [本地部署手册](docs/local-development.md)。下面保留普通 Wrangler 配置方式，用于需要自定义部署配置的开发。

需要用现有数据测试新版时，可用 `local:clone` 将完整 SQL 备份及已执行迁移清单导入独立本地副本，再应用新迁移。该流程不需要本机先登录 Cloudflare；备份可由有权限的部署者提供。见 [副本演练与切换说明](docs/accounts-rollout.md)。

```bash
npm install
copy .dev.vars.example .dev.vars
```

普通 Wrangler 配置需要独立的随机服务端密钥；账号/邮件验收优先使用上面的隔离入口：

```text
ADMIN_SECRET=一串足够长的随机字符串
EMAIL_CODE_PEPPER=独立的至少32字节随机值
MAIL_PAYLOAD_KEY=另一个独立的至少32字节随机值
```

可选：

- `FEISHU_WEBHOOK`：访客发消息时推送到飞书群
- `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`：浏览器推送
- `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`：改用 Turso
- 不填 Turso 变量时使用 D1
- `ADMIN_PASSWORD` 仅用于识别旧管理员迁移，不是新账号登录密码；管理员资格通过受控引导授予已验证账号
- 模板默认 `MAIL_MODE=disabled`；本地合成邮件箱由 `local:*` 沙箱提供，不会发送真实邮件

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

打开 <http://127.0.0.1:8787>，后台在 <http://127.0.0.1:8787/desk>，不在公开导航里。

## 部署

当前项目按 Workers Paid + D1 + KV 部署。免费 Workers 的每日请求额度可能不够持续轮询。

**从旧版升级前，先看[部署者交接、SQL 与上线验收](docs/accounts-rollout.md#代码先提交部署者随后联调)。** 账号迁移不随 Git 提交自动执行；先核对自动部署设置，再安排维护窗口、最新备份、新目标库及配套代码切换。历史图片 KV 必须保留，不能用本地测试库覆盖生产。

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 创建自己的资源：

```bash
npx wrangler d1 create tangbao
npx wrangler kv namespace create IMAGES
```

3. 复制 `wrangler.accounts.example.jsonc` 为不提交的 `wrangler.production.jsonc`，填写实际 Worker、域名、`APP_ORIGIN`、D1/KV 名称和 ID。

   这些 ID 不是密钥，但每个部署者都应该换成自己的资源。

4. 备份并核对目标数据库，再应用尚未执行的迁移，逐项添加服务端 secrets：

```bash
npx wrangler d1 migrations list DB --remote --config wrangler.production.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
# 只有全新 Worker 才生成独立 ADMIN_SECRET，原站升级保留原值。
npx wrangler secret put EMAIL_CODE_PEPPER --config wrangler.production.jsonc
npx wrangler secret put MAIL_PAYLOAD_KEY --config wrangler.production.jsonc
# 按交接手册完成资源/维护/访问限制核对后，再部署选定目标。
npx wrangler deploy --config wrangler.production.jsonc
```

不要提交 `.dev.vars` 或 `wrangler.production.jsonc`，也不要上传本地禁用/测试配置。原生 `EMAIL` 绑定运行时不需要发信 API Key；部署 Token 放本机/CI Secrets，邮件 pepper 和加密密钥放 Worker Secrets。发信前确认域名已启用、DNS 已配置，以及正式 `APP_ORIGIN`、发件地址、`MAIL_MODE=cloudflare` 一致。

模板默认维护开启，业务 API、注册和验证均暂停；在覆盖全部入口的受限站点中关闭维护后，才能正常注册、真实邮箱验证并受控引导首个管理员。完整步骤、配置位置、上线验证和回退见[发布交接手册](docs/accounts-rollout.md)。生产发送、收件箱送达、真实回执及历史图片需部署者另行验收。

## 检查

```bash
npm run types
npx tsc --noEmit
npm run check
```

干净检出及 CI 都先运行 `npm run types`，生成不提交到 Git 的 Worker 类型声明，再执行类型检查。

`scripts/smoke.mjs` 会向本地服务写入测试数据，不要指向生产环境。

旧 smoke、浏览器和截图脚本仍有过时页面/接口断言，修复前不代表当前产品的有效回归；遗留由 [#11](https://github.com/PhaerisWakfu/tangbao/issues/11) 跟踪。迁移脚本已统一使用 `DB` binding；非默认目标仍须显式追加 `--config`，例如 `npm run migrate:remote -- --config wrangler.production.jsonc`。

## 后续开发入口

- [参与开发](CONTRIBUTING.md)：分支、提交范围与检查入口
- [前端规范](docs/frontend.md)：样式、交互、响应式、可访问性和验证要求
- [Issue 工作流程](docs/issue-workflow.md)：需求、开发、Bug、发布和验收
- [账号设计](docs/accounts.md)：一次匿名体验、邮箱密码账号、旧模型绑定和 Cloudflare Email Sending
- [隔离本地部署与多人模拟](docs/local-development.md)：`local:verify` 自动回归，以及 prepare/dev/seed 人工验收流程

后续需求与实现统一在 [GitHub Issues](https://github.com/PhaerisWakfu/tangbao/issues) 维护；文档中的方案不代表功能已实现或部署。

## 设计稿

`design/` 是第一轮到第四轮的设计过程和截图，不参与 Worker 打包。

```bash
npm run design
```

打开 <http://127.0.0.1:8788>。

## 隐私和人工身份

- 前台会明确说明回复的是人工，不是自动生成模型
- 对话只用于站点运行，不出售，也不公开成可搜索页面
- 用户删除对话时，服务端会删除消息和图片
- 申请信息只用于审批和联系
- 公开部署前请清理测试数据、图片和本地配置

## 许可证

代码采用 MIT License，见 [LICENSE](LICENSE)。

站点文案、品牌和个人身份不随代码自动授权。第三方组件和字体说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 安全

请不要在 Issue 中公开漏洞细节或密钥。报告方式见 [SECURITY.md](SECURITY.md)。
