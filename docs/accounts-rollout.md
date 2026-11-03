# 账号迁移与小范围试用

对应 [#5](https://github.com/PhaerisWakfu/tangbao/issues/5)、邮件 [#8](https://github.com/PhaerisWakfu/tangbao/issues/8) 与旧模型迁移 [#9](https://github.com/PhaerisWakfu/tangbao/issues/9)。用户已验收首轮本地合成 demo；此处描述后续演练和发布路径，实际执行状态以 Issue 为准。

## 先本地演练，不以云端登录为前置

| 环境 | 代码与数据库 | 邮件与图片 |
| --- | --- | --- |
| 现有线上站 | 保持当前版本及当前 D1 | 保持现有配置 |
| 本地合成 demo | 新版本、独立合成 D1/KV | 模拟邮件、合成图片 |
| 本地数据副本 | 新版本连接一份备份导入的本地 D1，仅对副本应用新 SQL | 模拟邮件；SQL 只有图片元数据，旧图片文件另取 KV 副本 |
| 后续私人测试站（可选） | 独立 Worker、独立云端 D1/KV、独立地址 | 经授权使用真实邮件，仅向确认的测试邮箱发送 |

本地开发、导入已有 SQL、迁移和检查不需要 Cloudflare 登录。取得云端备份、部署云端 Worker、操作云端 D1 或发送真实 Cloudflare 邮件，需要有相应账号权限的人执行；不限定必须由数据库最初创建者本人操作。当前电脑未配置有效 Wrangler 登录，不能把本地 SQL 执行成功说成已能操作线上。

本地 D1 是电脑上的文件，不能直接绑定给线上 Worker。若最终选择新库切换，必须在 Cloudflare 创建新 D1，导入切换时的完整最新数据，再将新版 Worker 的 DB 绑定指向该云端库。

## 部署者先提供什么

现在只需取得备份，不改任何线上表：

1. Cloudflare → Workers & Pages → 当前糖包 Worker → 设置/绑定，确认 `DB` 实际绑定哪个 D1。不能只凭仓库里的资源 ID 猜测。
2. 使用该线上部署配置导出完整 SQL，包含表结构与数据；同时查询已执行迁移清单。将两份文件交给本地开发者，不传登录密码或 API Token。
3. 若希望验旧图片，再单独复制对应 KV 图片。D1 备份不含 KV 文件，也不会自动带上浏览器里的匿名对话凭证。

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

旧图片仅在 KV 副本也到位后才可验收；不会为补图回连生产 KV。当前未取得真实线上快照时，只能报告“合成旧库副本演练”，不能说用户真实数据已迁移。

## 真实邮件和最终切换

本地邮件替身通过不代表真实邮箱收到。真实 Cloudflare 发信仍需要获授权的 Worker 邮件绑定或 Email Sending API 凭据，可由部署者执行，不要求用户本人先登录。发信域 `mail.phaeris.cn`、发件人 `noreply@mail.phaeris.cn`、每日 200 封且不设月度限制保持原决定。测试收件邮箱另存本地私有记录，不写入公开配置。

真实邮件先仅发送少量验证/找回邮件到已确认收件人，分别检查服务受理、收件箱/垃圾箱和验证成功；普通登录保持零邮件。真实退信/送达 Queue 需要部署者配置订阅并单独验证。公开注册前再开放正常收件范围。

用户确认副本和真实邮件后，再选择短维护窗口发布：

1. 暂停旧站写入，记录正在使用的 Worker 版本、DB/KV 绑定和备份恢复点。
2. 取得最后一份完整数据，演练过的迁移应用到目标库；若使用新库切换，复制对应 KV，核对关键记录/归属后让新代码绑定新库。
3. 检查登录、管理员、旧模型认领、历史和邮件后恢复访问。测试期间写进副本的假数据不回灌正式库，测试注册也不默认变为正式账号。
4. 新站开放写入后，回滚需处理这些新写入，不能直接切回旧快照。代码回退也不能恢复已撤销的凭据。切换失败且尚未开放新写入时，才按事先记录的旧代码与旧绑定恢复。

这次先采用完整副本演练和短维护窗口，不对当前共享库做随机流量灰度。长期零停机切换需要另做兼容结构、增量数据同步与回滚设计；只有一个使用者时没有必要先引入这些机制。
