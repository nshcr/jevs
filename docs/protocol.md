# MCP 契约

## 输入映射

| MCP 字段         | TypeSafe SDK 字段          |
| ---------------- | -------------------------- |
| content          | state                      |
| question         | instructions               |
| classify.options | Choice criteria            |
| score.levels     | Score criteria             |
| check.yes / no   | Noul criteria.true / false |
| model            | model                      |

每个评估请求至少包含一个判断。ID 不得为空白、重复或为 `__proto__`；问题与标准中的 JSON 键 `__proto__` 也会被明确拒绝，避免解析器静默丢弃数据。普通 `constructor` 字段保留。

`content` 和 `question` 必填，可为字符串、对象、数组或 null；嵌套 JSON 支持数字和布尔值，顶层不接受裸数字或布尔值。输入结构遵循官方 JavaScript SDK 的 EntryType。

混合工具的 classifications、scores、checks 组内结构分别与 classify、score、check 的 items 相同。服务将它们合并为一次 systemOne 调用，问题彼此独立。

## 输出

单记录评估成功返回 `{results, model, usage: {inputTokens, outputTokens}}`：

- classification：`{id, kind, value, confidence, probabilities}`。
- score：`{id, kind, value, confidence, probabilities, levels}`；value 是从 0 开始的等级期望位置，levels 是编号到原始等级说明的映射。
- check：`{id, kind, probability}`，没有独立 confidence。

按 ID 关联，不依赖数组顺序。实际模型可能是别名解析后的版本。models.list 不是全部可用版本的白名单。

响应校验包括必填类型、ID 集合、原语类型、选项/等级集合、0–1 概率和置信度、非负整数 token 数。Choice 必须选中最高概率候选（允许并列）；Score 检查等级范围、legend 和加权期望。概率和容差为 1e-6，评分加权误差容差为 1e-6 × max(1, 等级数−1)。不重新计算 confidence。

新增上游字段不进入公共结果。单记录评估的契约错误使该记录整体失败，不交付部分答案；`assess_batch` 保留其他记录的成功结果。所有工具声明 outputSchema；成功时结构化内容和 JSON 文本一致。

## 失败与恢复

先检查 `isError`。上游或配置错误的 `content[0].text` 为 JSON：

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Model service returned HTTP 429.",
    "action": "Wait before retrying within the caller budget.",
    "retry": "after_backoff",
    "status": 429,
    "retryAfterMs": 2000
  }
}
```

错误结果没有成功 structuredContent。status 和 retryAfterMs 按需出现。MCP SDK 参数错误可为普通文本，不必符合此 JSON 格式。

| 错误码                             | 处理                                           |
| ---------------------------------- | ---------------------------------------------- |
| NOT_CONFIGURED / ACCESS_DENIED     | 修正服务器密钥与权限                           |
| INVALID_REQUEST                    | 检查模型、选项、等级、上下文大小               |
| INVALID_RESPONSE                   | 不使用部分结果，排查契约差异                   |
| RATE_LIMITED / SERVICE_UNAVAILABLE | 按 retryAfterMs 或有界退避等待                 |
| TIMEOUT / CONNECTION_ERROR         | 上游完成状态未知，由调用方决定是否承担重复成本 |
| LOCAL_OVERLOAD / QUEUE_TIMEOUT     | 降低并发或缩小批次，有界退避后重试             |
| CANCELLED                          | 不自动恢复已取消的任务                         |
| UPSTREAM_ERROR / INTERNAL_ERROR    | 根据诊断修正条件，避免盲目重试                 |

retry 为 never、after_backoff 或 caller_decision，是恢复提示而非自动操作。服务始终禁用自动重试。

## 多记录批量与取消

`assess_batch` 接收 1–32 个 `{id, content}` 记录和一套 classifications/scores/checks，支持可选 model。记录 ID 与问题 ID 是独立命名空间，各自不得重复。全部参数先通过 MCP schema 校验；每条记录再进行服务商兼容性校验。记录间不共享内容，也不是 TypeSafe 的离线批处理 API。

返回 `{records: [...]}`。每项为 `{id, status: "ok", result}` 或 `{id, status: "error", error}`，result 与单记录输出契约一致，error 与工具错误详情一致。返回顺序保持输入顺序，仍应按 ID 关联。即使全部记录失败，批量执行的正常返回也使用该逐记录信封；不能只检查顶层 isError。参数非法时才在执行前整体失败。不要把失败记录当成否定判断，也不要假设失败请求没有产生费用。

批量记录共享进程内调度器。队列满返回 `LOCAL_OVERLOAD`，排队过期返回 `QUEUE_TIMEOUT`；两者表示该记录未发送上游，`retry` 为 `after_backoff`。并发配置及调优见 [性能与负载控制](performance.md)。

MCP 取消信号贯穿队列和 SDK：移除等待项、取消进行中的请求、停止提交批量剩余项。SDK 的单请求超时仍从开始执行计算；它不包含排队，也不是整个 batch 的期限。宿主的整体超时应按批量规模设置，或缩小批次。单个 `assess_batch` 必须等待该批记录全部结束才返回，不是流式结果接口。

## 接入与适配

调用方使用统一工具参数和返回结构；供应商配置与适配细节集中在 [供应商接入](providers.md)。不能无损兼容的输入会返回 `INVALID_REQUEST` 和具体 `action`，不会自动改变判断含义。Skill 只描述 Jev 能力、公共 MCP 契约和通用恢复规则。

## 参考

- [TypeSafe HTTP Reference](https://docs.typesafe.ai/api)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Advanced structure](https://docs.typesafe.ai/primitives/advanced)
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
