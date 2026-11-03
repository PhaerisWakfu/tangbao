# 参与开发

先阅读 [前端规范](docs/frontend.md) 和 [Issue 工作流程](docs/issue-workflow.md)。需求、开发任务和 Bug 先查重并建立 GitHub Issue，写明范围及验收标准；实现和验证回填原 Issue。

## 本地开发和检查

使用 Node.js 22 以上：

```sh
npm ci
npm run types
npx tsc --noEmit
npm run check
```

在隔离本地数据上验证受影响流程。旧 smoke/浏览器/截图脚本存在过时断言，不能直接当作当前回归通过依据，相关整改由 [#11](https://github.com/PhaerisWakfu/tangbao/issues/11) 跟踪。不得把这些脚本指向生产环境。

复用 [本地部署与多身份验证](docs/local-development.md)：`npm run local:verify` 自动启动全新 D1/KV 实例并执行当前多身份场景；人工操作使用 `local:prepare`、`local:dev`、`local:seed`。未来邮箱账号矩阵明确标为尚未实现，不计入当前通过项。

## Git 与交付

每个 Epic 使用独立功能分支，功能子任务复用父 Epic 分支；Bug 修复使用 Ricky 专属的 `rick-dev`。分支命名、基线及例外在对应 Issue 明确记录，详见 [Issue 工作流程](docs/issue-workflow.md)。保留他人的未提交改动，不扩大本次提交范围。

Git 提交以中文为主，首行标题后必须空一行，再用正文说明改动、影响范围或验证结果，并以 `Refs #编号` 关联 Issue；不得只写单行标题。

PR 使用仓库模板，提交后把分支、变更与验证记录回填 Issue。代码完成、提交、推送、发布和验收分别记录，验收完成前不自动关闭 Issue。

本地协作规则、个人接手分析/Todo、截图和验收产物不提交；这些文件由 `.gitignore` 排除。前端规范、账号设计、Issue 流程、本地部署手册和必要源码/脚本/模板可以提交。新的个人材料放 `.tmp/`、`.local/` 或 `private-assets/`，不要在可发布文档中链接本地专属文件。

## 安全和隐私

不要公开漏洞细节，遵循 [SECURITY.md](SECURITY.md)。不提交 `.dev.vars`、数据库备份、真实对话截图、邮箱/电话/微信或生产凭据；测试、截图和 Issue 仅使用合成数据。

## 许可证

贡献代码遵循仓库 MIT License。站点文案、品牌和个人身份不随代码自动授权复用。
