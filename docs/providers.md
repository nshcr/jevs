# 供应商接入

供应商配置、适配差异和验证范围以本文为唯一维护入口。MCP 工具与 skill 使用统一契约；部署者选择端点与凭据，适配层处理路径、封装、模型目录和已知输入限制。

## 配置与验证范围

在实际运行 MCP 的进程环境设置 `TYPESAFE_API_KEY`（对应供应商的密钥）及 `TYPESAFE_BASE_URL`。`TYPESAFE_DEFAULT_MODEL` 可选；未设置时服务按下表选择默认值，工具参数 `model` 可以覆盖。切换供应商时同步删除旧的模型环境变量或改为对应 ID。不要把凭据放进工具参数或 Git。

| 供应商                | TYPESAFE_BASE_URL                                             | 默认模型            | 本项目验证范围                                                      |
| --------------------- | ------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| TypeSafe              | `https://api.typesafe.ai`（默认）                             | `jev-latest`        | 官方 SDK/协议及本地模拟测试；未记录直连推理实测                     |
| OpenCode Zen          | `https://opencode.ai/zen`                                     | `jev-1.13`          | 已有 `jev-1.13-free` 真实调用和兼容性回归测试                       |
| Vercel AI Gateway     | `https://ai-gateway.vercel.sh/typesafe`                       | `typesafe-ai/jev`   | 当前配置账户的目录、Choice/Score/Noul、混合判断与双记录批量实测通过 |
| OpenRouter            | `https://openrouter.ai/api`                                   | `typesafe/jev-1.13` | 官方 SDK 契约核对及模拟适配测试；未真实调用                         |
| Cloudflare AI Gateway | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai` | `typesafe/jev`      | 官方文档核对及模拟适配测试；未真实调用                              |

表中是本服务接受的基础地址，不是完整推理 URL；不要自行追加 `/v1`、`/systemone` 或 `/run`。无效 URL 或已知端点的错误基础路径会在调用前返回 `NOT_CONFIGURED` 和修正提示；输入内容不受支持则为 `INVALID_REQUEST`。自定义 TypeSafe 兼容地址仍可使用，但需自行验证。价格、免费额度、模型别名和账户可用性可能变化，以上状态不构成在线可用性保证。

## TypeSafe

官方 SDK 使用 Bearer 密钥，发送 `POST /v1/systemone`，通过 `GET /v1/models` 发现模型。推理包含 `model/state/questions`，返回 `model/answers/usage`。MCP 保留原始判断数值并校验 ID、类型、概率与评分，不引入聊天补全或文本解析。

来源：[HTTP API](https://docs.typesafe.ai/api)、[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)。

## OpenCode Zen

使用 Zen 密钥；真实推理路径为 `/zen/v1/systemone`，模型目录为 `/zen/v1/models`。需要限时免费模型时显式设置 `TYPESAFE_DEFAULT_MODEL=jev-1.13-free`；默认 `jev-1.13` 不承诺免费。模型名不带 OpenCode 客户端配置中的 `opencode/` 前缀。

已落地的适配：

- 将 `{object: "list", data: [...]}` 模型目录转换成 MCP 模型卡，只保留 Jev；缺失描述和发布日期为空，不把目录创建时间当成发布日期。
- 顶层 null content、null 评分等级、question/yes/no 全为 null 的 check 在发送前拒绝；嵌套 null 与 null Choice 描述保留。
- 针对实测的两位小数响应，以 ±0.005 舍入区间校验概率与评分；要求存在合法的底层分布及一致评分。返回原值，不归一化概率或重算 score。其他端点继续严格校验，不能凭猜测放宽。

来源：[Zen Jev 与模型目录](https://opencode.ai/docs/en/zen/#jev)。

## Vercel AI Gateway

使用 AI Gateway 密钥。必须选择 `/typesafe` 兼容入口，SDK 继续使用 `noul` 与 TypeSafe 请求/响应。Vercel 另外提供 `/v1/evaluate` 和 AI SDK 的 `boolean` 形式；它们不是此 MCP 的接入路径，不应混用。

当前配置账户的模型目录返回 1 个模型；配置别名 `typesafe-ai/jev` 未出现在目录中，但推理响应成功返回该别名。Choice、Score、Noul、含结构化字段的混合判断以及两条记录的批量检查均通过 MCP 契约校验。目录与推理是独立请求，需分别检查。其他账户仍须自行验证凭据和访问权限。

当前配置账户返回的 Score 概率与分数舍入到两位小数。适配器仅对 Vercel `/typesafe` 路径启用有界舍入区间校验，要求存在相容的底层概率分布和分数，并保留供应商原值，不归一化或重算。当前实测只覆盖本地配置账户，不构成其他账户的可用性承诺。

来源：[TypeSafe 兼容入口公告](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)。

## OpenRouter

使用 OpenRouter 密钥。模型存在不代表它使用聊天补全：官方 SDK 的 Jev 示例走 `alpha.decisions.create`。本适配器将 SDK 的推理路径改为 `/api/alpha/decisions`，保留 TypeSafe 形状的正文与响应；模型目录仍使用 `/api/v1/models`，只保留 `typesafe/jev-` 系列。

按官方 SDK schema 提前拒绝 null content、null question 和 null 评分等级。Choice 描述可为 null；check 的 yes/no 可以一起省略，但一旦提供，须同时为非 null。嵌套 JSON 不因这些顶层限制被压平成文本。

这是 Alpha API，未来可能变化；尚未完成真实推理、账户计费和响应精度验收。目录中的 `created` 不作为模型发布日期。

来源：[官方示例](https://openrouter.ai/labs/jev/compile)、[官方 SDK 路由](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/funcs/alphaDecisionsCreate.ts)、[请求 schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsrequest.ts)、[问题 schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsnoulquestion.ts)、[响应 schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsresponse.ts)。

## Cloudflare AI Gateway

使用实际 Account ID 替换地址中的 `ACCOUNT_ID`，将 Cloudflare API Token 放入 `TYPESAFE_API_KEY`。这里使用 AI Gateway 统一 REST API；`typesafe/jev` 是第三方模型，经 Unified Billing 计费，不是 `@cf/` Workers AI 托管模型。

默认路由到该账户的默认 AI Gateway。需要指定 gateway 时，在 MCP 宿主环境设置 `CLOUDFLARE_AI_GATEWAY_ID`，服务将其作为 `cf-aig-gateway-id` 请求头发送，Codex plugin 已转发该环境变量。无需提供 TypeSafe 或 OpenRouter 的密钥。

注意权限名与产品名不同：官方要求 `/accounts/.../ai/*` 的 Token 具有 Account > Workers AI > Read，即使请求第三方模型也一样；只有 AI Gateway 管理权限会返回 401。账户还需有可用额度。

适配器发送 `POST .../ai/run`，将 SDK 正文改为 `{model, input: {state, questions}}`。接受 Jev 的直接输出，或标准 REST `{success: true, result: ...}` 信封；失败信封不会当成有效判断。模型列表使用 `.../ai/models/search?search=typesafe%2Fjev&per_page=100&format=openrouter`，只保留 `typesafe/jev`。若返回满页，拒绝将它作为完整目录，不额外发起无界翻页。

未将其他供应商的 null 限制或舍入容差套用到这里；文档样例不能证明所有边界输入、响应精度和账户条件。正式使用前需用目标账户验收。网关配置的缓存、日志、限流等规则会生效；MCP/SDK 不重试不代表网关自身没有配置重试。

来源：[AI Gateway REST API、鉴权与 gateway 选择](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)、[Jev 模型及请求格式](https://developers.cloudflare.com/ai/models/typesafe/jev/)、[模型检索 API](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/)。

## 适配边界与验收

服务继续使用官方 TypeSafe JavaScript SDK。适配只作用于明确的 origin 和路径；鉴权、30 秒请求超时、取消及 HTTP 错误仍由 SDK 处理，MCP/SDK 不自动重试，不改写非成功 HTTP 响应；远端网关策略由部署者另行确认。不凭空生成模型卡、token 用量或缺失答案。无法无损接受的输入返回 `INVALID_REQUEST`；成功 HTTP 响应未满足公共契约时返回 `INVALID_RESPONSE`。

模拟测试覆盖路由、请求封装、模型过滤、输入拒绝、错误和取消，只证明适配逻辑。新账户真实验收应分别检查模型目录、Choice/Score/Noul、混合结构与独立记录批量，以及结构化输入和错误恢复；记录实际 model/usage 与失败。上表标为未实测的供应商仍没有在线调用证据，不能用模拟通过代替。
