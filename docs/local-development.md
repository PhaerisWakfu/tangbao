# 本地部署与多身份验证

入口 Issue：[本地部署与多人验证 #16](https://github.com/PhaerisWakfu/tangbao/issues/16)，原生父项为工程整备 #10，关联开发入口修复 #11。这套流程验证当前人工对话站；未来邮箱账号的测试矩阵在本文后半部，不能把合成运营者口令当成已实现的正式账号。

## 与开发分支关联

Epic 在独立功能分支工作，Bug 修复在 Ricky 专属 `rick-dev` 上进行，完整约定见 [Issue 工作流程](issue-workflow.md)。验收记录同时注明 Issue/Epic、分支、提交、工作区是否有未提交改动、instance 及结果。

切换分支前先停止当前 checkout 的运行实例，再按目标分支执行 prepare/dev/seed 或全新 verify。多个 instance 共用此 checkout 的源码，切换分支会影响它们；独立 D1/KV 只保证数据隔离。需要同时验证不同分支时使用不同 checkout，不能只换 instance。

实例可按任务命名，如 `epic-5-run-01` 或 `bug-12-run-01`。本手册及复用脚本可提交；实际运行报告、凭据、截图和本地专属规则不提交。

## 一条命令做回归

首次检出使用 Node.js 22 以上，并安装依赖：

```sh
npm ci
npm run types
npx tsc --noEmit
npm run check
npm run local:verify
```

`local:verify` 自动创建新的命名实例、生成仅本地配置及随机测试口令、应用并核对全部迁移、启动 Worker、执行合成多身份 HTTP 场景，最后停止它自己启动的进程。每次使用独立目录和可用端口，不覆盖上次结果，不清空正在人工验收的实例。

若需要稳定的证据名称，可用：

```sh
npm run local:verify -- --instance issue-16-run-01
```

已存在的 instance 会被拒绝，重跑换 `run-02`，保留首次失败。它不接受 `--base-url`、`--remote` 或任意 Wrangler 透传参数。现有 `scripts/smoke.mjs` / `browser.mjs` 仍有过时断言，不属于这条新流程。

## 留一个可交互的本地站点

```sh
# 终端一：准备并启动
npm run local:prepare -- --instance demo --port 8790
npm run local:dev -- --instance demo

# 终端二：服务就绪后生成当前版本合成场景
npm run local:seed -- --instance demo
npm run local:info -- --instance demo
```

首页为 `http://127.0.0.1:8790/`，对话页 `/chat`，后台 `/desk`。`local:dev` 在当前终端前台运行，Ctrl+C 停止。再次运行 `local:dev` 使用同一份 DB/KV；再次 `prepare` 只补迁移并核验目录，不清空数据。端口在 prepare 时确定，dev/seed/info 不允许偷偷改端口。

更新源码后的迁移顺序是：停止对应实例 → `local:prepare` → `local:dev` → 验证；不要在其他人正在验收同一实例时执行迁移或重新生成配置。并行工作使用不同 instance，HTTP 和 inspector 端口也必须不同。

`seed` 通过实际的申请、管理员审批、登录、发言和回复 API 建立场景，不直接插入伪造的登录态。首次执行也运行 25 项当前基线检查；成功后重复 seed 只复用同一份合成身份，不重复申请或造对话。若上次中断/失败，保留文件并改用新 instance。日常回归使用全新的 `local:verify`。

| 产物 | 所在位置及用途 |
| --- | --- |
| 实例标记/端口 | `.tmp/local-sandboxes/<instance>/instance.json` |
| 独立运行配置/本地适配入口 | 同目录 `wrangler.json` / `worker.mjs`，不改生产配置 |
| 随机管理员测试凭据 | 同目录 `.dev.vars`，权限 0600 |
| 合成角色口令、cookie、对话 token | 同目录 `actors.json`，权限 0600；手动登录读取这里对应角色的 password |
| 本地 D1 / KV | 同目录 `state/`，prepare 和 dev 使用相同 `--persist-to` |
| 迁移及服务日志 | 同目录 `migrations.log` / 自动验证的 `server.log` |
| 逐项结果 | `verification-<时间>-<随机值>.json`，保留 PASS/FAIL、未实现与未覆盖 |
| 自动验证进程生命周期 | `lifecycle.json`，记录就绪、失败及停止；启动失败也留档 |

以上产物均在 Git 已忽略的 `.tmp/` 内，仅合成数据，不提交。换场景首先换 instance；不要对未知目录或共享验收库自动 reset。手动清理前先停止对应服务，只处理明确的实例目录。

## 本地隔离如何保证

- 每个实例使用独立配置、D1/KV 持久化目录、HTTP/inspector 端口；资源 ID 是本地占位值，不复制线上 DB/KV ID。
- Wrangler 强制 `--local`，只监听 `127.0.0.1`；不发布 Tunnel。子进程不继承业务 provider keys，不读取根目录 `.dev.vars`/`.env`；实例目录只有生成的测试凭据。
- 本地适配入口调用同一份 `src/index.ts`，不绕过鉴权；已知 Turso、Resend、飞书和 Web Push 配置在配置及入口两处清空。不会为模拟邮箱而请求真实发信。
- 场景脚本固定连接实例记录的回环地址，每次请求前核验 `/__local/health` 的随机实例标记，包括会写心跳/分配任务的旧 GET 接口；不把 GET 一律视为只读。
- `prepare` 根据迁移目录动态生成清单，再查询本地 `d1_migrations` 精确对比；当前为 18 份，包含 `0006_blocks.sql`。日志数量不写死。

这是一套针对现有集成的本地配置隔离，不是全局网络防火墙。未来增加外部服务时，应同时更新本地禁用/替身配置和场景断言。

实现依据：[Workers 本地变量加载规则](https://developers.cloudflare.com/workers/local-development/environment-variables/)、[本地数据与持久化目录](https://developers.cloudflare.com/workers/local-development/local-data/)、[D1 迁移命令](https://developers.cloudflare.com/workers/wrangler/commands/d1/)。Turso 兼容性仍需独立本地适配验证，D1 通过不能替代 Turso 通过。

## 多个人同时聊天怎么模拟

同一个浏览器配置里的普通标签页共享 cookie 与 localStorage；两个隐私窗口也不一定是两个隔离身份。仅换端口会改变 localStorage 的 origin，但 cookie 不按端口隔离，因此也不够。

推荐两种方式：

1. **快速手动验证**：使用下面不同的 `.localhost` 主机名。它们访问同一个 Worker/数据库，但 cookie 和浏览器存储按主机名分离。当前已用 Codex 内置浏览器验证这些别名；不需要改 hosts。别名只是存储隔离，不会自动登录或授予角色。
2. **同域名正式回归**：同一个站点 URL 使用不同浏览器配置，或自动化工具的独立 BrowserContext，每个人一份 context/storageState；不要共用一份登录状态。当前新增的自动场景使用独立 HTTP cookie jar，UI 验证由浏览器单独执行。

| 身份 | demo 浏览器地址 | 登录及任务 |
| --- | --- | --- |
| 管理员 | `http://admin-demo.localhost:8790/desk` | `actors.admin.password`；审批、审计及停用 |
| 运营者 A | `http://operator-a-demo.localhost:8790/desk` | `actors["operator-a"].password`；型号 `tangbao-local-a` |
| 运营者 B | `http://operator-b-demo.localhost:8790/desk` | `actors["operator-b"].password`；型号 `tangbao-local-b` |
| 浏览器访客 A | `http://visitor-a-demo.localhost:8790/chat` | 匿名，选择模型 A |
| 浏览器访客 B | `http://visitor-b-demo.localhost:8790/chat` | 匿名，选择模型 B |

实例名不是 demo 时，使用 `local:info` 输出的地址（主机名也含实例名，避免跨实例 cookie 混用）。若某浏览器不解析 `.localhost`，改用隔离浏览器配置，不以普通多标签替代。

API seed 的访客凭据在 `actors.json`，不自动导入浏览器 localStorage；新开的访客浏览器是另外的匿名身份。这是有意保留真实进入流程，不在页面写隐藏状态来冒充用户。

手动操作顺序：

1. A/B 两位运营者各自登录 `/desk`，刷新队列使其在线；心跳 120 秒过期，长时间搁置后先刷新。
2. 两位访客各自打开 `/chat`，在模型菜单选择 A/B，分别发送可区分的合成文字。
3. 两位运营者刷新，确认各自只看到对应访客，再分别回复。
4. 两位访客刷新或等待轮询，确认各自只收到对应回复、侧栏历史相互独立。
5. 管理员进入“审计”查看两个模型；A/B 的后台均不应有管理员的申请/审计入口。
6. 重启本地服务，再刷新访客及运营者，验证历史、图片和登录可用。服务停止期间的短暂网络错误不能等同于数据丢失。

所有角色共享本机出口 IP，现有每小时新对话/登录限流和基于 IP 的封禁也会共享影响。不要为跑测试直接关闭产品限流；用新的独立验证实例重开数据。独立会话不等于独立 IP。

不同主机名会影响缓存和 SameSite 行为，因此快捷别名测试不能代替生产同域名下的多 context、HTTPS 和 CSRF 回归。

## 当前与未来的验证矩阵

| 场景 | 当前可执行方式 | 阶段 |
| --- | --- | --- |
| 管理员、运营者 A/B 登录隔离 | 独立 cookie jar；浏览器独立 host/profile | 当前 API 场景已覆盖，UI 单独留证 |
| 访客 A/B 的消息、回复与历史 | 每段真实 token，各自指定模型；UI 各自 localStorage | 当前已覆盖 |
| A 看不到/回不了 B 的对话 | 错误 token、跨模型读取/回复反向测试 | 当前已覆盖 |
| 管理员审计两位模型 | 实际审计及详情 API，浏览器审计页 | 当前已覆盖 |
| 图片及消息池分配 | multipart PNG → 本地 KV；先排队再运营者心跳接单 | 当前已覆盖 |
| 账号注册、邮箱密码登录、未验证/已验证/停用 | 增加 accounts fixture，走正式注册/登录 API | 尚未实现，关联 #6 |
| 匿名第一段、第二段拦截、删除不返额度 | 两个 guest 身份、并发请求、注册后继续草稿 | 尚未实现，关联 #7 |
| 验证/找回、过期/错误/重发/预算 | 本地 mail adapter + 可控时钟/失败替身，隔离验证码用途 | 尚未实现，关联 #8 |
| 旧口令认领、冲突、旧会话撤销 | 已验证账号 A/B 竞争同一旧模型 | 尚未实现，关联 #9 |

未来邮件替身应有本地 outbox（仅合成数据）、验证码可控读取和失败/429 注入；不得把生产 key 填入本地沙箱。真实 Resend 送达用指定受控地址另测，不包含在 mock/API 通过的结论里。

## 已知验证边界

当前实测环境为 macOS、Node 22、锁文件中的 Wrangler 4.151.2、workerd 本地 D1/KV。没有宣称 Windows/Linux、Turso、生产边缘缓存、真实邮件/推送或未来邮箱账号通过。

本轮首个自动启动尝试因 Wrangler 对绝对 `tsconfig` 路径处理失败，原 `server.log` 保留；本地配置改为相对路径后通过。后续每轮使用新的实例和报告，不用成功覆盖首次失败。具体运行与浏览器结果在 #16 回填，代码提交、推送和用户验收单独记录。
