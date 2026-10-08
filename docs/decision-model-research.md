# 决策模型契约核验

核验快照：2026-10-08。协议和模型事实限于下列来源及对应部署方式；配置与字段映射见 [供应商接入](providers.md)，扩展实现见 [适配架构](adapter-architecture.md)。

| 产品                    | 官方契约                                                                                                                                                                                                                | 接入差异                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| TypeSafe Jev            | [System One HTTP API](https://docs.typesafe.ai/api)、[模型](https://docs.typesafe.ai/models)                                                                                                                            | text/JSON；choice、score、noul                                         |
| OpenAI Decisions        | [Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)、[创建 API](https://developers.openai.com/api/reference/resources/decisions/methods/create)                                                   | typed string/boolean 候选、user 图文消息、带标签评分、逐题 refusal     |
| OpenRouter Decisions    | [Alpha schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md)、[目录 API](https://openrouter.ai/docs/api/api-reference/models/get-models)                                   | 相似判断语义，响应测量可省略；目录标签不决定 wire 协议                 |
| Workers AI Clef / Flash | [Clef](https://developers.cloudflare.com/workers-ai/models/clef/)、[Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)、[REST](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) | HTTP 成功/失败信封及端点特定的图片、数量、字节限制                     |
| 自托管 Clef             | [模型卡](https://huggingface.co/Cloudflare/clef)、[Python 实现](https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py)                                                                                 | 本地 callable 接受 PIL 图片、视频帧及媒体处理 kwargs，不是 HTTP server |

## OpenAI 的发布与语义

[官方更新记录](https://developers.openai.com/api/docs/changelog) 确认 2026-10-06 发布 public beta；该核验日期的支持模型为 [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna)，不将 beta 表述为 GA。

`/v1/decisions` 与 OpenRouter Alpha Decisions 是独立协议。字符串和布尔候选具有不同身份，`true` 与 `"true"` 不能合并为同一个 key；评分以零基等级索引的概率期望表达，可为小数；逐题 refusal 不使其他答案失效。原生输入为文本或 user 图文消息，MCP 的 JSON 条目由适配器显式序列化为文本。

[Models API](https://developers.openai.com/api/reference/resources/models/methods/list) 不提供 Decisions 能力筛选。账户目录与已核实型号求交集仍是不完整发现，不证明端点访问或其他 GPT 的支持。用户提供的 [Hugging Face 社区文章](https://huggingface.co/blog/sora-2/what-is-openai-decisions-api-a-practical-guide) 使用 illustrative pseudocode，不作为实现依据。

## 同名模型与字段不能跨部署推断

OpenRouter 的 decisions 模态目录可含不同请求协议。[Tev1](https://openrouter.ai/togethercomputer/tev1-4b-experimental) 使用 Chat Completions 和有限字母回答；[Perplexity Decider](https://openrouter.ai/perplexity/pplx-decider-v1-27b) 使用原生多问题协议，公开型号说明有 128 问题上限。通用 Decisions schema 不提供全局问题数或全部型号的选项上限，不能复制 Jev 限制。

Workers Clef 的 HTTP 媒体契约与自托管 Python callable 分开验收；后者的 PIL 视频帧和 media_kwargs 不能据模型名称传给 Workers。普通 chat/vLLM 服务也不自动具备原生决策 head。

[TypeSafe confidence](https://docs.typesafe.ai/confidence) 的 Choice 和 Score 定义不同于自托管 Clef 的最大概率；Workers 与 OpenAI 的具体公式未在本次契约核验中建立。服务原样保留数值；跨模型/部署使用阈值需分别校准。

## 证据范围

仓库契约测试与 MCP 实验验证本地编码、解码、能力拒绝及进程交接。OpenAI 未完成真实密钥推理；Clef Python 使用真实进程与 Pillow，但后端为合成实现，未加载真实权重或执行 GPU 推理。该证据不支持在线吞吐、成本收益或质量等价结论。
