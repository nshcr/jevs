# MCP 契约

## 输入与能力

核心输入描述业务判断，不包含供应商 HTTP 正文。`classify`、`score`、`check` 接收一份证据与 `items`；`assess_structure` 使用 `classifications`、`scores`、`checks`；`assess_batch` 使用共享判断与独立 `records`。所有评估工具接受可选 `model`、`allowUnverifiedModel` 和支持时的 `safetyIdentifier`；每份证据可为 `content` 或 `messages`，可选图片、视频与媒体处理参数属于该份证据，批量时属于各自记录。

每个评估请求至少一个判断。分类至少一个选项、评分至少一个有序等级（部分供应商要求至少两个）；上限属于供应商能力，不在全局 MCP schema 固定为 Jev 的 255/10。`provider_info({model})` 和模型卡声明 `maxQuestions`、`maxOptions`、`maxScoreLevels`、`maxImages` 等已知限制，未提供上限不表示无限。

ID 不得为空白、重复或为 `__proto__`；问题与标准中的 JSON 键 `__proto__` 也会被拒绝，避免解析器静默丢弃数据。普通 `constructor` 字段保留。问题 ID 在全部组间唯一，批量记录 ID 有独立命名空间。供应商可进一步限制 ID 字符与长度。

每份证据必须在 `content` 和 `messages` 中二选一；`question` 必填。`content`、`question` 可为字符串、对象、数组或 null；嵌套 JSON 支持数字和布尔值，顶层不接受裸数字或布尔值。标准也保留结构化 JSON。OpenAI 原生字段只接受文本，其适配器明确用 JSON 序列化传递对象、数组和 null；字符串保留原文，不压平 JSON 字段。其他协议保留原生 JSON 或拒绝不支持的输入。

分类 `options` 可以是 `{label: description}`，也可以是 `[{value, description?}]`。数组值为字符串或布尔值，按类型保证唯一；`true` 与 `"true"` 是两个选项。布尔选项要求 `typedChoices: true`；字符串协议在发送前拒绝布尔值，不转换成字符串。描述仍接受 text/JSON/null，省略描述时由各适配器映射原生可选字段。

`images` 为 data URL 字符串或 `{content_type, base64, detail?}`，MCP 接受 MIME `image/png`、`image/jpeg`、`image/webp`、`image/gif`，具体支持范围由适配器验证。OpenAI 支持 inline base64 图片，GIF 由上游限制为非动画；Workers Clef 不接受 GIF。服务不获取远程 URL；只有相应图片能力的 provider 接受图片。`cloudflare-workers` 的数量、字节、请求大小与像素限制见 [供应商接入](providers.md#cloudflare-workers-ai-clef)。音频和自由文本生成不在工具契约中。

`messages: [{parts: [...]}]` 表达有序 user 消息；parts 为 `{type: "text", text: string}` 或 `{type: "image", image: ImageInput}`，每条消息至少一个 part。它要求 `messages: true`，并与 `content`、顶层 `images`、`videos` 互斥；不能用此字段传 system/assistant/tool 角色或原始 API 正文。OpenAI 原生保留消息与 parts 次序，最多 128 张图片跨全部消息计数。图片对象的 `detail` 为 `low`、`high`、`auto`、`original` 或 null，要求 `imageDetail: true`；省略时使用上游默认值。

评分的可选 `levelLabels: string[]` 必须与 `levels` 等长，要求 `labeledScores: true`；OpenAI 将它们编码为原生等级标签，省略时使用零基索引的字符串。可选 `safetyIdentifier` 为最多 128 字符的字符串或 null，要求 `safetyIdentifier: true`，原样映射为上游安全标识，不作为认证身份。

仅本地 `clef-python` 支持 `videos: [{frames: ImageInput[]}]`，每段视频至少一个有序帧；Python 桥把帧解码为 PIL 图片。`mediaOptions` 为 JSON 对象，要求 `mediaOptions: true`，映射官方 callable 的 `request.media_kwargs`，用于媒体处理参数，不是任意 wire、模块、shell 或工具执行入口。它们可与旧 `content`、`images` 组合，不与 `messages` 组合。Workers HTTP 与 OpenAI 不接受这些字段。

同一请求的问题彼此独立，不能读取其他问题的答案。支持混合问题的适配器将单记录发为一次上游请求；需要前次答案的流程由调用方分阶段构造。

## 输出

单记录评估成功返回 `{provider, protocol, model, results, responseId?, upstreamProvider?, usage?}`：

- classification：`{id, kind: "classification", value, confidence?, probabilities?}`，value 保留字符串或布尔值；概率为原有 `{label: probability}` 或带类型的 `[{value, probability}]`，不能转为会丢失值类型的 map。
- score：`{id, kind: "score", value, confidence?, probabilities?, levels?, levelProbabilities?}`。OpenAI 的 `levelProbabilities` 保留 `[{value: 零基索引, label, probability}]`。
- check：`{id, kind: "check", probability?, value?}`，至少提供肯定概率或布尔值之一。
- refusal：`{id, kind: "refusal", judgment: "classification" | "score" | "check"}`，保留原题类型，要求适配器声明 `refusals: true`。它是正常逐题拒答，其余题结果仍保留；没有伪造 value、概率、分数或拒答原因。
- usage：`{inputTokens?, outputTokens?, cachedInputTokens?, cacheWriteTokens?, reasoningTokens?, totalTokens?, cost?}`，供应商未提供时省略字段或整个对象。

`responseId` 与 `upstreamProvider` 保留可映射的上游请求 ID 与供应商标识；`usage.cost` 原样保留，不换算货币或推定计费单位。按 ID 关联，不依赖数组顺序。实际模型可能是别名解析后的版本。System One 评分通常为从 0 开始的有序等级期望位置，可为小数；解释分数时同时保留标准与提供商。check 的概率不会自动变成布尔值，布尔值不会自动伪造成 0 或 1 概率。

响应校验检查问题 ID、判断类型及输出必要形状。概率、置信度、评分、token 用量保留供应商数值；不归一化、舍入、重算，不校验概率和、最高概率候选或评分的数学关系。缺失概率、置信度、legend 与 usage 保持缺失；模型之间的 confidence 不保证同义，也不保证校准。

新增上游字段不进入公共结果。单记录契约错误使该记录整体失败，不交付部分答案；`assess_batch` 保留其他记录成功结果。`protocol` 标识本次适配器，不推断实际模型的统计语义。适配实现返回的显式协议必须与所选模型的声明一致，否则为 `INVALID_RESPONSE`；缺失时由声明补充。实际模型别名解析不受此限制。Tev1 返回标签而无概率；即使 chat 响应带 token logprobs 也不转为概率分布。所有工具声明 outputSchema；成功时 MCP 结构化内容和 JSON 文本一致。

## 供应商与模型发现

`provider_info` 接受可选 `{model}`，省略时查询默认模型。返回 `{provider, protocol, defaultModel, model, availability, capabilitySource, capabilities, toolSupport?, unverifiedModelsAllowed?, reason?}`。能力包含判断类型、输入模态、是否支持混合问题、可选 `typedChoices`、`refusals`、`messages`、`imageDetail`、`labeledScores`、`safetyIdentifier`、`mediaOptions`、已知数量上下限，以及 `confidence: "provider-defined" | "unavailable"`。`capabilitySource` 为 `model`（精确模型）、`protocol`（协议基线）或 `configuration`（部署者配置）；未知模型标为 `unverified`，基线不等于全部模型能力。`toolSupport` 分别为 `classify`、`score`、`check`、`assess_structure`、`assess_batch` 给出 `supported | unverified | unsupported`；它说明该模型的工具适用性，不保证每个参数组合都支持。工具发现仍返回全集，评估时按实际所选型号检查。未知精确型号默认拒绝执行；单次 `allowUnverifiedModel: true` 或宿主 `JEVS_ALLOW_UNVERIFIED_MODELS=true` 允许显式尝试其协议基线，`unverifiedModelsAllowed` 报告宿主设置。`unsupported` 型号及不支持的输入、问题类型或限制不受覆盖参数放宽。这是本地配置描述，不发送推理，不证明账户访问权限。

`list_models` 在此基础上返回 `source: remote | configured`、`complete` 与 `models: [{id, availability, capabilitySource, protocol?, capabilities?, description?, reason?}]`。目录来源和完整性不代表账户能推理；configured 是宿主配置的目录，不是实时发现。OpenRouter 的 decisions 模态目录可含聊天协议模型，协议由精确型号解析；别名可能变化，保留实际返回 model。

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

错误没有成功 structuredContent。`code` 为稳定 MCP 分类码；`upstreamCode` 在错误体包含可识别的顶层或嵌套代码时出现。完整上游正文不回显。`status`、`retryAfterMs` 按需出现。MCP SDK 参数错误可为普通文本，不必符合此 JSON 格式。

| 错误码                             | 处理                                          |
| ---------------------------------- | --------------------------------------------- |
| NOT_CONFIGURED / ACCESS_DENIED     | 修正服务器配置、密钥与权限                    |
| INVALID_REQUEST                    | 检查模型协议、能力、选项、标准与输入大小      |
| INVALID_RESPONSE                   | 不使用该记录部分结果，排查契约差异            |
| RATE_LIMITED / SERVICE_UNAVAILABLE | 结合额度原因、retryAfterMs 与预算决定有界退避 |
| TIMEOUT / CONNECTION_ERROR         | 上游完成状态未知，由调用方判断重复成本        |
| LOCAL_OVERLOAD / QUEUE_TIMEOUT     | 降低并发或缩小批次，有界退避后重试            |
| CANCELLED                          | 不自动恢复已取消任务                          |
| UPSTREAM_ERROR / INTERNAL_ERROR    | 根据诊断修正条件，避免盲目重试                |

适配器不自动重试。`retry: never | after_backoff | caller_decision` 只是恢复提示，不会触发额外请求。网关可能有独立重试策略。超时、网络断开或取消不能证明远端未执行或未计费。

## 多记录批量、调度与取消

`assess_batch` 接收 1–32 个 `{id, content?, messages?, images?, videos?, mediaOptions?}` 记录和共享 classifications/scores/checks；每条记录须在 content/messages 中二选一。model、allowUnverifiedModel、safetyIdentifier 是整次批量共享的选择与元信息。全部参数先通过 MCP schema 校验，再按每条记录校验供应商能力。每记录一个上游请求、内容相互隔离，不是供应商离线 Batch API。

返回 `{records: [...]}`，每项为 `{id, status: "ok", result}` 或 `{id, status: "error", error}`；result 与单记录契约一致。顺序保持输入顺序，仍应按 ID 关联。即使所有记录失败，批量成功信封也可能返回；必须逐条检查状态，只重试符合条件的失败记录。

进程内共享有界调度器。`JEVS_REQUEST_TIMEOUT_MS` 默认 30000ms，作用于每次 HTTP 请求或本地运行时评估，不包含 MCP 调度器等待时间，不是整个 batch 总期限。本地 Clef 的 provider 内部串行等待、加载与推理计入同一评估期限；该内部队列的取消或到期仅移除对应请求，活动评估取消或到期才终止 worker。排队上限与期限见 [性能与负载控制](performance.md)。取消移除尚未发送的工作，并传递给活动请求；宿主可能直接观察到取消，未必收到工具结果。

## 本地指导

`decision_guide` 的 `overview`、`patterns`、`examples`、`limits`、`sources` 与 `jevs://guide/<topic>` 资源均来自本地打包文件，不调用模型。工具发现与指导无需密钥；配置 provider 与真实调用按供应商要求处理。凭据只在服务器配置中，服务不检索文件、不持久化输入、不执行返回动作。
