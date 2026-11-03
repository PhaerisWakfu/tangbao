# 账号迁移与小范围试用

对应 [#5](https://github.com/PhaerisWakfu/tangbao/issues/5)、邮件 [#8](https://github.com/PhaerisWakfu/tangbao/issues/8) 与旧模型迁移 [#9](https://github.com/PhaerisWakfu/tangbao/issues/9)。本地合成及真实 D1 副本的核心流程已由用户确认；真实邮件、历史 KV 图片和生产切换另行验收，进度以 Issue 为准。

## 先本地演练，不以云端登录为前置

| 环境 | 代码与数据库 | 邮件与图片 |
| --- | --- | --- |
| 现有线上站 | 保持当前版本及当前 D1 | 保持现有配置 |
| 手工旧版演练 | 冻结账号改造前代码、独立本地 D1；由用户自己申请模型和聊天 | 独立本地 KV 保存实际画作，各角色另存浏览器匿名凭证 |
| 本地合成 demo | 新版本、独立合成 D1/KV | 模拟邮件、合成图片 |
| 本地数据副本 | 新版本连接一份备份导入的本地 D1，仅对副本应用新 SQL | 模拟邮件；SQL 只有图片元数据，旧图片文件另取 KV 副本 |
| 后续私人测试站（可选） | 独立 Worker、独立云端 D1/KV、独立地址 | 经授权使用真实邮件，仅向确认的测试邮箱发送 |

本地开发、导入已有 SQL、迁移和检查不需要 Cloudflare 登录。取得云端备份、部署云端 Worker、操作云端 D1 或发送真实 Cloudflare 邮件，需要有相应账号权限的人执行；不限定必须由数据库最初创建者本人操作。本地 SQL 执行成功不代表已有云端权限。

本地 D1 是电脑上的文件，不能直接绑定给线上 Worker。若最终选择新库切换，必须在 Cloudflare 创建新 D1，导入切换时的完整最新数据，再将新版 Worker 的 DB 绑定指向该云端库。

## 没有线上备份时，先手工制造旧版数据

使用 [本地部署手册](local-development.md) 的旧版演练入口，在冻结的账号改造前版本上自行申请、审批模型，再用不同访客入口聊天、画图和上传图片。此实例不自动预置模型或对话，不应用账号 migration；数据库和图片写入独立持久目录。各角色入口使用不同主机名隔离浏览器数据，使用普通窗口并保留该浏览器；操作后点击各角色保存页，将本站的匿名对话凭证、申请标识等另存本地。

用户完成后再暂停旧版写入，备份完整 D1、图片 KV 和已保存的浏览器凭证，保留原件；新版本只迁移其副本。演练浏览器匿名历史时优先沿用原主机名和端口，不能假设换地址后 localStorage 自动出现；需要换地址时再明确导入原凭证。迁移后检查旧模型认领、匿名历史主动关联、跨设备账号历史和实际图片文件。手工演练能验证流程，但不替代最终线上结构、真实 KV 和真实发信验证。

## 部署者先提供什么

现在只需取得备份，不改任何线上表：

1. Cloudflare → Workers & Pages → 当前糖包 Worker → 设置/绑定，确认 `DB` 实际绑定哪个 D1。不能只凭仓库里的资源 ID 猜测。
2. 使用该线上部署配置导出完整 SQL，包含表结构与数据；同时查询已执行迁移清单。将两份文件交给本地开发者，不传登录密码或 API Token。
3. 本轮账号/文字副本演练可暂不导出图片 KV；请同时记录线上 Worker 的 `IMAGES` 实际绑定的 KV 名称及 namespace ID，保持原库和绑定不变。正式迁移必须验证旧图片；D1 备份不含 KV 文件，也不会自动带上浏览器里的匿名对话凭证。

在已登录且能访问该库的部署者电脑上运行下列命令。将“实际数据库名称”和“实际生产配置文件”替换为第 1 步确认的信息；先建立不进入 Git 的 `private-assets/account-copy/` 目录。

```sh
npx wrangler d1 export 实际数据库名称 --remote --config 实际生产配置文件 --output ./private-assets/account-copy/source.sql
npx wrangler d1 execute 实际数据库名称 --remote --config 实际生产配置文件 --command "SELECT name FROM d1_migrations ORDER BY name" --json > ./private-assets/account-copy/baseline.json
```

导出可能短暂阻塞数据库请求，应选无人操作的时段；它不是改表操作。[Cloudflare 导出说明](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。如果 `d1_migrations` 不存在或版本记录不可信，反馈实际情况，先核对结构，不能伪造一份“已执行”清单继续迁移。备份可能含真实对话和凭据摘要，仅放本地忽略目录，不放公开 Issue/Git。

## 在本地导入和试用

拿到 SQL 与迁移 JSON 后，使用全新实例名：

```sh
npm run local:clone -- --instance accounts-copy --port 8896 --snapshot ./private-assets/account-copy/source.sql --baseline ./private-assets/account-copy/baseline.json
npm run local:dev -- --instance accounts-copy
npm run local:info -- --instance accounts-copy
```

`local:clone` 只允许本地 D1：先将原备份复制到独立实例，再核对源迁移记录，应用尚未执行的 SQL，比较核心记录数量。报告写入实例的 `clone-report.json`，失败保留现场并拒绝覆盖已有实例。若 SQL 导出没有包含迁移表，才根据已核实的独立清单恢复迁移记录；不猜测版本。记录数相同只是基本检查，还要验证旧模型认领、历史权限和业务数据。

导入使用已锁定 Wrangler 的 SQLite 分句器，先建齐表与索引，再导入数据，最后恢复触发器，避免外键引用后建表及重放历史审计动作；原备份保持不变，重排后的 SQL 另存实例目录。只接受支持的完整 D1 导出语句，未知格式停止处理，不用分号直接拆字符串或触发器。

副本使用独立本地密钥，禁用远程数据库、真实邮件、飞书与 Web Push；复制过来的账号会话、认领证明及邮件挑战会失效，未完成的旧邮件任务取消。不要在真实数据副本运行 `local:seed`，它会引入合成账号和对话。需要测试新账号时直接通过产品页注册，从本地验证码面板取码；管理员使用受控引导脚本授予该副本中的已验证账号。

旧模型可用原口令在副本绑定新账号，写入只发生在副本。旧管理员通过受控引导迁移，不向公开认领接口开放管理员授予。匿名历史必须提供原对话凭证主动关联；换域名后原站 localStorage 不会自动带到新站，不能按 IP 或邮箱直接认领。

旧图片仅在 KV 副本也到位后才可在测试站验收；不会为补图回连生产 KV。当前未取得真实线上快照时，只能报告“合成旧库副本演练”，不能说用户真实数据已迁移。

## 图片数据必须随正式迁移保留

D1 保存图片所属消息/对话、图片 ID、`image_key` 和类型；`IMAGES` KV 保存图片二进制。新代码通过 `message_images → messages → threads` 检查归属，再按原 `image_key` 读取 KV。旧的 `messages.image_key` 也需纳入历史清单，不能只按当前 `img/` 前缀猜测存量范围。现有账号迁移 0021/0022、模型认领与匿名历史关联均不重写图片 ID、`image_key` 或 KV 文件。

两条正式迁移路径分别处理：

- **继续使用原图片 KV（同账号部署时优先）**：目标正式 Worker 的 `IMAGES` 保持绑定已核实的原 namespace，D1 的图片引用保持不变；账号升级无需为了迁移而重命名或搬走原图。切换前仍需做独立备份及完整性检查，原 KV 不清空、不重建。
- **更换 KV / Cloudflare 账号**：先将图片按原 key、原始二进制复制到新 namespace，并保留必要元数据及已有过期设置。key 清单不包含图片内容，需读取实际值；枚举时按游标取完所有分页。逐项核对 key、字节长度和 SHA-256，确认完成后才切 `IMAGES` 绑定。[KV 枚举](https://developers.cloudflare.com/kv/api/list-keys/)、[二进制读取](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)。

测试副本始终使用独立 KV。当前删除对话流程会调用已绑定 KV 的删除操作，因此不能把测试站接到生产 KV 来省略复制；正式切换时也不能让新旧站继续同时写同一套图片数据。原 D1/KV 的备份和恢复点须对应同一暂停写入窗口，含测试期间之后新产生的图片。

上线前图片验收为必需项，不能因为账号和文字历史通过就跳过：

1. 从完整数据库列出当前及旧字段引用的全部图片 key，保留图片与消息/对话的映射；核对图片记录数、去重 key 数及原文件。源端已有缺图也单独列出，不删引用来掩盖问题。
2. 复用原 KV 时确认目标绑定与原 namespace 一致，并核验引用对应文件存在、可读；更换 KV 时另做源/目标二进制长度和 SHA-256 对照。保留校验清单和结果。
3. 验证旧画作/上传图片、多图顺序、图片类型及下载；验证账号关联、旧模型绑定及跨设备登录后仍可查看，并确认其他账号不能越权读取。
4. 任何遗漏、内容不一致或图片访问失败未查清前暂停正式切换。新站开放写入后，恢复方案必须同时涵盖新增 D1 记录与新增 KV 文件；不能只回退数据库。

真实 KV 尚未核查或复制时，记录为“图片未验收”，不声称全部历史内容已完成迁移。本轮只固定上述要求，不操作线上 KV，也不要求部署者立即全量导出图片。

## 真实邮件和最终切换

本地邮件替身通过不代表真实邮箱收到。真实 Cloudflare 发信仍需要获授权的 Worker 邮件绑定或 Email Sending API 凭据，可由部署者执行，不要求用户本人先登录。发信域 `mail.phaeris.cn`、发件人 `noreply@mail.phaeris.cn`、每日 200 封且不设月度限制保持原决定。测试收件邮箱另存本地私有记录，不写入公开配置。

真实邮件先仅发送少量验证/找回邮件到已确认收件人，分别检查服务受理、收件箱/垃圾箱和验证成功；普通登录保持零邮件。真实退信/送达 Queue 需要部署者配置订阅并单独验证。公开注册前再开放正常收件范围。

用户确认副本和真实邮件后，再选择短维护窗口发布：

1. 暂停旧站写入，记录正在使用的 Worker 版本、DB/KV 绑定和备份恢复点。
2. 取得最后一份完整数据，演练过的迁移应用到目标库；若使用新库切换，复制对应 KV，核对关键记录/归属后让新代码绑定新库。
3. 检查登录、管理员、旧模型认领、历史和邮件后恢复访问。测试期间写进副本的假数据不回灌正式库，测试注册也不默认变为正式账号。
4. 新站开放写入后，回滚需处理这些新写入，不能直接切回旧快照。代码回退也不能恢复已撤销的凭据。切换失败且尚未开放新写入时，才按事先记录的旧代码与旧绑定恢复。

这次先采用完整副本演练和短维护窗口，不对当前共享库做随机流量灰度。长期零停机切换需要另做兼容结构、增量数据同步与回滚设计；只有一个使用者时没有必要先引入这些机制。

## 代码先提交，部署者随后联调

提交代码、合并 PR、部署 Worker、执行远程 SQL 是四件事。此版本不会随 Git 提交自动运行迁移。仓库 CI 只检查类型和客户端语法；部署者还要去 Cloudflare 当前 Worker 的 Builds/构建设置核对是否连接 Git 自动部署，准备好数据和配置前不要让默认分支提交直接覆盖生产 Worker。

这一版已提供以下发布材料，不需要另写一份没有版本记录的建表 SQL：

| 文件 | 作用 |
| --- | --- |
| `migrations/0021_accounts.sql` | 账号、会话、稳定模型身份与归属、匿名额度、邮件挑战/outbox 等结构 |
| `migrations/0022_account_admin_audit.sql` | 管理员授予/撤销、账号状态审计及会话撤销触发器 |
| `scripts/sql/accounts-preflight.sql` | 迁移前只读记录版本、核心行数和异常引用，不输出密码值 |
| `scripts/sql/accounts-postflight.sql` | 迁移后只读核对版本、核心行数、UID/owner/角色/外键及管理员准备情况 |
| `scripts/sql/accounts-image-inventory.sql` | 只读导出当前和旧字段图片引用，用于与 KV 文件对照 |
| `scripts/bootstrap-admin.mjs` | 指定一个已验证账号，先预览 SQL，再受控授予首个管理员 |
| `wrangler.accounts.example.jsonc` | 不含密钥的发布配置模板；默认开启维护，所有资源占位值须替换 |

不提供一键 DROP 表的反向 SQL：认领会旋转旧口令，改密、找回和权限变更会撤销会话，删表或仅回退代码不能恢复这些状态。回退使用下文的旧版本、旧库绑定和配套 KV 恢复点。

## 部署者准备哪些信息，放在哪里

先确认实际账号和资源。当前已知生产域名 `tangbao.phaeris.cn`、D1 名称 `tangbao261102`、`IMAGES` 对应 KV 名称 `tangbao`；资源 ID 仍以 Cloudflare 当前 Worker → 设置 → 绑定的实际值为准。

| 项目 | 到哪里确认 / 如何保存 |
| --- | --- |
| Cloudflare 账号、Worker 名称、生产网址 | 当前 Worker 的概览及域名/路由；Account ID 从账号概览复制，填写发布配置的 `account_id`，它不是密钥 |
| `DB` 的 D1 名称/ID、`IMAGES` 的 KV 名称/ID | Worker → 设置 → 绑定；记录原值，作为核对和回退依据 |
| `EMAIL` 邮件绑定 | Worker 原生 `send_email`，发件地址限制为 `noreply@mail.phaeris.cn`；域名须已启用发信及完成 DNS 配置 |
| 普通配置 | 写入本机忽略的 `wrangler.production.jsonc`：`APP_ORIGIN`（精确 HTTPS origin）、`MAIL_MODE=cloudflare`、`MAIL_FROM`、`MAIL_DAILY_LIMIT=200`、`MAINTENANCE` 及绑定/路由 |
| `ADMIN_SECRET` | 原生产密钥保留，核对存在即可，不输出值；它影响旧工作台 cookie 识别及请求重放凭据 |
| `ADMIN_PASSWORD` | 旧管理员兼容凭据，保留原有配置；它不会自动变成新管理员的邮箱账号密码 |
| 新密钥 `EMAIL_CODE_PEPPER`、`MAIL_PAYLOAD_KEY` | 各用独立随机值，至少 32 字符，通过 Worker 的 Secrets 保存；不要写进 Git、普通 vars、日志或截图，不要每次部署重新生成 |
| 旧飞书/Web Push 配置 | 正式环境保留原有密钥；独立试运行站不复制这些生产通知密钥，避免向存量订阅发送测试通知 |
| Turso 配置 | 本次目标是 D1，确认 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 没有同时生效；两项都有值时代码会优先选择 Turso |
| 邮件投递事件（可后续独立开通） | 先创建 Queue 和 Email Sending 事件订阅，再配 `queues.consumers`、`MAIL_EVENTS_QUEUE` 和发信 Account ID；未配置时不声称退信/送达回调已验收 |

**当前实现用 `env.EMAIL.send()`，线上运行时不需要发信 API Key，也没有读取 `CLOUDFLARE_API_TOKEN` 的业务代码。** 部署者用自己的 Wrangler 登录即可部署和测试；如果用 CI，部署 Token 放 CI Secrets。只有本地/外部程序改走 Email Sending REST API 时，才需要发信 Token 和 Account ID，目前没有启用该 REST 适配器。不要把取得 Token 当作本版原生 Worker 发信的必经步骤。[原生邮件 API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)、[邮件绑定限制](https://developers.cloudflare.com/email-service/configuration/send-bindings/)。

Secrets 可在 Cloudflare → Workers & Pages → 目标 Worker → 设置 → 变量和密钥中设置，也可在已核对的目标配置上交互输入：

以下代码块使用 Bash/Git Bash，需 Node.js 22+、项目已执行 `npm ci` 且 Wrangler 账号有对应资源权限。Windows 可在项目目录使用 Git Bash；旧 Windows PowerShell 的默认重定向可能生成 UTF-16 文件，不用于这里的 JSON 备份。SQL/JSON 输入统一保存为 UTF-8 无 BOM。

```sh
cp wrangler.accounts.example.jsonc wrangler.production.jsonc
# 先编辑：Worker/域名、DB/KV ID、APP_ORIGIN，以及当前阶段的维护状态。
npx wrangler secret put EMAIL_CODE_PEPPER --config wrangler.production.jsonc
npx wrangler secret put MAIL_PAYLOAD_KEY --config wrangler.production.jsonc
```

命令会提示输入，不要把值拼在命令行或粘贴进公开 PR。每个新值可用本机 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 单独生成，妥善存入该环境的密钥管理记录。新建试运行 Worker 的 `ADMIN_SECRET` 使用独立随机值；正式 Worker 继续使用原值。本地 `.dev.vars` 不会自动成为云端配置，且不进入 Git。[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

只有全新独立 Worker 才需另行执行 `npx wrangler secret put ADMIN_SECRET --config wrangler.production.jsonc`；现有正式 Worker 升级时不重新生成该值。

## 先在独立试运行站测试真实邮件

1. 使用独立 Worker、D1 和 KV，配置自己的 HTTPS 地址。通过 Cloudflare Access 限定仅部署者和验收者访问整个测试域名，关闭未受保护的 `workers.dev` / Preview URLs 旁路。试运行时 `MAINTENANCE=0`，才能正常注册和验证；维护开启时不能注册首个管理员。
2. 导入备份到这份独立 D1，核对原迁移记录后执行 0021/0022。配置 `EMAIL`、新邮件 Secrets 和上述普通变量。测试 Worker 无需复制生产通知密钥，也不能连接原图片 KV。KV 未复制时仍只验账号/文字及真实邮件，图片标记未验收。
3. 用双方约定的真实测试邮箱注册，从实际收件箱/垃圾箱取验证码完成验证；再测重发、找回和密码重登。记录供应商受理、实际收到、验证码生效三个结果。普通登录不应新增邮件；少量测试即可，不循环消耗每日预算。
4. 使用测试站的已验证专用账号演练管理员引导。正式站开放前还要对正式目标库重新引导，不把测试站账号、会话和测试数据回灌正式库。

## 正式切换操作顺序

下列远程命令只由获授权的部署者在约定窗口执行。推荐最终使用**新 D1 接收停写后的最新完整数据**，原库留作回退，图片优先继续使用原 KV。先在独立站完成真实邮件及图片准备，再进入维护窗口。

1. **记录回退点并停止旧业务。** 保存当前 Worker 版本、全部入口/路由、DB/KV 绑定、Cron/Queue 和密钥名称。用本版代码与原绑定、`MAINTENANCE=1` 部署为停写版本；该守卫位于数据库初始化前，API/Worker 页面返回 503，Cron 不处理，Queue 延后重试。静态资源可能继续可读，但不产生业务写入。此能力不自动作用于旧部署/其他 Worker；封住仍能写同库的旧直连入口，暂停相关旧消费者，等待在途请求完成后再取备份。不要只在旧版本上加一个未实现完整停写的变量就宣称冻结。
2. **取最后一份 D1/KV 恢复点。** 运行迁移前只读检查，保存 SQL、迁移记录和图片引用清单；确认原 KV 文件已备份/核验。此时的备份替代早期演练快照，期间新增内容必须包含在内。

```sh
# 此刻配置 DB 必须还是已冻结的源库，所有输出写入私有目录。
mkdir -p private-assets/account-copy
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file scripts/sql/accounts-preflight.sql --json > private-assets/account-copy/preflight.json
npx wrangler d1 export DB --remote --config wrangler.production.jsonc --output private-assets/account-copy/final-source.sql
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --command "SELECT name FROM d1_migrations ORDER BY name" --json > private-assets/account-copy/final-migrations.json
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file scripts/sql/accounts-image-inventory.sql --json > private-assets/account-copy/image-inventory.json
```

3. **迁移新目标库。** 先执行 `npx wrangler d1 create tangbao-accounts-v1 --config wrangler.production.jsonc`（名称已存在则换一个新名称），把返回的 `database_name` / `database_id` 写入配置文件的 `DB`；此时尚未重新部署，线上停写 Worker 仍绑定原库。导入最后备份，核对迁移记录为真实的连续 0001–0020，再使用 migrations apply 只补 0021/0022。若版本不符或格式报错，保留现场先核对，不猜版本、不重放旧 SQL。

```sh
# 这里开始，配置 DB 必须是新建的空目标库，不能还是源库。
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file private-assets/account-copy/final-source.sql
npx wrangler d1 migrations list DB --remote --config wrangler.production.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file scripts/sql/accounts-postflight.sql --json > private-assets/account-copy/postflight.json
```

使用已核对配置的 `DB` binding；若使用 package 的 `migrate:remote`，仍要显式追加 `-- --config wrangler.production.jsonc`。不要单独 execute 两份 migration 后遗漏 `d1_migrations` 记录。[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)。此流程已在本地真实备份副本演练，云端导入和迁移仍需部署者实际检查。

4. **限制访问，再让新站进入受控检查。** Cloudflare Access 仅放行部署者/验收者，覆盖正式域名并关闭旁路入口；确认无公众流量后，把配置设为新 D1、已核实的原 `IMAGES` KV、正式 `EMAIL`/Secrets、精确正式 `APP_ORIGIN`，再以 `MAINTENANCE=0` 部署。这里是正式目标环境的受控烟测，原站已停止写入，不是把仍在线的生产 KV 接给普通测试副本。不要在这一步删除旧对话或旧图。
5. **引导首个正式管理员。** 在受限的正式网址注册、真实邮箱验证管理员账号；到该目标 D1 的 `accounts` 表按邮箱筛选并复制账号 `id`。运行以下脚本先看 SQL、核对配置指向新目标库，再执行。0022 的审计触发器会撤销旧会话，之后用该邮箱和密码重新登录。

```sh
node scripts/bootstrap-admin.mjs --account-id 替换为已验证账号ID --config wrangler.production.jsonc --remote
node scripts/bootstrap-admin.mjs --account-id 替换为已验证账号ID --config wrangler.production.jsonc --remote --execute
```

脚本不接受 `--env`；本手册使用完整独立配置，不能把目标环境藏在未生效的 env 子项里。已有管理员时普通首次引导会拒绝，只有明确的管理员恢复操作才使用 `--recovery`。管理员角色直接获得主模型工作台权限，不用把主模型作为普通旧模型公开认领；旧管理员口令不能替代此引导。

6. **烟测通过后开放。** 执行下表验收，复跑 postflight，确认至少一个已验证且启用的管理员、历史行数/图片映射及实际文件一致，再移除临时 Access 访问限制恢复公众使用。新配置的一分钟 Cron 负责已知邮件限流失败补偿；若开启回执 Queue，另验订阅和消费者。公开新写入开始的时间、Worker 版本和目标 DB/KV 必须记录。

新版本下，未绑定账号的旧模型暂不进入正常接单目录，旧运营者需完成注册、邮箱验证和原口令认领；历史仍保留，管理员可审计。不要按历史申请邮箱批量填 owner。旧待审批申请 `account_id=NULL` 不能直接作为已验证新申请审批，应联系申请者验证后重新提交；口令遗失、停用、共享口令或争议进入人工核验。首版没有自助更换登录邮箱或模型转让功能。

## 部署者要验哪些场景

| 场景 | 通过标准 |
| --- | --- |
| 真邮箱注册/重发/找回 | 实际收件箱或垃圾箱收到，发件域正确；错误码拒绝，重发旧码失效，正确码只消费一次；验证码用于对应目的 |
| 普通登录、改密、退出 | 登录不发邮件；刷新/重开保持登录；改密/找回后旧会话失效；退出清当前站点客户端数据，同源标签同步，另一设备会话按既定规则保留，下一次需密码 |
| 匿名与草稿 | 首段可继续，第二段发送要求验证账号，取消/失败保留正文及附件，成功不重复发送；删除不恢复额度 |
| 历史与跨设备 | 账号历史跨设备可见；旧匿名历史只有持原 token 主动关联才可归属；其他账号不能读取 |
| 模型与权限 | 正常申请/审批、每账号一个模型、旧口令核验后确认绑定；原型号/状态/队列保留，旧口令失效；停用不自动恢复，普通用户无管理权限 |
| 管理员 | 正式已验证账号经脚本受控授予，密码重登可进入主模型、申请、审计；公开注册和普通认领不能授予 admin |
| 实际图片（正式开放必需） | 新旧图片 key/消息归属及 KV 文件对应，原图、多图顺序、画作和下载可用；越权拒绝；不靠删引用掩盖缺图 |
| HTTPS/发布隔离 | 正式 origin 正确，账号 cookie 为 HttpOnly/Secure/SameSite，跨站写请求拒绝；生产没有本地验证码面板、fixture 或演练口令；旁路入口不会绕开受控检查 |
| 邮件运行状态 | 日预算 200、无月度限制；明确限流才有界重试，unknown 不盲目重发；若配置回执，验真实 delivered/bounce 事件及去重，否则记录回执未验收 |

完整失败边界（过期 10 分钟、错误 5 次、并发/幂等、日预算、跨账号及网络失败）优先在独立试运行站验证，不用真实生产用户做破坏性测试。正式烟测只使用双方约定的少量账号/邮箱，不删除原有历史。缺图、真实邮件未收到、归属错误或异常行数未解决时，保持访问受限，不开放公众流量。

## 回退和反馈

公众开放前若受控检查失败：重新进入维护、等待在途任务结束，保留失败目标库和日志；根据记录恢复旧 Worker 版本和原 D1/KV 绑定。原 KV 若在受控检查产生变更，须按配套备份/变更清单恢复，不能只切 DB。受控检查产生的账号和测试写入不会自动回到旧库，应明确记录是否作废。

公众开放后已有新写入时，不直接切回旧快照：先停写，保留新 D1/KV 完整数据，再决定增量保留或恢复方案；仅回退代码不能复原已旋转口令和撤销会话。

部署者回传：代码 commit/Worker 版本、实际目标 DB/KV 名称及 ID、备份时间与恢复点、迁移前后检查结果、管理员引导是否成功、上表逐项结果、真实邮件的服务受理/收件/验证结果及图片核验结果。API Token、密钥、密码、验证码、完整对话不放公开 PR/Issue。真实邮件、图片、Cloudflare 停写/切换没有实际执行前，记录为未验收，不以本地通过替代。
