# Jevs Codex marketplace

此分支是生成的 Codex plugin 分发目录。需要 Bun 1.4.2 或更新版本，并将 Bun 加入 Codex 进程的 PATH。

从 [nshcr/jevs](https://github.com/nshcr/jevs) 的 release 分支安装：

```sh
codex plugin marketplace add https://github.com/nshcr/jevs.git --ref release
codex plugin add jevs@jevs
```

更新后新建 Codex 任务并核对 MCP 握手版本：

```sh
codex plugin marketplace upgrade jevs
codex plugin add jevs@jevs
```

从 Codex 进程环境提供 `TYPESAFE_API_KEY`；可选 `TYPESAFE_DEFAULT_MODEL` 和 `TYPESAFE_BASE_URL`。不要把凭据提交到仓库。端点、模型和兼容性见 [供应商接入](docs/providers.md)。推理需要服务商账户权限与网络。

调用 `jev_guide` 获取使用指导。源码与发布流程位于项目的 main 分支。此目录不需要 npm 安装，也不包含 Bun 运行时。

`build-info.json` 记录来源提交，`CHECKSUMS.sha256` 提供逐文件完整性校验。许可证见 [LICENSE](plugins/jevs/LICENSE)，调用技能见 [SKILL.md](plugins/jevs/skills/jev-mcp/SKILL.md)。
