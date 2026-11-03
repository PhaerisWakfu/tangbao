# 本地部署与多身份验证

隔离运行工具由 [#16](https://github.com/PhaerisWakfu/tangbao/issues/16) 建立，账号场景由 [#5](https://github.com/PhaerisWakfu/tangbao/issues/5) 扩展。运行结果以每次报告为准；账号代码、本地邮件替身通过、真实邮件送达和生产部署分别记录。

## 分支、实例与数据

Epic 的子项复用父 Epic 分支，Bug 使用 `rick-dev`，规则见 [Issue 工作流程](issue-workflow.md)。验收记录注明分支、提交、dirty 状态、instance 和结果。

不同 instance 隔离 D1/KV、端口和凭据，不隔离同一 checkout 的源码。切换分支前检查该 checkout 的运行服务；需要同时运行不同分支时使用独立 checkout，不停止别人的服务。实例如 `epic-5-run-01`，失败重跑换新名称，不覆盖首次失败。

## 自动回归

使用 Node.js 22 以上：

```sh
npm ci
npm run types
npx tsc --noEmit
npm run check
npm run local:verify -- --instance epic-5-run-01
```

`local:verify` 创建全新本地实例、随机测试密钥、独立 D1/KV，动态应用并核对全部 SQL migration，启动 Worker，通过正式 HTTP API 执行多身份场景，最后停止自己启动的服务。它拒绝已存在的 instance、远程基址和 Wrangler 任意透传参数。

`npm run check` 覆盖 app、desk、account 三个客户端入口的语法，不替代浏览器、权限、数据库或邮件验证。旧 smoke/browser 脚本不在本回归流程内。

## 留一个可操作的验收站点

```sh
# 终端一：准备并启动，端口可按当前空闲情况指定
npm run local:prepare -- --instance epic-5-demo --port 8792
npm run local:dev -- --instance epic-5-demo

# 终端二：通过真实账号流程建立演示数据
npm run local:seed -- --instance epic-5-demo
npm run local:info -- --instance epic-5-demo
```

使用 `local:info` 输出的首页、聊天页、后台及“本地验收与验证码”地址。不要凭旧记录猜端口或实例凭据。验收面板 URL 含本地实例 nonce，只在回环主机生效，不放入公开 Issue 或提交截图。

本地验收面板提供：

- 管理员、运营者 A/B、普通用户的合成邮箱/密码及独立角色入口；使用正常登录界面，不注入伪造登录态。
- 一个待绑定的旧模型及其合成旧口令，用新的已验证普通账号演练认领。
- 合成邮件箱。用户在产品页用 `your-name@example.test` 注册/找回后，返回面板点击“刷新验证码”，复制该邮箱和用途对应的验证码。
- 建议的产品验收步骤。面板只存在于忽略目录生成的本地 wrapper，生产路由不提供这些能力。

`seed` 首次运行注册并验证账号，通过受控管理员引导脚本向已验证合成账号授予角色，撤销旧会话后重新通过正式登录 API 登录。模型运营者通过申请/审批取得资格，不发放新旧口令。旧模型 fixture 只建立合成旧模型和口令，认领仍须通过正式证明/确认接口，不直接伪造 owner 或 cookie。

`local:seed` 使用 `interactive-seed` 模式，执行用于建立可操作数据的多身份、历史、权限及分配场景，不运行测试时钟快进和邮件故障注入。`local:verify` 使用 `full-regression` 模式，另跑长期会话续期、验证码边界、改密/撤销、认领竞争及发送故障。两种结果的模式和未覆盖项都会写入报告，避免把未来测试时钟和限流事实带进长期验收 demo。

成功 seed 后再次执行会复用同一组合成身份，不重复申请或创建对话。中断/失败的实例保持原样，改用新 instance。已有实例更新源码时先停止对应服务，再 prepare 应用缺少的迁移；prepare 不清数据，也不替换已存在的本地密钥，只补齐缺少的测试密钥。

## 多个人与跨设备怎么验

普通多标签共享 cookie/localStorage，不能当作不同账号。`local:info` 和验收面板中的角色入口使用不同的 `.localhost` 主机名，从而隔离 cookie 和浏览器存储。例如一个管理员、两位运营者、两位匿名访客，全部访问同一个本地数据库。

这些快捷主机名不会自动登录或授予权限。若浏览器不解析 `.localhost`，改用独立浏览器配置或自动化工具的独立 BrowserContext，不用普通多标签替代。

跨设备历史测试使用同一账号在另一个独立浏览器配置/BrowserContext 登录；可先检查原设备匿名历史手动关联，再查看另一设备的服务端历史。匿名历史不因同 IP 自动出现。

正式同域 HTTPS、SameSite 和来源检查仍需单独验证；不同主机名的快捷角色验证不能替代这些结论。

## 建议的浏览器验收

1. 匿名发送首段，再新建第二段；检查账号弹层出现，正文、附件、所选模型和画图状态保留。
2. 注册合成邮箱，从本地邮件面板读取验证码；验证成功后继续原发送且只生成一次对话。取消和错误验证码不丢草稿。
3. 使用已验证普通用户申请模型，管理员审批；运营者只看到自己的队列和回复范围，普通用户不能取得管理权限。
4. 同一账号跨设备查看历史；匿名历史主动关联后旧 token 不再有权读取。不同账号不能看到彼此历史。
5. 关闭/重新打开产品页，确认默认保持登录。退出后清理本站 cookie 与缓存，下一次正常密码登录；设置不提供切换账号入口。
6. 旧模型先显示将绑定的型号，再确认认领；另一个账号不能重复认领，停用模型不被自动恢复。管理员绑定不走公开旧口令认领。
7. 检查 390px/1440px、昼夜主题、中文输入法、键盘焦点/Tab/Escape、长邮箱、网络失败及错误恢复。

截图和浏览器结果保存在对应实例的忽略目录；勿上传真实邮箱、对话或凭据。

## 隔离与本地控制

- 配置只含本地占位 D1/KV ID，Wrangler 强制 `--local`，只监听 `127.0.0.1`，不发布 Tunnel。
- 子进程使用环境变量白名单，不继承业务 provider keys，不读取根目录真实 `.dev.vars`/`.env`。
- Turso、飞书和 Web Push 关闭；邮件固定 `MAIL_MODE=test`，`EMAIL` 远程绑定不存在。测试不发送真实邮件。
- 每次场景请求先核验 `/__local/health` 的随机实例标记，包括可能写心跳/分配任务的 GET。
- 合成邮件读取、fixture 管理、测试时钟/故障/预算注入只在本地 wrapper 提供，固定操作白名单并检查 nonce，拒绝任意 SQL。
- HTTP actor 使用独立多 cookie jar，并携带同源 Origin。批量场景以合成边缘 IP 区分 actor，避免全部共用一个 IP 导致旧创建限流互相干扰；同匿名身份并发测试仍使用同一 cookie/IP。
- SQL migration 清单与本地 `d1_migrations` 精确对比，不写死迁移份数；新账号结构不靠请求入口自修复。

这是已知集成的隔离配置，不是全局网络防火墙。增加外部服务时，同时更新禁用/替身配置和场景断言。

## 产物与结果

| 产物 | 路径/内容 |
| --- | --- |
| 实例身份和端口 | `.tmp/local-sandboxes/<instance>/instance.json` |
| 隔离配置和本地 wrapper | 同目录 `wrangler.json` / `worker.mjs` |
| 随机本地密钥 | 同目录 `.dev.vars`，权限 0600 |
| 合成账号、cookie、对话 token | 同目录 `actors.json`，权限 0600 |
| D1/KV | 同目录 `state/`，prepare/dev 使用相同持久化目录 |
| 迁移/服务日志 | 同目录 `migrations.log` / `server.log` |
| 逐项结果 | `verification-<时间>-<随机值>.json`，保留 PASS/FAIL 和具体失败原因 |
| 生命周期 | `lifecycle.json`，包括启动失败和停止结果 |

所有产物均忽略、不提交。报告明确保留 Turso 真实运行、真实 Cloudflare 邮件送达/退信、生产 HTTPS/边缘缓存、高并发容量和生产迁移等未测边界。浏览器验收另留证，不由 HTTP 场景代替。

## 上线与回退

生产使用 Cloudflare Email Sending、每日 200 封预算、不设置月度限制；详见 [账号设计](accounts.md)。真实发信由指定受控地址单独验收，发送受理不等于进收件箱。

部署者准备生产时，先在本地检出待发布版本并核对 `wrangler.jsonc` 中 `DB` 的数据库名称/ID，以及 `EMAIL` 的发件地址。新增 `EMAIL_CODE_PEPPER`、`MAIL_PAYLOAD_KEY` 两个 Worker secret，分别使用密码管理器生成至少 32 字节的独立随机值，不填进 Git 或聊天；已有 `ADMIN_SECRET` 也需为足够长的随机值。可在 Cloudflare 的 Worker → 设置 → 变量与机密中添加，或使用 `npx wrangler secret put <名称> --config wrangler.jsonc` 的交互输入。密钥轮换需要另做验证码/outbox/旧凭据恢复安排，不把更换密钥当作普通重启。

D1 迁移使用稳定 binding `DB`，不要沿用旧 `migrate:*` 脚本中的数据库别名。部署者核对和备份目标数据库后，可先用 `npx wrangler d1 migrations list DB --config wrangler.jsonc --remote` 查看待执行文件，再用 `npx wrangler d1 migrations apply DB --config wrangler.jsonc --remote` 应用尚未执行的迁移；随后部署对应版本。本文只是操作说明，本地 demo 不会执行这些远程命令。

管理员引导复用 `scripts/bootstrap-admin.mjs`。先通过产品页注册并验证账号，取得目标账号 ID，再明确指定配置和本地/远程目标。脚本默认只生成可审阅 SQL，不执行；例如本地预览：

```sh
node scripts/bootstrap-admin.mjs \
  --account-id 'ACCOUNT_ID' \
  --config .tmp/local-sandboxes/epic-5-demo/wrangler.json \
  --local --persist-to .tmp/local-sandboxes/epic-5-demo/state
```

将 `ACCOUNT_ID` 换成已验证合成账号的实际 ID。核对 SQL 和目标后，添加 `--execute` 才会执行。默认首管理员模式要求当前没有管理员；`--recovery` 仅用于部署者确认过的受控恢复。审计 migration 记录管理员授予/撤销及账号状态变化。远程使用 `--remote` 且不得附带本地持久化目录，由有权限的部署者单独核对并执行。

远程数据库迁移、管理员受控引导、部署及真实数据操作由有权限的部署者明确执行。先核对目标数据库、迁移版本和恢复点，再部署相匹配的代码；普通本地回归不操作线上。已认领模型和已撤销凭据不能靠回退代码自动恢复，需使用事先演练的恢复流程。
