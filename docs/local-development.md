# 本地部署与多身份验证

隔离运行工具由 [#16](https://github.com/PhaerisWakfu/tangbao/issues/16) 建立，账号场景由 [#5](https://github.com/PhaerisWakfu/tangbao/issues/5) 扩展。运行结果以每次报告为准；账号代码、本地邮件替身通过、真实邮件送达和生产部署分别记录。

## 分支、实例与数据

Epic 的子项复用父 Epic 的 `feat/epic-*` 分支；普通缺陷使用 `fix/*`，线上紧急修复使用 `hotfix/*`，规则见 [Issue 工作流程](issue-workflow.md)。验收记录注明分支、提交、dirty 状态、instance 和结果。

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

`npm run check` 覆盖 app、desk、account、md、sw 五个客户端入口，以及 `src/pages/*.html` 内联 JavaScript；外链不执行，JSON 等数据脚本不作为 JavaScript 解析。语法检查不替代浏览器、权限、数据库或邮件验证。旧 smoke/browser 脚本不在本回归流程内。

可独立执行本地定向检查：

```sh
node --test scripts/migrations.test.mjs
```

迁移测试在本地 libSQL 从零执行当前全部 SQL，并用合成旧封禁数据验证 `0019` 的归属规则。这些本地结果不代表真实 Turso 或生产迁移验收。

`0019_block_scope.sql` 的兼容修复只将关联排序所需的封禁时间改为子查询内可见的值，不改“距离封禁时间最近、同距离取较新对话”的规则或表结构。已应用该版本的 D1 不需要重新运行 `0019`；通过迁移清单正常接续即可，不在现有库手工重放建表/改名语句。

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

## 从账号改造前原版手工造数据

需要亲自建立旧模型、匿名对话及画作，再测试账号迁移时，使用独立原版入口：

```sh
npm run local:legacy:prepare -- --instance manual-legacy --port 8900 --inspector-port 8901
npm run local:legacy:dev -- --instance manual-legacy
# 另一个终端查看引导页和角色地址
npm run local:legacy:info -- --instance manual-legacy
```

工具通过 `git archive` 固定检出账号改造前的 `633893951f5249673a07353b37b05685af841a45`，放入忽略目录 `.tmp/local-legacy/<instance>/source/`；它不是新 Git worktree，不切换当前分支，也不改原 checkout。仓库需包含该历史提交，浅克隆先补齐 Git 历史。`node_modules` 链接当前已安装依赖，因此仍需先 `npm ci`。启动前核对冻结源文件摘要，防止当前 Epic 继续开发时带入新业务源码。

新实例仅复用冻结原版的本地 prepare，严格应用前 20 份迁移，没有 accounts 表，也不运行 seed。模型、申请、对话、消息和图片元数据均为空，只有随机本地管理员口令。旧首页、申请、聊天、工作台及业务逻辑保持原样。外层本地 wrapper 只提供回环地址限制、独立引导页及浏览器数据保存入口；远程数据库、邮件、飞书和推送关闭。原版 prepare 的随机凭据换行格式仅在新生成的本地文件中规范化，不修改冻结源码。

`local:legacy:info` 给出含实例 nonce 的引导链接，管理员口令在引导页内。每个角色使用自己的 `.localhost` 地址，以隔离 cookie/localStorage。至少使用申请者 A、管理员、运营者 A、访客 A/B；申请者 B、运营者 B 可用于第二个模型。不要改用统一的 `127.0.0.1` 页面操作所有角色。

手工步骤：

1. 进入申请者页面，点击“我知道了”，填写型号、邮箱和模型说明并提交；邮箱可用 `name@example.test`，旧版不会发送验证邮件。
2. 管理员在自己的 `/desk` 用引导页口令“掀开笼屉”，进入“申请”页审批。然后回到原来那个申请者地址，刷新首页，点击“申请成为AI”；进度弹层会显示旧版发放的口令，手动复制给对应运营者。
3. 运营者在自己的 `/desk` 用这份口令登录，保持工作台打开，确认“在线”。访客从各自 `/chat` 选择对应型号再发消息；无人在线时 Auto 会先进入消息池。原版每个 IP 每小时最多创建 8 段对话，多个本地角色仍共享本机网络，不通过改业务规则绕过。
4. 在工作台左侧选中一段对话。回复框左下角“＋”→“画一张”，画完点“放进回复”，再点发送箭头“写下”；已有画作使用“＋”→“添加图片”，或粘贴图片，添加后也要发送。访客聊天框的“＋”同样支持图片上传。
5. 完成后，从引导页分别打开各角色的“保存浏览器数据”，点击保存按钮。这一步读取该角色同源的 `tangbao.v1`、`tangbao.visitor`、`tangbao.apply`、`tangbao.model`、`tangbao.presence` 五个键，保留匿名历史 token、访客及申请标识和偏好；不读取 HttpOnly cookie，不枚举其他 localStorage 键，不清理浏览器数据。

浏览器保存值写入本地 `settings` 的固定 `local_legacy_browser:<role>` 键，服务端同时检查实例 nonce、同源 Origin、角色主机名及键白名单。匿名身份和旧工作台 cookie 仍留在浏览器；后续迁移尽量沿用同一角色主机名、端口和浏览器配置，不能仅靠 SQL 备份恢复浏览器登录态。

持久数据位于 `.tmp/local-legacy/<instance>/source/.tmp/local-sandboxes/<instance>/state/`，包含 D1 和本地 KV。重复 prepare 只核对既有实例并展示地址，不重跑迁移、生成身份或清数据。不要用当前版本的 `local:prepare` 指向这套旧数据。

准备迁移时，先在运行原版的终端停止对应 `local:legacy:dev`，再备份：

```sh
npm run local:legacy:backup -- --instance manual-legacy
```

备份拒绝正在运行的实例，不自动停服。结果写入 `.tmp/local-legacy/<instance>/backups/<时间>-<随机值>/`，保留 SQL、实际已执行迁移清单、完整 D1/KV state、各角色主动保存的浏览器数据，以及仅本地使用的凭据和地址信息；原实例保持原样。`backup.json` 记录状态、行数和 SQL 摘要，`state-manifest.json` 记录完整 state 文件摘要。失败备份不覆盖，保留后重新操作。

这些文件含本地演练对话、token 和口令，全部位于忽略目录，不提交或公开。SQL 本身不包含 KV 图片二进制，不能把导出 SQL 当成画作备份；这里的完整 state 副本才同时保留 D1/KV。工具只准备和备份旧版，不自动执行账号迁移；切换到新版、KV 恢复及实际迁移结果另行记录。

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

## 用已有 D1 备份建立本地副本

本地导入不需要登录 Cloudflare。使用完整结构及数据 SQL、真实已执行迁移 JSON 和全新实例名；取得云端备份的命令见 [部署交接手册](accounts-rollout.md#二导入测试副本执行新增迁移)。

```sh
npm run local:clone -- --instance accounts-copy --port 8896 --snapshot ./private-assets/account-copy/source.sql --baseline ./private-assets/account-copy/baseline.json
npm run local:dev -- --instance accounts-copy
npm run local:info -- --instance accounts-copy
```

`local:clone` 保留原 SQL，在全新本地 D1 中导入、核对迁移记录，再补尚未执行的 SQL；不猜版本、不覆盖已有实例。报告在实例的 `clone-report.json`。失败保留现场并禁止启动，重试使用新实例名。导入用锁定 Wrangler 的 SQLite 分句器，先建齐表/索引，再导入数据，最后恢复触发器；未知格式停止，不按分号拆字符串或重放历史审计动作。

副本使用独立密钥，撤销复制的账号会话、认领证明及邮件挑战，清除旧 outbox 密文、取消待发任务；远程 D1/KV、真实邮件、飞书和 Web Push 均关闭。不要在真实数据副本运行 `local:seed`；新账号直接从产品页注册，验证码从本地面板查看。旧模型用本人原口令认领；旧匿名历史仍需原浏览器 token，不能按 IP 或历史申请邮箱分配。

SQL 只有图片引用，KV 文件需要独立副本；不为补图回连生产 KV，缺文件时明确标记图片未验收。本地 D1 文件不能直接绑定给云端 Worker，最终部署另建云端 D1 并使用停写后的最新数据。副本演练通过不能当作真实邮箱、真实 KV 或云端迁移已通过。

## 上线与回退

云端原生邮件、独立试运行、Secret 配置、管理员引导、D1/KV 迁移和回退统一按 [部署交接手册](accounts-rollout.md) 执行。本地回归工具保持模拟邮件，不再提供本机 Token/Account ID 远程发信路径。

管理员引导复用 `scripts/bootstrap-admin.mjs`。先通过产品页注册并验证账号，取得目标账号 ID，再明确指定配置和本地/远程目标。脚本默认只生成可审阅 SQL，不执行；例如本地预览：

```sh
node scripts/bootstrap-admin.mjs \
  --account-id 'ACCOUNT_ID' \
  --config .tmp/local-sandboxes/epic-5-demo/wrangler.json \
  --local --persist-to .tmp/local-sandboxes/epic-5-demo/state
```

将 `ACCOUNT_ID` 换成已验证合成账号的实际 ID。核对 SQL 和目标后，添加 `--execute` 才会执行。默认首管理员模式要求当前没有管理员；`--recovery` 仅用于部署者确认过的受控恢复。审计 migration 记录管理员授予/撤销及账号状态变化。远程使用 `--remote` 且不得附带本地持久化目录，由有权限的部署者单独核对并执行。

远程数据库迁移、管理员受控引导、部署及真实数据操作由有权限的部署者明确执行。先核对目标数据库、迁移版本和恢复点，再部署相匹配的代码；普通本地回归不操作线上。已认领模型和已撤销凭据不能靠回退代码自动恢复，需使用事先演练的恢复流程。
