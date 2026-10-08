# Jevs

通过 MCP 调用有限答案决策模型，获取分类、评分和条件判断的结构化结果。支持 OpenAI Decisions、TypeSafe Jev、OpenRouter Decisions、Cloudflare Workers AI Clef、Clef 本地 Python 运行时、Tev1 Chat Completions，以及明确配置的服务和网关。基于 TypeScript、Bun 和 stdio，以 Codex plugin 发布。

## 安装

需要 Bun 1.4.2 或更新版本，且 Codex 进程的 PATH 能找到 Bun。安装使用 [nshcr/jevs](https://github.com/nshcr/jevs) 的 `release` 分支。

```sh
codex plugin marketplace add https://github.com/nshcr/jevs.git --ref release
codex plugin add jevs@jevs
```

配置下方环境变量，新建 Codex 任务后调用 `provider_info` 和 `decision_guide`。无密钥也可发现工具和读取指导。更新与固定版本见 [Codex plugin](docs/codex-plugin.md)。

## 配置

显式选择供应商，服务不再从 URL 推断身份。以下示例使用 OpenRouter；密钥从实际 MCP 宿主环境提供：

```sh
JEVS_PROVIDER=openrouter
JEVS_DEFAULT_MODEL=typesafe/jev-1.13
# JEVS_API_KEY 由宿主的凭据配置提供
```

`JEVS_PROVIDER` 默认 `typesafe`。OpenAI 原生接入设为 `openai`（默认 `gpt-6-luna`）；本地 Clef 设为 `clef-python`，并提供 `JEVS_PYTHON_MODEL_DIR` 和部署者准备的 Python/模型依赖。全部供应商、地址与迁移规则见 [供应商接入](docs/providers.md)，旧 `TYPESAFE_*` 配置已移除。

调用 `provider_info({model})` 检查所选型号的协议、能力和 `toolSupport`。未核实型号默认拒绝执行；确认协议后可在单次评估传 `allowUnverifiedModel: true`，或宿主配置 `JEVS_ALLOW_UNVERIFIED_MODELS=true`。这不放宽 unsupported 或输入限制。

源码运行可使用 `.env`，不要提交凭据。`JEVS_REQUEST_TIMEOUT_MS` 默认 30000ms；调度默认并发 4、队列 32、排队期限 1000ms，配置见 [性能与负载控制](docs/performance.md)。服务不自动重试。

## 工具

| 工具               | 用途                       | 参数                                                                                                                     |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `classify`         | 从有限候选中选一项         | `content` 或 `messages`、`items: [{id, question, options}]`                                                              |
| `score`            | 按有序标准评分             | `content` 或 `messages`、`items: [{id, question, levels, levelLabels?}]`                                                 |
| `check`            | 判断条件                   | `content` 或 `messages`、`items: [{id, question, yes?, no?}]`                                                            |
| `assess_batch`     | 多条独立记录并发评估       | `records: [{id, content?, messages?, images?, videos?, mediaOptions?}]`、共享的 `classifications?`、`scores?`、`checks?` |
| `assess_structure` | 一次混合多类判断           | `content` 或 `messages`、`classifications?`、`scores?`、`checks?`                                                        |
| `list_models`      | 读取模型目录及协议适用状态 | 无                                                                                                                       |
| `provider_info`    | 解析所选模型的协议与能力   | 可选 `model`                                                                                                             |
| `decision_guide`   | 读取本地指导与示例         | 可选 `topic`                                                                                                             |

每份证据选择 `content` 或有序 `messages`；图片、视频及原生元信息按模型能力接受。批量记录共享判断标准，每条记录独立评估。工具发现保留全集，实际调用仍校验所选型号；相互依赖的判断由调用方分阶段执行。

例如调用 `classify`：

```json
{
  "content": { "message": "包裹两周了还没收到。" },
  "items": [
    {
      "id": "team",
      "question": "应该由哪个团队处理 `message`？",
      "options": {
        "orders": { "includes": ["配送", "订单状态"] },
        "billing": { "includes": ["退款", "扣款"] },
        "other": "不属于上述类别"
      }
    }
  ]
}
```

`content`、问题和描述接受 text/JSON/null，供应商可有更严格限制。分类选项为映射或 typed array；布尔值 `true` 与字符串 `"true"` 保持不同。成功结果保留 provider、protocol、实际 model 和按 ID 关联的判断，供应商未提供的数值不补零。`kind: "refusal"` 表示该题未作判断；批量调用须逐条检查 `records[].status`。完整字段、能力与错误见 [MCP 契约](docs/protocol.md)。

## 调用指导与数据边界

`decision_guide` 提供 `overview`、`patterns`、`examples`、`limits`、`sources`，也可读取 `jevs://guide/<topic>`。插件内置 [调用 skill](skills/jev-mcp/SKILL.md)。模型评估给定证据，不检索 URL 或执行返回动作；置信度不代表授权，跨模型阈值需分别校准。

远端 provider 接收调用内容和媒体；`clef-python` 在配置的本地运行时执行。服务不持久化输入，stdout 仅承载 MCP；错误不回显完整上游正文。取消或超时不证明远端未执行或未计费。

## 开发与验证

使用 `.bun-version` 指定的 Bun：

```sh
bun install --frozen-lockfile --ignore-scripts
python3 -m venv .local/test-python
.local/test-python/bin/python -m pip install -r scripts/requirements-test.txt
PATH="$PWD/.local/test-python/bin:$PATH" bun run verify
```

| 命令                        | 用途                               |
| --------------------------- | ---------------------------------- |
| `bun start` / `bun run dev` | 启动源码 MCP / 监听变化重启        |
| `bun run format`            | 统一格式                           |
| `bun run check`             | 治理、源码审计、格式与类型检查     |
| `bun run test`              | 本地测试                           |
| `bun run build`             | 构建 MCP bundle 与依赖许可证清单   |
| `bun run verify`            | 完整检查、测试、构建和插件目录验证 |

本地验证需要 Python 与测试用 Pillow；requirements-test.txt 固定测试依赖，Python 桥测试不会因缺失依赖而静默跳过。测试不需要 torch、真实权重或 GPU；这些只属于部署者实际模型运行环境。

服务通过 stdin/stdout 使用 MCP。验证覆盖本地协议、进程、bundle 与插件边界；OpenAI 未完成真实账户推理，Clef 测试不加载真实权重。实验与报告见 [适配架构](docs/adapter-architecture.md#本地验证)。历史 Jev 基准资料另存于 `benchmark` 分支。

## 发布与许可

项目采用 [MIT 许可证](LICENSE)；发布和回滚流程见 [构建与发布](docs/releases.md)。

## 文档

- [Codex plugin](docs/codex-plugin.md)：安装、环境配置、更新与固定版本。
- [MCP 契约](docs/protocol.md)：输入输出、错误和批量。
- [供应商接入](docs/providers.md)：端点、模型、能力与验证范围。
- [决策模型研究](docs/decision-model-research.md)：官方契约、语义差异与扩展条件。
- [适配架构](docs/adapter-architecture.md)：模型解析、接入边界与本地验证。
- [性能与负载控制](docs/performance.md)：请求组织、并发调优与证据范围。
- [构建与发布](docs/releases.md)：维护者验证、GitHub 发布与回滚。
