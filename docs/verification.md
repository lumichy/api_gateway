# 第一版交付验证（2026-10-01）

本次交付是可运行的本机文本网关；没有把模拟测试作为真实订阅打通的证据。

- 完整测试：node --test tests/*.test.ts，83 通过、0 失败。
- 静态检查：npm run typecheck，通过。
- 独立进程联调：main.ts 启动临时 demo 配置；未授权 /v1/models 返回 401；auto 普通请求返回 200，实际 provider=available，第一家 quota_exhausted 后回退；SSE 返回 200 且以 [DONE] 结束；管理状态返回 200，耗尽池有冷却记录，当前 leases=[]。联调进程和临时数据库已清理。
- 官方 CodeBuddy 包：项目内 @tencent-ai/codebuddy-code@2.161.0；CLI --version 和 --help 已执行成功。入口由官方 package.json.bin.codebuddy 导出，实际为 bin/codebuddy。
- 登录助手：只创建不存在的 config.local.json，保留已有配置，默认 disabled 且 billingVerified=false；通过 Node argv 保留空工具参数，不经 shell。
- 本机密钥与订阅：未读取登录令牌；未验证 CodeBuddy 登录或发真实推理请求；其他真实订阅也未验证。

仍需完成：
1. 用户在交互终端运行 node scripts/login-codebuddy.ts 并完成官方登录，确认关闭额外按量付费。
2. 使用最小短文本验证 CodeBuddy 订阅模型、用量变化和无工具执行，再开启网关真实路由。
3. 逐家验证 Ark、Claude 和 ChatGPT SIWC 授权。SIWC 登录与自动刷新尚未实现。
4. 为各家补齐经官方验证的自动额度来源；目前 unknown 不伪装为可查询的余额，支持人工快照和本地估算。
5. 核实 Antigravity 的完整工具禁用契约后实现其推理路径；当前停用。

客户端第一版支持 /v1/chat/completions 文本与 SSE；不支持前台 /v1/responses、图片、工具调用和全部可选 OpenAI 参数。

## 2026-10-02 真实 CodeBuddy 验证

用户确认登录成功、额外按量付费关闭。通过真实本机 HTTP 网关调用 codebuddy/hy3，返回 200、provider=codebuddy、回答 OK.、stop，用量 prompt_tokens=5868 / completion_tokens=15 / total_tokens=5883。官方接口拒绝 default-model，但列出 hy3 可用。

修复两阶段工具初始化：空工具专用 Agent + 单独工具名称 deny 规则；任何初始化报告非空工具仍拒绝。回归覆盖两个初始化阶段、字面量 system 指令和未来未知工具。完整离线测试更新为 84 通过、0 失败。官方余额尚未查询，token 用量不作为余额或扣费池证明；实际扣费池需要用户在官方账户中核对。

最终复核：85 项离线测试通过，TypeScript 检查通过。修复 Windows CLI 回答完成后临时目录短暂 EBUSY 导致的 SSE 错误；清理仅对资源占用等临时错误进行最多10次有界重试，总等待最多2.75秒。后台网关已重新加载修复，auto 真实 SSE 复核返回 200、文本 OK、finish_reason=stop、无 error、以 [DONE] 结束，管理接口 active leases=0。

## 2026-10-06 火山 Coding Plan 接入

专用 coding/v3 接口与模型 deepseek-v4.1-flash：真实固定模型普通请求返回 200、provider=ark、OK、stop，用量 35/36/71。重启当前实际监听进程后，模型列表包含 auto、codebuddy/hy3 和 ark/deepseek-v4.1-flash；统一入口 auto SSE 返回 200、provider=ark、OK、stop、[DONE]，用量 35/18/53。

回退验证：暂存人工火山零额度快照，auto 真实请求返回 200、provider=codebuddy、OK.；finally 已通过 /admin/unblock 清除测试快照，当前租约为0。场景模拟的是额度条件，后备模型真实调用；不是声称真实火山账户已耗尽。两家仍无稳定官方余额机器查询，余额保持 unknown。

已有 Ark 适配器无需修改；新增本机配置、私有环境凭据与操作记录。网关后台 PID 32160，地址和客户端密钥不变。

## 2026-10-06 新增两个火山模型

统一入口 /v1/models 已列出 ark/glm-5.3-flash 和 ark/doubao-seed-2.1-lite。分别通过实际网关固定模型请求验证，均为 HTTP 200、provider=ark、回答 OK、finish_reason=stop。GLM 未提供可用 token usage，网关省略 usage；豆包报告 prompt_tokens=35、completion_tokens=31、total_tokens=66。

仅追加现有 Ark provider 的模型配置，未修改适配器代码；auto 默认火山模型仍为 deepseek-v4.1-flash，客户端地址和密钥保持不变。后台服务已重启加载配置。

## 配置文件命名统一

已将包含 CodeBuddy 和火山模型的运行配置重命名为 config.local.json，与 main.ts、doctor 和 start.ps1 的默认路径一致；登录助手也只创建不存在的 config.local.json，保留已有多供应商配置。

## 2026-10-06 Antigravity 登录与工具隔离检查

用户确认使用 Google AI Pro 登录。本机官方可执行文件位于 `%LOCALAPPDATA%/agy/bin/agy.exe`，版本 1.3.0。`agy models` 成功返回账号可用模型，包括 gemini-3.8-flash-low、gemini-3.1-pro-high 等。只读取了设置中与计费相关的字段：未设置 API-key 模型供应商，useG1Credits=false；这不是实际扣费池或剩余额度的证明。

在独立临时目录创建 gateway-text Agent，声明 tools: []、mcpServers: []、skills: []、plugins: []。分别检查官方文档中的平铺 Markdown 和 `<name>/agent.md` 两种布局；另检查 Git 工作区识别。使用 stream-json 输入输出、固定 Agent 和模型、关闭 slash commands，空 stdin 结束，不发送用户推理请求。

所有初始化均以退出码0结束，但 init.tools 仍包含 view_file、write_to_file、run_command、浏览器及 MCP 等工具，permission_mode=request-review。因此尚不能证明自定义 Agent 禁用了全部工具，也不能仅凭 init.agent 字段认定配置生效。未发送真实模型请求，未修改用户全局配置，未把 Antigravity 加入 config.local.json 或自动调度。当前实际启用的 provider 仍为 Ark 和 CodeBuddy。

继续接入的条件：验证有效的 CLI 全工具禁用配置，或实现独立的操作系统隔离与权限边界，再验证真实文本和 SSE 请求。官方 `/usage` 仍为交互面板；没有把 token 用量或模型列表当作订阅余额。

参考：[CLI Agent 布局](https://antigravity.google/docs/cli/commands/agents/)、[Headless 初始化协议](https://antigravity.google/docs/cli/headless/)。

## 2026-10-07 Antigravity CLI 适配器

补做真实 Agent 对照，纠正上一节仅根据 init.tools 判断工具禁用失败的结论：CLI 1.3.0 的 init.tools 列出全局工具目录，不能作为选定 Agent 的工具权限。自定义系统指令要求 AGY_GATEWAY_AGENT，而 stdin 用户要求 OK；返回 SUCCESS、AGY_GATEWAY_AGENT，说明 Agent 正文指令生效。随后两次相同的临时文件读取请求：tools: [] 返回 NO_TOOL、没有 tool step、未读取随机测试值；仅允许 view_file 的对照 Agent 实际调用该工具并读取了脚本创建的随机测试值。只涉及自建临时文件，没有读取用户文件。

新增 src/adapters/antigravity.ts 并注册 provider 工厂：唯一 Agent 名称与隔离目录、单轮 stdin NDJSON、可选 literal system、版本1.3.0检查、账号默认计费及额外 credits 检查、完整终态/退出码与文本一致性、SSE 增量及可选 usage、异常工具/子代理事件拒绝、取消与临时目录清理。官方余额保持 unknown。现有回退调度已通过该适配器 quota 错误的离线集成测试，测试后租约为0。

独立审查发现全局 AGENTS.md/GEMINI.md 可自动加载；已添加拒绝检查及四项回归。本机没有这些全局规则，也没有插件或 MCP 配置，但存在 orca-status 的 PreInvocation/PostInvocation/Stop/PostToolUse hooks。hooks 会执行本机脚本，无法通过当前 CLI 参数单独关闭；已向用户提出沿用或关闭的选择。适配器默认拒绝未批准的 hooks，approvedHooksSha256 固定完整已批准配置，变化后重新阻止调用。

config.local.json 已追加 Antigravity：gemini-3.8-flash-low、gemini-3.1-pro-high，priority20、maxConcurrency1；enabled=false，等待 hooks 选择。未更改全局配置，未重启运行中的两家网关。原生 Windows 取消测试通过；POSIX SIGTERM-resistant 进程的强制终止尚未验证。

最终离线验证：112 项测试通过、0失败；npm run typecheck 与 npm run format:check 均通过。以上真实 CLI 对照不能替代待执行的网关 HTTP/SSE 验收，尚未宣称 Antigravity 已在运行服务中可用。

### 用户选择后完成真实启用

用户明确选择关闭 hooks。已备份原配置至 data/antigravity-hooks.backup-2026-10-07.json，并仅将全局 orca-status 定义的 enabled 设置为 false。补充禁用 hooks 不需批准的回归测试。当前实际 CLI 版本核实为1.3.1，本次真实 Agent 对照使用的也是该版本；适配器及 fixture 已同步版本保护，不沿用前一天的1.3.0版本记录。

临时真实 HTTP 网关验收：gemini-3.8-flash-low 普通请求200、provider=antigravity、OK、stop，usage1985/1/1986；同模型 SSE 200、OK、[DONE]、usage1992/1/1993；gemini-3.1-pro-high 普通请求200、OK、stop、usage2252/81/2333。临时状态租约为0。

运行服务原端口没有监听，故启动加载三家配置的后台网关，PID23636、地址仍为 http://127.0.0.1:8787/v1，密钥保持原环境凭据。实际 /v1/models 发布7个别名（含auto）；通过实际端口验证 Antigravity SSE 返回200、OK、[DONE]。独立临时网关将 Ark 与 CodeBuddy 的默认模型额度设为人工0快照，auto 实际返回 antigravity、200、OK、stop；模拟额度条件没有修改生产数据库，也不代表两家真实账户耗尽。临时与生产活动租约均为0。三家最终配置诊断 available=true。

官方余额仍为 unknown。Antigravity 支持单个 user 及可选前置 system，不支持历史或 developer 角色；纯文本模式不暴露 Agent 内部工具。测试用量不能证明精确订阅剩余量或实际扣费池。

最终启用后回归：113 项测试通过、0失败；TypeScript 与源码格式检查均通过。

## 2026-10-10 Codex CLI 与 Claude Code

新增 Codex exec 适配器（本机官方 CLI 0.157.1），与已有 quota-only app-server、SIWC Responses 模式分开。官方 login status 已确认 ChatGPT 账号登录；没有复制 token 或使用 API key。忽略用户配置/项目规则、清空技能及开发者指令，固定禁用工具与扩展特性；本地 Responses 捕获验证模型请求 tools:[]，不包含用户技能或全局规则。固定版本不匹配、工具事件、不完整结果、异常退出均拒绝调用。

Codex 真实适配器最小请求返回 OK，官方 account/rateLimits/read 返回两个百分比额度窗口。临时 HTTP 网关普通请求返回200、codex、OK、stop，用量3645/15/3660；auto SSE 在人工零额度前序池后返回200、codex、OK、stop、[DONE]，用量3647/5/3652，活动租约0。此处仅模拟前序额度条件，不代表其他真实账户耗尽。CLI 在消息完成后输出回答，因此 SSE 是完成后的文本输出，并非逐 token 增量。

config.local.json 已启用 codex/gpt-6-sol（priority30），保留原三家供应商。核实原 PID23636 命令属于本项目后，重启为 PID37476。实际8787端口发布8个模型别名（含auto），Codex 固定模型 SSE 返回200、OK、stop、[DONE]，用量3649/5/3654，管理接口活动租约0。地址和现有客户端凭据不变。新鲜官方已知额度优先于 unknown，因此 auto 可能先选 Codex。

Claude Code 2.1.296 的适配器已完成。使用保留 OAuth 的 safe mode，禁用工具/MCP/hooks/用户自定义配置，移除 API 凭据覆盖，严格验证 claude.ai firstParty Pro/Max 登录及 init.apiKeySource=none。启动前拒绝本机受管理策略文件、Windows策略注册表及远端策略缓存；当前检查未发现这些策略。本机 Pro 账号登录已确认，但真实 Claude 推理仍等待用户确认 Extra Usage 已关闭；config.local.json 中 enabled/billingVerified 均为false，没有对其发送推理请求。Claude 额度仍为unknown。

离线测试覆盖两个 CLI 的订阅鉴权、literal system/用户 stdin、异常工具、终态一致性、额度/认证/限速错误、路由回退及租约释放；取消测试先等待推理进程 readiness，再断言进程已退出且临时目录已删除。专项30项通过，完整143项通过、0失败，typecheck 与 format:check 通过。独立代码审查指出的取消时机和 Claude 鉴权元数据问题均已修复并复核通过。Windows 原生执行已验证；POSIX 抗 SIGTERM 进程尚未验证。

最终 doctor 诊断：Ark、CodeBuddy、Codex available=true；Claude disabled。另发现已安装 Antigravity 自动更新到1.3.2，与已验证固定版本1.3.1不同，available=false。配置仍保留 enabled=true，但实际调用会被版本检查拒绝，auto 会跳过；未放宽旧版本契约。需要另行验证1.3.2后恢复。

### Antigravity 1.3.2 恢复

用户要求恢复后，补做真实隔离对照：同一自建临时 canary 文件，tools:[] Agent 返回 NO_TOOL、工具事件0、未读到随机值；仅允许 view_file 的对照 Agent 产生读取工具事件并返回随机值。均为 SUCCESS/单轮，未读取用户文件，测试目录已清理。新版本仍使用原有 init/step_update/result 协议和 request-review 权限模式，hooks/额外 credits 检查保持不变。

白名单由单一1.3.1改为明确的1.3.1、1.3.2；增加1.3.2可用、1.3.3/2.0.0拒绝的回归，先确认旧代码针对1.3.2失败再修复。健康检查显示实际安装版本。临时网关 gemini-3.8-flash-low 普通请求200/OK/stop（usage1980/1/1981）；SSE200/OK/[DONE]（usage1992/1/1993）；gemini-3.1-pro-high 普通请求200/OK/stop（usage2257/87/2344），活动租约0。

完整144项测试通过、0失败，typecheck及format:check通过。核实旧网关PID37476后重启为PID23128，地址和密钥不变。实际8787入口 Antigravity SSE 返回200、OK、[DONE]。独立临时网关将所有其他供应商默认池设为人工零额度，auto 实际选择 antigravity 并返回200、OK、stop；模拟没有修改生产额度。临时与生产活动租约均为0。余额仍为unknown；未来未验证版本仍须重新验收。

### Claude Code 启用及未启用模型错误修复

用户报告 claude/sonnet 返回429 quota_exhausted，但官方 Claude Code 可正常使用。核实配置仍为 enabled=false/billingVerified=false，未向 Claude 发出推理；路由排除所有候选后用通用额度耗尽错误回复，这是误导性错误。新增路由及HTTP回归：显式禁用模型在探测额度前返回400 unsupported并说明disabled/billing未验证；不设置Retry-After、不创建租约，auto仍可选择已启用供应商。先验证旧行为测试失败，再修复。

用户明确确认 Extra Usage 已关闭并授权验证/启用。Claude Code 2.1.296 的订阅auth及隔离检查通过；实际适配器请求返回OK/stop，usage616/4/620。临时统一HTTP固定模型普通请求200/claude/OK/stop，人工零额度前序后的auto SSE返回200/claude/OK/[DONE]，两次usage614/4/618，活动租约0。

config.local.json 中 Claude 的enabled及billingVerified改为true，模型sonnet、priority40保持原配置。核实旧PID23128命令属于本项目后重启为PID21788；实际8787入口发布9个别名（含auto和claude/sonnet）。真实Claude SSE返回200、OK、[DONE]、usage614/4/618，管理接口活动租约0。地址和客户端密钥不变，Claude仍为unknown额度。

完整146项测试通过、0失败，typecheck及format:check通过。此处验证真实文本与传输，不把 token usage 当成剩余额度，也没有启用Extra Usage或提取官方CLI凭据。

### CLI 适配器模块拆分

用户批准将CodeBuddy及Claude拆为独立模块。新增codebuddy.ts（健康检查、Agent及禁止工具设置、调用入口）、claude.ts（健康/订阅鉴权、safe-mode、策略/版本预检、初始化鉴权、调用入口）、cli-stream.ts（两家共用print参数及stream-json解析）。subprocess.ts保留子进程传输、启动参数校验、取消、清理及CLI公共函数，不再执行两家的健康或推理分支。index.ts分别分发；scripts/codebuddy.ts及直接健康测试的import同步更新。

保持原参数顺序、协议、限额、终态校验、用量及取消处理。完整146项回归通过、0失败，typecheck及format:check通过。核实旧PID21788后重启为PID24320，原8787入口health=ok。拆分后的CodeBuddy、Claude、Codex及Ark只读诊断available=true；未为重构追加真实推理请求。最终诊断另发现Antigravity再次升级到白名单以外的版本，因版本检查而不可用；这是已安装CLI变化，非本次模块拆分所致，未放宽契约。

### Antigravity 1.3.3 恢复（2026-10-10）

用户报告 antigravity/gemini-3.8-flash-low 返回503/auth_required。实际CLI为1.3.3，doctor明确显示版本尚未验证；原错误是健康检查统一提示，并不能据此认定账号登录失效。

在保持本番版本限制期间补做原生CLI隔离对照：tools:[] Agent返回NO_TOOL，工具事件0，未读到随机canary；只允许view_file的对照Agent产生2个工具事件并读到自建临时文件的随机值。两次均SUCCESS/单轮，Agent/model/request-review初始化保持原协议，一次性临时目录已清理。

回归先确认1.3.3可用预期在旧代码失败，再将支持版本加入1.3.3；保留1.3.4/2.0.0拒绝。完整154项测试通过，typecheck及format:check通过。

确认生产网关空闲后重启。实际8787入口指定gemini-3.8-flash-low的SSE返回200、provider=antigravity、OK、[DONE]。独立内存状态中将其余四家额度置零，auto真实回退到Antigravity，普通JSON返回200、OK、stop。生产及临时状态活动租约均0；未修改生产额度或登录配置。
