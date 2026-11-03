---
name: develop
description: 根据糖包项目已确认的 GitHub Issue 实现功能或工程任务，完成 Epic 分支管理、本地验证及提交验收回填。用于开始或继续实现、功能交付；仅整理需求使用 requirement，缺陷调查修复使用 bugfix。
metadata:
  short-description: "根据糖包项目 GitHub Issue 实现功能或工程任务，完成分支管理、本地验证与交付回填"
---

# 功能开发

输入为已明确的 Issue 和本次实施范围；输出为可审阅的改动、有效验证及 Issue 交付记录。

调用示例：使用 `$develop` 执行指定 GitHub Issue，按项目分支规范完成实现、验证和交付记录。

## 进入实施

1. 读取当前 checkout 的 [Issue 工作流程](../../../docs/issue-workflow.md) 和 CONTRIBUTING.md，遵守共享的 Skill 执行约定；适用仓库以文档声明为准。本地有 AGENTS.md 时读取其适用规则，项目文档以 checkout 根目录解析。
2. 读取目标 Issue、父 Epic、必要子项与依赖，对照实际代码核实范围和验收。没有 Issue 时先查重并落实到 Issue；缺少关键决定时澄清，不把建议写成已确认或把“已合并”当作依赖已部署。
3. 在 Issue 写入实施方案、共享消费者、数据影响和验证计划，再更新为开发中。前端读 docs/frontend.md，账号读 docs/accounts.md，运行与验证读 docs/local-development.md；设计中未实施的能力不得作为当前前提。

## 工作位置和改动

- 每个 Epic 单独使用并复用其功能分支，默认 codex/epic-<父Issue编号>-<名称>，默认基线 main；先查已有分支并记录基线。同一 Epic 子项共用，不将两个 Epic 混入一条分支。独立工具/文档 Task 在 Issue 记录实际分支。
- 分支操作服从本次明确指令及适用规则。切换前检查脏文件和运行实例，保留并隔离无关工作；只停止本任务启动且会受影响的实例。不同 instance 隔离数据，不隔离同一 checkout 的源码版本。
- 围绕验收结果做最小可审阅改动。检查共享代码的相关消费者；鉴权、账号归属和匿名额度由服务端执行；数据结构使用顺序 migration，并检查 D1/Turso 原子性和返回值差异。
- 新发现的独立 Bug 建立或关联 bug Issue，按 bugfix 流程在 rick-dev 处理，记录带回本 Epic 的依赖/提交；不顺带吸收无关修复。公开安全问题按 SECURITY.md 脱敏。

## 验证和交付

按 [本地部署手册](../../../docs/local-development.md) 选择与变更风险匹配的检查，记录分支、commit、dirty 状态、instance 和结果。用合成数据；多身份场景验证独立存储及交叉授权。语法检查不能替代浏览器或权限验证，已有充分证据的检查不机械重复。

使用 [Issue 记录格式](../../../docs/issue-records.md) 回填实现、验证、未验证、提交/推送、部署和验收。用户已授权的工作继续完成；Git 提交与推送按本次范围执行，中文标题后空一行写正文并用 Refs #N。提交前审阅实际暂存文件和忽略结果，保留本地协作规则及一次性产物的排除边界。

实现完成进入待验证或待验收；用户验收及部署分别记录。未验收保持 Open，避免 Closes/Fixes 提前关闭；Epic 等全部必需子项验收后关闭。交付给出 Issue、实际改动、验证依据和遗留。
