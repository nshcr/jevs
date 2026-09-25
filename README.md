# Jevs

让模型和 agent 通过 MCP 调用 [TypeSafe AI 的 Jev](https://docs.typesafe.ai/introduction)，获取分类、评分和条件判断的结构化结果。基于 TypeScript、Bun 和官方 JavaScript SDK，通过 stdio 通信，以 Codex plugin 发布。

## 安装

需要 Bun 1.4.2 或更新版本，且 Codex 进程可以从 PATH 找到 Bun。安装来源为 [nshcr/jevs](https://github.com/nshcr/jevs) 的 `release` 分支；维护者须先完成一次发布。

```sh
codex plugin marketplace add https://github.com/nshcr/jevs.git --ref release
codex plugin add jevs@jevs
```

配置下方服务商环境变量，新建 Codex 任务后调用 `jev_guide`。无密钥也可发现工具和读取指导。更新、固定版本和宿主配置见 [Codex plugin](docs/codex-plugin.md)。

## 配置

从 Codex 进程环境提供 `TYPESAFE_API_KEY`，按 [供应商接入](docs/providers.md) 配置 `TYPESAFE_BASE_URL` 与可选 `TYPESAFE_DEFAULT_MODEL`。该文档集中列出端点、模型、凭据要求、兼容性和验证状态。源码运行可使用 `.env`，不要提交凭据。

默认每个进程并发 4 个上游请求，最多排队 32 个，排队期限为 1000ms。通过 `JEVS_MAX_CONCURRENCY`、`JEVS_MAX_QUEUE`、`JEVS_QUEUE_TIMEOUT_MS` 调整，详见 [性能与负载控制](docs/performance.md)。

## 工具

| 工具               | 用途                       | 参数                                                                        |
| ------------------ | -------------------------- | --------------------------------------------------------------------------- |
| `classify`         | 从候选中选一项（Choice）   | `content`、`items: [{id, question, options}]`                               |
| `score`            | 按有序标准评分（Score）    | `content`、`items: [{id, question, levels}]`                                |
| `check`            | 判断条件成立的概率（Noul） | `content`、`items: [{id, question, yes?, no?}]`                             |
| `assess_batch`     | 多条独立记录并发评估       | `records: [{id, content}]`、共享的 `classifications?`、`scores?`、`checks?` |
| `assess_structure` | 一次混合多类判断           | `content`、`classifications?`、`scores?`、`checks?`                         |
| `jev_list_models`  | 查询账号可用模型           | 无                                                                          |
| `jev_guide`        | 读取指导与示例，不调用 Jev | 可选 `topic`                                                                |

评估工具支持批量和可选 `model` 参数。相同上下文中的独立判断可合并成一次调用；后续判断依赖前次答案时，由调用方构造下一次请求。

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

`content`、`question` 和标准说明可使用字符串、JSON 对象、数组或 null，支持结构化规则和示例。Choice 提供 2–255 个选项，Score 提供 2–10 个等级，结果 ID 在整次调用内唯一。

成功结果包含 `results`、实际使用的 `model` 和 token `usage`，同时提供 MCP 结构化内容与 JSON 文本。按 ID 读取结果：分类返回标签、概率和置信度；评分返回可为小数的等级位置；条件判断返回肯定概率，不自动转换为布尔值。

完整契约和错误处理见 [协议说明](docs/protocol.md)。

## 调用指导与数据边界

`jev_guide` 提供 `overview`、`patterns`、`examples`、`limits`、`sources`，也可通过 `jevs://guide/<topic>` 资源读取。插件内置 [调用 skill](skills/jev-mcp/SKILL.md)，覆盖多标签、重排、分层分类、组合评分和证据校验。

同一上下文的独立问题可合并调用；不同记录使用 `assess_batch`，逐条检查 `records[].status`。后续问题依赖前次答案时，由调用方构造下一次请求。Jev 返回判断与概率，不生成自由文本，不执行动作，也不保证事实正确。

调用内容会发送给配置的服务商。SDK 每次请求尝试超时 30 秒，并按 SDK 默认策略重试符合条件的失败；取消或超时不代表远端未执行或未计费。服务不持久化输入，stdout 仅承载 MCP 协议；错误会保留可识别的供应商错误码，不回显完整错误正文。供应商差异由 MCP 适配层处理；配置与适配边界见 [供应商接入](docs/providers.md)，调用方按统一工具契约及错误提示处理。

## 开发与验证

使用 `.bun-version` 指定的 Bun：

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

| 命令                        | 用途                               |
| --------------------------- | ---------------------------------- |
| `bun start` / `bun run dev` | 启动源码 MCP / 监听变化重启        |
| `bun run format`            | 统一格式                           |
| `bun run check`             | 治理、源码审计、格式与类型检查     |
| `bun run test`              | 本地测试                           |
| `bun run build`             | 构建 MCP bundle 与依赖许可证清单   |
| `bun run verify`            | 完整检查、测试、构建和插件目录验证 |

服务等待 stdin 上的 MCP 消息，没有终端交互界面。需要真实推理时，复制 `.env.example` 为 `.env` 并配置密钥。

`verify` 只使用本地 HTTP fixture 和临时 Git 仓库，不调用外部服务，也不发布。调度与请求形态见 [性能与负载控制](docs/performance.md)。

## 发布与许可

`bun run verify` 生成 `artifacts/marketplace/`；`dist/` 和 `artifacts/` 不纳入源码 Git。维护者从 main 手动触发 **Publish Codex marketplace**，将插件目录发布到同仓库 release 分支。版本管理和发布检查见 [构建与发布](docs/releases.md)。

项目采用 [MIT 许可证](LICENSE)。第三方依赖保留各自许可证，发布目录附带许可证清单。

## 文档

- [Codex plugin](docs/codex-plugin.md)：安装、环境配置、更新与固定版本。
- [MCP 契约](docs/protocol.md)：输入输出、错误和批量。
- [供应商接入](docs/providers.md)：端点、模型、配置、适配边界与验证状态。
- [性能与负载控制](docs/performance.md)：请求组织、并发调优、基准与调用记录。
- [构建与发布](docs/releases.md)：维护者验证、GitHub 发布与回滚。
