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

从 Codex 进程环境提供 `JEVS_PROVIDER`（默认 `typesafe`）、`JEVS_API_KEY`；可选 `JEVS_DEFAULT_MODEL`、`JEVS_BASE_URL` 与 `JEVS_REQUEST_TIMEOUT_MS`。Cloudflare 可用 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_AI_GATEWAY_ID`。旧 `TYPESAFE_*` 配置需要迁移。不要把凭据提交到仓库。端点、模型和兼容性见 [供应商接入](docs/providers.md)。远端推理需要服务商账户权限与网络；本地 `clef-python` 需配置 `JEVS_PYTHON_MODEL_DIR` 和部署者准备的 Python 模型环境。

OpenAI Decisions 原生接入设置 `JEVS_PROVIDER=openai`，由宿主提供 OpenAI `JEVS_API_KEY`；默认模型为 `gpt-6-luna`，使用 `/v1/decisions` public beta。已有配置不会自动切换；切换时同步清理原供应商基础地址和模型覆盖。

未核实型号默认拒绝执行；核对协议后可在单次调用传 `allowUnverifiedModel: true` 或设置宿主 `JEVS_ALLOW_UNVERIFIED_MODELS=true`，不能放宽 unsupported 或能力限制。

调用 `provider_info` 查看指定模型的能力及五工具适用状态，调用 `decision_guide` 获取使用指导。带类型的分类候选需保持 string/boolean 区别；结果可能包含按题 `refusal`，不得当成否定或零分。源码与发布流程位于项目的 main 分支。此目录不需要 npm 安装，也不包含 Bun 运行时。

`build-info.json` 记录来源提交，`CHECKSUMS.sha256` 提供逐文件完整性校验。许可证见 [LICENSE](plugins/jevs/LICENSE)，调用技能见 [SKILL.md](plugins/jevs/skills/jev-mcp/SKILL.md)。
