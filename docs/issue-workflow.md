# GitHub Issue 工作流程

适用仓库：<https://github.com/PhaerisWakfu/tangbao/issues>。后续所有需求、开发任务、Bug、设计决策和验收均以 Issue 为事实记录；仓库文档存稳定规范和设计，Todo 只作入口，不复制维护另一套实时进度。

三个可调用的场景入口共用本文规则与 [Issue 记录格式](issue-records.md)，按当前目标选择：

| 场景 | Skill | 输出 |
| --- | --- | --- |
| 新需求、反馈、方案及范围调整 | [requirement](../.agents/skills/requirement/SKILL.md)，调用 `$requirement` | 场景、范围、验收、Epic/子项及依赖 |
| 按 Issue 实现功能或工程任务 | [develop](../.agents/skills/develop/SKILL.md)，调用 `$develop` | 实现、针对性验证及交付记录 |
| 异常调查、根因定位与修复 | [bugfix](../.agents/skills/bugfix/SKILL.md)，调用 `$bugfix` | Bug 证据、修复、回归及验收记录 |

源码统一放在仓库标准目录 `.agents/skills/`，每个场景仅保留一份 SKILL.md；名称、触发说明和简介使用该文件的 YAML frontmatter，调用示例写在正文。省去可选的 agents/openai.yaml 界面配置，不维护额外的 UI 默认提示。Codex 可按[仓库 Skill 发现规则](https://learn.chatgpt.com/docs/build-skills#where-to-save-skills)读取这些入口，无需在根目录增加 skills/ 或安装到个人全局目录。自动发现以当前会话的可用 Skill 列表为准，未加载时可直接读取对应入口执行；适用范围仍为本文声明的仓库。

## Skill 共用执行约定

- 从当前 checkout 核对根目录、远程、分支、dirty 状态及适用指令，避免对其他项目套用本仓库规则。本次明确用户指令优先；旧任务的 main 直推等授权不能沿用到新任务。AGENTS.md 等本地材料缺少时，使用已跟踪规范和实际代码，不为补齐入口而提交本地报告。
- 项目中的 AI/模型由人回复；设计建议、用户已确认规则、实际实现分别识别。按涉及范围读取前端、账号、本地部署规范，不为每次任务加载全部资料。
- 本仓库日常 GitHub Issue 操作优先使用官方 CLI `gh`，子命令未覆盖时用 `gh api` 调用 REST/GraphQL。正常读写不打开浏览器；CLI 失败先诊断并报告具体原因，确实无法覆盖或用户要求页面操作时才用备用入口。授权和业务页面验证按其实际需要使用浏览器，不能把浏览器成功当作 CLI 已修复。模板缺失不妨碍用结构化正文维护 Issue；必要写入未完成时明确待同步内容和阻碍，不能将本地草稿说成远程已完成。
- 原生父子关系、labels 和 assignee 均须实际设置并核验，按下文统一规则执行；依赖与父子归属分别维护。不为演示或验证 Skill 创建无业务意义的 Issue。
- 只对真正影响方案且无法从现有证据得到的问题请求澄清；等待必要回答时继续独立工作，不将超时当作批准。用户已授权的工作继续推进，不添加固定的重复确认。
- Git 提交、推送、部署和真实邮件等操作按本次范围及授权执行，Skill 不扩大授权。生产访问与本地验证分开；公开安全问题按 SECURITY.md 脱敏。
- 验证按风险选取并记录有效覆盖；重要失败、重跑条件和未验证项保留。文档或 Skill 变更检查结构、链接、场景职责和实际提交范围，无需为此重跑业务回归。
- 实时进展回填 Issue；稳定规范发生变化才更新对应文档。提交前逐文件检查 diff、暂存区和忽略结果，AGENTS.md 及一次性报告/截图/凭据继续排除，不使用强制添加绕过忽略。

## GitHub CLI 操作

开始前检查 `gh --version`、`gh auth status`，确认活动账号和目标仓库；账号具有仓库 WRITE 权限不等于当前令牌具有 Issue 写权限。所有命令显式指定 `--repo PhaerisWakfu/tangbao`；`gh api` 显式写仓库路径，避免因当前目录或环境变量操作其他仓库。

按实际任务选择命令，下面的编号仅展示命令用法：

```sh
# 查询已有工作与完整记录
gh issue list --repo PhaerisWakfu/tangbao --state all --search '关键词'
gh issue view 4 --repo PhaerisWakfu/tangbao --json number,title,body,state,labels,assignees,parent,updatedAt

# 正文先写到被忽略的临时文件，再更新或创建
gh issue edit 4 --repo PhaerisWakfu/tangbao --body-file .tmp/issue-4.md
gh issue create --repo PhaerisWakfu/tangbao --title '需求标题' --body-file .tmp/requirement.md --label Requirement --assignee rickybtang --parent 5

# 设置真实元数据与原生关系
gh issue edit 6 --repo PhaerisWakfu/tangbao --add-label Requirement --add-assignee rickybtang --parent 5
gh api --paginate 'repos/PhaerisWakfu/tangbao/issues/10/sub_issues?per_page=100'
```

- 查重覆盖 Open/Closed Issue。写入前读最新正文与 updatedAt；更新主描述时保留并行修改，不能用旧快照覆盖。发现并行更新就重新读取并合并本次内容。
- 多行正文、评论使用 `--body-file`；`gh api` 的复杂载荷使用 `--input` JSON 文件。临时文件放被忽略的 `.tmp/`，不要在命令字符串中拼接未经转义的 Markdown、反引号或 `$()`，不新增根目录文件或辅助 YAML。
- 创建、编辑、评论、标签、指派、父子关系均通过 CLI 执行；按安装版本的 `--help` 确认可用参数，未覆盖的能力继续使用 `gh api`。父子关系不能用正文链接替代。
- 每次写入后回读对应资源，核对本次正文/评论及应有的 labels、assignee、parent、state；多页列表按需分页。响应失败或部分成功时先检查远端实际结果，再决定是否重试，避免重复 Issue 或评论。
- 读成功不能证明写权限。遇到 403 时区分账号权限、令牌权限/资源范围和授权方式；例如细粒度令牌对外部协作者场景有限制。凭据调整由用户完成授权；不输出令牌，不自动扩大权限，不将换浏览器绕过失败记录为 CLI 成功。
- 只为真实任务写入，不创建演示 Issue 来验证工具。CLI 的读写/回读证据和失败原因记录在原 Issue；不将本机登录状态和具体 Token 信息提交到仓库。

命令依据：[Issue 编辑](https://cli.github.com/manual/gh_issue_edit)、[Issue 创建](https://cli.github.com/manual/gh_issue_create)、[API 调用](https://cli.github.com/manual/gh_api)。

## 最小工作单元

一项可独立验收的用户结果对应一个需求/Bug Issue。较大的主题使用 Epic，使用 GitHub 原生父子 Issue 关系拆分可交付子任务；正文链接和任务清单只是补充，不能代替原生层级。依赖与父子关系分开记录，避免把依赖误当归属。纯技术任务也必须写目的、范围、验收和依赖，不能只有“优化代码”。发现重复先关联已有 Issue；讨论改变范围时更新主描述并保留简短决策记录。

使用 `.github/ISSUE_TEMPLATE/` 中的需求、Bug、开发任务和 Epic 表单。类型必须使用实际 labels：需求 `Requirement`，缺陷复用仓库已有的 `bug`，工程任务 `Task`，汇总 `Epic`；需求 Epic 同时带 `Requirement`，工程 Epic 同时带 `Task`。标题前缀仅辅助阅读，不作为唯一分类。`Requirement`、`Task`、`Epic` 已在本仓库创建；不需要复制一个只大小写不同的 Bug 标签。

表单和 PR 模板属于仓库文件，提交到默认分支后才在 GitHub 新建流程生效。仅在本地生成时必须如实说明“尚未提交/推送”，不能把已创建远程 labels 与未发布的模板混为一谈。表单结构参考 [GitHub 官方说明](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)。

本轮及后续由此协作提交的 Issue 默认分配给 `rickybtang`，除非用户另外指定。创建后检查实际 assignee，不能只在正文写负责人。表单预填 assignee 和 labels；若权限导致未生效，必须补设并验证。

| 字段 | 规则 |
| --- | --- |
| 类型 | labels：`Requirement` / `bug` / `Task` / `Epic`；如原生 Issue type 可用则同步，不能假设个人仓库具备组织类型 |
| 优先级 | P0 紧急不可用或重大风险；P1 核心能力/阻塞；P2 一般改进；P3 后续探索 |
| 阶段 | 待澄清 → 待开发 → 开发中 → 待验证 → 待验收 → 完成；另可标记阻塞/暂缓 |
| 责任人 | 默认 `rickybtang`；用户指定其他人时再调整 |
| 关系 | 原生父子 Issue、独立的依赖关系，以及相关 Bug/提交/PR |
| 证据 | 源码 commit、运行环境、合成步骤、实际结果；静态发现不得写成线上复现 |

阶段放在 Issue 主描述开头，Open/Closed 是最终状态，不能把 Open 理解为尚未开发。优先级暂在正文维护；需要扩展 priority/status/area labels 时统一配置，避免与正文冲突。不把未创建的 Projects 或自动化描述为已启用。

## 需求生成与方案

1. 从聊天或反馈提炼“谁在什么场景遇到什么问题、希望获得什么结果”，先查重。
2. 明确本次范围与不做项，把产品决定、建议和未决问题分开。不要将建议写为用户已确认。
3. 写可观察的验收条件，包括错误、权限、兼容、数据迁移；必要时加流程图或线框图。
4. 跨模块需求先评估前端、服务端、数据、外部服务、运营和费用；拆子任务并注明先后关系。
5. 只有真正影响实现且无法从代码/文档得到的问题才请求澄清，其余合理假设先写入 Issue。

## 代码开发

1. 开发前更新 Issue 的范围、方案、依赖及验证计划，阶段改为开发中。
2. 检查分支、脏文件和运行中的本地服务：每个 Epic 单独建立并复用 `feat/epic-<父 Issue 编号>-<slug>` 分支；普通缺陷使用 `fix/<issue>-<slug>`，线上紧急修复使用 `hotfix/<version>-<slug>`，不吸收无关修改。
3. 做最小可审阅改动。共享组件、鉴权和存储变更检查全局消费者；数据库变更写迁移及回退/补偿说明。
4. 按 [参与开发](../CONTRIBUTING.md) 和 [本地部署手册](local-development.md) 执行检查，补与风险匹配的行为测试；不能将语法通过视为业务通过。
5. 提交使用中文标题、空行和正文，附 `Refs #N`。PR 使用仓库模板，描述分支、基线、问题、结果、验证及限制；按实际提交文件审阅，不提交本地专属规则及个人产物。
6. 实现完成后改为待验证或待验收。代码提交/推送/合并与发布、生产验证、用户验收分别记录。

分支约定：统一小写和短横线，不使用个人名或工具名前缀。

```text
feat/<issue>-<slug>        功能
fix/<issue>-<slug>         普通缺陷
hotfix/<version>-<slug>    线上紧急修复
chore/<slug>               工程维护
docs/<slug>                文档
refactor/<slug>            重构
```

Epic 默认使用 `feat/epic-<父 Issue 编号>-<slug>`，基线在父 Issue 写明，未指定时以 `main` 为默认基线；同一 Epic 子任务共用分支。普通 Bug 使用 `fix/<issue>-<slug>`，线上紧急修复使用 `hotfix/<version>-<slug>`；本地不存在时先检查远程同名分支。独立文档/规则/工具 Task 使用 `docs/<slug>` 或 `chore/<slug>`，并在 Issue 记录所属分支，不自动混入某个 Epic。分支合并后删除；切换前保留和隔离无关未提交改动，不自动 stash/reset 或强推。

本地验证按“确定分支与基线 → 停止当前 checkout 的旧实例 → 切换分支 → prepare → dev/seed 或自动 verify → 回填结果”执行。记录实际分支/提交、工作区是否有未提交改动、instance 和结果。不同 instance 的数据隔离不等于同一 checkout 的源码版本隔离。

提交示例：

```text
限制匿名访客创建第二段对话

服务端按匿名身份原子消耗一次创建额度，注册提示保留当前草稿。
补充并发创建、删除后不返还和登录后继续发送的验证。

Refs #N
```

## Bug 修复

1. 记录环境/版本、复现步骤、预期、实际、影响范围和证据；不确定时标注“静态发现/待复现”。
2. 区分产品预期、实现缺陷、数据问题和环境问题；先定位拥有该规则的代码，避免只修单个页面。
3. 证明根因，列修复方案和回归范围；重要错误保留首次失败及修复后结果。
4. 修复后重复原步骤，再检查相邻路径和异常恢复。数据修复与代码修复分开，生产数据操作先确认具体范围。
5. 若无法复现，记录环境差异和下一步证据，不将“未复现”写成“已解决”。

## 安全问题

遵循 [SECURITY.md](../SECURITY.md)。公开 Issue 只写脱敏整改主题、阶段和验收边界，不写可利用步骤、敏感返回、密钥或真实用户数据。详细证据走私密安全报告；本地调查可保存在已忽略的 `private-assets/`，不随 Git 发布。公开跟踪不代表私密报告已经提交。

## 验收、部署和关闭

完成记录至少包括：

```text
实现：变更摘要、提交/PR、影响范围
验证：环境、命令/步骤、结果（含失败和未测）
发布：未发布 / 目标环境及版本 / 回滚点
验收：验收人或已约定的客观验收证据
遗留：已拆分并链接的后续 Issue
```

仅当本 Issue 的验收条件满足才关闭。验收未完成时使用 `Refs #N`，避免 `Closes/Fixes #N` 导致合并时提前关闭。文档 Issue 的验收可以是文档可读、链接正确及内容评审，不强求部署。Epic 等全部必需子项验收后关闭；超出范围的剩余工作必须另建关联 Issue。

## 当前接手事项

首次接手发现及实时进展由 [GitHub Issues](https://github.com/PhaerisWakfu/tangbao/issues) 维护；账号入口为 [#5](https://github.com/PhaerisWakfu/tangbao/issues/5)，工程整备入口为 [#10](https://github.com/PhaerisWakfu/tangbao/issues/10)。规范变化回写可复用文档并关联 Issue，文档及流程建设由 [#4](https://github.com/PhaerisWakfu/tangbao/issues/4) 跟踪。

本地协作规则、给维护者看的分析/Todo 快照、报告、截图和会话产物不属于提交范围，统一放入被忽略的位置。前端规范、账号设计、本文及本地部署手册等可复用文档保持可提交；公开文档不引用本地专属文件。提交前同时检查 `git diff --cached` 和忽略结果，不使用强制添加绕过边界。
