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

响应校验检查必填字段和类型、问题 ID 与判断类型是否匹配，以及结果能否映射到公共输出。概率、置信度、评分、token 用量只检查为数字；不限制数值范围，不校验概率和、最高概率候选、评分与概率的关系，也不要求供应商回显的概率键或 legend 与请求完全一致。数字和供应商返回的 legend 原样保留，不归一化、不舍入、不重算。

新增上游字段不进入公共结果。单记录评估的契约错误使该记录整体失败，不交付部分答案；`assess_batch` 保留其他记录的成功结果。所有工具声明 outputSchema；成功时结构化内容和 JSON 文本一致。

## 失败与恢复

先检查 `isError`。上游或配置错误的 `content[0].text` 为 JSON：

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "upstreamCode": "rate_limit_exceeded",
    "message": "Model service returned HTTP 429.",
    "action": "Wait before retrying within the caller budget.",
    "retry": "after_backoff",
    "status": 429,
    "retryAfterMs": 2000
  }
}
```

错误结果没有成功 structuredContent。`code` 是稳定的 MCP 分类码；`upstreamCode` 在 HTTP 错误体包含可识别的顶层或嵌套代码时出现。完整上游正文不回显。`status` 和 `retryAfterMs` 按需出现。MCP SDK 参数错误可为普通文本，不必符合此 JSON 格式。

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

推理请求沿用 TypeSafe SDK 的重试策略，不额外禁用或实现第二层重试；当前 SDK 默认最多重试两次，并对配置的 HTTP 状态、连接错误和超时重试。`retry` 是 SDK 最终返回错误后的恢复提示，不会在 MCP 层自动触发重试。

## 多记录批量与取消

`assess_batch` 接收 1–32 个 `{id, content}` 记录和一套 classifications/scores/checks，支持可选 model。记录 ID 与问题 ID 是独立命名空间，各自不得重复。全部参数先通过 MCP schema 校验；每条记录再进行服务商兼容性校验。记录间不共享内容，也不是 TypeSafe 的离线批处理 API。

返回 `{records: [...]}`。每项为 `{id, status: "ok", result}` 或 `{id, status: "error", error}`，result 与单记录输出契约一致，error 与工具错误详情一致。返回顺序保持输入顺序，仍应按 ID 关联。即使全部记录失败，批量执行的正常返回也使用该逐记录信封；不能只检查顶层 isError。参数非法时才在执行前整体失败。不要把失败记录当成否定判断，也不要假设失败请求没有产生费用。

批量记录共享进程内调度器。队列满返回 `LOCAL_OVERLOAD`，排队过期返回 `QUEUE_TIMEOUT`；两者表示该记录未发送上游，`retry` 为 `after_backoff`。并发配置及调优见 [性能与负载控制](performance.md)。

MCP 取消信号贯穿队列和 SDK：移除等待项、取消进行中的请求、停止提交批量剩余项。SDK 的单请求超时仍从开始执行计算；它不包含排队，也不是整个 batch 的期限。宿主的整体超时应按批量规模设置，或缩小批次。单个 `assess_batch` 必须等待该批记录全部结束才返回，不是流式结果接口。

## 参考

- [TypeSafe HTTP Reference](https://docs.typesafe.ai/api)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Advanced structure](https://docs.typesafe.ai/primitives/advanced)
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
