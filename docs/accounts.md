# 账号、匿名体验、旧模型与邮件

本规范对应 [账号 Epic #5](https://github.com/PhaerisWakfu/tangbao/issues/5) 及原生子项 #6–#9。代码、本地回归、真实邮件送达、生产迁移和用户验收分别记录在 Issue，不将本文视为上线证明。

## 已确认的产品规则

- 普通访客可匿名体验一段对话，同段可继续发送；新建第二段前需要注册并验证邮箱。删除对话不恢复匿名创建额度。
- 日常使用邮箱和密码登录；验证码用于验证邮箱和找回密码，普通登录不发送邮件。
- 未验证账号只能完成验证/找回流程，仍可凭原匿名凭证继续首段；验证后才能新建账号对话和申请成为 AI。
- 首版每个账号最多经营一个模型。账号身份、稳定模型身份、显示型号分别管理；修改型号不改变所有权。
- 账号新建对话支持跨设备历史。旧匿名历史由用户主动选择关联，并验证原对话凭证；不根据 IP、visitor ID 或历史申请邮箱自动认领。
- 登录默认长期保持，使用约 400 天的持久 cookie，并在活跃使用时续期。退出撤销当前会话、清理本站 cookie 和客户端缓存，下一次需要密码登录；设置不提供切换账号功能。
- 模型停用影响该模型接单和回复，账号停用影响账号所有会话；两项操作分开。
- 发信按顺序使用 Brevo 与 Cloudflare：每天先用 Brevo 280 封，用尽后切 Cloudflare 920 封（对应其每月 3,000 封免费额度，超出按 $0.35/1,000 封计费），应用侧每日总预算 1,200 封。用到当日预算 90% 时按 UTC 日期去重，推送一次飞书提醒（未配置 `FEISHU_WEBHOOK` 时只写日志）。单家额度错误时打开该家 5 分钟熔断并切换另一家，两家都不可用时提示额度已满，下一个 UTC 日恢复。不另设应用侧月度限制，实际计费以控制台为准。

邮箱验证只证明对邮箱的控制权，不代表实名或内容安全保证。糖包的模型仍由人回复。

## 身份与权限

| 身份 | 可执行范围 |
| --- | --- |
| 匿名访客 | 创建第一段，凭原 token 继续读取和发送 |
| 未验证账号 | 账号验证、找回；原匿名首段仍按原凭证访问 |
| 已验证普通账号 | 新建账号对话、跨设备查看本人历史、主动关联匿名历史、申请模型 |
| 模型运营者 | 普通账号能力及本人模型的队列、资料（型号、简介、开场问题）和回复 |
| 管理员 | 显式授予的管理、审批、审计能力；公开注册不授予 |

账号 cookie 为不透明随机 session，服务端只保存摘要并核对账号状态、会话版本、有效期和撤销记录。HttpOnly 防止客户端脚本读取会话值，生产使用 Secure/SameSite；写请求还检查同源 Origin。角色和资源所有权均由服务端判断，不相信客户端按钮、URL 或 localStorage。

密码使用有算法、参数、版本和随机 salt 的自适应 KDF，不沿用旧运营者口令的快速摘要。新设置密码为 6–20 个字符，至少包含数字、英文字母、特殊符号中的两类；按 Unicode 代码点计数，不 trim、不静默截断，允许密码管理器。空格与汉字不计入这三类，特殊符号按 Unicode 标点/符号判定。登录及修改密码时的“当前密码”仍接受既有 1–128 字符凭据，不追溯强制重置旧长密码；昂贵计算前执行原子限流。具体实现和本地 workerd 基准记录随 #6 交付。

当前使用 scrypt（N=32768、r=8、p=3），每条密码独立 32 字节 salt、32 字节派生值，保存带版本和参数的编码。同一 Worker isolate 串行派生，避免并发占满内存；参数变更应重新核对目标 Workers 的 CPU 和内存限制。本地耗时不等于生产性能证明。

## 匿名额度与历史

服务端匿名 cookie 对应 `guest_identities`，不把可自填的 `x-visitor` 当作额度凭证。客户端先进入页面取得身份，再创建首段。额度消耗、创建请求幂等记录和对话写入在同一事务中处理；同一身份并发创建最多成功一次，同一个幂等键重试返回原结果，内容不同则拒绝。

第二段被拦截时在聊天原页打开账号弹层，保留正文、File 附件、模型和画图状态；取消或失败恢复草稿，完成验证后只恢复一次原动作。附件不靠已经失效的 object URL 跨页保存。切换对话或异步回包不得把请求结果写进另一个当前对话。

既有匿名多段历史继续凭原 token 访问；新建按新规则执行。登录后的主动关联同时验证当前账号与原 token，关联后旧 token 不能继续访问该账号对话。账号历史在服务端按账号查询，其他账号及退出后的客户端不得继承它。图片访问也必须验证对话权限，匿名图片使用有时效的签名 URL。

清 cookie、隐私模式或换浏览器会产生新匿名身份，不能承诺严格“一人一次”。IP/行为限流用于抑制滥用，不把共享网络的人视作同一账号。

无痕窗口不能作为可靠的永久设备身份。Chrome 在所有无痕窗口关闭后会清除该会话的 cookie 和站点数据；普通网页没有可静默读取、跨浏览器且不可重置的物理设备编号。浏览器指纹仅能作风险信号，浏览器也会限制可用于指纹识别的信息，不能据此执行严格“每台设备终身一次”的额度。

Cloudflare Turnstile 的 Ephemeral IDs 需要 Enterprise Turnstile（或 Enterprise Bot Management 加相应附加服务），现有 Workers Paid 不代表已具备该功能。官方明确说明不同设备可能得到相同 ID，建议用于识别高频滥用而非唯一识别单台设备。因此不为一次匿名额度引入该服务，也不新增指纹采集或修改匿名门槛。当前新建对话还受服务端每 IP 每小时 16 次的创建限流；同一对话的访客消息另有每小时 60 条的限流。这两项限制不能等同于设备或个人额度，换网络仍可能绕过。

能力边界核对于 2026-11-03：[Chrome 无痕会话](https://support.google.com/chrome/answer/95464?hl=en)、[MDN 浏览器指纹](https://developer.mozilla.org/en-US/docs/Glossary/Fingerprinting)、[Cloudflare Ephemeral IDs 限制](https://developers.cloudflare.com/turnstile/tutorials/fraud-detection-with-ephemeral-ids/)、[Turnstile 套餐](https://developers.cloudflare.com/turnstile/plans/)。第二段要求邮箱验证账号，不称为实名验证；若将来要求更严格的额度，需要另行确定账号门槛及滥用治理方案。

已归属账号的对话采用稳定账号身份执行模型级拉黑，不能因换设备绕过；匿名普通模型封禁匹配 token/visitor，普通模型不写入或匹配 IP。IP 只参与管理员全局封禁，读请求不把 IP-only 命中扩散为其他访问者的永久身份封禁。历史关联按原 token/visitor 继承有效封禁，不将共享 IP 升级成账号封禁。

普通运营者仅能解除本人模型作用域中的封禁；管理员“全部解开”可清理同一账号或同一匿名 visitor 的跨模型封禁及对应全局 IP 记录。聚合同一访问者时使用账号/非空 visitor，不按共享 IP 搜集其他人的对话或删除其独立封禁。解封不等于恢复已停用账号。

模型运营者可以在「修改模型信息」中维护型号、简介和最多四条开场问题，每条最多二十个字；开场问题只作为访客空会话里的建议按钮，未设置或清空时不显示建议按钮，也不自动发送消息。

## 新申请与旧模型认领

新 AI 申请使用已登录、已验证账号的邮箱，审批直接关联账号与模型，不再向新申请发放旧口令。账号已经拥有模型时，不能通过第二次申请、并发审批或旧模型认领取得第二个模型。

旧模型流程为：注册并验证账号 → 输入旧口令证明控制权 → 展示目标型号 → 确认绑定 → 原子写入唯一 owner 并消费短期认领证明 → 撤销旧登录能力及相关旧会话。有效旧 cookie 可识别型号并引导迁移，不能代替邮箱验证；没有旧 cookie 时使用旧口令识别。成功迁移后使用正常持久登录，不重复验证邮箱。

认领证明绑定账号、稳定模型 ID、用途和有效期。重复、过期、跨账号提交与两账号竞争必须只有一个合法结果。已有对话、图片、订阅、模型级拉黑范围和停用状态保留；绑定不自动恢复停用模型。

`0027_clear_legacy_credentials.sql` 清空旧申请中可恢复的口令副本，保留模型原口令的验证摘要，不自动认领或改变归属/停用状态。持有原口令的用户仍可走上述认领流程；遗失口令继续人工核验，不恢复明文副本。该数据迁移不改变结构版本。

历史图片以 D1 中的消息关联、图片 ID/`image_key` 与 `IMAGES` KV 二进制共同保存。账号迁移不重写图片引用；正式发布需保留原 KV 绑定或完整复制并核对原 key/文件，图片未验收不能宣布迁移完成。测试副本不连接生产 KV，详见 [图片迁移要求](archive/accounts-rollout.md#图片数据必须随正式迁移保留)。

历史申请邮箱没有验证，不能自动分配所有权。旧口令遗失、共享、争议、异常申请记录或停用模型需要人工核验。管理员和主模型通过部署者控制的引导工具绑定已验证账号，公开认领接口不能授予 admin。

## Cloudflare Email Sending

生产站点为 `https://tangbao.phaeris.cn`，发信子域为 `mail.phaeris.cn`，发件人为 `糖包 <noreply@mail.phaeris.cn>`。部署者已确认 Workers Paid、D1、Cloudflare DNS 和 Email Sending 可用。每天先用 Brevo 的 `send.phaeris.cn`（`糖包 <noreply@send.phaeris.cn>`）280 封，用尽或熔断后切到 Cloudflare 的 `mail.phaeris.cn`，应用内预算 920 封；应用侧每日总预算 1,200 封，保留 90% 飞书提醒和单家 5 分钟熔断。Cloudflare 超出每月 3,000 封后按 $0.35/1,000 封计费，账户的免费额度与计费以控制台为准。真实收件箱送达仍需单独验收。

部署配置使用原生邮件绑定 `EMAIL`，限制发件地址为所选地址，并允许公开注册用户成为收件人。发信域作为独立子域开通，不把 Email Routing 收件转发当作公开发信能力。[子域配置](https://developers.cloudflare.com/email-service/configuration/subdomains/)、[绑定配置](https://developers.cloudflare.com/email-service/configuration/send-bindings/)。

当前实现只通过 `env.EMAIL.send()` 发信，生产 Worker 运行时无需填写发信 API Key，也不要求向开发者提供 Cloudflare Account ID 或 API Token。部署者用自己的 Wrangler 登录完成发布；`EMAIL_CODE_PEPPER` 和 `MAIL_PAYLOAD_KEY` 是站点保护验证码和邮件内容所需的 Worker Secrets，邮件额度提醒用的 `FEISHU_WEBHOOK` 同样按 Secret 配置。部署顺序、Secrets 放置、管理员引导和完整验收见[部署交接手册](archive/accounts-rollout.md)。

与 [Send emails 入门指南的 Workers 栏](https://developers.cloudflare.com/email-service/get-started/send-emails/) 对照：`wrangler.jsonc` 配置 `send_email` 的 `EMAIL` 绑定，`src/email.ts` 调用 `env.EMAIL.send({to, from, subject, text, headers})`，保存返回的 `messageId`。验证码先进入持久 outbox 再调用该绑定；纯文本邮件无需额外提供 HTML。

真实邮件统一由部署者在 Cloudflare 上的独立试运行 Worker 验证，不再准备本机远程发信配置。部署后的 Worker 直接使用原生 `EMAIL` 绑定，无需教程中用于本地远程开发的 `remote: true`。`local:*` 工具保留独立 D1/KV 和模拟邮件箱，用于本地回归；它不会向真实邮箱发信。

```text
MAIL_MODE=disabled                 # disabled | test | cloudflare
MAIL_FROM=糖包 <noreply@mail.phaeris.cn>
APP_ORIGIN=https://tangbao.phaeris.cn
MAIL_DAILY_LIMIT=1200
MAIL_PROVIDERS=brevo,cloudflare
CLOUDFLARE_DAILY_LIMIT=920
BREVO_DAILY_LIMIT=280
BREVO_FROM=糖包 <noreply@send.phaeris.cn>
# 邮件每日预算用到 90% 时推送到飞书群；留空只写日志
FEISHU_WEBHOOK=
# Worker secrets：EMAIL_CODE_PEPPER、MAIL_PAYLOAD_KEY、FEISHU_WEBHOOK
# EMAIL 为 Worker 原生邮件绑定
# 可选可信投递事件：MAIL_EVENTS_QUEUE、MAIL_EVENTS_ACCOUNT_ID
```

`MAIL_MODE=test` 仅允许回环本地环境。沙箱不配置远程邮件绑定，生产 key 不进入本地配置；合成验证码只通过本地 wrapper 的实例凭据查看。测试时钟和失败注入也仅限本地替身，不作为生产 API。

服务端生成 6 位验证码，10 分钟有效，最多错误 5 次，60 秒重发冷却；重发使旧码失效，验证与找回用途隔离。验证码摘要使用带服务端 pepper 的 HMAC，校验、失败计数和成功消费使用条件原子写。密码重置和消费挑战、提升会话版本、撤销旧会话在同一事务完成；成功后要求正常登录。

邮件先记入持久化 outbox，预算在创建任务前原子预留；日预算按 UTC 日期计算。短期 payload 加密保存并在消费、到期或终态清理。发送任务使用条件占用防止并发重复消费；明确可重试的限流错误有界退避，永久错误停止，超时未知不盲目重发。`ctx.waitUntil` 用于触发处理，但不是持久化队列本身。

Worker 配置每分钟运行补偿任务，在 10 分钟验证码有效期内处理已知可重试的失败；不能沿用原先 10 分钟一次的定时频率。Cloudflare 已受理的邮件由供应商处理后续投递，站点不重复发送。

日志不包含密码、验证码、完整正文或重置凭据。供应商接受发送、投递事件、收件箱收到和用户完成验证分别记结果。投递事件从可信平台队列消费并去重，不通过公开无鉴权 webhook 改写状态，送达事件不能激活账号。

若启用投递事件，部署者需在 Cloudflare 为 `mail.phaeris.cn` 配置邮件事件订阅及对应队列消费者，设置 `MAIL_EVENTS_QUEUE` 和 `MAIL_EVENTS_ACCOUNT_ID` 为实际队列名称与发信账户 ID。接入时核验账户、来源域、事件 ID 和消息 ID；未接入前只有发送任务状态，不能声称送达/退信回调已验收。真实队列连通性与事件字段以部署者环境单独验证。

生产配置需同时添加 `queues.consumers` 指向该队列。例如在实际队列已创建后，将消费者项设为 `{ "queue": "实际队列名", "max_batch_size": 10, "max_batch_timeout": 5 }`，并将 `MAIL_EVENTS_QUEUE` 设为相同名称。没有配置的队列不会自动创建；代码已提供 Queue 消费入口，未知队列会重试而不会冒充成功。事件格式遵循 [Cloudflare 邮件事件文档](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)。

## 数据与迁移

账号、角色、服务端会话、匿名身份、幂等请求、认领证明、验证挑战、发送任务、日预算和投递事件采用顺序 SQL migration。`operators.operator_uid` 稳定唯一，owner 的非空唯一约束保证一账号一模型；申请中的账号约束与最终 owner 约束共同检查。

线上已确认使用 D1，为主要回归目标；Turso 适配器仍需兼容检查。D1 `batch` 与 Turso write batch 的原子性、条件写返回值分别核对，不能因第一条语句影响 0 行就假设后面的语句自动停止。新账号结构不在请求热路径静默建表或修表。

本地通过 prepare 应用并核对源码全部迁移。远程迁移由有权限的部署者在确认目标数据库、备份和版本后单独执行；本地验证不授权生产写入。

本次新增 `0021_accounts.sql`、`0022_account_admin_audit.sql`、`0023_thread_pins.sql`、`0024_thread_reads.sql`、`0025_operator_accepting.sql`、`0026_presence_away.sql`、`0027_mail_providers.sql` 与 `0028_account_push.sql`。旧库只应用尚未执行的 migration，不重新执行全量建表。部署者应先核对 Wrangler 中 `DB` 对应的数据库，再备份、预览待执行项、应用迁移，并部署同版本 Worker。受控管理员引导见 [本地与上线手册](local-development.md#上线与回退)。本地 libSQL 兼容检查发现旧迁移 `0019_block_scope.sql` 的数据转换语句存在兼容错误，由 [#11](https://github.com/PhaerisWakfu/tangbao/issues/11) 跟踪；D1 的迁移通过不能当作 Turso 全量迁移通过。

上线前先演练新增结构与账号流程、管理员受控引导及旧模型认领，再开放迁移并处理未绑定项。窗口和人工争议细则在上线前确定。回退代码不能自动恢复已经撤销的凭据或撤销模型所有权；真实凭据清理、数据回退或恢复必须单独说明范围和恢复方法。

## 验证与交付边界

复用 [本地部署手册](local-development.md) 和 `npm run local:verify`，使用全新实例保留每次结果及有意义的首次失败。重点覆盖注册并发唯一性、匿名额度并发/幂等/删除不返还、跨账号越权、跨设备历史、图片权限、验证码过期/重发/重放、登录零邮件、改密/找回/退出/停用撤销，以及旧模型认领竞争。

浏览器另验 390px/1440px、昼夜主题、键盘、中文输入法、草稿和附件恢复、长期登录与退出清理。受控真实发信另验收件箱、垃圾箱和退信，不以本地替身或供应商受理替代实际送达。当前实现、检查、提交、部署、验收及未测项以 #5–#9 的交付记录为准。


真实邮件联调、完整验收与配套上线顺序见 [部署交接手册](archive/accounts-rollout.md)；本地副本导入见 [本地部署手册](local-development.md#用已有-d1-备份建立本地副本)。
