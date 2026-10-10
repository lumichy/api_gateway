# AI 订阅统一网关

个人、本机运行的文本 AI 网关。客户端固定连接一个 OpenAI 兼容地址，网关选择可用订阅，并在尚未交付回答时自动回退。

**当前交付边界：** 已真实接通 CodeBuddy、火山 Coding Plan、Antigravity CLI、Codex CLI 和 Claude Code。五家均已启用并通过各自真实调用验证。统一入口支持纯文本、SSE 与自动回退；完整编码工具调用不支持，五家的精确官方剩余额度尚未全部接通。

## 立即运行演示

需要 Node.js 24 或更新版本。运行服务没有第三方运行时依赖。

~~~powershell
cd C:\lumichy\codex\api_gateway
node src/main.ts --config config.demo.json
~~~

也可以运行 npm run demo 或 .\scripts\start.ps1 -Demo。

演示使用固定开发凭据，监听本机回环地址：

- Base URL：http://127.0.0.1:8787/v1
- Gateway Key：demo-local-gateway-key-12345678
- 模型：auto
- Admin Key：demo-local-admin-key-1234567890

~~~powershell
$payload = @{model='auto'; messages=@(@{role='user'; content='你好'})} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri http://127.0.0.1:8787/v1/chat/completions -Method Post -ContentType 'application/json' -Headers @{Authorization='Bearer demo-local-gateway-key-12345678'} -Body ([Text.Encoding]::UTF8.GetBytes($payload))
~~~

演示第一家在调用时报告额度耗尽，第二家返回回答。响应头 X-Gateway-Provider 可确认实际供应商。演示额度有限，调用后的估算和冷却状态保存到 data/demo.sqlite；重启保留状态。可通过管理接口重置测试状态。

## 配置真实订阅

~~~powershell
Copy-Item -LiteralPath config.example.json -Destination config.local.json
$env:GATEWAY_KEY = '设置至少24字符的独立网关密钥'
$env:GATEWAY_ADMIN_KEY = '设置另一个至少24字符的管理密钥'
node scripts/doctor.ts --config config.local.json
node src/main.ts --config config.local.json
~~~

将上面的密钥示例替换为自己的随机值。普通 JSON 配置只保存环境变量名；密钥通过环境变量传入。服务只允许 127.0.0.1 或 ::1。管理和模型调用使用不同密钥。真实供应商需要同时设置 enabled:true 和 billingVerified:true；后者是操作者确认，不能代替实际扣费核对。

所有供应商初始关闭。先使用官方客户端完成登录或授权，确认目标模型可用，并关闭额外按量付费，再启用该适配器。doctor 不发推理请求、不消耗模型额度，不会显示密钥；available 仅表示本地检查通过，liveVerified 始终 false，直到通过独立真实验收记录验证。

| 供应商 | 实现与启用方式 | 消息能力 | 当前余额来源 |
| --- | --- | --- | --- |
| 火山方舟 Coding Plan | 专用 Coding Plan Key 放入 ARK_CODING_API_KEY；只能使用 /api/coding/v3 | 文本角色、多轮 | 未核实稳定机器查询，unknown 或人工快照 |
| Claude | 本机官方 CLI 的订阅登录；固定可执行路径 | 一个 user，可选一个前置 system | unknown 或人工快照 |
| CodeBuddy | 官方 CLI 订阅登录；固定可执行路径 | 一个 user，可选一个前置 system | unknown 或人工快照；统计不等于剩余额度 |
| ChatGPT SIWC（可选） | 官方 SIWC 授权给本应用的访问令牌放入 CHATGPT_SIWC_ACCESS_TOKEN；mode:responses | 结构化多轮；可选一个前置 system | unknown；不能混用 Codex 的额度桶 |
| Codex CLI | 官方订阅登录；mode:exec，CLI 0.157.1 | 一个 user，可选前置 system；SSE 在回答完成后输出 | 官方 RPC 多窗口百分比 |
| Codex App Server | 可单独通过官方 RPC 读取 quota | 推理停用，未核实完整禁用工具配置 | 官方，多额度桶；不等于 SIWC Responses 权益 |
| Antigravity | 本机官方 agy CLI 1.3.1/1.3.2 缓存账号；单次隔离的空工具 Agent；全局 hooks 需单独确认 | 一个 user，可选一个前置 system | unknown 或人工快照；/usage 未作为机器接口 |

CLI 适配器不把完整历史压成带角色标签的字符串。多轮请求会筛选到支持结构化历史的供应商；若没有匹配者，返回明确 400。可选 system+user 是单轮，已单独验证。不能因需要回退而放宽消息语义。

### Antigravity CLI

复用官方 CLI 的 Google 登录，无需把 OAuth 凭据放进网关。Windows 官方默认可执行文件为 `%LOCALAPPDATA%/agy/bin/agy.exe`；先运行官方 `agy models` 确认可用模型，再在 config.local.json 中设置 type:antigravity、command 和 models。已验证版本为1.3.1和1.3.2，本机当前1.3.2。启用需要 enabled:true 与 billingVerified:true；本机已启用并真实验证 gemini-3.8-flash-low 和 gemini-3.1-pro-high 两个模型，priority20。新鲜已知额度优先，unknown 供应商再按 priority 排序。

客户端固定模型别名为 `antigravity/gemini-3.8-flash-low` 或 `antigravity/gemini-3.1-pro-high`；`auto` 可在前序供应商耗尽后选择它。地址和 Gateway Key 沿用现有入口。余额 unknown 时按配置优先级回退，不能宣称按精确官方余额选择。

CLI 不支持每次调用关闭全局 lifecycle hooks。若已配置 hooks，适配器默认拒绝启动；用户明确允许沿用后，通过 approvedHooksSha256 固定已批准配置，配置变化会重新阻止调用。适配器运行时不修改用户全局设置。全局规则、MCP 或插件也会被拒绝，避免干扰隔离的文本调用。CLI 升级后需重新验证适配契约。检查配置可运行 `node scripts/doctor.ts --config config.local.json`。

本机用户选择关闭 hooks：已将全局配置中 orca-status 的 enabled 设为 false，原配置备份在忽略目录 data/antigravity-hooks.backup-2026-10-07.json。适配器运行时不再修改全局配置。

### 优先接入 CodeBuddy

用户选择 CodeBuddy 作为第一家真实验证对象。官方 CLI 已安装到 .tools/codebuddy，已验证版本 2.161.0；用户已确认登录成功且额外按量付费关闭，hy3 已真实调用成功；官方余额和扣费池仍待核实。

官方包名称为 @tencent-ai/codebuddy-code。项目内安装与登录助手：

~~~powershell
node scripts/login-codebuddy.ts
# 重装固定版本时：.\scripts\setup-codebuddy.ps1
~~~

登录助手读取已安装的官方包，生成未启用的 config.local.json，然后运行交互式官方 CLI 供你登录；安装脚本固定使用 2.161.0。登录涉及浏览器授权，需要你亲自完成。也可使用已经安装的官方原生可执行文件，直接修改 command。

Windows 网关不运行 .cmd 或 shell 字符串。npm 安装应配置 node.exe 加绝对 JavaScript 入口，例如：

~~~json
{
  "id": "codebuddy",
  "type": "codebuddy",
  "models": ["hy3"],
  "command": "C:/Program Files/nodejs/node.exe",
  "args": ["C:/lumichy/codex/api_gateway/.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"],
  "enabled": false,
  "billingVerified": false
}
~~~

实际入口由安装后的 package.json.bin 决定；不要假设一定是 cli.js。setup 脚本自动读取入口。args 只允许 node.exe 的一个绝对 JS 入口（CodeBuddy 官方扩展名为空的 bin/codebuddy 也受支持），禁止附加运行时 flags、设置覆盖或用户 prompt。

网关调用 CLI 时创建空工具的专用 Agent，并逐项禁止当前版本在默认初始化阶段和专用 Agent 中提供的工具，同时使用空 MCP 严格配置、禁用 hooks、隔离临时目录和不保存会话。CLI 2.161.0 的空 --tools 和通配符禁用规则不能单独达到这一效果；任何初始化事件仍报告工具时会拒绝请求。版本必须支持这些官方参数，否则请求失败，不退化为可执行本地工具的模式。

hy3 已由官方错误响应列为该账户可用模型，并通过真实网关请求验证；原先的 default-model 不能作为请求模型。首次真实请求用明确模型别名 codebuddy/hy3，只发送短文本“请只回复 OK”。核对官方账户用量变化和工具初始化事件；确认目标订阅扣费、没有额外 API 计费后再标记 billingVerified:true 并加入 auto。当前项目没有保存任何 CodeBuddy 登录凭据。

### ChatGPT SIWC 授权

这里需要官方 Sign in with ChatGPT 注册/授权产生、授予本应用 plan usage 权限的访问令牌。不能拿已有 Codex 凭据文件的 token 冒充本应用的授权。商业 sk- API key 在该路径被拒绝。

目前只提供令牌环境变量接口，尚未实现 SIWC 登录 UI 和自动刷新；令牌过期返回需要重新授权的错误并回退其他供应商。该路径需要完成官方注册/授权准备，不能仅凭 Plus/Pro 订阅就称已经可用。

## 客户端接入

标准 OpenAI Python SDK 示例（需要客户端自己安装 openai）：

~~~python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="你的 Gateway Key")
result = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "解释一下网关的回退机制"}],
)
print(result.choices[0].message.content)
~~~

支持 GET /v1/models、POST /v1/chat/completions、stream:true，以及字符串内容的 system/developer/user/assistant 消息。每家适配器进一步检查是否能保留对应消息语义。

仅支持 model/messages/stream 参数。tools、图片、音频、temperature、max_tokens、JSON Schema 等均明确返回 400。/v1/responses 前台兼容接口尚未实现；不能用于要求工具调用或 Responses 协议的完整编码客户端。

auto 允许跨供应商回退。显式 provider/model 别名固定供应商，不自动改变你指定的模型。流式输出交付第一个文本片段后不切换供应商，避免混合两家的回答；中断时返回 SSE 错误。总截止时间、客户端断开和慢客户端回压都会取消上游并释放额度租约。

## 额度、调度和管理

优先新鲜已知额度，比较每个订阅最紧张窗口的剩余比例；tokens、请求数和积分不相加。余额未知候选作为后备，不能把它标成无限余额。若已知剩余数没有总额度，无法归一比较比例，按配置 priority（较小优先）排序。

共享额度池通过 pool 字段关联模型；任一相关窗口耗尽就排除该池。SQLite 事务预留并发、请求、token 和已配置的积分预算，防止本机并发过量分配。默认输出 token 预估 4096，加输入 UTF-8 字节数形成保守预留；实际计费可能不同，预留不是供应商保证。

用量分为 official/manual/estimated/unknown。原始上游快照保留在 reported；本地已可能消耗的额度只改变估算，取消和失败也会记账。只有新的官方快照才调和远端真实用量。manual 快照通过管理接口更新，不因重启或成功调用自动恢复。

套餐耗尽按 resetAt 屏蔽；不知重置时间时冷却 60 秒，到期只允许一个恢复探测。普通 429 限速按 Retry-After 冷却；认证失败暂停 5 分钟。每家每请求最多尝试一次。官方数据过期时明确降为未知，不伪造余额。

管理接口均使用 Admin Key：

- GET /admin/status：适配器能力、额度、冷却和当前租约；没有消息正文或密钥。
- POST /admin/quota：人工录入/更新额度；时间戳 resetAt 使用 Unix 毫秒。
- POST /admin/unblock：重置指定 provider/model 的共享池快照和冷却，重新采集。
- GET /health：无鉴权的最小服务存活信息。

~~~powershell
$headers = @{Authorization="Bearer $env:GATEWAY_ADMIN_KEY"}
$quota = @{provider='codebuddy'; model='你的模型名'; pool='codebuddy-plan'; windows=@(@{unit='credits'; remaining=120; limit=1000; resetAt=$null})} | ConvertTo-Json -Depth 8
# 积分池还需要可靠的请求成本预算才能预留；目前默认没有该预算，建议先用官方可核实的请求窗口或保持 unknown。
Invoke-RestMethod -Uri http://127.0.0.1:8787/admin/quota -Method Post -Headers $headers -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($quota))
~~~

人工积分字段仅可展示；当前配置尚未暴露积分预算参数，已知积分池默认不参与无法预留成本的请求。可将窗口改为 unit:percent、remaining:12、limit:100 表达余量比例，但比例只用于排序，不能声称精确预留积分。不要将 token 用量当成剩余订阅积分。

## 验证与诊断

~~~powershell
node --test tests/*.test.ts
node scripts/doctor.ts --config config.example.json
# 开发依赖安装后：
npm run typecheck
~~~

测试使用真实本地 HTTP 服务、SQLite 临时数据库和子进程协议 fixtures，不需要真实密钥。覆盖请求格式、SSE、401/429、未知/零额度、共享池、并发预留、重启、取消、恢复探测、错误分类、CLI 参数隔离、超大帧、负数用量和不读取数据的 TCP 客户端。

资源限制：请求体 1 MiB、单个上游帧/CLI 行 1 MiB、上游错误体 8 KiB、CLI health 输出 64 KiB、回答文本 16 MiB、每次尝试最多 65536 个事件。非流式文本片段合并，避免为每个字符保存一个事件对象。健康/额度探测并行且有独立超时。

data/、config.local.json、.env、.tools/ 和 node_modules/ 忽略提交。运行时不记录 prompt、OAuth token、API key 或原始上游错误体。

## 官方参考与当前限制

- [火山 Coding Plan 专用接口与额度查询](https://www.volcengine.com/article/37875)
- [CodeBuddy 官方安装与登录](https://www.codebuddy.cn/docs/cli/quickstart)
- [CodeBuddy CLI 参数](https://www.codebuddy.cn/docs/cli/cli-reference)
- [Claude SDK 与订阅的当前说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [ChatGPT SIWC 订阅调用](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [SIWC 参数限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Codex App Server 额度 RPC](https://learn.chatgpt.com/docs/app-server)
- [Antigravity Headless](https://www.antigravity.google/docs/cli/headless/)

更详细的适配器契约、参数和无法启用的原因见 src/adapters/README.md。方案已完成第一版协议与路由验证；全部五家真实接入、全部精确自动余额采集，以及 SIWC 登录/刷新还未完成。

## 本机已验证的 CodeBuddy 入口（2026-10-02）

配置 config.local.json 已启用 hy3。本机访问凭据存放在 data/client.json；私有环境变量文件为 .env.local，两者已排除提交。客户端使用 base_url=http://127.0.0.1:8787/v1、model=auto 和 client.json 中的 api_key。

~~~powershell
node --env-file=.env.local src/main.ts --config config.local.json
~~~

已启动的后台进程 PID 写在 data/gateway.pid；服务重启后重新运行上述命令。目前启用火山（priority=5）、CodeBuddy（priority=10）、Antigravity（priority=20）和 Codex（priority=30）。Codex 可读取官方百分比额度，auto 优先新鲜已知额度，因此可能先选择 Codex；其余三家余额仍为 unknown，再按 priority 回退。火山支持结构化多轮文本；CodeBuddy 只支持一个 user 和可选的前置 system，多轮请求不能回退到 CodeBuddy。完整工具调用尚不支持。

## 火山 Coding Plan 接入（2026-10-06）

专用端点 https://ark.cn-beijing.volces.com/api/coding/v3，模型 deepseek-v4.1-flash。凭据保存在私有 .env.local 的 ARK_CODING_API_KEY，配置中仅引用变量名。仍使用同一个客户端地址与 Gateway Key；model=auto 自动选择，model=ark/deepseek-v4.1-flash 固定火山。

真实普通和流式请求均返回 200、OK、stop。使用临时人工零额度场景验证 auto 跳过火山并调用真实 CodeBuddy，随后已清除测试快照；这不代表真实火山额度已耗尽。尚未实现火山官方余额自动读取，可通过 /admin/quota 录入已核实额度；余额未知时按优先级选择，真实耗尽或限速由上游错误触发冷却与回退。

火山新增可用模型（2026-10-06，已真实验证）：ark/glm-5.3-flash、ark/doubao-seed-2.1-lite。客户端将 model 设置为对应完整别名即可使用；auto 当前仍优先选择火山的 deepseek-v4.1-flash，不会随机轮换模型。

## Codex CLI 与 Claude Code（2026-10-10）

两家均复用本机官方 CLI 的订阅账号登录，无需 API Key，登录凭据留在官方 CLI 中。Codex CLI 0.157.1 已启用，固定别名 `codex/gpt-6-sol`；Claude Code 2.1.296 在用户确认 Extra Usage 已关闭后完成真实验证并启用，固定别名 `claude/sonnet`。地址和 Gateway Key 不变，`auto` 自动选择启用的供应商。显式指定未启用的供应商会返回400 unsupported及配置原因，不再误报429额度耗尽。

Codex 配置使用 `type:codex`、`mode:exec` 和原生可执行路径。Windows 不使用 `.cmd` 启动器；npm 安装的本机路径已写入 config.local.json。使用忽略用户配置和项目规则、无工具/插件/技能、临时会话与隔离目录；升级 CLI 后需重新验证固定版本契约。Codex SSE 在 CLI 完成回答后输出文本，不是逐 token 流。官方额度由独立 app-server RPC 读取，与可选 SIWC Responses 的额度不能混用。

Claude 使用保留账户登录的 `--safe-mode`，禁用工具、MCP、用户 hooks、自定义设置和会话保存。`--bare` 不用于订阅登录。遇到本机受管理策略文件/注册表或远端策略缓存时拒绝调用，避免策略引入 hooks 或付费凭据；不修改用户设置。Claude 剩余额度暂为 unknown，耗尽/限速/认证错误通过现有冷却与回退处理。

两个 CLI 都仅接受一个 user 和可选的前置 system；多轮请求继续由支持结构化历史的供应商处理。详见 [验证记录](docs/verification.md) 和 [适配器契约](src/adapters/README.md)。

Antigravity 1.3.2 已完成工具隔离、两个模型的 HTTP/SSE 和模拟零额度回退验证并恢复。已验证版本使用明确白名单；未来未验证的升级仍会被拒绝，需要重新检查启动参数、事件协议和工具隔离后加入。
