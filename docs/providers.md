# 供应商接入

供应商配置决定连接或本地运行时，所选型号决定协议与能力。配置描述、模型目录和实际推理是不同证据；接入前核对目标账户或本地模型环境。

## 配置

| 环境变量                       | 含义                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `JEVS_PROVIDER`                | `typesafe`（默认）、`system-one`、`openai`、`openrouter`、`cloudflare-workers`、`cloudflare-gateway`、`vercel`、`zen`、`clef-python`、`custom` |
| `JEVS_PROTOCOL`                | 仅 `custom` 使用，选择已注册协议，如 `system-one` 或 `tev1-chat`                                                                               |
| `JEVS_API_KEY`                 | 对应供应商的密钥，留在 MCP 宿主环境                                                                                                            |
| `JEVS_BASE_URL`                | 可选基础地址；`system-one` 和 `custom` 必填                                                                                                    |
| `JEVS_DEFAULT_MODEL`           | 可选默认模型；`system-one` 和 `custom` 必填；工具的 `model` 可覆盖                                                                             |
| `JEVS_ALLOW_UNVERIFIED_MODELS` | 默认 `false`；`true` 允许显式尝试未核实型号，不能放宽 unsupported 或能力限制                                                                   |
| `JEVS_PYTHON_MODEL_DIR`        | `clef-python` 的可信官方模型目录，包含 `joint_schema_model.py` 与权重                                                                          |
| `JEVS_PYTHON_EXECUTABLE`       | `clef-python` 的 Python 解释器，默认 `python3`                                                                                                 |
| `JEVS_REQUEST_TIMEOUT_MS`      | 每次请求期限，默认 30000ms                                                                                                                     |
| `CLOUDFLARE_ACCOUNT_ID`        | Cloudflare 账户 ID；未提供显式完整账户基础地址时必填                                                                                           |
| `CLOUDFLARE_AI_GATEWAY_ID`     | 可选 AI Gateway ID                                                                                                                             |

旧 `TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL`、`TYPESAFE_DEFAULT_MODEL` 不再读取。切换供应商时同步设置或清除基础地址和模型配置。HTTP provider 均可显式使用自定义代理基础地址（HTTP(S)，不含 query、fragment 或嵌入凭据）。URL 不用于推断身份；不要把完整推理 URL 当基础地址，也不要把凭据放入工具参数。

| provider             | 默认基础地址                                                 | 默认模型               | 推理协议                           |
| -------------------- | ------------------------------------------------------------ | ---------------------- | ---------------------------------- |
| `typesafe`           | `https://api.typesafe.ai`                                    | `jev-latest`           | `POST /v1/systemone`               |
| `system-one`         | 必须显式配置                                                 | 必须显式配置           | `POST /v1/systemone`               |
| `openai`             | `https://api.openai.com`                                     | `gpt-6-luna`           | `POST /v1/decisions`               |
| `openrouter`         | `https://openrouter.ai/api`                                  | `typesafe/jev-1.13`    | 由模型决定：Decisions 或 Tev1 chat |
| `cloudflare-workers` | `https://api.cloudflare.com/client/v4/accounts/{account}/ai` | `@cf/cloudflare/clef`  | `POST /run/{model}`                |
| `cloudflare-gateway` | `https://api.cloudflare.com/client/v4/accounts/{account}/ai` | `typesafe/jev`         | `POST /run`                        |
| `vercel`             | `https://ai-gateway.vercel.sh/typesafe`                      | `typesafe-ai/jev`      | `POST /v1/systemone`               |
| `clef-python`        | 本地 Python 进程                                             | `clef`（可由宿主命名） | 官方 Python `systemone` callable   |
| `zen`                | `https://opencode.ai/zen`                                    | `jev-1.13`             | `POST /v1/systemone`               |

`custom` 要求显式基础地址、默认模型和 `JEVS_PROTOCOL`；密钥可省略，已配置则使用 Bearer。只复用已注册协议，不从配置动态加载代码。切换到其他 provider 时清除 `JEVS_PROTOCOL`。例如本地 Tev1 chat 服务可设置 `JEVS_PROVIDER=custom`、`JEVS_PROTOCOL=tev1-chat`、`JEVS_BASE_URL=http://localhost:8080`、`JEVS_DEFAULT_MODEL=local/tev1`，请求路径为 `/v1/chat/completions`。该配置型号默认 `unverified`；部署者确认协议后，还需该次评估 `allowUnverifiedModel: true` 或宿主 `JEVS_ALLOW_UNVERIFIED_MODELS=true` 才会尝试。

默认型号不能保证账户权限或额度。`provider_info({model})` 返回协议、能力、适用状态、能力来源、五工具的 `toolSupport` 和宿主的 `unverifiedModelsAllowed`，不进行推理。工具发现保留全集，调用仍按所选型号校验。

未登记型号默认 `unverified` 并拒绝执行；确认协议后，可在该次评估传 `allowUnverifiedModel: true` 或由宿主设置 `JEVS_ALLOW_UNVERIFIED_MODELS=true` 尝试。该开关不放宽 `unsupported`、不支持的输入或已知限制。

## TypeSafe、System One 与兼容网关

TypeSafe 使用 Bearer 密钥；请求包含 `model/state/questions`，响应包含 `model/answers/usage`。`GET /v1/models` 获取远端目录。Jev 是文本模型；Choice 最多 255 个选项，Score 最多 10 个有序等级。Structured JSON 保留，不压平成文本。来源：[TypeSafe HTTP API](https://docs.typesafe.ai/api)、[模型](https://docs.typesafe.ai/models)。

`system-one` 面向由部署者明确保证协议的自定义服务，要求基础地址和模型。它与 `custom` 均允许显式无密钥服务；它返回配置目录，不能证明远端完整模型集合。没有精确型号证据的 System One 配置同样需要显式允许未核实型号尝试。协议兼容不证明模型具备 Jev 的质量、置信度语义或多模态能力。

Cloudflare 自托管 Clef 的官方代码提供 Python callable；本项目通过独立 `clef-python` provider 桥接，配置与运行边界见下方。普通 chat/vLLM 端点仍不能直接视为 System One 决策 HTTP 服务。

Vercel 采用 `/typesafe` 兼容入口，Zen 采用 `/zen/v1/systemone`，都发送 System One 正文。Vercel 的另一种 `/v1/evaluate` 与 AI SDK `boolean` 形式不是此适配器协议。Zen 默认 `jev-1.13` 不承诺免费，需免费别名时显式选择并核验账户条件。来源：[Vercel 兼容入口](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)、[Zen Jev](https://opencode.ai/docs/en/zen/#jev)。

## OpenAI Decisions

```sh
JEVS_PROVIDER=openai
JEVS_DEFAULT_MODEL=gpt-6-luna
# JEVS_API_KEY 由宿主提供 OpenAI API Key
```

2026-10-08 核验：Decisions API 于 2026-10-06 发布 public beta，官方支持模型为 `gpt-6-luna`。内置 `openai` provider 使用 Bearer 认证和 `/v1/decisions`，协议名为 `openai-decisions`；与 OpenRouter Alpha Decisions 的协议独立。来源：[更新记录](https://developers.openai.com/api/docs/changelog)、[Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)、[Luna 模型](https://developers.openai.com/api/docs/models/gpt-6-luna)。

`classify`、`score`、`check` 分别编码为 `choice`、`score`、`predicate`，支持同次混合请求。上下文、问题和描述中的字符串保持原文；JSON 对象、数组和 null 明确序列化为 JSON 文本，因为原生接口的内容与 instructions 是文本。有 `yes`/`no` 标准的 check 将 `{question, yes?, no?}` 编码为 instructions；省略的标准不补写。评分等级默认依输入顺序命名为字符串索引；可提供与 `levels` 等长的 `levelLabels: string[]` 自定义原生标签，要求 `labeledScores: true`。返回分数是从 0 开始的等级位置，可为小数。

分类 `options` 可为映射或 `[{value: true}, {value: "true"}]`。候选按类型唯一，`true` 与 `"true"` 保持不同；`value` 和原生 `probabilities: [{value, probability}]` 保留类型。布尔候选要求 `typedChoices: true`。OpenAI 要求 2–255 个候选；null/省略描述不发送。评分 `levelProbabilities: [{value, label, probability}]` 保留原生索引与标签。来源：[创建 API](https://developers.openai.com/api/reference/resources/decisions/methods/create)。

拒答是按题返回的正常结果：`{id, kind: "refusal", judgment: "classification" | "score" | "check"}`。该题没有 value/probability，其他答案仍保留；调用方须单独处理，不能替换为 false 或零分。`provider_info` 为该协议声明 `refusals: true`。

支持文本和内嵌图片，最多 128 张（跨全部消息计数）；使用 PNG/JPEG/WebP/GIF data URL 或 `{content_type, base64}` 形式；OpenAI 仅支持非动画 GIF，服务不检查像素或帧数，进一步格式约束由供应商验证。适配器生成 user 消息及 `input_text`/`input_image` parts，不读取远程图片 URL，不支持 file ID、audio 或工具调用。公开 Decisions 契约没有问题数与评分等级数上限，本服务不移植 Jev 或 Clef 的限制。模型上下文与远端请求限制仍适用。图片对象可选 `detail: "low" | "high" | "auto" | "original" | null`，要求 `imageDetail: true`。图片格式来源：[官方图片输入指南](https://developers.openai.com/api/docs/guides/images-vision)。

除原有 `content`/`images` 组合外，可用 `messages` 保留原生 user 消息及图文次序；不能同时提供 content、顶层 images 或 videos：

```json
{
  "messages": [
    {
      "parts": [
        {
          "type": "text",
          "text": "Export fails in Safari but works in Chrome."
        }
      ]
    }
  ],
  "safetyIdentifier": "local-demo-user",
  "items": [
    {
      "id": "severity",
      "question": "How severe is this issue?",
      "levels": ["Cosmetic only", "A workaround exists", "Fully blocked"],
      "levelLabels": ["cosmetic", "workaround", "blocked"]
    }
  ]
}
```

这是 `score` 参数；`messages` 要求相应能力，每个 parts 项为文本或 `{type: "image", image: ImageInput}`。可选 `safetyIdentifier` 为最长 128 字符的字符串或 null，原样映射 `safety_identifier`，不是 API 认证身份。省略可选字段时不造值；不支持额外角色、聊天历史、视频或 `mediaOptions`。

用量保留 `inputTokens`、`outputTokens`、`cachedInputTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`；不推算缺失计费字段、confidence 公式或重算概率。`list_models` 将账户 `/v1/models` 目录与已核实的 Decisions 型号求交集，返回 `source: remote`、`complete: false`；通用 OpenAI 目录不提供 Decisions 能力筛选。未知显式型号为 `unverified`，不按 GPT 名称推断支持。来源：[Models API](https://developers.openai.com/api/reference/resources/models/methods/list)。

## OpenRouter Decisions

```sh
JEVS_PROVIDER=openrouter
JEVS_DEFAULT_MODEL=typesafe/jev-1.13
# JEVS_API_KEY 由宿主提供
```

使用 OpenRouter 密钥；原生决策模型调用 `/api/alpha/decisions`。`GET /api/v1/models?output_modalities=decisions` 获取决策目录，包含 Jev、Clef 与其他厂商的模型；不再按 Jev 名称过滤。目录模态不决定 wire 协议。模型卡标识 supported/unverified/unsupported；Tev1 精确型号使用独立 `tev1-chat`，其他未知型号仍须显式允许尝试。

官方 schema 要求 `state` 与 `instructions` 为 string/object/array，允许 Choice 描述为 null，Score 描述不允许 null；check 的 true/false 标准可以共同省略，提供时必须完整。上游 `id`、`provider` 与 `usage.cost` 可映射保留，不推定 cost 的货币或单位。Choice、Score 的 `confidence`、`probabilities`，Score 的 `legend` 为可选字段；服务保留缺失。通用 schema 没有全局问题数、选项上限或精度保证，具体模型还可能限制请求。

来源：[原生 Decisions API schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md)、[模型目录 API](https://openrouter.ai/docs/api/api-reference/models/get-models)。Alpha 协议可能变化，真实推理、计费与每个模型能力需独立验收。

## Tev1 Chat Completions

在 OpenRouter 设置 `JEVS_DEFAULT_MODEL=togethercomputer/tev1-4b-experimental`，或在工具中传入同名 `model`。模型解析选择 `tev1-chat`，调用 `/api/v1/chat/completions`，不发送 Decisions 正文。

只支持单个 classification、2–24 个选项，问题和选项描述必须是非空字符串；state 的 JSON 结构保留在 user message 内。适配器使用连续 A–X 标签，按本次映射还原原始选项 key。返回值必须是一个完整合法字母，且 chat 响应正常结束。解释文字、截断、拒答或工具调用返回 `INVALID_RESPONSE`，不交付猜测结果。token logprobs 不转换成 confidence 或完整选项概率。

采用 `temperature: 0`、`max_tokens: 8`。发布者建议关闭 thinking；其 Together 私有参数在 OpenRouter 的精确映射尚未核验，因此没有发送猜测字段。`assess_batch` 可使用相同单分类标准处理不同记录，每记录一次请求；不会自动将多问题拆成多次调用。

来源：[OpenRouter Tev1](https://openrouter.ai/togethercomputer/tev1-4b-experimental)、[发布者示例](https://github.com/togethercomputer/tev1/blob/main/examples/decide.py)。同供应商的 [Perplexity Decider](https://openrouter.ai/perplexity/pplx-decider-v1-27b) 则支持原生多问题，已按精确型号记录 128 问题上限。不能跨型号或托管端点复制这些能力。

## Cloudflare Workers AI Clef

```sh
JEVS_PROVIDER=cloudflare-workers
CLOUDFLARE_ACCOUNT_ID=your-account-id
JEVS_DEFAULT_MODEL=@cf/cloudflare/clef
# JEVS_API_KEY 由宿主提供 Cloudflare API Token
```

使用 Workers AI 原生端点，支持 `@cf/cloudflare/clef` 与 `@cf/cloudflare/clef-flash`。完整模型 ID 进入路径，body 中 `model` 使用 `clef` 或 `clef-flash`。响应解析标准 Cloudflare 成功信封；失败信封不当成有效判断。配置目录列出这两个已知模型，`source: configured`、`complete: false` 不代表实时账户访问检查。

公开 Workers schema 限制每请求 1–64 个问题、每 Choice 2–255 个选项、每 Score 2–10 个等级。问题 ID 最大 100 字符，仅允许字母、数字、`_`、`.`、`-`。图片支持 PNG/JPEG/WebP data URL 或 `{content_type, base64}`，最多 4 张；每张解码后 4 MiB/16 MP，合计 8 MiB，请求体 13 MiB。远程 URL 不会被获取。Workers 公开契约未列出视频或 `precision` 参数，本适配器不发送它们。

图片放在单记录 `images` 或批量 `records[].images`，使用有效 data URL 或 `{content_type, base64}`。本地检查格式、数量及字节限制；16 MP 像素限制由 Cloudflare 验证。Workers 的置信度公式未核验，不套用自托管公式。

来源：[Clef schema](https://developers.cloudflare.com/workers-ai/models/clef/)、[Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)、[Workers REST](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)。

## Clef 本地 Python 运行时

```sh
JEVS_PROVIDER=clef-python
JEVS_PYTHON_MODEL_DIR=/absolute/path/to/trusted/clef-release
JEVS_PYTHON_EXECUTABLE=python3
JEVS_DEFAULT_MODEL=clef
# 不需要 JEVS_API_KEY 或 JEVS_BASE_URL；切换时清除原 JEVS_PROTOCOL。
```

模型目录须包含官方 `joint_schema_model.py` 与本地权重；解释器及 Python、Pillow、torch、transformers 等依赖由部署者准备。服务不自动安装包或下载权重，按目录调用官方 `load_release_model` 与 `systemone`。目录属于可执行的可信部署配置，工具参数不能改变目录、模块或解释器。`JEVS_DEFAULT_MODEL` 是宿主给此运行时绑定的 selector，默认 `clef`；可由宿主命名，评估中的 `model` 只能省略或等于这个 selector，不能切换其他模型。

支持旧 `content` 与 text/JSON 判断、嵌入图片、`videos: [{frames: ImageInput[]}]` 和 `mediaOptions`。每段视频至少一帧，图片/帧由 Pillow 解码为 PIL 对象；按输入次序保留视频帧，动画图片由本地 worker 拒绝。`mediaOptions` 是 JSON 对象，原样映射官方 `request.media_kwargs`，用于媒体处理选项；不作为通用请求正文透传。本运行时不接收 OpenAI 的 messages、image detail、safetyIdentifier、levelLabels 或布尔候选。

`JEVS_REQUEST_TIMEOUT_MS` 同样限制本地评估，计入 provider 内部串行等待、模型初次加载与推理，应按部署容量设置。排队中到期或取消只移除该请求，不中断其他活动调用；活动请求到期或取消会终止 worker，后续请求需重新加载。本地运行时串行处理模型请求，MCP 调度与批量隔离仍生效。

Workers HTTP 不继承 Python callable 的视频和媒体选项。来源：[官方模型卡](https://huggingface.co/Cloudflare/clef)、[官方 Python 实现](https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py)。

## Cloudflare AI Gateway

```sh
JEVS_PROVIDER=cloudflare-gateway
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_AI_GATEWAY_ID=your-gateway-id
JEVS_DEFAULT_MODEL=typesafe/jev
# JEVS_API_KEY 由宿主提供 Cloudflare API Token
```

该适配器使用统一 REST API，发送 `{model, input: {state, questions}}` 到账户 `/ai/run`。可选 `cf-aig-gateway-id` 指定网关；未配置时使用账户默认网关。`typesafe/jev` 是 Unified Billing 第三方模型，不是 `@cf/` Workers 模型；原生 Clef 选择 `cloudflare-workers`。Gateway 返回配置默认模型的目录，`source: configured`、`complete: false`；显式其他第三方模型仍须部署者核验 native-compatible 协议与账户访问。

官方要求账户 Token 的 Workers AI Read 权限，即使请求第三方模型也一样；账户还需访问权限与额度。远端网关缓存、日志、限流和重试规则独立生效。来源：[统一 REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)、[Jev 请求格式](https://developers.cloudflare.com/ai/models/typesafe/jev/)。

## 模型发现与数值语义

`list_models` 返回 `source: remote | configured`、`complete` 和各模型的 `availability: supported | unverified | unsupported`，可附能力及原因。`capabilitySource: model | protocol | configuration` 区分精确模型、协议基线和部署者配置；它不代表在线账户验证。`complete` 表示本次目录是否完整，不表示账号能成功推理。配置目录不是实时发现；远端目录也不是质量验收或版本白名单。

结果保留供应商提供的数字，不归一化、舍入或重算，也不为缺失字段造值。TypeSafe Choice confidence 是归一化后的最大概率，Score confidence 描述等级分布集中程度；公开自托管 Clef 使用最大概率；Workers Clef 具体公式未知。跨模型、协议或部署迁移时需要重新校准阈值。来源：[TypeSafe confidence](https://docs.typesafe.ai/confidence)、[自托管 Clef 实现](https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py)。

## 验证范围

契约测试与 MCP 实验覆盖本地协议和进程交接。OpenAI 未完成真实密钥推理；Clef Python 使用真实进程与 Pillow，但后端为合成实现，未加载真实权重或执行 GPU 推理。其他供应商的历史实测不能替代目标账户、模型与当前传输的验证。

部署后应分别核验目录、所需判断、媒体、取消及错误，并保留实际型号和用量。跨模型质量与置信度阈值需用代表性数据验收。
