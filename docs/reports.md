# 举报与信誉

对应 [Epic #25](https://github.com/PhaerisWakfu/tangbao/issues/25)，本期只实现举报、审核及账号信誉。满意度、拉黑统计、AI味榜单和匹配另行实现。

## 使用与归属

双方都须有已验证的账号。聊天和笼屉里，对方消息的复制按钮旁为举报入口，文字和图片共用规则。已拉黑但仍有访问权的历史消息可以举报，不要求聊天轮数。本人信誉位于账号设置，相关记录也从设置进入。管理员沿用笼屉的“审计 → 举报”筛选，在原阅读区域审核；可查看原对话，原对话已删除时使用工单证据。

新消息保存实际发送账号。迁移不推断旧消息作者，不根据 IP、浏览器、模型当前持有人或认领后的账号补填作者。无法核实作者的历史消息不能发起新举报。模型改名不改变账号归属；审核队列按稳定模型 UID 筛选。匿名聊天可继续使用，但不参与举报或扣分。

旧 `threads.reported_at/report_reason` 保留为只读“历史举报”，不追认结果、不扣分、不占新名额。旧 `POST /api/threads/:id/report` 适配到同一服务：优先使用指定消息，没有指定时选择最近一条有账号作者的对方回复。旧客户端未传请求键时，按消息及原因生成稳定键；同内容重试返回原工单。失败后主动发起新举报使用新页面生成的新请求键。

## 默认规则

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| initialScore / minimumScore | 100 / 0 | 新账号初始分、扣分下限 |
| minimumReportScore | 60 | 低于此分不能新举报，恰好60允许 |
| successLimit | 1 | 有方向的账号对终身成功次数上限 |
| pendingPerPair / pendingTargets | 1 / 3 | 同一对象待审核数、账号待审核对象数 |
| failureWindowSeconds | 604800 | 按裁决时刻滚动的7天窗口 |
| upheldPenalty | 5 | 成功时扣被举报方 |
| failureBands | 2→1、4→2、5→3、6→4、其余→5 | 失败次数包含本次，扣举报方 |
| reasonMinLength / reasonMaxLength | 2 / 500 | 举报原因字数 |
| reviewReasonMaxLength | 500 | 审核原因字数 |
| submissionsPerThread / rateWindowSeconds | 3 / 3600 | 同账号同对话的提交限流 |
| pageSize / maxPageSize | 10 / 50 | 列表默认及最大页长 |

资格按账号、方向计算，跨对话和设备共用。已有待审核照常裁决；两种结果都释放待审核名额，成功方向保留永久锁。失败序号为 `(裁决时刻-窗口, 裁决时刻]` 内此前失败数加一，恰好满窗口的旧失败不计入新档位。成功不加分，也不清空近期失败。已扣分不会因窗口过去或参数变更返还；最低分附近只记录实际扣除量。

参数的业务定义和默认值由 Ricky 批准。规则版本不可修改，发布只影响后续新操作/新裁决，不重新计算历史金额。账号初始化后不因 initialScore 调整重新初始化；账号对首次受理时冻结 successLimit，已成功锁定的方向不会被调参解锁。审核员只选择成功或失败并填写理由，不能提交自定义分值。取消、资格拒绝、网络错误不是失败裁决。本期没有撤回、更正、申诉和恢复信誉。

## 接口与版本维护

所有接口要求同源账号会话，响应不进入公共缓存。普通接口不接受查询他人信誉，不返回他人当前分数或举报者账号。管理员审核数据单独授权。

- `GET /api/reputation`：本人当前快照；裁决后即时更新，无每日全库扫描。
- `POST /api/reports`：`messageId / reason / requestKey`；消息归属、名额和分数由服务端复核。
- `GET /api/reports?requestKey=...`：按本人原请求键查提交结果；结果未知时保留同一请求键和内容。
- `POST /api/reports/states`：最多50条可见消息，一次读取资格和对应进度；不返回对象账号或分数。
- `GET /api/reports[?cursor=...]`、`GET /api/reports/:id`：本人提交、本人收到的成功处理、证据和本人实际扣分。
- `GET /api/admin/reports?status=pending|upheld|rejected&model=...&cursor=...`：有界审核队列。
- `POST /api/admin/reports/:id/preview`：`outcome: upheld|rejected / reason`，返回当前实际影响及确认 token。
- `POST /api/admin/reports/:id/decision`：同一结论、理由及 token；影响变化返回409，必须重新预览确认。相同终态重放不再次扣分。

配置接口不新增产品配置编辑页。管理员可读 `GET /api/admin/report-policy`；发布者须有管理员角色，并由部署配置 `REPORT_POLICY_OWNER_ACCOUNT_ID` 指定其账号ID。未配置时使用已有主页绑定管理员；两者均未设置时不允许发布。该配置只指定规则维护者，不授予管理员角色。保存操作人、原因和前一版本：

1. 读取当前规则，修改需要调整的字段，保留完整 policy。
2. `POST /api/admin/report-policy/preview`，内容 `{policy, reason}`，取得 `{base, policy, token}`。
3. `POST /api/admin/report-policy/publish`，发送上述预览结果及相同 reason；其他人先发布时返回409，重新读取。
4. 回滚先以 `{version: 历史版本ID, reason}` 调用 preview，再将其 base/token、version及相同 reason 发往 `/api/admin/report-policy/rollback`。回滚也创建新版本，不修改旧版本。

数值须为整数；分数在0～100范围，失败档位递增、末档无上界，页长最多50，输入长度和并发名额另有资源上限。格式非法时不发布。新版本不会绕过已存在的成功锁或改写既有账目。

## 数据、并发及资源

顺序应用全部迁移，新增 `0030_reports.sql`，结构版本升级为30。D1和Turso使用同一SQL：插入触发器原子检查账号对和待处理容量；裁决触发器复核当前版本、信誉修订号和阶梯，信誉快照、工单终态、成功锁同次提交。不可变工单保存创建/裁决版本、名义扣分及实际扣前扣后值。重复提交/丢失回包按原请求键恢复，重复裁决以工单终态去重。

工单只保存选中消息、前4条文字上下文及选中消息图片引用，不复制整段聊天。工单与图片引用同次落库；删除聊天保留工单及其图片。图片清理器在删除KV前按索引复核消息引用和工单引用，仍被引用的资源不删除。证据图片走工单专属授权路由，原聊天删除后也不会变成公开资源。本期不设自动销毁期限，后续保留/删除政策另行明确。

按约100同时在线、每秒个位数举报/审核设计。列表按账号、状态、稳定模型及时间索引，每页最多50；普通记录从两个账号索引各取一页后合并。可见消息资格合并查询，沿用现有聊天刷新信号失效，不增加独立高频轮询。审核列表沿用现有审计刷新周期；审核表单不随轮询重建。跨账号切换及跨工单迟到响应不能覆盖当前视图。

## 本地验证

```sh
npm run types
npx tsc --noEmit
npm run check
node --test scripts/reports.test.mjs scripts/report-client.test.mjs scripts/image-cleanup.test.mjs scripts/schema.test.mjs scripts/tooling.test.mjs
npm run local:verify -- --instance report-regression-new-name
```

使用全新合成实例验证正式HTTP、D1/KV及独立账号会话。`local:seed`保留可人工操作的数据，不执行滚动时钟和扣分边界；浏览器从现有账号设置、对话和审计入口验收。远程迁移、生产部署、真实Turso连接及用户验收分别记录，不由本地通过推断。
