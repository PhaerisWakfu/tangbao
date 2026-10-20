# 糖包

一个看起来像大模型对话应用的网站。模型名是 `tangbao-vme50-flash`，回复的人是糖包。

访客写下问题，糖包在后台亲手打字回复。他醒着的时候页面是白天，关灯之后整页转成夜色。人工身份写在小字、模型卡和关于页里。

## 目录

```text
src/                  站点逻辑和页面
  index.ts            Worker：接口、登录、开关灯记录
  pages/              对话页、关于页、后台页
  client/             这两个页面用的脚本
public/               样式、字体、图标
migrations/           数据库表结构
design/               做正式页之前的设计稿，不参与运行
  forks/              第一轮 01–04，第二轮 05–08
  shots/              各稿的截图
  index.html          稿子索引
scripts/              本地预览设计稿、跑测试、截图
wrangler.jsonc        Cloudflare 配置
.dev.vars.example     口令模板。真正的 .dev.vars 不进仓库
```

## 本地运行

需要 Node.js 22 以上。

```bash
npm install
copy .dev.vars.example .dev.vars
```

在 `.dev.vars` 里改两行：

- `ADMIN_PASSWORD`：桌子背面的口令
- `ADMIN_SECRET`：登录会话的签名密钥，随便一长串

```bash
npm run migrate:local
npm run dev
```

打开 http://127.0.0.1:8787 。后台在 http://127.0.0.1:8787/desk ，不在公开导航里。

## 设计稿

第二轮稿在 `design/forks/`，索引是 `design/index.html`。

```bash
npm run design
```

打开 http://127.0.0.1:8788 。正式页面按 `07-steam.html` 搬进来，推理核心、吞吐和可用性条来自 `08-console.html`。

## 部署到 Cloudflare

用 Workers 免费计划。页面由 Worker 返回，样式和字体走静态资源。数据在 D1。

```bash
npx wrangler login
npx wrangler d1 create tangbao
npx wrangler r2 bucket create tangbao-images
```

把命令输出的 `database_id` 写进 `wrangler.jsonc`，然后：

```bash
npm run migrate:remote
npx wrangler secret bulk .dev.vars
npm run deploy
```

`secret bulk` 会把 `.dev.vars` 里的口令和签名密钥写进 Worker，文件本身不会进仓库。
