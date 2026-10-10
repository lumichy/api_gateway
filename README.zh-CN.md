# 订阅 AI 网关（subscription-ai-gateway）

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

## 这个工程是干什么的

一个**个人、本机运行的 AI 网关**。它把多个 AI 供应商（订阅账号或 API 服务）收敛成一个 OpenAI 兼容入口：客户端永远只连接 `http://127.0.0.1:8787/v1`。使用 `auto` 时，网关按能力、额度与可用状态选择供应商，并在额度耗尽、限速、认证失败或临时故障时尝试回退。

核心能力：

- **统一入口**：标准 `/v1/chat/completions`，兼容 OpenAI 客户端 SDK，支持流式 SSE
- **自动调度**：按剩余额度打分、冷却隔离、并发预留；非流式请求成功前可按错误类型回退，流式开始输出任何 chunk 后不切换供应商
- **额度遥测**：官方渠道优先采集额度，采集不到就标记 `unknown`，绝不伪造余额
- **按能力调度**：兼容 API 转发 tools、多模态消息和扩展参数；CLI 不支持的请求明确返回 400，auto 只在支持相应请求的供应商中选择

明确的服务边界：这是**单人本机服务**——只监听回环地址、所有客户端共用一把密钥和同一份额度、无会话记忆与粘性路由。不适合多人共用或多租户部署。

技术形态：Node.js ≥ 24 直接运行 TypeScript，**零第三方运行时依赖**（只用 `node:http`、`node:sqlite`、`node:child_process` 等内置模块），无构建步骤。

## 安装

```powershell
git clone <仓库地址> api_gateway
cd api_gateway
```

要求 Node.js 24 或更新版本。没有 `npm install` 步骤——运行时零依赖（`npm install` 仅在开发时安装 TypeScript/Prettier 用于类型检查和格式化）。

验证环境：

```powershell
node --version          # 需要 v24+
node scripts/doctor.ts --config config.example.json
```

`doctor` 是启动前诊断：校验配置文件，检查已启用供应商的可执行文件、凭据环境变量及部分 CLI 的登录状态。它不发推理请求、不显示密钥，也不保证上游连通、模型权限或剩余额度。

## 设定

### 1. 准备密钥

网关使用两把互相独立的长密钥（都要求 ≥ 24 字符）：

- `GATEWAY_KEY`：客户端调用推理接口用
- `GATEWAY_ADMIN_KEY`：管理接口用（查看状态、录入额度、解除封锁）

两把钥匙不能相同——否则任何持有调用密钥的人都能操作管理接口。

配置文件里**只保存环境变量的名字**，密钥本体永远走环境变量，配置文件可以安全提交。推荐用私有环境变量文件（如 `.env.local`，已排除提交）：

```
GATEWAY_KEY=一串至少24字符的随机值
GATEWAY_ADMIN_KEY=另一串至少24字符的随机值
```

### 2. 编写配置文件

复制模板并编辑：

```powershell
Copy-Item config.example.json config.local.json
```

顶层字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 只允许 `127.0.0.1` 或 `::1`，其他值启动即失败 |
| `port` | `8787` | 1–65535 |
| `statePath` | `data/gateway.sqlite` | SQLite 状态库；相对路径以配置文件所在目录为基准 |
| `gatewayKeyEnv` / `adminKeyEnv` | `GATEWAY_KEY` / `GATEWAY_ADMIN_KEY` | 环境变量名 |
| `timeoutMs` | `120000` | 单请求总预算（含全部回退尝试），100–600000 |
| `quotaTtlMs` | `60000` | 额度快照新鲜度，100–3600000 |
| `providers` | — | 供应商列表，1–32 个 |

当前 `config.example.json` 包含本机配置的模型、开关和可执行路径，不是全部关闭的通用模板。复制到另一台机器后，需要核对路径、环境变量和启用项；密钥本体仍只存在于私有环境文件中。

每个供应商的公共字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一小写标识，也是路由别名的前缀（`id/model`） |
| `type` | `openai-compatible` / `codex` / `claude` / `codebuddy` / `antigravity` |
| `models` | 模型列表（1–64 个）；`openai-compatible` 可含 `/`（如 `nvidia/model:free`），其他类型禁止 `/`。`auto` 使用列表中的首个模型 |
| `enabled` + `billingVerified` | **双开关，必须同时为 `true` 才会启用**。后者表示操作者已核实预期计费路径：CLI 使用目标订阅；API 使用目标账户的免费额度或已接受的 API 计费 |
| `allowAuto` | 是否参与 `auto` 自动调度（见各类型说明） |
| `priority` | 同分时数值小者优先，0–10000，默认 100 |
| `maxConcurrency` | 该供应商的最大并发请求数，1–32，默认 1 |

实现中真实供应商默认关闭，但配置文件可以显式启用。CLI 启用前完成官方账户登录、确认模型可用及额外按量付费设置；API 配置有效密钥并核实模型权限与计费，再设置两个开关。

当前本机磁盘配置（2026-10-10）：

| Provider | `enabled` | `auto` 使用的首个模型 | `priority` |
| --- | --- | --- | --- |
| Ark | `true` | `deepseek-v4.1-flash` | 5 |
| Agnes | `true` | `agnes-3.0-flash` | 5 |
| OpenRouter | `true` | `nvidia/nemotron-3-ultra-550b-a55b:free` | 100 |
| CodeBuddy / Antigravity / Codex / Claude | `false` | 不参与调度 | 按各自配置 |

全部 7 个 Provider 已配置 `allowAuto: true`、`maxConcurrency: 3`；关闭的 Provider 仍不参与调度。OpenCode Zen 已从本机配置移除。`config.example.json` 仍保留上次同步时 OpenRouter 关闭、首个模型为 `openrouter/free` 的设置；以实际启动时指定的配置文件为准。

### 3. 启动

```powershell
node --env-file=.env.local src/main.ts --config config.local.json
```

启动后监听 `http://127.0.0.1:<port>/v1`。网关密钥缺失、配置字段非法或 API 端点格式不合法会导致启动失败；Provider 密钥、CLI 登录/版本及模型权限等问题还会在健康检查或实际调用时暴露。

**修改 `config.local.json` 或 `.env.local` 后需要重启进程**，当前没有配置热加载。重启前让正在处理的请求完成，再停止旧进程并运行上述启动命令。磁盘配置可能与运行中的配置不同，`GET /admin/status` 和 `GET /v1/models` 可用于确认实际启用状态。额度录入、额度刷新和解除冷却通过管理接口即时生效，不需要重启。

### 4. 客户端接入

以 OpenAI Python SDK 为例：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="你的 GATEWAY_KEY")
result = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "解释一下网关的回退机制"}],
)
print(result.choices[0].message.content)
```

`model` 的三种写法：

| 写法 | 行为 |
| --- | --- |
| `auto` | 网关按额度/冷却/优先级自动选择（受 `allowAuto` 约束） |
| `id/model`（如 `claude/sonnet`） | 锁定该供应商，失败直接报错，不回退 |
| 其他 | 400 |

响应头 `x-gateway-provider` / `x-gateway-model` 标明实际服务方；响应体 `model` 保留客户端传入的别名（包括 `auto`）。有已知重试时间的错误带 `retry-after` 头。

### `auto` 的选择顺序

1. 只考虑同时启用、已核实计费且 `allowAuto: true` 的 Provider，使用每家的 `models[0]`，不在同一家模型列表内随机轮换。
2. 在健康检查与额度查询前筛选请求能力。工具、多模态或生成参数等扩展请求只交给兼容 API；CLI 不会因 `auto` 自动获得这些能力。
3. 排除健康检查不通过、处于冷却或已知额度为零的候选。缺少或过期的非人工额度会尝试查询；查询失败保持未知，不自动认定额度耗尽。
4. 新鲜的已知额度优先于未知额度。多个额度窗口取剩余比例的最小值作为分数，分数高者优先；同分或均未知时按 `priority` 从小到大，再按 Provider ID 字母顺序排列。
5. 按排序尝试取得并发与预算预留；当前 Provider 已满时尝试下一家。每家至多尝试一次。可回退错误继续尝试，参数错误或不支持错误直接返回；流式开始输出后不能切换。

例如当前磁盘配置中，OpenRouter 若成功读取到新鲜、非零的免费每日请求额度，会排在额度未知的 Agnes 和 Ark 前，即使它的 `priority` 是 100。若三家额度均未知，则顺序为 Agnes → Ark → OpenRouter；Agnes 与 Ark 同为 5，按 ID 排序。该顺序会随额度、冷却、并发和请求能力改变。

## 供应商配置

五种供应商类型。CLI 系（claude / codebuddy / antigravity / codex exec）共享一组硬约束：

- **单轮语义**：只接受一条 user 消息 + 可选的一条前置 system 指令；`auto` 的多轮请求会筛选到支持结构化历史的供应商（openai-compatible / codex responses）。显式 CLI 别名不回退，直接拒绝不支持的历史
- **版本相关**：Claude、Codex exec 使用已验证固定版本，Antigravity 使用已验证版本白名单；CodeBuddy 检查 CLI 可执行状态并验证实际事件协议，升级后同样需要重新核对
- **参数白名单**：`command` 只能是 node.exe 或原生可执行文件（禁 shell 和 `.cmd`），`args` 只能是一个绝对路径的 JS 入口——运行时 flags、设置覆盖、内嵌 prompt 一律拒绝
- **运行时验证**：CLI 通过工具禁用参数、专用空工具 Agent 与事件检查隔离工具。出现实际工具调用或违反对应 adapter 契约的初始化信息时拒绝；Antigravity 的全局工具目录不等于所选 Agent 的工具权限

---

### openai-compatible —— 通用 API 接入与扩展点

**这是网关的扩展性所在：任何"Bearer 密钥 + OpenAI Chat Completions 协议"的 HTTP 服务，都只需写一段配置即可接入，零代码改动。**

```json
{
  "id": "ark",
  "type": "openai-compatible",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
  "apiKeyEnv": "ARK_CODING_API_KEY",
  "models": ["deepseek-v4.1-flash", "glm-5.3-flash", "doubao-seed-2.1-lite"],
  "quotaSource": "ark-cli",
  "allowAuto": true,
  "enabled": false,
  "billingVerified": false,
  "priority": 10,
  "maxConcurrency": 3
}
```

要点：

- `baseUrl` 填 **API 根路径**，网关自动追加 `/chat/completions`；URL 会经过安全校验（仅 http/https、禁止内嵌凭据/查询串/锚点），并拒绝跟随重定向
- **推理使用同一个通用 adapter**——火山方舟、OpenRouter、Agnes 等只通过配置指定端点和密钥；没有按 Provider ID 选择的专用推理类型。可选额度采集另有官方来源约束
- 完整消息能力：结构化多轮历史 + system 指令原样转发（协议对齐，零翻译）
- **`allowAuto` 默认 `false`**：API 计费服务按 token 收费，被回退链意外选中会产生真实账单，所以必须显式写 `true` 才参与自动调度；显式别名（`id/model`）不受此限制

**额度遥测扩展**。默认额度为 `unknown`（调度时按 `priority` 排序）。可选配置 `quotaSource` 接入官方遥测：

| `quotaSource` | 额度来源 | 额外要求 |
| --- | --- | --- |
| `"openrouter"` | 官方 key 接口：免费模型每日请求数，以及 API key 的 USD 用量/消费上限 | `baseUrl` 必须是官方 `https://openrouter.ai/api/v1`；USD 数据不等同于钱包余额，也不代替免费请求余额 |
| `"ark-cli"` | 官方 arkcli：返回的 session / weekly / monthly percent 窗口 | 安装并登录官方 arkcli，可用 `quotaCommand` 指定原生可执行文件；需独立控制面凭据，推理 API key 不能替代 |

接入新的 OpenAI 兼容服务的完整清单就是：**一段 JSON 配置 + 一个环境变量密钥 + 双开关**。服务端只需兼容 Chat Completions 协议；不需要为此写任何代码。

Agnes 已加入本机及示例配置：模型别名 `agnes/agnes-3.0-flash`，Base URL 为 `https://apihub.agnes-ai.com/v1`，密钥引用 `AGNES_API_KEY`。本机已启用并通过真实请求验证，当前显式设置 `allowAuto: true`、`maxConcurrency: 3`；额度采集尚未接入，显示 `unknown`。新环境需要自行配置密钥并核实计费。模型与端点见 [Agnes 官方文档](https://www.agnes-ai.com/en/docs/agnes-30-flash)。

#### Chat Completions 功能

`openai-compatible` 保留请求参数与消息 JSON：`tools`、`tool_choice`、`parallel_tool_calls`、工具结果消息、旧式 `functions/function_call`、`response_format`、`temperature`、`top_p`、`stop`、`max_tokens/max_completion_tokens`、`n`、`logprobs`、`stream_options`、推理选项和模型商扩展字段。图片、音频、文件等消息内容数组原样转发。具体功能是否可用由上游模型决定，网关不会执行工具或下载消息中的媒体。

流式与非流式保留全部 choices、工具调用、推理内容、拒绝信息、音频、annotations、logprobs、usage 明细及扩展响应字段。`model` 返回客户端使用的网关别名；实际供应商与模型见 `x-gateway-provider` / `x-gateway-model`。开始输出任何流式 chunk 后不会切换供应商，避免混合工具参数或回答。

例如使用 Python OpenAI 客户端进行工具调用：

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=os.environ["GATEWAY_KEY"])
messages = [{"role": "user", "content": "东京现在多少度？"}]
tools = [{"type": "function", "function": {
    "name": "get_temperature", "description": "查询城市温度",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                   "required": ["city"]}
}}]
result = client.chat.completions.create(
    model="ark/deepseek-v4.1-flash", messages=messages,
    tools=tools, tool_choice="auto",
)
answer = result.choices[0].message
if answer.tool_calls:
    messages.append(answer.model_dump(exclude_none=True))
    for call in answer.tool_calls:
        # 示例工具结果；真实应用应校验工具名/参数并执行自己的工具。
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": '{"temperature": 20, "unit": "C"}'})
    final = client.chat.completions.create(
        model="ark/deepseek-v4.1-flash", messages=messages, tools=tools,
    )
    print(final.choices[0].message.content)
else:
    print(answer.content)
```

CLI 与订阅 Responses 路径仍仅支持原有文本语义，扩展参数会返回 `unsupported`，不静默忽略。兼容 API 的 `allowAuto` 默认值不变；`auto` 携带工具或多模态请求时只选择已启用且允许 auto 的兼容 API。请求上限仍为 1 MiB，响应上限 16 MiB，单个 SSE frame 上限 1 MiB。

### claude

本机官方 Claude Code CLI，钉版 **2.1.296**。

```json
{
  "id": "claude",
  "type": "claude",
  "models": ["sonnet"],
  "command": "claude",
  "enabled": false,
  "billingVerified": false,
  "priority": 20
}
```

- 每次请求在全新临时目录中启动，`--safe-mode`、空工具、空 MCP、禁 hooks/斜杠命令/浏览器、不保存会话；`ANTHROPIC_*` / `CLAUDE_CODE_*` 环境变量被剥离，确保走订阅登录而非 API 计费
- 健康检查要求订阅登录状态：`claude.ai` + firstParty + Pro/Max；发现系统级受管策略（managed settings / registry）时先于启动直接拒绝——受管 hooks 能穿透 safe mode
- 额度：官方 `rate_limit_event` 窗口（五小时/七天等），但只能从**真实请求的响应中**观察，没有独立的只读查询；没有请求观察前额度为 `unknown`
- CLI 2.1.296 的 `unifiedWindows` 已实测支持，可读多个窗口的利用率和重置时间；没有报告的窗口保持未知，不换算成虚构的剩余请求数

### codebuddy

本机官方 CodeBuddy CLI（通过 `scripts/login-codebuddy.ts` 完成登录）。

```json
{
  "id": "codebuddy",
  "type": "codebuddy",
  "models": ["REPLACE_WITH_ACCOUNT_MODEL"],
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/path/to/.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"],
  "enabled": false,
  "billingVerified": false
}
```

- `args` 是 node.exe 的单个绝对 JS 入口（官方无扩展名的 `bin/codebuddy` 也接受）；该 CLI 版本的解析器不支持通配符，网关按名单逐个禁用约 60 个内置工具，并创建空工具专用 Agent
- 请求后若初始化事件仍报告工具，拒绝该请求——不信任参数，只信任运行时报告
- 禁 hooks、空 MCP 配置、隔离临时目录、不保存会话
- 额度：尚无已核实的官方 CLI 账户余额查询方式，保持 `unknown`；`/cost` 或模型积分倍率不能代替账户余额，可通过 `/admin/quota` 人工录入

### antigravity

本机官方 agy CLI（Google 登录缓存在官方 CLI 内，网关不接触凭据），接受 1.3.1–1.3.3。

```json
{
  "id": "antigravity",
  "type": "antigravity",
  "models": ["gemini-3.8-flash-low"],
  "command": "C:/Users/<你>/AppData/Local/agy/bin/agy.exe",
  "enabled": false,
  "billingVerified": false
}
```

- 每次请求创建一个独立命名的空工具 Agent（tools/MCP/skills/plugins 全空）+ 隔离工作目录；商业 API 凭据环境变量从子进程剥离，确保走缓存账号
- 启动前审计 `~/.gemini` profile：全局指令文件、全局 MCP/插件/规则**存在即拒绝**；全局 hooks 需要操作者通过 `approvedHooksSha256` 批准当前配置的 SHA-256 摘要，配置一变立即重新拒绝——网关不修改用户的全局设置
- 额度：官方 CLI 的只读 `/usage` JSON（要求 1.3.3），分别读取 Gemini 和第三方 Claude/GPT 模型组的 5 小时、每周 percent 窗口，不额外调用模型

### codex

三种互斥模式：

| `mode` | 能力 | 说明 |
| --- | --- | --- |
| `app-server`（默认） | 只读额度 | 官方 RPC 读取 percent 窗口；**推理不可用**（无法验证全工具禁用的配置之前不放开） |
| `responses` | 推理 | ChatGPT SIWC 访问令牌（`tokenEnv`），结构化多轮 + system；`sk-` API key 被拒绝；令牌需操作者自行获取并轮换，无自动刷新 |
| `exec` | 推理 | 官方 CLI **钉版 0.157.1**，ChatGPT 账号登录，只读沙箱，逐项禁用工具/技能/插件/记忆等特性，单轮语义 |

```json
{
  "id": "codex",
  "type": "codex",
  "mode": "exec",
  "models": ["gpt-6-sol"],
  "command": "codex",
  "enabled": false,
  "billingVerified": false
}
```

## 运维

管理接口（均使用 Admin Key）：

| 端点 | 说明 |
| --- | --- |
| `GET /admin/status` | 供应商能力、额度快照、冷却记录、活跃租约 |
| `POST /admin/quota` | 人工录入额度（`pool` 字段可建立共享额度池；`resetAt` 用 Unix 毫秒） |
| `POST /admin/quota/refresh` | 只读采集额度，可指定 `provider` 和 `model`；默认查询每个启用 Provider 的首个模型，不调用模型、不覆盖人工额度 |
| `POST /admin/unblock` | 清除指定 provider/model 的快照与冷却，重新采集 |

故障时的自动行为：额度耗尽 → 按官方重置时间冷却（未知则 60 秒）；限速 → 按 `Retry-After` 冷却；认证失败 → 封锁整个供应商 5 分钟；冷却到期后只放行一个恢复探测。进程崩溃遗留的并发租约按过期时间自动清理。

读取并刷新额度：

```powershell
npm run quota
node --env-file=.env.local scripts/quota.ts --provider ark
node --env-file=.env.local scripts/quota.ts --provider antigravity --model gemini-3.8-flash-low
```

结果中 `quota` 是本次查询结果，`effectiveQuota` 是调度实际使用的缓存，`saved` 表示本次是否保存了非未知的新快照。人工录入优先，不会被官方刷新覆盖。官方快照默认缓存 60 秒；正常请求在额度缺失/未知或过期时尝试刷新，成功调用后也会短暂尝试刷新。Claude 仅被动读取已有请求产生的事件，刷新命令不会为了查额度另发对话；同一官方观察不会因读取而延长新鲜度。

健康检查与额度查询使用独立时限：调度默认分别最多 3 秒和 10 秒，调用后的尽力刷新最多 1 秒；总过程仍受请求超时约束。查询失败不封锁健康 Provider，返回未知来源和原因。已删除 Provider 的历史额度或冷却记录可能仍保留在 SQLite 中，但不参与调度，也不会出现在 `/v1/models`。

## 开发与测试

```powershell
node --test tests/*.test.ts     # 全部测试：本地 HTTP/SQLite/子进程 fixtures，不接触真实账号
npm run typecheck               # 需先 npm install 安装开发依赖
npm run format:src
npm run format:check
```

新增普通兼容 API Provider 只需配置，不必编写 adapter。接入其他协议时实现 `src/types.ts` 的 `Provider` 接口并在 `src/adapters/index.ts` 注册；只有超出现有消息或事件契约的功能才需要扩展 HTTP 层与调度器。详细契约见 [src/adapters/README.md](src/adapters/README.md)，代码导读见 `docs/code-walkthrough.md`。

## 当前限制

- **接口范围**：提供 `/v1/chat/completions` 和 `/v1/models`。没有前台 `/v1/responses`、Embeddings、独立图片生成、音频转写或文件管理端点；Codex 的 `mode: responses` 是内部订阅调用路径，不等于向客户端开放 Responses API。
- **CLI 能力**：Claude、CodeBuddy、Antigravity、Codex exec 仅支持单条 user 加可选前置 system 的文本请求。不支持工具、多模态或生成参数；显式 CLI 请求返回 `unsupported`，`auto` 按请求能力筛选。Codex 内部 Responses 支持文本多轮，但仍不支持这些扩展字段。
- **兼容 API 的支持边界**：tools、结构化输出、多模态消息、推理参数与响应扩展已实现转发，具体是否可用由上游模型决定。网关不执行工具、不下载媒体、不把不兼容的模型转换成具有相应能力的模型。
- **调度边界**：每家只使用 `models[0]`，不在同一 Provider 内自动挑选其他模型；显式别名不跨 Provider 回退。没有会话粘性，后续 `auto` 请求可能换模型。参数错误或不支持错误不会回退，流式输出开始后也不会切换。
- **额度不是实时精确余额**：官方快照有缓存和采集延迟，percent 窗口不等于剩余 token/请求数。Ark 需要额外控制面登录，Claude 必须观察实际响应事件，CodeBuddy 和 Agnes 尚无已实现的官方余额采集；未知额度仍可参与调度。并发 token 预算是保守估算，实际消耗以合法上游 usage 结算；USD key 用量不等同于账户钱包余额。
- **容量与生效**：单请求体最多 1 MiB，累计响应最多 16 MiB，单 SSE frame 最多 1 MiB；`maxConcurrency` 是该 Provider 在本机网关内的请求上限，不增加上游额度或限速。配置和环境文件修改后必须重启。
- **本机服务边界**：只监听回环地址，无多租户、用户隔离或内置会话存储。`available`/`doctor` 不保证连通、额度、模型权限或计费；`billingVerified` 是操作者声明。CLI 的 POSIX 部署与抗 SIGTERM 子进程清理尚未验证。
- **日志范围**：网关常规状态与错误输出不记录 prompt、令牌、密钥或上游原始错误体；客户端自行保存回答、独立 CLI 日志以及 `.tools` 手动验证报告有各自的数据保存范围。
