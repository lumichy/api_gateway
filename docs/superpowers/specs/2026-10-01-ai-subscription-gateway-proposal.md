# AI 订阅统一网关：设计提案

状态：用户已确认；第一版协议、调度及本地验证已交付。真实账号接入仍待验证，详见 docs/verification.md。核查日期：2026-10-01。

## 目标与部署假设

个人单用户本机服务，默认监听 127.0.0.1:8787。客户端固定使用 http://127.0.0.1:8787/v1 和一个 Gateway Key，发送 model=auto。每个账号的订阅和计费池独立；网关按请求能力与可用额度选择供应商，额度耗尽后在同一个请求内尝试下一家。首次登录各官方客户端仍需用户完成，网关不能代替授权。

不承诺所有供应商都公开精确余额，不将调用成功等同于剩余无限，不将本地 token 统计伪装成官方余额。全部供应商不可用时返回 OpenAI 风格 429 与可知的最早重置时间。

## 三种接入方案

1. 推荐：统一网关 + 官方订阅接口/官方 Agent 适配器。符合优先使用已有订阅的目标；需要处理 Agent 与模型接口的语义差异，并为每条接入路径验证实际扣费池。
2. 仅聚合商业 API：协议容易统一，可采用成熟 API 代理，但 API key 的费用通常独立于个人订阅，不满足本项目的主要目标。
3. 包装非公开模型端点：可能接近原生模型协议，但认证、额度字段和兼容性缺少稳定契约。不作为默认设计；没有核实前不启用。

## 官方接入证据与限制

| 来源 | 推荐适配路径 | 额度来源 | 启用条件 |
| --- | --- | --- | --- |
| 火山方舟 Coding Plan | 专用 OpenAI 兼容地址 https://ark.cn-beijing.volces.com/api/coding/v3 | 已核实控制台可查看多窗口额度；尚未确认可供个人账号使用的稳定机器查询接口 | 专用 Coding Plan Key、可用模型及个人使用场景验证；不替换为按量计费端点 |
| CodeBuddy | 官方 codebuddy --serve 的 /api/v1/runs 和 SSE；也可评估 ACP | /api/v1/stats 是使用统计，不能直接认定为套餐剩余积分；余额暂为 unknown | 本地登录、服务版本契约、订阅实际扣费验证、工具禁用能力验证 |
| Claude | 官方 Claude Agent SDK 或 claude -p | 官方可用遥测需进一步核实；初期 unknown + 限额错误和重置时间 | 使用订阅认证，不能误选商业 API Key；额外付费设置需核实 |
| ChatGPT Plus/Pro（Codex） | 优先 codex app-server；亦可评估官方 Sign in with ChatGPT 的 Responses 接入 | account/rateLimits/read 和 account/rateLimits/updated，多额度桶对应到实际请求 | 官方登录、成功推理确认模型权益；SIWC 的可用性与授权单独验证 |
| Google AI Pro/Ultra（Antigravity） | 官方 agy headless 的 stream-json | 官方 /usage 能显示模型额度，但交互式 TUI 不能直接作为稳定机器接口；暂为 unknown | 本地登录、订阅扣费路径、输出协议、工具禁用与关闭额外 credits 验证 |

上述官方 CLI/SDK 的存在证明可程序化调用，不证明所有 OpenAI 参数都等价，也不证明所有调用一定消耗目标订阅。

Claude 官方帮助页的 June 15 更新明确暂停原拟议的 Agent SDK 独立额度方案；当前页面表示 SDK、claude -p 和第三方使用仍计入订阅。不能引用该页下方已撤回方案作为当前规则。

Antigravity SDK quickstart 使用 GEMINI_API_KEY，不能据此声称它使用 AI Pro/Ultra 订阅；优先验证官方 CLI 的缓存登录路径。

## 接口与兼容性

第一版支持 GET /v1/models、POST /v1/chat/completions 的文本多轮对话、非流式及 SSE。发布 model=auto 和显式供应商模型别名；显式别名默认固定供应商，跨家回退仅适用于 auto。

第一版不静默接受 tools、tool_choice、图片、音频、JSON Schema、logprobs 等未实现功能。不支持的参数返回清晰 400；后续扩展由能力矩阵筛选适配器。严格语义参数（如指定温度）不能被无声忽略。POST /v1/responses 作为独立后续兼容模块，未实现前不能宣传全量 OpenAI/Codex 客户端兼容。

Agent 适配器默认关闭本地工具、MCP、扩展和工作区规则加载，使用隔离工作目录。若某官方 Agent 无法关闭工具或正确表达 system/developer/history，该路径暂不参与 auto；不以拼接带角色标签的文本声称无损角色转换。Agent 内部工具事件不能冒充客户端工具调用。

客户端提供完整标准消息历史；网关跨供应商时重放历史。各供应商内部会话隔离，不共享私有 session ID。网关输出统一 id、choices、finish_reason、usage，并在响应头提供请求 ID 和实际供应商。供应商未提供 token 数时不编造 usage。

## 模块与技术栈

推荐 TypeScript + Node.js + Fastify；SQLite 存储额度快照、冷却期、请求状态与审计元数据。订阅 CLI 留在已登录的本机环境，不优先使用会丢失登录与本机运行依赖的容器。

模块：HTTP 协议层、能力筛选、额度采集器、调度器、供应商适配器、状态存储、管理接口。

适配器统一契约：capabilities()、health()、quota()、invoke()、cancel()。invoke 输出标准化内容事件、终态、可选 usage 和分类错误；quota 返回带时间戳与来源的快照。

网关鉴权和管理鉴权分离。凭据通过官方认证存储、环境变量或系统安全存储使用；普通配置只引用凭据名。日志默认不保存消息内容、密钥、OAuth token 或供应商原始错误体。

## 额度数据模型

以 provider/account/model-or-quota-pool 为键。一个池含多个窗口，每个窗口保存 unit、remaining、limit、usedPercent、resetAt、observedAt、source、confidence。freshness TTL 默认 60 秒，可配置。

source 区分 official、manual、estimated、unknown。缺失字段保留 null，不解释为 0 或 100%。本地消耗只修正估算，不覆盖已验证官方余额；外部客户端并行消耗通过重新采集同步。

不同供应商的 token、请求次数、积分不直接相加。可比较时计算各自剩余比例；供应商的有效余量取所有相关窗口中最紧张的窗口。任何相关窗口耗尽，该池停止调度。

## 调度步骤

1. 验证请求语义和鉴权，过滤未登录、禁用、能力不匹配、冷却中、余额确认耗尽的候选。
2. 使用新鲜官方快照计算最紧张窗口的剩余比例，结合安全余量与每家最大并发量，优先余量充足者。比例相同时按配置优先级、健康状态与延迟排序。
3. 已知额度候选优先；余额未知候选保留低优先级回退资格，只描述为 availability-aware，不宣称精确余额调度。
4. SQLite 事务领取请求名额，预留估计预算。Agent 内部可能多次调用，预算为保守估计，不保证跨供应商精确请求数。
5. 发起请求。成功后结算、释放预留并刷新额度。失败时保留已可能消耗的估计并进行分类；不因重试将消耗清零。
6. 启动时回收过期请求租约，恢复未过期额度和冷却状态。进程重启不立即重新尝试明确耗尽的供应商。

## 自动回退和错误分类

quota_exhausted：屏蔽相应模型/额度池直至 resetAt；没有重置时间时进入保守冷却并允许到期后单次探测，探测不是确认额度已重置。

rate_limited：遵循 Retry-After 或指数退避，不解释为所有窗口耗尽。

auth_required：停用该适配器并在本机管理状态提示重新登录。

invalid_request / context_too_large / unsupported：不盲目对所有供应商重试；上下文过长可仅尝试确认能容纳该上下文的候选。

transient upstream errors：在尚未向客户端提交响应且没有发生工具副作用时可回退；每家最多一次，总尝试次数有界，总截止时间默认 120 秒。

在第一次下游 SSE 数据写出前允许回退。流式输出开始后不切换供应商，返回标准化中断错误并关闭流；不拼接两家回答。非流式请求只有完整成功结果才交付客户端。

客户端断开即取消上游任务、停止重试并释放租约。已触发工具副作用的请求不能自动重放；第一版通过禁用 Agent 工具避免该类副作用。

## 额外付费控制

付费商业 API 适配器默认关闭。使用专用 Coding Plan 端点。Antigravity 关闭 useG1Credits 等额外扣费选项。对不能通过官方配置阻止套餐耗尽后付费的路径标为 needs_billing_verification，验证之前不启用自动调度。不承诺仅依赖延迟额度快照即可保证绝对零额外费用。

## 验收标准

- 标准 OpenAI 客户端只配置一次地址与 Gateway Key，model=auto 返回有效文本响应。
- 仿真供应商 A 额度耗尽、B 正常：同一请求转交 B，客户端不改配置。
- 多窗口任一耗尽即排除，模型池之间不错误传播耗尽状态，官方 usedPercent 正确转换为剩余比例。
- 余额 unknown、过期快照、外部用量更新、并发预留、重启恢复均有测试。
- 429 限速和套餐耗尽不同处理；401 要求重新登录；所有候选耗尽返回统一 429。
- SSE 首个数据之前失败可回退；首个数据之后失败不可拼接；断开客户端会取消子进程/Agent run。
- 对全部实际接入的订阅分别做最小实时请求并核对官方扣费记录；未配置账号的适配器显示未验证，mock 测试不替代实际接入验收。
- 交付可运行源码、配置示例、启动脚本、客户端接入示例、mock 测试、故障排查文档和接入状态表。

## 官方参考

- 火山专用端点及额度控制台：https://www.volcengine.com/article/37875
- 火山订阅套餐使用条件：https://docs.volcengine.com/docs/ark/subscription-package-service-terms-conditions?lang=zh
- CodeBuddy HTTP/Agent 接口：https://www.codebuddy.cn/docs/cli/http-api
- Claude SDK 订阅最新说明：https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Codex App Server 与额度 RPC：https://learn.chatgpt.com/docs/app-server
- ChatGPT 订阅授权接入：https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- ChatGPT 订阅 Responses 限制：https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- Antigravity 官方 headless：https://www.antigravity.google/docs/cli/headless/
- Antigravity 额度查看：https://www.antigravity.google/docs/cli/commands/usage/
- Antigravity SDK 的 API key 路径：https://www.antigravity.google/docs/sdk/overview/

## 当前交付状态

已完成空目录及上级指令检查、官方接入研究与设计提案。尚未写实现代码，未运行测试，未登录各家订阅，也未验证实际扣费。等待用户确认第一版文本 Chat Completions 范围及上述官方适配路线后进入实施计划。
