# Epic #5 部署、数据迁移与验收手册

读者：没有参与本次开发、但拥有 Cloudflare 部署权限的维护者。所有命令由部署者在项目根目录执行。对应 [Epic #5](https://github.com/PhaerisWakfu/tangbao/issues/5)、[邮件 #8](https://github.com/PhaerisWakfu/tangbao/issues/8)、[旧模型认领 #9](https://github.com/PhaerisWakfu/tangbao/issues/9) 和 [迁移交付 #17](https://github.com/PhaerisWakfu/tangbao/issues/17)。

本版代码已完成本地账号与真实 D1 副本演练，用户已确认本地流程。**真实 Cloudflare 发信、真实历史图片及云端切换尚未验收，须按本文实际执行后记录结果。** 本文不包含任何现成测试账号、生产密码或验证码。

## 先看执行顺序

1. **先建独立测试站**：新 Worker、新 D1、新 KV、独立 HTTPS 地址，只让部署者和验收者访问；使用 Cloudflare 原生邮件绑定发真实邮件。此阶段不升级现有站点、不迁移现有数据库。
2. **再做正式切换**：测试通过后约定维护窗口，暂停旧业务，取得最新备份，将数据迁移到另一个全新正式 D1，最后在原正式域名切换匹配的新代码与数据库。正式图片默认保留原 KV。

不要把新版直接覆盖当前线上 Worker 当作测试，也不要只新建 Worker 却仍连接生产 D1/KV。测试站内的注册、认领和聊天只写测试库，之后不自动合入正式库。

发信只使用 `env.EMAIL.send()`。**不用准备发信 API Key，不用向开发者提供 Account ID/API Token，也不用添加 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 环境变量。** 部署者用自己电脑上的 Wrangler 登录发布即可；如果本来使用 CI，沿用部署者自己的 CI 授权。[官方 Workers 发信指南](https://developers.cloudflare.com/email-service/get-started/send-emails/)。

## 一、准备代码、资源和配置

### 1. 取代码，先检查，不部署

使用 Node.js 22+。建议在一个新目录取功能分支，避免覆盖部署者电脑已有的工作：

```sh
git clone --branch feat/epic-5-accounts https://github.com/PhaerisWakfu/tangbao.git tangbao-accounts-release
cd tangbao-accounts-release
npm ci
npm run types
npx tsc --noEmit
npm run check
git rev-parse HEAD
npx wrangler login
npx wrangler whoami
```

保存输出中的代码 commit；后续测试和正式切换使用同一待发布版本。多账号登录时选择资源所在的 Cloudflare 账号。Wrangler 可能要求在部署配置中指定 `account_id` 以区分多个账号；它只是发布工具的账号标识，不是额外的邮件业务变量或密钥。

Git push 不会执行迁移。仓库 CI 只做检查；**先到 Cloudflare 当前 Worker → Settings/设置 → Builds/构建，核对有没有 Git 自动部署**，准备好迁移前不要让提交覆盖现有生产服务。本文不要求创建 PR 或合并 main。

下文使用 Bash/Git Bash，SQL/JSON 保存为 UTF-8。Windows 用户可用 Git Bash；不要用旧 PowerShell 的默认 UTF-16 重定向保存备份。

### 2. 记录现有资源，再建测试资源

先到 Cloudflare → Workers & Pages → 当前糖包 Worker → Settings/设置 → Bindings/绑定，记录以下信息；以控制台实际值为准：

| 信息 | 当前已知值 / 需要做的事 |
| --- | --- |
| 正式 Worker 名称、版本、域名和所有入口 | 网址为 `https://tangbao.phaeris.cn`；记录 Worker 名称、当前版本、路由、workers.dev/Preview 是否开放 |
| `DB` | D1 名称为 `tangbao261102`；记录实际 database ID |
| `IMAGES` | KV 名称为 `tangbao`；记录实际 namespace ID，原库保留 |
| 发信域 | Cloudflare → Email Service → Email Sending → `mail.phaeris.cn`，确认发送已启用、DNS 已配置 |
| 发件人 | `糖包 <noreply@mail.phaeris.cn>`；与绑定限制保持一致 |
| 配额 | 应用侧每日总预算 360 封（Cloudflare 90、Brevo 280），180 封告警；单家日额度错误触发该家 5 分钟熔断并切换另一家；账户月度额度以两家控制台为准，测试会真实消耗发信额度 |
| 旧配置与任务 | 保存普通变量、Secrets 名称、Cron/Queue、通知配置及恢复方法；不要截图或回传密钥值 |
| 验收人员 | 准备管理员 A、新申请者 B、旧模型运营者 C 三个账号各自可收件的真实邮箱，及两个独立浏览器配置或设备；C 另需本人原后台口令 |

本文用三个根目录配置文件明确目标，它们都已被 Git 忽略：

| 文件 | 对应目标 |
| --- | --- |
| `wrangler.accounts-test.jsonc` | 新建的独立测试 Worker / D1 / KV |
| `wrangler.accounts-source.jsonc` | 当前正式 Worker / 原 D1 / 原 KV；用于只读导出及最终停写，不改成测试资源 |
| `wrangler.production.jsonc` | 最终新版正式 Worker / 新正式 D1 / 原 KV |

`wrangler.accounts-source.jsonc` 以部署者现有的正式部署配置为底稿，对照控制台核实原 Worker 名称和绑定。保持 `main=src/index.ts`、资源路径相对项目根目录，`DB` 的迁移目录为 `migrations`。不要把发布模板中的占位 ID 当成原库 ID。

建立测试配置：

```sh
cp wrangler.accounts.example.jsonc wrangler.accounts-test.jsonc
```

打开该文件，先把 `name` 改为一个全新名称，例如 `tangbao-accounts-test`。`routes` 填准备用于测试的独立子域；`APP_ORIGIN` 填同一个精确 HTTPS origin，不含路径或末尾斜杠。保持 `workers_dev=false`、`preview_urls=false`、`MAINTENANCE=1`。

在 Cloudflare 为该测试域名建立 Access 访问规则，仅允许部署者和验收者访问**整个域名（含 /api 和 /desk）**；确认未登录 Access 的另一个浏览器无法访问。关闭 workers.dev 和 Preview URL 旁路。不要在受限测试站链接上公开真实对话或备份。

然后创建全新测试资源：

```sh
npx wrangler d1 create tangbao-accounts-test --config wrangler.accounts-test.jsonc
npx wrangler kv namespace create IMAGES --config wrangler.accounts-test.jsonc
```

将创建结果写回测试配置的 `d1_databases`（`database_name`、`database_id`）和 `kv_namespaces.id`。与正式库逐项比对，必须不是原 D1/KV。把所有 `replace-...` 和全零资源 ID 替换完再部署。

### 3. 原生邮件和必要站点密钥

模板已包含以下原生绑定，无需加入 `remote: true`，也不配置 REST/SMTP：

```jsonc
"send_email": [{
  "name": "EMAIL",
  "allowed_sender_addresses": ["noreply@mail.phaeris.cn"]
}]
```

绑定名必须为 `EMAIL`；不要只限制为某一个收件邮箱，否则正常注册用户不能收到邮件。模板中的 `MAIL_MODE=cloudflare`、`MAIL_FROM`、`MAIL_DAILY_LIMIT=360`、`MAIL_PROVIDERS=cloudflare,brevo`、`CLOUDFLARE_DAILY_LIMIT=90`、`BREVO_DAILY_LIMIT=280`、`BREVO_FROM`、`BREVO_API_KEY` 和一分钟 Cron 保持即可。

以下是**应用自身所需 Secrets**，与邮件 API Token 无关：

| Secret | 用途 | 测试 / 正式怎样处理 |
| --- | --- | --- |
| `ADMIN_SECRET` | 识别旧后台 cookie、签名及请求凭据 | 测试站生成独立新值；升级现有正式 Worker 保留原值，不重新生成 |
| `EMAIL_CODE_PEPPER` | 保护邮箱验证码摘要 | 各环境使用独立随机值，首次配置后稳定保存 |
| `MAIL_PAYLOAD_KEY` | 加密待发邮件的短期内容 | 与 pepper 不同的随机值，各环境独立，首次配置后稳定保存 |

两个新邮件 Secret 各生成至少 32 字节随机值，保存到部署者的密码管理器，再录入 Worker Secrets。不要填进普通 `vars`、Git、聊天或命令行参数。可在本机分别执行下列命令生成，不要共享输出：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

先以 `MAINTENANCE=1` 部署测试 Worker，再录入这三个 Secret：

```sh
npx wrangler deploy --config wrangler.accounts-test.jsonc
npx wrangler secret put ADMIN_SECRET --config wrangler.accounts-test.jsonc
npx wrangler secret put EMAIL_CODE_PEPPER --config wrangler.accounts-test.jsonc
npx wrangler secret put MAIL_PAYLOAD_KEY --config wrangler.accounts-test.jsonc
```

也可到目标 Worker → Settings/设置 → Variables and Secrets/变量和密钥，新增类型为 Secret/加密。维护开启时页面和业务 API 返回 503，不能注册首个管理员，这是预期。[Cloudflare Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/)。

账号密码使用 scrypt。到 Worker → Settings/设置 → CPU limits 检查是否遗留了过小的自定义限制（例如旧套餐迁移的 50ms）；按独立站实际测量调整并记录，不以本地耗时替代 Workers 验证，不修改密码算法来规避限制。[Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)。

旧 `ADMIN_PASSWORD` 不是新管理员的邮箱登录密码。独立测试站不用复制生产飞书/Web Push Secrets；正式升级保留既有配置。本次使用 D1，确认目标 Worker 没有同时生效的 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN`，否则代码会优先选择 Turso。

## 二、导入测试副本，执行新增迁移

所有备份、检查结果放在 `private-assets/`，不提交 Git。先导出原库，以下四条只读取正式数据；导出可能短暂阻塞请求，选无人操作的时段。

```sh
mkdir -p private-assets/accounts-test
npx wrangler d1 export DB --remote --config wrangler.accounts-source.jsonc --output private-assets/accounts-test/source.sql
npx wrangler d1 execute DB --remote --config wrangler.accounts-source.jsonc --command "SELECT name FROM d1_migrations ORDER BY name" --json > private-assets/accounts-test/baseline.json
npx wrangler d1 execute DB --remote --config wrangler.accounts-source.jsonc --file scripts/sql/accounts-image-inventory.sql --json > private-assets/accounts-test/image-inventory.json
```

SQL 包含表结构和数据，**不包含 KV 图片文件，也不包含用户浏览器中的匿名对话 token**。原文件保留不编辑。只有新建的空测试 D1 才执行下一条导入：

```sh
npx wrangler d1 execute DB --remote --config wrangler.accounts-test.jsonc --file private-assets/accounts-test/source.sql
npx wrangler d1 execute DB --remote --config wrangler.accounts-test.jsonc --file scripts/sql/accounts-preflight.sql --json > private-assets/accounts-test/preflight.json
npx wrangler d1 migrations list DB --remote --config wrangler.accounts-test.jsonc
```

检查 `preflight.json` 的迁移记录，与 `baseline.json` 逐项一致。本次已核实的账号改造前源版本是连续 `0001_init.sql` 至 `0020_clear_blocked_waiting.sql`。待执行清单以所选部署提交的 `migrations/` 为准：账号功能包含 `0021_accounts.sql`、`0022_account_admin_audit.sql`；若部署包含后续图片清理/严格迁移修复的版本，还必须应用 `0023_image_cleanup_jobs.sql`、`0024_app_schema_version.sql`。旧七类核心记录数留作迁移后对照；历史异常引用、共享旧口令组不删记录掩盖。

**记录缺失、不一致、出现未知迁移，或者导入报错就停止。** 不在源库修表，不把 0001–0020 全部重跑，也不盲目手填“已执行”。保存原 SQL、baseline 和错误，反馈维护者。导入中断后的目标库保留现场，重新演练使用新的空 D1，不能在半成功库上反复导入。本地规范化导入已经验证，云端直接导入仍须实际检查；外键建表顺序等报错参考 [D1 导入说明](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。

核对无误后应用尚未执行的迁移：

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.accounts-test.jsonc
npx wrangler d1 execute DB --remote --config wrangler.accounts-test.jsonc --file scripts/sql/accounts-postflight.sql --json > private-assets/accounts-test/postflight.json
```

账号 SQL 为 [0021_accounts.sql](../migrations/0021_accounts.sql) 和 [0022_account_admin_audit.sql](../migrations/0022_account_admin_audit.sql)，后续迁移包含图片清理、会话置顶、已读记录、接单开关、暂离、邮件通道、账号推送、开场问题、结构检查、消息分页、[0026_security_maintenance.sql](../migrations/0026_security_maintenance.sql) 及 [0027_clear_legacy_credentials.sql](../migrations/0027_clear_legacy_credentials.sql)。按完整目录应用，不要单独 execute 文件而遗漏 `d1_migrations` 记录。[D1 migrations 说明](https://developers.cloudflare.com/d1/reference/migrations/)。

`0027` 清理当前数据库中的旧口令明文副本，保留原验证摘要和模型状态。部署后只核对 postflight 的 `legacy_credential_copies=0`，不输出原值；这一步不清理已有备份或平台恢复点。恢复旧备份时须在开放服务前接续全部迁移并再次核对，不恢复旧口令展示能力。

迁移后版本记录必须与所选部署提交的迁移目录逐项一致，不固定按 22 份判断。当前代码要求 `settings` 中 key 为 `app_schema_version` 的值为 `30`（包含 `0030_reports.sql` 举报升级）；缺失时相关入口返回 `503 SCHEMA_NOT_READY`，不会自动补表，处理方式见[严格迁移说明](local-development.md#严格迁移与缺失提示)。旧 `threads/messages/message_images/operators/applications/blocks/push_subscriptions` 行数与副本迁移前一致。无效/重复模型 UID、无账号 owner、无运营者角色 owner 四项均为 0；`foreign_key_check` 无结果。管理员刚迁移后为 0 是正常的，后续引导后至少为 1。

这条导入流程针对尚未启用账号的 0001–0020 源库。将来复制已经升级的 0021/0022 数据库时，须另行处理复制来的账号会话、验证码、认领证明、outbox 和通知任务，不能直接启动真实发信。

在 Access 生效、数据库迁移和 Secrets 都就绪后，将**测试配置**的 `MAINTENANCE` 改为 `0`，再次部署，打开测试站 `/chat` 开始验收：

```sh
npx wrangler deploy --config wrangler.accounts-test.jsonc
```

不要运行 `local:seed`，不要往云端上传 `.dev.vars` 或本地测试实例配置。云端没有本地验证码面板，验证码只能从真实邮箱取得。

## 三、先引导测试管理员

1. 测试站 `/chat` → 登录/注册 → 用部署者控制的真实邮箱注册，自己设置密码。收到邮件后输入验证码完成验证。
2. Cloudflare → D1 → **测试数据库** → Console/控制台，在 `accounts` 表按该邮箱查找，复制其 `id`，并核对 `verified_at>0`、`status=active`。这里的账号 ID 是新注册用户的 ID，不是 Cloudflare Account ID。
3. 先执行预览命令，打开生成的 SQL，核对账号和测试配置的 DB；确认后再执行第二条：

```sh
node scripts/bootstrap-admin.mjs --account-id 替换为已验证账号ID --config wrangler.accounts-test.jsonc --remote
node scripts/bootstrap-admin.mjs --account-id 替换为已验证账号ID --config wrangler.accounts-test.jsonc --remote --execute
```

脚本的普通模式只在尚无管理员时授予首个管理员；已有管理员时不要反复加 `--recovery`，该参数仅用于明确的受控恢复。脚本不支持 `--env`，本文用完整配置文件定位环境。

4. 授权会撤销该账号旧会话。用邮箱和密码重新登录 `/desk`，确认可进入主模型、审批和管理页面；不需要公开认领主模型。旧 `ADMIN_PASSWORD` 或普通旧模型口令不能代替管理员引导。

正式切换时还需在**正式新库**重新注册、验证、引导；测试管理员不会自动变成正式管理员。

## 四、部署者逐项验收

准备已引导的管理员 A、新申请者 B、持有本人旧模型口令的运营者 C；三个账号使用各自邮箱。B 用来申请新模型，C 在认领旧模型前不能已有模型或待处理申请。01–02 分别为 B/C 完成注册与验证。使用独立设备/浏览器配置测跨设备；同浏览器普通标签共享登录态，适合测同源退出同步。下面先在独立测试站做，不用真实生产用户做破坏性测试。

| 编号 | 操作 | 应看到的结果 |
| --- | --- | --- |
| 01 | `/chat` 注册真实邮箱 B；输入一次错误码，先保留未验证状态 | 真邮箱收到糖包验证码；错误被拒绝，未验证前不能新建第二段或申请模型 |
| 02 | 沿用 01 的未验证账号，在冷却结束后重发验证码；先试旧码，再用新码完成验证 | 60 秒内提示等待；重发后旧码失效，新码只可成功消费一次 |
| 03 | 设置密码；测试过短、过长或只有单一类别的密码 | 新密码为 6–20 字符，数字/英文字母/特殊符号至少两类；不符合有明确提示 |
| 04 | 正常邮箱密码登录，刷新、关闭再打开浏览器 | 默认保持登录；普通登录不发送邮件，不要求反复验证邮箱。记录 Workers 实际耗时/错误，检查有无 CPU/内存超限 |
| 05 | B 在两个设备登录并聊天，再在另一设备打开历史 | 本人账号历史跨设备可见；另一账号不能读取 B 的历史或图片 |
| 06 | 账号设置修改密码，再尝试旧密码和另一个设备旧会话 | 旧密码不能登录，其他旧会话被撤销；新密码登录后历史保留 |
| 07 | 登录页“找回密码”→ 真邮箱验证码 → 新密码 → 正常登录 | 邮件收到，找回码只用于找回；重置后旧密码和旧会话失效。服务端日志不输出验证码或密码 |
| 08 | 先完成下文匿名历史关联；改密/找回后在两设备用新密码重新登录，再仅退出其中一个设备 | 清理该设备本站客户端数据，同源标签同步退出；另一设备的新会话保留。下次需密码，服务端账号历史仍在 |
| 09 | 新浏览器身份匿名创建第一段并继续发送，再新建第二段 | 同段可继续；第二段要求登录/验证；删除第一段不返还额度。不断开新无痕窗口仍可能获得新身份，不承诺硬件绑定 |
| 10 | 第二段准备正文和附件，取消登录后再继续，随后完成登录 | 取消/失败保留草稿；成功只发送一次，附件可用，无重复对话 |
| 11 | 登录后在原匿名浏览器主动关联历史，再换设备登录 | 有原 token 的历史可关联；关联后旧 token 不再独立访问；没有有效原 token 的历史不能关联，其他账号不能读取已归属历史 |
| 12 | 已验证 B 提交 AI 申请，管理员 A 在 `/desk` 审批 | 申请绑定真实账号；审批后运营者可进本人工作台，一个账号最多一个模型 |
| 13 | 独立的已验证 C：`/desk` 或账号设置 → 绑定已有模型 → 原口令 → 核对型号及邮箱 → 确认 | 输入的是**原模型后台的旧口令，不是新邮箱账号密码**。确认前只核验；确认后 owner 唯一，旧口令/旧登录失效，邮箱登录可跨设备进工作台 |
| 14 | 对照认领前后的旧模型资料、状态、历史、队列及拉黑记录 | 归属稳定，原数据仍在；停用模型不会因认领而自动启用。其他账号不能抢已绑定模型或认领第二个模型 |
| 15 | 普通账号尝试管理页面，管理员处理一份测试申请 | 普通账号无管理权限；公开注册/认领不会授予 admin；首版无自助换邮箱、模型转让或切换账号入口 |
| 16 | 在独立 KV 上画图、上传、多图、查看及下载；补齐旧 KV 副本后再验旧图 | 文件、顺序和归属正确，跨设备可看，其他账号不能越权；未复制旧 KV 时明确记“旧图片未验收” |
| 17 | 检查 HTTPS、浏览器 DevTools 和所有访问入口 | 账号 cookie 为 HttpOnly/Secure/SameSite；origin 正确；无验证码面板/fixture/演练密码；旁路入口不会绕过 Access |
| 18 | 查看 Cloudflare 发信活动记录和 Worker 状态 | 分别记录“服务受理”“实际收件箱/垃圾箱收到”“验证码验证成功”；不把 messageId 或 accepted 当作送达成功 |

匿名历史的 token 保存在原浏览器、原 origin 下。**独立测试域名拿不到正式域名的 localStorage**：测试站只用自己新建的匿名历史演练，不把线上 token 复制到公开 URL。正式切换保留原 HTTPS 域名，用户在原浏览器先主动关联、确认历史进入账号，再退出或清缓存；未关联就退出会失去本机匿名入口。

完整错误边界在测试站另验并回传：验证码 10 分钟过期、连续错误最多 5 次、注册/找回用途隔离、重复提交与模型认领竞争、拉黑/停用和权限隔离。不要为了测额度连发 190 封或伪造供应商失败。未实际触发的 429/超时和真实回执记录为“未验证”，已有本地替身覆盖不能当作真实供应商结论。服务端新对话还有按 IP 的创建限流，连续造数触发时等待窗口，不改生产限额绕过。

邮件预算按 UTC 日期计数，应用侧总预算 360、不设应用侧月度限制；Cloudflare 按每天 90 封控制（3,000 封/月，按 31 天留缓冲）、Brevo 280，分别计数。180 封写告警日志；单家返回日额度错误时打开该家 5 分钟熔断并切换另一家，两家都不可用时重试/提示额度已满。同账号其他 Worker 的发送还受两家供应商账号额度约束。明确可重试的限流才有界重试，超时 unknown 不盲目重发。一分钟 Cron 不要删。首轮不需要配置邮件事件 Queue；若以后开通，再单独配置订阅、`queues.consumers`、`MAIL_EVENTS_QUEUE`/`MAIL_EVENTS_ACCOUNT_ID` 并验证 delivered/bounce 及去重，详见 [邮件事件约定](accounts.md#cloudflare-email-sending)。未接入时如实标注回执未验收。

## 图片数据必须随正式迁移保留

D1 的 `message_images → messages → threads` 和旧 `messages.image_key` 保存图片归属与 key，`IMAGES` KV 保存二进制。账号 SQL、模型认领和匿名历史关联均不改图片 key。**SQL 备份不能代替图片备份。**

默认同一 Cloudflare 账号内发布，正式新 Worker 继续绑定原 `IMAGES` namespace，不重建、不改 key。测试 Worker 始终绑定自己的 KV：删除对话会删除当前绑定 KV 的文件，不能为补图把测试站接到生产 KV。

正式切换前需要完成：

1. 用 `scripts/sql/accounts-image-inventory.sql` 列出当前及旧字段的全部引用，与实际 KV 文件核对；记录图片引用数、去重 key 数、文件存在/可读情况。源端已有缺图单独列出，不删引用掩盖。
2. 在停写窗口保存原 KV 的完整文件、key、必要 metadata/expiration 和校验清单，与最后 D1 SQL 对应同一恢复点。只有 key 列表不是完整备份；二进制不能以文本编码保存。
3. 在测试 KV 上复制所需旧图进行读取、画作、多图顺序、下载和权限验证；正式受控烟测只查看旧图，不删除原历史。
4. 如果一定要更换 namespace/账号，先完整复制全部分页的原 key、二进制、metadata 和原过期时间，逐项核对字节长度和 SHA-256，再切绑定。当前仓库不提供一键跨账号 KV 搬迁脚本，不把“已保留 D1 引用”写成“已搬完图片”。[KV 列表](https://developers.cloudflare.com/kv/api/list-keys/)、[二进制读取](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)。

### 停写后备份原 KV（只读）

在下文正式切换第 2 步完成 D1 导出后，维持停写，再整段复制执行下面的代码。它只对原 `IMAGES` 做 list/get，下载全部 key 的实际二进制；不会写入或删除线上 KV。目录已存在就拒绝覆盖，失败保留现场。需要重试时使用新的备份目录，不删第一次结果。

```sh
node --input-type=module - <<'NODE'
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const directory = 'private-assets/accounts-final/kv-backup';
const config = 'wrangler.accounts-source.jsonc';
const cli = path.resolve('node_modules/wrangler/bin/wrangler.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
mkdirSync(directory, { mode: 0o700 });
const manifest = { status: 'running', createdAt: new Date().toISOString(), config, files: [] };
const save = () => writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const run = args => {
  const result = spawnSync(process.execPath, [cli, 'kv', 'key', ...args, '--binding', 'IMAGES', '--remote', '--config', config],
    { encoding: null, maxBuffer: 32 * 1024 * 1024, timeout: 60000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.error || result.status !== 0) {
    writeFileSync(path.join(directory, 'failed-command.log'), Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)]), { mode: 0o600 });
    throw new Error('KV 读取失败，请私下检查 failed-command.log，不能将此备份视为完成');
  }
  return result.stdout;
};
save();
try {
  const keys = JSON.parse(run(['list']).toString('utf8'));
  if (!Array.isArray(keys) || keys.some(key => !key || typeof key.name !== 'string' || !key.name || key.name.startsWith('-')) || new Set(keys.map(key => key.name)).size !== keys.length) throw new Error('key 清单格式或唯一性异常');
  writeFileSync(path.join(directory, 'keys.json'), JSON.stringify(keys, null, 2), { mode: 0o600 });
  manifest.expectedKeys = keys.length;
  for (const key of keys) {
    const bytes = run(['get', key.name]);
    if (!bytes.length) throw new Error('发现空图片文件，请核查源端，停止交付');
    const file = hash(key.name) + '.bin';
    writeFileSync(path.join(directory, file), bytes, { flag: 'wx', mode: 0o600 });
    manifest.files.push({ ...key, file, bytes: bytes.length, sha256: hash(bytes) });
    save();
  }
  const inventory = JSON.parse(readFileSync('private-assets/accounts-final/image-inventory.json', 'utf8'));
  if (!Array.isArray(inventory) || inventory.some(entry => !Array.isArray(entry.results))) throw new Error('图片引用清单格式异常');
  const refs = inventory.flatMap(entry => entry.results).map(row => row.image_key);
  if (refs.some(key => typeof key !== 'string' || !key)) throw new Error('图片引用存在无效 key');
  const backedUp = new Set(manifest.files.map(file => file.name));
  manifest.missingReferences = [...new Set(refs)].filter(key => !backedUp.has(key));
  if (manifest.missingReferences.length) throw new Error('D1 引用存在缺图，详见 manifest.json');
  manifest.status = 'complete';
  manifest.finishedAt = new Date().toISOString();
  save();
  console.log('KV 备份及引用检查完成，文件数：' + manifest.files.length);
} catch (error) {
  manifest.status = 'failed'; manifest.error = error.message; save(); throw error;
}
NODE
```

当前锁定 Wrangler 的 `key list` 会自动取完分页；`key get` 默认输出二进制，不加 `--text`。文件名使用 key 的摘要，`manifest.json` 保留原 key、字节数、内容 SHA-256 及原有 metadata/expiration。只有 `status=complete` 且文件数等于 expectedKeys 才算此次读取完成；还需检查最后新增的画作，确认停写前的近期 KV 写入已经传播。真实 KV 尚未执行此备份，文件完整性与恢复仍须部署者验收。

恢复演练先在独立测试 KV 做：按 manifest 的原 key、原二进制文件逐项还原，命令格式为 `npx wrangler kv key put 原key --path 备份文件路径 --binding IMAGES --remote --config wrangler.accounts-test.jsonc`。原记录有 metadata 时加 `--metadata` 及其 JSON，有仍有效的过期时间时加 `--expiration` 及原时间戳；已到期记录先核查，不改成永久保存。恢复后重新读取比较长度和 SHA-256，再测旧图查看和权限。未演练不填写“恢复通过”。正式回退若需要恢复原 KV，必须先核实具体受影响的 key，不能把测试库内容整体覆盖原 KV。

**未取得完整图片恢复点，或缺图、内容不一致、越权读图未查清时，只能继续受限账号/邮件测试，不能宣布正式迁移完成或向公众开放。**

## 六、正式停写、迁移和切换

仅在独立站的账号、真实邮件及其他不依赖旧图的场景通过、图片恢复方案准备好后，由部署者选择维护窗口执行。使用与测试通过相同的代码 commit；最终新 D1 使用停写后的最新完整数据，不使用旧测试库。

### 1. 保存旧版本并暂停旧业务

记录旧 Worker 版本、全部入口/路由、DB/KV 绑定、Cron/Queue、普通变量和 Secret 名称及恢复方式。

将 `wrangler.accounts-source.jsonc` 的代码入口指向本版 `src/index.ts`，保持原 Worker 名称、原 D1、原 KV、原通知配置、正式 origin 和原 `ADMIN_SECRET`，添加 `MAINTENANCE=1`；使用本版一分钟 Cron/原生邮件配置。然后部署停写版本：

```sh
npx wrangler deploy --config wrangler.accounts-source.jsonc
```

该守卫在数据库初始化前返回维护响应，API/Worker 页面 503，Cron 暂停，Queue 延后重试；此刻原库仍是 0001–0020。检查未登录和已登录请求都被暂停，不能靠“只隐藏登录按钮”停写。静态资源可能继续可读，但不产生业务写入。

它不会自动影响其他 Worker、旧直连入口或在途请求；关闭仍能写同库的其他入口、暂停旧消费者，等在途请求结束后再备份。不能只给旧代码加一个它不执行的维护变量。若部署停写版本失败，不继续导出切换数据。

### 2. 取得同一窗口的最终 D1/KV 恢复点

```sh
mkdir -p private-assets/accounts-final
npx wrangler d1 execute DB --remote --config wrangler.accounts-source.jsonc --file scripts/sql/accounts-preflight.sql --json > private-assets/accounts-final/preflight.json
npx wrangler d1 export DB --remote --config wrangler.accounts-source.jsonc --output private-assets/accounts-final/source.sql
npx wrangler d1 execute DB --remote --config wrangler.accounts-source.jsonc --command "SELECT name FROM d1_migrations ORDER BY name" --json > private-assets/accounts-final/baseline.json
npx wrangler d1 execute DB --remote --config wrangler.accounts-source.jsonc --file scripts/sql/accounts-image-inventory.sql --json > private-assets/accounts-final/image-inventory.json
```

同时执行上节原 KV 的只读备份和完整性检查，再向独立测试 KV 恢复所需旧图，完成旧图查看、下载及权限验收；未通过则保持维护，不继续正式开放。保存备份时间、SQL 的 SHA-256 和恢复方法；期间新增的对话及图片不能漏掉。原库留作回退，不在其上执行 0021/0022。

### 3. 新正式 D1 导入并迁移

复制并编辑正式配置：`name` 为当前正式 Worker，`routes` 和 `APP_ORIGIN` 为原正式域名，`IMAGES` 为核实过的原 KV，`MAINTENANCE=1`。正式配置中的原通知配置和 Secrets 保留。先创建一个新正式库，再填写返回的 DB 名称/ID：

```sh
cp wrangler.accounts.example.jsonc wrangler.production.jsonc
# 先编辑正式 Worker 名称、域名、原 KV 和普通配置；不要部署。
npx wrangler d1 create tangbao-accounts-v1 --config wrangler.production.jsonc
# 把新库的 database_name / database_id 写回 wrangler.production.jsonc 的 DB。
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file private-assets/accounts-final/source.sql
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file scripts/sql/accounts-preflight.sql --json > private-assets/accounts-final/target-before.json
npx wrangler d1 migrations list DB --remote --config wrangler.production.jsonc
```

此时只改变了本机配置，新版还未部署，停写 Worker 仍绑定原库。核对导入完整、版本和最后 baseline 一致、只剩 0021/0022，再执行：

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file scripts/sql/accounts-postflight.sql --json > private-assets/accounts-final/postflight.json
npx wrangler secret put EMAIL_CODE_PEPPER --config wrangler.production.jsonc
npx wrangler secret put MAIL_PAYLOAD_KEY --config wrangler.production.jsonc
```

正式邮件密钥使用独立随机值，不复用测试值；原 `ADMIN_SECRET` 不改。任一步失败、版本不符或原数据/图片数量异常，就保持维护、保留现场，不继续开放。

### 4. 在原域名受控检查，再开放

1. Cloudflare Access 限制整个正式域名，仅部署者/验收者可访问；关闭 workers.dev/Preview 等旁路，确认公众无法进入。
2. 核对正式配置的 DB=新正式库、KV=原图片库、EMAIL=原生绑定、APP_ORIGIN=原正式 origin；将 `MAINTENANCE` 改为 `0`，部署：

```sh
npx wrangler deploy --config wrangler.production.jsonc
```

3. 在正式域名注册并真实验证首个管理员账号，按第三节脚本引导；两条命令的配置都换成 `wrangler.production.jsonc`，账号 ID 换成正式新库中的账号。密码重登确认管理功能，不把测试库账号回灌正式。
4. 少量烟测注册、普通登录零邮件、退出、找回、本人旧模型认领、原浏览器匿名历史关联、跨设备、旧图片查看。正式原 KV 不执行删除旧对话等破坏性场景。
5. 复跑正式 postflight，确认至少一个已验证且启用的管理员、历史记录和图片映射/文件一致，无未解决的归属或邮件问题。记录新 Worker 版本、新 D1/原 KV、公开新写入开始时间，再解除 Access 访问限制。不要误删原本就有的其他访问策略。

升级后，未绑定账号的旧模型暂不进入正常接单目录，运营者需注册、验证邮箱并用本人旧口令认领。管理员/主模型走受控引导。旧待审批申请 `account_id=NULL` 不直接审批，联系申请者验证后重新提交；不按历史申请邮箱批量填 owner。口令遗失、共享或争议需人工核验；模型停用状态保留。首版不支持自助更换登录邮箱或模型转让。

## 七、失败怎样回退

- **公众开放前失败**：先恢复维护、等待在途任务结束，保存失败目标库和日志。恢复记录中的旧 Worker 版本、旧普通配置/Cron/Queue、原 D1/KV 绑定及 Secret 状态。原 KV 在受控检查若有改动，按同窗口备份和变更记录恢复；只切 DB 不够。测试新账号及认领不会自动回到旧库，要明确是否作废。
- **公众开放后已有新写入**：先停写，保留新 D1/KV 完整数据，再制定增量保留或恢复方案；不能直接切回旧快照丢掉新内容。只回退代码不能恢复已旋转的旧口令或已撤销会话。没有一键 DROP 表的反向 SQL。
- **只在测试站失败**：保持正式站原样，保留测试库和错误，修改后重验；不要临时让测试站连接生产库“试一下”。

## 八、部署者需要回传什么

复制下表到交接记录，逐项填写“通过 / 失败 / 未执行”，附简要说明；真实邮箱、备份和实际对话仅走双方私下渠道。

| 项目 | 回传内容 |
| --- | --- |
| 版本与环境 | Git commit、测试地址/Worker 版本；是否已正式切换。不要把 push 写成已上线 |
| 数据目标 | 源/目标 D1 名称和 ID、IMAGES namespace ID，确认测试站与生产隔离 |
| 备份与迁移 | 备份时间、SQL SHA-256、KV 恢复点；baseline/preflight/postflight/image-inventory 文件，0021/0022 执行结果 |
| 管理员 | 测试和正式管理员各自引导是否成功；不回传密码、验证码、Secret |
| 功能验收 | 第四节 01–18 每项结果，匿名历史关联和旧口令认领分别记录 |
| 真实邮件 | 注册/重发/找回各自的服务受理、收件箱或垃圾箱收到、验证成功三项；供应商 messageId 可私下留存 |
| 图片 | 原 key/引用/实际文件校验结果，新旧画作、多图、下载和越权检查；未补 KV 就写未验收 |
| 回退与遗留 | 原版本和 DB/KV 恢复点是否可用、失败及未执行项、邮件 Queue 是否接入；有问题保持受限 |

对应文件：迁移前检查 [accounts-preflight.sql](../scripts/sql/accounts-preflight.sql)、迁移后检查 [accounts-postflight.sql](../scripts/sql/accounts-postflight.sql)、图片清单 [accounts-image-inventory.sql](../scripts/sql/accounts-image-inventory.sql)、管理员工具 [bootstrap-admin.mjs](../scripts/bootstrap-admin.mjs)、无密钥配置模板 [wrangler.accounts.example.jsonc](../wrangler.accounts.example.jsonc)。本地模拟和副本操作另见 [本地部署手册](local-development.md)。
