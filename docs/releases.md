# Codex plugin 构建与发布

`nshcr/jevs` 的 main 分支保存源码，release 分支保存可安装的 Codex marketplace。

## 本地验证

使用 `.bun-version` 指定的 Bun，依赖已安装时可完全离线运行：

```sh
bun run verify
```

执行治理、格式、类型、测试、构建、MCP 冒烟检查，生成 `artifacts/marketplace/` 并检查精确文件清单、逐文件哈希、源码哈希和文档链接。重复运行会替换这一生成目录。密钥放在 `.env` 或宿主私有环境中，不纳入发布目录。

GitHub Action 先执行 `bun install --frozen-lockfile --ignore-scripts`，再执行 `bun run verify`；依赖安装可能访问 registry。默认测试仅使用本地 HTTP 模拟端点，发布测试使用临时本地 Git bare 仓库，不调用模型或外部 Git 服务。

marketplace 包含 `.agents/plugins/marketplace.json`、根 README、`docs/providers.md`、`build-info.json`、`CHECKSUMS.sha256`，以及 `plugins/jevs/` 下的 manifest、MCP 配置、bundle、skill 和许可证。依赖已打入 bundle；用户仍需预装 Bun。许可证清单为安装依赖的保守超集，不是精确 bundle SBOM。

## 发布步骤

`.github/workflows/ci.yml` 在源码 push、pull request 和手动触发时验证 Linux/macOS。release 分支不触发该工作流；远端分支也不携带 workflow。

1. 修改源码；已发布版本有变化时，运行 `bun run version:set -- <version>` 提升版本。
2. 运行 `bun run verify`，提交改动并推送 main。
3. 在 GitHub Actions 中从 **main** 手动运行 **Publish Codex marketplace**。
4. 确认工作流成功，在 job summary 查看版本、来源 SHA 和 release 提交；脚本会回读远端 release 引用核验。也可核对 release 分支 `build-info.json`。

工作流先对触发时的 SHA 执行 Linux/macOS 验证，再检出同一 SHA 重建发布目录。发布 job 使用 `contents: write` 将目录提交到 release 分支：首次创建独立根提交，后续保留历史，通过普通 push 更新。

Action 不需要 PAT 或模型密钥，使用仓库 `GITHUB_TOKEN`；仓库规则需允许该 token 更新 release 分支。Actions 固定提交，发布并发串行且不取消正在执行的发布。保护规则拒绝写入时任务失败，不绕过规则。

发布脚本要求工作区干净、构建来源等于 HEAD。再次发布同一源码及相同清单为 no-op；不同源码必须是已发布源码的后继，且版本必须递增。同版本不同内容和过期源码都被拒绝。

本地 `verify` 不推送、不安装插件。只有显式执行 `bun scripts/publish.ts --confirm` 才会访问 Git 远端；通常交由 Action 调用。项目采用 MIT 许可证，发布目录包含 LICENSE 和第三方依赖许可证清单。

## 回滚

单个用户可按 [固定版本与回滚](codex-plugin.md#固定版本与回滚) 注册旧发布提交。面向所有用户回滚功能时，在 main 撤回对应代码、提升版本并重新发布，保留 release 分支历史。

校验和用于完整性检查，不是签名。GitHub Action、远端推送以及 Codex 实际安装和缓存更新需要在真实宿主验收；本地测试不代表这些行为已验证。
