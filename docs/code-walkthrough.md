# 代码实现说明（Code Walkthrough）

> 面向想改这个项目的人。目标是读完能回答两个问题：**一次请求在代码里怎么流动**，以及**每个模块为什么这么写**。
> 面向操作者的使用说明见根目录 `README.md`；适配器契约细节见 `src/adapters/README.md`。

---

## 0. 一句话定位

这是一个**本机单进程的 OpenAI 兼容反向代理**：客户端只连一个地址（`http://127.0.0.1:8787/v1`），网关在**还没把任何内容交付给客户端之前**，根据额度、冷却、能力匹配度挑选一家订阅供应商，失败就自动换下一家。

三个关键词决定了整个代码库的形状：

| 关键词 | 含义 | 代码里体现为 |
| --- | --- | --- |
| **本机** | 只监听回环地址，配置里只存环境变量**名** | `config.ts:39` 强制 loopback；`config.ts:36` 拒绝未知字段（防明文密钥） |
| **不交付即可回退** | 一旦吐了第一个字节，就不能换供应商了 | `scheduler.ts:200` 的 `committed` 标志 |
| **不伪造余额** | 查不到就写 `unknown`，绝不假装无限 | `quota.ts:8` 直接返回 `null` 分数；`types.ts:15` 的四种 source |

技术栈上刻意极简：**零运行时依赖**，只用 Node 24 内置能力（`node:http`、`node:sqlite`、`node:child_process`、`AbortSignal`）。TypeScript 直接由 `node` 跑（`--experimental-strip-types`），无构建步骤。`tsconfig.json` 里 `"erasableSyntaxOnly": true` 和 `"noEmit": true` 就是在保证这一点。

---

## 1. 心智模型：一次请求的完整调用链

```
客户端
  │  POST /v1/chat/completions  {model:"auto", messages:[...], stream:false}
  ▼
server.ts:createServer
  │  ① 生成 requestId、设置总超时 AbortController、监听客户端断开
  │  ② 鉴权（timingSafeEqual 常量时间比较）
  │  ③ Content-Type 校验 → 读 body（1 MiB 上限）→ validateRequest 严格白名单
  ▼
scheduler.ts:Router.run  ←—— 整个项目最核心的 250 行
  │  阶段 A 并行发现候选：能力过滤 → 预检 → 冷却 → 健康 → 额度 → 打分
  │  阶段 B 排序：分数降序 → priority 升序 → id 字典序
  │  阶段 C 逐个尝试：预留租约（BEGIN IMMEDIATE 事务）→ 流式读事件 → 记账
  │        失败且未 committed？→ 记冷却 → 换下一家
  ▼
adapters/*  invoke()  →  AsyncIterable<ProviderEvent>
  │  真实 HTTP（ark / responses）或 子进程 CLI（claude / codebuddy / antigravity）
  ▼
server.ts 把事件转成 OpenAI 格式（JSON 或 SSE）
```

关键点：**`server.ts` 完全不认识任何供应商**。它只认识 `ProviderEvent { type:'text' | 'done' }`。所有供应商差异都被 `src/adapters/` 吃掉了。

---

## 2. 文件职责地图

| 文件 | 行数 | 一句话职责 |
| --- | --- | --- |
| `src/main.ts` | 54 | 启动装配：解析 `--config` → 加载配置 → 取密钥 → 建适配器 → 开 HTTP → 优雅退出 |
| `src/config.ts` | 211 | 唯一的配置入口。白名单校验 + 区间校验 + 路径规范化 + 密钥分离 |
| `src/types.ts` | 43 | 全部跨模块类型。`Provider` 接口是整个系统的核心契约 |
| `src/errors.ts` | 58 | `GatewayError`（kind → HTTP 状态映射）+ `safeError` + `abortable` |
| `src/server.ts` | 373 | HTTP 接入层：路由、鉴权、请求校验、SSE 输出、错误响应 |
| `src/scheduler.ts` | 278 | `Router`：候选发现 → 排序 → 预留 → 尝试 → 回退。**项目的心脏** |
| `src/state.ts` | 219 | SQLite 持久化：额度快照、共享池、冷却、租约。用同步 API 保证事务原子性 |
| `src/quota.ts` | 51 | 纯函数：把额度快照算成 0~1 的分数；算下次重置时间 |
| `src/usage.ts` | 17 | 校验上游返回的 token 用量是否自洽，非法就丢弃（不当成 0） |
| `src/adapters/index.ts` | 176 | 工厂 `createProvider()`，把 6 种 type 收敛成同一个 `Provider` 对象 |
| `src/adapters/http.ts` | 141 | SSE 解析、HTTP 错误分类、字节级边界控制 |
| `src/adapters/subprocess.ts` | 319 | CLI 子进程封装：行读取、退出码分类、启动参数白名单、临时目录清理 |
| `src/adapters/responses.ts` | 112 | ChatGPT SIWC（Responses API）适配 |
| `src/adapters/codex.ts` | 129 | Codex app-server **只读额度**（JSON-RPC over stdio） |
| `src/adapters/antigravity.ts` | 302 | Antigravity CLI 适配，含最严格的用户 profile 审计 |
| `scripts/doctor.ts` | 13 | 诊断工具：跑健康检查并打印 JSON，**永不显示密钥值** |

---

## 3. 核心抽象：`Provider` 接口

`src/types.ts:21-33`。整个网关只依赖这 7 个成员：

```ts
export interface Provider {
  id: string;
  models: string[];
  enabled: boolean;
  priority: number;                                   // 越小越优先
  maxConcurrency: number;
  capabilities: { system: boolean; history: boolean };
  reservationCosts?: { requests: number; outputTokens: number; credits?: number };
  validate?(request: ChatRequest): void;             // 纯函数预检，不许有 I/O
  health(signal?): Promise<{ available: boolean; detail?: string }>;
  quota(model, signal): Promise<QuotaSnapshot>;
  invoke(request, signal): AsyncIterable<ProviderEvent>;
}
```

三个设计决定值得单独说：

**① `invoke` 返回 `AsyncIterable`，不是 Promise\<string\>。**
这是"不交付即可回退"能成立的技术基础。适配器用 `async function*` 逐个吐出事件，网关可以**在拿到第一个 text 之前**决定要不要换人。代价是 `server.ts:265` 外面套了一层 `for await`，以及非流式模式要做缓冲聚合（见 §7）。

**② `validate` 是纯函数，不允许有 I/O。**
`scheduler.ts:68` 在**还没 spawn 进程、还没发 HTTP** 之前就调用它。测试 `adapters.test.ts` 里专门有一条 `provider pure preflight rejects CLI history and SIWC system placement without I/O`，断言"预检失败时 `invoke` 的调用次数是 0"。这避免了"因为不支持的消息语义，白白启动一次 CLI 然后失败"。

**③ `capabilities` 只有两个布尔值，不是能力集合。**
因为真实需求只有两个维度：能不能带 `system`/`developer` 指令，能不能带多轮历史。加新维度就要改接口，刻意让它变贵。

---

## 4. 启动：`main.ts`

只有 54 行，是标准的"装配 + 优雅退出"：

```ts
const config = await loadConfig(resolve(file));   // 失败 → 打印 + exitCode 1
const keys = secrets(config);                      // 失败 → 明确提示设哪些环境变量
const providers = config.providers.map(createProvider);
const state = new State(config.statePath);
const server = createGateway({ ...config, ...keys, providers, state });
```

注意：**所有可能失败的事情都发生在 `listen` 之前**。密钥不对、配置非法、适配器参数不合法，都在启动时立刻退出，而不是等第一个请求打进来才炸。

优雅退出（`main.ts:38-49`）：

```ts
const shutdown = () => {
  if (closing) return;            // 幂等，重复信号不重复关
  closing = true;
  server.close(() => state.close());   // 等存量连接结束
  server.closeIdleConnections();        // 空闲的立刻断
  setTimeout(() => server.closeAllConnections(), 2000).unref();  // 2s 后强杀
};
```

`unref()` 是关键：不让这个定时器把进程吊住。挂起连接最多存活 2 秒。

---

## 5. 配置：`config.ts`

已经在单独解释 `config.ts:181` 时详细讲过 `validateConfig` 的白名单哲学。这里补充**只有读代码看不出来的东西**：

**为什么相对路径锚定配置文件目录（`:185`）**

```
resolve(dirname(full), config.statePath)
```

配置文件里写 `data/gateway.sqlite`，实际落盘位置是**配置文件旁边**的 `data/`，不是当前工作目录。这让程序可以从任何 cwd 启动。`:memory:` 是 SQLite 内存库特判，必须短路否则会被 `resolve` 破坏。

**为什么 demoMode 用固定假密钥（`:189-194`）**

`demoMode` 下密钥硬编码为 `demo-local-gateway-key-12345678`。目的是让人能 `git clone` 下来直接 `npm run demo` 跑通，不用先设环境变量。生产路径下 `secrets()` 会强制要求两个密钥长度 ≥ 24 且互不相同。

**配置里绝对不能出现的东西**

- 明文密钥 → `fields` 白名单会把它当"未知字段"拒掉（`:36`）
- `host: "0.0.0.0"` → `:39` 只允许 `127.0.0.1` / `::1`
- `gatewayKeyEnv === adminKeyEnv` → `:42` 拒绝，防止密钥复用导致提权
- `demoMode: true` 但列表里有真实供应商 → `:158` 拒绝，防止"以为在演示其实在烧钱"
- 模型名含 `/` → `:85` 拒绝，因为模型名会拼进路由路径

---

## 6. 调度核心：`scheduler.ts`

### 6.1 三阶段结构

**阶段 A：并行发现候选（`:49-116`）**

`Promise.all` 同时探询所有供应商，每个供应商走 6 道闸门，任意一道不过就 `return null` 并记录 `lastError`：

```
enabled？ ──否──→ 跳过
  ↓ 是
model = auto ? p.models[0] : 别名解析
  ↓
能力匹配？（system/developer 需要 capabilities.system；
         >1 条 user/assistant 需要 capabilities.history）──否──→ 记 unsupported
  ↓ 是
p.validate() 纯函数预检（不 spawn、不发请求）        ──抛──→ 记错误
  ↓
state.getBlock() 有冷却？ ──是──→ 记入 exhaustedUntil
  ↓ 无
health() 且 available？（3s 超时，探针不互相阻塞）  ──否──→ 记 auth_required
  ↓ 是
额度：缓存够新就复用，否则调 quota() 并存库
  ↓
quotaScore() === 0？──是──→ 算重置时间，必要时写入冷却
  ↓ >0
成为候选
```

几个容易忽略的细节：

- **`auto` 模式只用 `p.models[0]`**（`:52`）。也就是说 `auto` **不会**在一家供应商的多个模型之间轮换。想指定模型必须写显式别名 `codebuddy/hy3`。这是有意的——README 明确说了"auto 当前仍优先选择火山的 deepseek-v4.1-flash，不会随机轮换模型"。
- **健康探针有独立超时**（`:78`，默认 `min(3000, max(10, timeoutMs/4))`）。测试 `hung health candidate cannot block a healthy provider` 构造了一个 `health()` 永不 resolve 的假供应商，断言健康供应商在 150ms 内被选中。
- **额度刷新条件很保守**（`:88-92`）：`source === 'manual'` 的快照**永不自动刷新**（那是人工录的，重启也要保留）；其余情况在 `source === 'unknown'` 或超过 `quotaTtlMs`（默认 60s）时才重新拉取。
- **能力不匹配的 `lastError` 是 `unsupported`**。所以如果你发了一个带 system 的多轮请求而唯一的供应商是 CodeBuddy（只支持单轮），最终返回的是 400 + `unsupported`，而不是模糊的 500。

**阶段 B：排序（`:118-126`）**

```ts
if (a.score === null && b.score !== null) return 1;    // 未知额度的排最后
if (a.score !== null && b.score === null) return -1;
return (b.score ?? 0) - (a.score ?? 0)                  // 分数高的优先
    || a.provider.priority - b.provider.priority        // 同分：priority 小的优先
    || a.provider.id.localeCompare(b.provider.id);      // 再同：id 字典序（保证确定性）
```

**"未知额度"排最后，而不是排第一**——这是全项目最重要的排序规则之一。README 说得很直白："余额未知候选作为后备，不能把它标成无限余额"。而 `quota.ts:34` 里，只要所有窗口都算不出比例（比如只有 `remaining` 没有 `limit`），分数就是 `null`，也就是"按 priority 排"而不是"按余额排"。

最后那行 `localeCompare` 是为了**排序稳定性**。没有它，两家分数/优先级都相同的情况下，`Array.sort` 的结果依赖引擎实现，会让回退顺序变得不可预测。

**阶段 C：逐个尝试（`:127-268`）**

```ts
for (const candidate of candidates) {
  // 6.1 二次检查：排序到执行之间状态可能已变
  if (getBlock() || quotaScore() === 0) continue;

  // 6.2 算预留成本
  cost = { requests: 1,
           tokens: 所有消息 UTF-8 字节数之和 + (reservationCosts?.outputTokens ?? 4096),
           credits: ... };

  // 6.3 原子预留
  lease = state.reserve(p.id, model, maxConcurrency, deadline, cost, quotaTtlMs);
  if (!lease) { lastError = rate_limited(retryAt: now+1000); continue; }

  // 6.4 消费事件流
  ...
}
```

**为什么要"二次检查"**（`:131-140`）：`Promise.all` 的探询阶段和实际调用阶段之间有时间差。期间别的请求可能把这家耗尽了。排序时的结论不能直接当成执行时的结论。

**预留成本的算法是刻意保守的**（`:143-145`）：用**全部消息**的字节数（不只是最后一条 user）+ 4096 输出 token。这是个悲观估计，宁可少发请求也不要超卖。README 明确说了"预留不是供应商保证"。

### 6.2 回退的唯一红线：`committed`

```ts
if (event.type === 'text') {
  if (request.stream) {
    committed = true;                                 // ← 吐出去就不能反悔
    yield { ...event, providerId: p.id, model };
  } else {
    parts.push(event.text);                           // ← 攒着，不算交付
  }
}
```

catch 里的判断（`:253-259`）：

```ts
if (committed || e.kind === 'invalid_request' || e.kind === 'unsupported' || e.kind === 'cancelled')
  throw e;      // 已经承诺了，或者重试也没用 → 立刻失败
// 否则：记 lastError，continue 换下一家
```

这解释了两个测试：

- `stream failure after text never mixes a second provider`：流式下 A 吐了 "partial" 才失败，**不能**回退到 B，因为答案会变成"半段 A + 整段 B"。
- `non-stream failure discards partial answer and falls back`：非流式下 A 吐了 "partial" 才失败，**可以**回退，因为 `buffered` 数组会被丢弃，没人看到过。

**"重试也没用"的四种错误**：客户端请求本身有问题（`invalid_request`）、供应商不支持这个语义（`unsupported`）、用户取消（`cancelled`）、已经承诺过（`committed`）。其余错误（`transient` / `quota_exhausted` / `rate_limited` / `auth_required`）都允许换下一家。

### 6.3 成功路径的收尾（`:222-234`）

```ts
this.state.consume(p.id, model, usage, cost);   // 用实际上报量记账，没上报就用预留量
accounted = true;
this.state.clearBlock(p.id, model);             // 成功了就解除冷却
try {
  const q = await p.quota(model, 1s 超时);
  if (q.source === 'official') this.state.saveQuota(...);   // 只有官方快照才覆盖
} catch {}                                        // 刷新失败不影响本次响应
for (const e of buffered) yield e;                // 交付缓冲内容
return;
```

**`finally` 里的兜底（`:260-267`）**：

```ts
finally {
  try { if (!accounted) this.state.consume(p.id, model, usage, cost); }
  finally {
    this.state.release(lease);
    if (iterator?.return) void iterator.return().catch(() => {});
  }
}
```

`accounted` 标记保证"只记一次账"。而**失败和取消也要记账**——因为请求已经发给上游了，上游很可能真的扣了额度。测试 `cancelled submitted request retains possible consumption` 断言：请求在提交后被取消，额度仍然从 3 减到 2。

`iterator.return()` 是 async generator 的早期退出钩子，它会触发适配器里的 `finally`，从而杀掉子进程、删临时目录。

---

## 7. 流式 vs 非流式

这是 `server.ts` 和 `scheduler.ts` 配合最微妙的地方。

### 7.1 流式

`server.ts:265-312`：

```
第一个事件到达 → setHeader('x-gateway-provider', ...) + setHeader('x-gateway-model', ...)
              → writeHead(200, text/event-stream)
              → 发第一个 chunk：delta:{role:'assistant'}
后续 text 事件 → delta:{content:...}
done 事件       → 最后一个 chunk：delta:{} + finish_reason + usage
              → "data: [DONE]\n\n"
```

**响应头在第一个事件到达时才写**（`:266-291`）。这意味着选定供应商之前，客户端拿不到任何 HTTP 响应。这也是"网关可以完全静默地换人"的前提。

**背压处理**（`server.ts:155-158`）：

```ts
async function write(res, data, signal) {
  if (signal.aborted || res.destroyed) throw new GatewayError('cancelled', 'Client disconnected');
  if (!res.write(data)) await once(res, 'drain', { signal });   // ← 等排空
}
```

`res.write()` 返回 `false` 表示内核缓冲区满了。必须等 `'drain'` 事件才能继续写，否则会无限堆积内存。测试 `request deadline releases upstream even when raw TCP client never reads SSE` 用一个 `socket.pause()` 的原始 TCP 客户端验证：即使客户端完全不读，总超时依然能取消上游并释放租约。

### 7.2 非流式：为什么要缓冲 + 聚合

如果非流式也直接累加字符串，5000 个小 delta 就会产生 5000 次字符串拼接，O(n²)。所以：

```ts
const flush = () => {
  if (parts.length) {
    buffered.push({ type:'text', text: parts.join(''), providerId: p.id, model });
    parts = []; partBytes = 0;
  }
};
// 每 1024 段 或 每 64 KiB 刷一次（scheduler.ts:205）
```

测试 `many tiny nonstream deltas are aggregated into bounded routed events`：5000 个单字符事件，最终 `buffered` 事件数 < 20。**既省内存，又保留了"能回退"的能力**（因为没交付）。

### 7.3 流式中途出错

`server.ts:351-352`：

```ts
if (res.headersSent) {
  res.end('data: ' + JSON.stringify(errorBody(e)) + '\n\ndata: [DONE]\n\n');
}
```

HTTP 状态码已经发出去了改不了，所以把错误**塞进 SSE 流里**再正常收尾。客户端会在已经收到部分内容后收到一个 `error` 字段——这是 SSE 协议下唯一诚实的做法。

---

## 8. 额度系统

### 8.1 四级来源（`types.ts:15`）

| source | 含义 | 会不会被自动覆盖 |
| --- | --- | --- |
| `official` | 供应商官方接口返回的 | ✅ 新的 official 快照会 |
| `manual` | 管理员通过 `/admin/quota` 人工录入 | ❌ **永不自动刷新** |
| `estimated` | official/manual 减去本地已消耗 | —（是 `getQuota` 派生出来的） |
| `unknown` | 查不到 | ❌ 已有快照时忽略新的 unknown（`state.ts:37`） |

**`reported` 字段是关键设计**（`state.ts:70-75`）：

```ts
return {
  ...reported,
  source: reported.source === 'unknown' ? 'unknown' : 'estimated',
  windows,          // 已扣掉本地消耗
  reported,         // ← 原始观测，原样保留
};
```

本地消耗只修改估算值，**永远不污染原始观测**。测试 `local estimates preserve original official observation` 断言：消耗后 `q.windows[0].remaining === 2` 而 `q.reported.windows[0].remaining === 3`。这样等官方下次返回真实数字时，可以干净地对账。

### 8.2 分数算法（`quota.ts`）

`quotaScore` 返回 0~1 的**剩余比例**，规则：

- 快照不存在或 `source === 'unknown'` → `null`（排最后）
- 已过 `resetAt` 的窗口跳过
- `remaining = w.remaining ?? (100 - w.usedPercent)`（`:12-14`）
- 非 manual 且过期（`now - observedAt > ttl`）→ 跳过，**除非**是"确实为 0 且有重置时间"（`:16-21`）。这就是 README 说的"官方数据过期时明确降为未知，不伪造余额"
- 任一窗口 `remaining <= 0` → **立即返回 0**（`:22`），不做平均
- 计算方式：percent 窗口用 `usedPercent`；有 `limit` 用 `remaining/limit`；**都没有 → `null`**
- 最后 `Math.min(...)` —— **取最紧张的窗口，不是平均**（`:34`）

测试 `known quota chooses the bottleneck across all windows` 精确验证了这点：A 有窗口 (90, 5)，B 有窗口 (30, 40)。A 分数 = min(0.9, 0.05) = 0.05，B = 0.3。**选 B**，尽管 A 的第一个窗口余量更大。

`nextReset` 取 **`Math.max`**（`quota.ts:50`）而不是 min，因为注释说得很清楚："All exhausted windows must reset before this pool can become eligible again."（所有耗尽的窗口都重置了，这个池才能重新参与。）

### 8.3 共享额度池

多个模型可以共用一个额度池（`state.ts:15` 的 `model_pools` 表）。`state.pool(provider, model)` 返回池名，默认等于模型名。

共享的意义：CodeBuddy 的 3 个模型如果都走同一个订阅套餐，那么任一模型耗尽，整个池都被排除。测试 `shared model pools account consumption together`：池里 `remaining: 2`，通过 `m1` 消耗 1，`m2` 读出来变成 1。

### 8.4 预留的原子性（`state.ts:116-176`）

`reserve` 是全项目并发安全的关键，用 `BEGIN IMMEDIATE` 手动管理事务：

```ts
this.db.exec('BEGIN IMMEDIATE');
try {
  this.sweep();                                    // 清掉过期租约
  if (count(provider) >= max)           return;    // ① provider 级并发上限
  if (recovery && count > 0)            return;    // ② 冷却到期只放 1 个探测
  if (getBlock(provider, model))        return;    // ③ 还在冷却中
  reserved = SUM(所有活跃租约的预留量);             // ④ 已承诺但未兑现的量
  for (const w of quota.windows) {
    if (w.remaining - reserved[w.unit] < cost[w.unit]) return;   // ⑤ 预算不足
  }
  INSERT INTO pool_leases ...;
  this.db.exec('COMMIT');
  return id;
} catch (e) { this.db.exec('ROLLBACK'); throw e; }
```

`BEGIN IMMEDIATE` 而不是默认的 `BEGIN`（deferred）：立即拿写锁，避免两个请求同时通过"读余量"检查然后双倍预留。这是 SQLite 里做悲观锁的标准做法。

**第 ② 条特别巧妙**：`recovery` 的 SQL 没有 `until_at` 条件，也就是说**过期的冷却记录也算**。效果就是——冷却期结束后，第一个请求获得租约并开始探测，同时第二个请求因为 `recovery && count > 0` 被拒。这样天然实现了"到期只允许一个恢复探测"。测试 `expired block permits only one concurrent recovery probe` 和 `stale official zero without reset permits one reserved recovery probe` 各测一遍。

注意 `:132-133` 混用了两个不同作用域：

- `this.count(provider)` —— **全 provider** 的活跃租约数，对应 `maxConcurrency`
- `count` 变量 —— **本池** 的活跃租约数

### 8.5 冷却时长决策表（`scheduler.ts:245-249`）

```ts
const until = e.retryAt                                    // 上游给了 Retry-After
  ?? (e.kind === 'quota_exhausted' ? nextReset(q) : undefined)  // 官方重置时间
  ?? Date.now() + (e.kind === 'auth_required' ? 300000 : 60000); // 兜底
```

| 错误 | 冷却到 | 屏蔽范围 |
| --- | --- | --- |
| `auth_required` | +5 分钟 | **整个 provider**（`block(p.id, '*', ...)`） |
| `quota_exhausted` | 官方 `resetAt`；未知则 60 秒 | 共享池 |
| `rate_limited` | `Retry-After`；未知则 60 秒 | 共享池 |

为什么认证失败要屏蔽整个 provider？因为凭据问题是 provider 级别的，不该每个模型各自失败一次。`state.ts:80` 的 `model === '*' ? '*' : pool(...)` 就是在处理这个通配符。

而成功之后 `clearBlock`（`state.ts:91`）会同时删掉池记录和 `'*'` 记录——只要有一家模型成功了，整个 provider 的认证封锁就解除。

---

## 9. 错误分类

### 9.1 kind → HTTP 状态（`errors.ts:15-25`）

| kind | HTTP | 含义 | 允许回退 |
| --- | --- | --- | --- |
| `quota_exhausted` | 429 | 额度用完 | ✅ |
| `rate_limited` | 429 | 被限速 | ✅ |
| `auth_required` | 503 | 凭据/登录失效 | ✅（并封锁 5 分钟） |
| `transient` | 502 | 上游抽风 | ✅（仅未交付时） |
| `invalid_request` | 400 | 请求本身有问题 | ❌ |
| `unsupported` | 400 | 语义不支持 | ❌ |
| `cancelled` | 499 → **实际发 408** | 客户端断开/超时 | ❌ |

`server.ts:359` 有个转换：`e.status === 499 ? 408 : e.status`。因为 499 是 nginx 的私有约定，不是 HTTP 标准，客户端库不一定认识。

### 9.2 `safeError` 的兜底策略（`errors.ts:30-34`）

```ts
export function safeError(error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : new GatewayError('transient', 'Upstream request failed');   // ← 原文丢弃
}
```

**任何非 `GatewayError` 的异常都被替换成统一的模糊消息。** 这是防止信息泄露的关键：上游的原始错误体、堆栈、路径都可能被 `JSON.stringify` 带进 `detail` 之类的字段然后发给客户端。README 的"运行时不记录 prompt、OAuth token、API key 或原始上游错误体"就是靠这一行保证的。

### 9.3 HTTP 状态 → kind 的分类（`adapters/http.ts:36-46`）

```ts
const quota = /quota|credit|budget|balance|subscription.*exhaust/i.test(code);
const kind =
  status === 401 || status === 403 ? 'auth_required'
  : status === 429 ? (quota ? 'quota_exhausted' : 'rate_lifted')
  : status >= 500                   ? 'transient'
  :                                   'invalid_request';
```

**429 要再分一次**：额度耗尽和普通限速的冷却策略不同（一个等到 `resetAt`，一个按 `Retry-After`）。判断依据是错误体里的 `error.code` 或 `error.type` 是否匹配额度相关关键词。`Retry-After` 同时支持秒数和 HTTP 日期两种格式（`:49-52`）。

### 9.4 CLI 退出码分类（`adapters/subprocess.ts:90-99`）

CLI 没有 HTTP 状态码，只能靠 stderr 正则：

```ts
/auth|log.?in|not signed/i   → auth_required
/quota|credits|usage limit/i → quota_exhausted
/rate.?limit/i               → rate_limited
默认                          → transient
```

stderr 只保留**最后 8192 字节**（`:60`），防止一个啰嗦的 CLI 撑爆内存。

### 9.5 `abortable`（`errors.ts:35-58`）

把一个 Promise 和 AbortSignal 赛跑，并保证 listener 被清理：

```ts
if (signal.aborted) {
  void promise.catch(() => {});          // ← 关键：已经取消也要处理 rejection，否则 unhandledRejection
  return Promise.reject(new GatewayError('cancelled', 'Request cancelled'));
}
```

第一行那个 `void promise.catch(() => {})` 是个容易忽略但很重要的细节：如果 signal 在调用前就 aborted 了，这个 Promise 未来仍会 reject，没人接就变成 `unhandledRejection`，在 Node 里会**直接终止进程**。

---

## 10. 适配器层

### 10.1 `createProvider()` 工厂（`adapters/index.ts:30`）

它不是一个"类"，而是一个**返回对象的函数**。所有 6 种 type 共享同一个外壳，差异通过几个闭包变量表达：

```ts
const direct   = config.type === 'codex' && config.mode === 'responses';
const enabled  = config.type === 'demo' ? (config.enabled ?? true)
               : config.enabled === true && config.billingVerified === true;
const blocked  = { codex: 'Codex app-server inference unavailable: ...' };
```

**`enabled` 的双开关是全项目的安全基石**（`index.ts:36-39`）：

```ts
enabled: config.enabled === true && config.billingVerified === true
```

真实供应商必须**同时**打开两个开关。`enabled` 是"我想用它"，`billingVerified` 是"我确认这个账号、这套凭据、这个调用方式走的是订阅而不是额外按量付费"。两个都要显式写 `true`，任何遗漏都导致关闭。`adapters/README.md` 说得直接："These unavailable states cannot be bypassed with billingVerified."

**能力矩阵（`index.ts:46-55`）**：

| type | system | history |
| --- | --- | --- |
| `demo` | ✅ | ✅ |
| `ark` | ✅ | ✅ |
| `claude` / `codebuddy` / `antigravity` | ✅ | ❌ |
| `codex` + `mode:responses` | ✅ | ✅ |
| `codex` + `app-server` | ❌（被 blocked） | ❌ |

CLI 系不支持多轮历史，是因为它们**不能把带角色标签的历史压成一段字符串**——那样会破坏语义。README 明确说了："不能因需要回退而放宽消息语义。" 所以宁可返回明确的 400，也不做角色压平。

**能力过滤发生在两个地方**，这是有意的双保险：
1. `scheduler.ts:54-66` 用 `capabilities` 粗筛（不调 I/O）
2. `scheduler.ts:68` 调 `p.validate()` 精筛（纯函数）

### 10.2 CLI 子进程的参数白名单（`adapters/subprocess.ts:120-135`）

```ts
export function validateBootstrap(config: ProviderConfig) {
  const args = config.args ?? [];
  const officialCodeBuddyEntry = config.type === 'codebuddy' && basename(args[0] ?? '') === 'codebuddy';
  if (args.length && (
    args.length !== 1 ||                                    // 只能有一个参数
    !isAbsolute(args[0]) ||                                 // 必须绝对路径
    (!/\.(?:mjs|cjs|js)$/i.test(args[0]) && !officialCodeBuddyEntry) ||  // 必须是 JS 入口
    !/^node(?:\.exe)?$/i.test(basename(config.command ?? ''))    // command 必须是 node
  )) throw new GatewayError('unsupported', '...');
}
```

**为什么这么严**：Windows 上 `spawn` 走 shell 会有巨大的注入面。所以项目规定：永不用 `cmd.exe`/PowerShell/`.cmd` shim，`command` 只能是 `node.exe` 或原生 `.exe`，`args` 只能是一个绝对路径的 JS 入口。

这样一来，**用户配置里的 `args` 完全没有表达能力**——不能加 `--dangerous-skip-permissions`，不能覆盖 settings，不能塞 prompt。安全 flag 现在由 `claude.ts` 的 `claudeInvoke` 和 `codebuddy.ts` 的 `codebuddyInvoke` 分别构造，共用 `cli-stream.ts` 中的 `printCliArgs`；用户无法覆盖。

`health`、`invoke`、`quota` 三个入口**都**会先调 `validateBootstrap`（`:161`、`:226`、`codex.ts:15`），测试 `all CLI health paths reject runtime flags before process creation` 覆盖了这一点。

### 10.3 `codeBuddyDeniedTools`：一份硬编码的 60 个工具名

`codebuddy.ts` 中的 `codeBuddyDeniedTools` 是实测禁用工具名数组。注释解释了原因：

> CodeBuddy 2.161.0 emits a default-agent init before selecting the text agent, then injects collaboration tools even for `tools:[]`. Deny the observed catalog by separate names; its whole-tool parser does not expand `*` or commas.

翻译：Claude CLI 支持 `--disallowedTools '*'`（通配符），但 CodeBuddy CLI 2.161.0 的解析器**不支持通配符也不支持逗号分隔**，只能一个一个列。于是项目把实测观察到的全部工具名逐一列出。

同时共用的 `cli-stream.ts` 的 `printCliInvoke` 有一道运行时防线：

```ts
if (event.type === 'system' && event.tools?.length)
  throw new GatewayError('unsupported', 'CLI reported active tools despite no-tools flags');
```

**启动参数只是"请求"，运行时报告才是"事实"。** 参数说禁了但初始化事件仍报告有工具 → 直接拒绝这次请求，不信任配置。README 说的"任何初始化事件仍报告工具时会拒绝请求"就是这个。

### 10.4 Antigravity：最严格的 profile 审计（`adapters/antigravity.ts:52-103`）

其他适配器只管自己的进程，Antigravity 还要审计**用户的全局环境**：

| 检查 | 拒绝条件 | 为什么 |
| --- | --- | --- |
| `AGENTS.md` / `GEMINI.md` 非空 | 存在即拒 | 全局指令会污染输出，破坏"纯文本网关"语义 |
| `settings.json` 的 `hooks` / `hooks.json` | 存在且 digest ≠ `approvedHooksSha256` | hooks 会执行任意命令 |
| `settings.modelProvider` | 存在即拒 | 会被路由到按量计费的第三方模型 |
| `settings.useG1Credits` | `!== false` 即拒 | 开启了额外积分 = 额外扣费 |
| `mcp_config.json` 的 `mcpServers` | 非空即拒 | MCP 会拉起外部进程 |
| `rules/` `plugins/` `hooks/` 目录 | 非空即拒 | 同上 |

hooks 的处理特别讲究（`:36-50`）：

```ts
const active = Object.fromEntries(
  Object.entries(definitions).filter(([, d]) => d?.enabled !== false)
);
if (Object.keys(active).length) hooks.push({ file, definition: active });
return hooks.length ? sha256(JSON.stringify(hooks)) : undefined;
```

只把**启用中的** hook 算进摘要（`enabled !== false`，`undefined` 视为启用），然后取 SHA-256。配置里填 `approvedHooksSha256` 表示"我看过这些 hook 并批准了"。任何改动都会让摘要变化 → 重新拒绝。测试 `Antigravity hooks need explicit approval of their exact configuration` 和 `Antigravity permits explicitly disabled global hooks` 覆盖两侧。

**它还拒绝"修改用户的全局设置"**。所有检查都是只读的，发现问题就报错让用户自己去改，而不是网关替用户改。这是很值得尊重的边界。

调用时（`:199-206`）还会**剥掉商业 API key 环境变量**：

```ts
const environment = { ...process.env };
for (const name of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_APPLICATION_CREDENTIALS'])
  delete environment[name];
```

理由和上一条一样：必须确保走的是**缓存的订阅账号登录**，而不是按量付费的 API key。

还有两个细节值得一提：

- **版本必须精确匹配**（`:16`, `:119-123`）：`version.trim() !== '1.3.1'` 就拒绝。README 写的是 1.3.0，这里代码是 1.3.1——**文档和代码不一致，以代码为准**（需要核对时以 `supportedVersion` 常量为准）。
- **init 事件的严苛校验**（`:226-241`）：agent 名、model、cwd（`resolve` 后比较）、`permission_mode === 'request-review'`、`tools` 必须是数组，全部要匹配。注释解释了 `tools` 为什么只校验"是数组"而不校验内容：CLI 1.3.1 在这里**总是**advertise 全局目录，即使 `tools: []` 也一样——这是实测验证过的行为，真实的空工具控制是通过别的手段验证的。

### 10.5 `sse()` 的字节级边界控制（`adapters/http.ts:60-104`）

SSE 解析最容易出的 bug 是**边界**：CR 和 LF 分两个 chunk 到、UTF-8 多字节字符被切断、单个 `data:` 帧累积超大。

```ts
buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
// { stream: true } ← 关键：多字节字符跨 chunk 时保留残余字节
while ((newline = buffer.indexOf('\n')) >= 0) {
  const line = buffer.slice(0, newline).replace(/\r$/, '');   // ← 兼容 CRLF
  ...
  if (line === '') { yield data.join('\n'); frameBytes = 0; }  // 空行 = 帧边界
  else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
}
```

`frameBytes` 累计**整帧**大小（含所有行），超过 1 MiB 就报错。测试 `SSE bounds accumulated multiline frame bytes not just remaining line` 专门验证了这一点——只看"当前行"是不够的，很多行拼起来一样能超大。

`httpError`（`:9-30`）也是同样的严谨：只读 8192 字节就 `reader.cancel()`，而且读失败不会掩盖 HTTP 状态码（`:24` 注释："Body failure must not hide the HTTP status"）。

### 10.6 临时目录清理（`subprocess.ts:10-28`）

```ts
for (let attempt = 0; ; attempt++) {
  try { await remove(directory); return; }
  catch (error) {
    if (attempt >= 10 || !['EBUSY','EPERM','ENOTEMPTY','EMFILE','ENFILE'].includes(code)) throw error;
    await delay((attempt + 1) * 50);   // 线性退避：50, 100, 150, ... ms
  }
}
```

Windows 上文件锁经常导致 `rm` 立刻失败。这是**唯一一个带重试的清理逻辑**，因为它是纯粹的本地资源清理，重试无副作用。测试 `temporary directory cleanup recovers from a short Windows resource lock` 验证了它能从短暂锁定中恢复。

---

## 11. HTTP 接入层：`server.ts`

### 11.1 路由表

| 路径 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/health` | GET | 无 | 最小存活信息 |
| `/admin/status` | GET | Admin | 适配器能力 + 额度 + 冷却 + 租约 |
| `/admin/quota` | POST | Admin | 人工录入额度（source 强制 `manual`） |
| `/admin/unblock` | POST | Admin | 清冷却 + 删快照，重新采集 |
| `/v1/models` | GET | Gateway | 列出 `auto` + 所有 `provider/model` 别名 |
| `/v1/chat/completions` | POST | Gateway | 主入口 |

`/admin/*` 全部先过 Admin 鉴权再路由（`:178-179`），**没有单独的 admin 端口**。所以凭据隔离靠的是"两把不同的密钥"（`secrets()` 强制它们不同且都 ≥ 24 字符）。测试 `management requires independent admin token` 用 gateway key 打 `/admin/status` 必须是 401。

### 11.2 鉴权的常量时间比较（`server.ts:16-21`）

```ts
function authorize(req, key) {
  const actual   = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + key);
  if (!key || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new GatewayError('auth_required', 'Invalid gateway credentials', { status: 401 });
}
```

`timingSafeEqual` 要求两边**等长**，否则抛异常。所以先比长度（会短路，但这只泄露长度信息，是可接受的），再比内容。

### 11.3 请求校验的严格程度

`validateRequest`（`:61-89`）是白名单式的，**任何多余字段都直接 400**：

```ts
for (const key of Object.keys(value))
  if (!['model','messages','stream'].includes(key))
    throw new GatewayError('unsupported', 'Unsupported request parameter: ' + key);
```

发 `temperature`、`tools`、数组形式的 `content` 全部 400。测试 `unsupported tools and request fields reject before upstream` 断言这类请求下**上游调用次数是 0**。

这是刻意的**能力诚实**——与其"接受参数然后悄悄忽略"让用户误以为 temperature 生效了，不如明确报错。README 里那句"tools、图片、音频、temperature、max_tokens、JSON Schema 等均明确返回 400"就是这个决定的外部表现。

### 11.4 服务端超时配置（`:368-371`）

```ts
server.timeout = options.timeoutMs ?? 120000;   // socket 空闲超时
server.headersTimeout = 15000;                  // 收到完整请求头
server.requestTimeout = 30000;                  // 收到完整请求体
server.maxHeadersCount = 64;                    // 头字段数量上限
```

`requestTimeout`（30s）远小于 `timeoutMs`（120s），因为**上传请求体**应该很快；`timeoutMs` 管的是**等待响应**。分清这两个阶段才能既防慢速上传又给长推理留时间。

### 11.5 `finally` 里无条件 abort（`:361-366`）

```ts
finally {
  clearTimeout(deadline);
  req.off('aborted', abort);
  res.off('close', abort);
  control.abort();          // ← 一定会执行
}
```

**即使一切正常**也会 abort `control`。这不是 bug——`control` 的作用是"这个 HTTP 请求的生命周期"。正常完成时 abort 它是为了让 `Router.run` 内部那些还在跑的 `setTimeout` 和 `AbortSignal.any` 感知到终止。这保证了**任何路径下上游子进程/HTTP 连接都会被回收**，没有泄漏。

---

## 12. 资源上限汇总

散落在各处的硬限制。改这些数字时要看清楚谁在依赖它们。

| 限制 | 值 | 位置 | 作用 |
| --- | --- | --- | --- |
| 请求体 | 1 MiB | `server.ts:51` | 防止大包打爆内存 |
| 单个 SSE 帧 / CLI 行 | 1 MiB | `http.ts:85`、`subprocess.ts:76` | 防止单帧/单行无限大 |
| 上游错误体 | 8 KiB | `http.ts:16` | 只读前 8 KiB 做分类 |
| CLI health 输出 | 64 KiB | `subprocess.ts:167` | 累加统计，不是单行 |
| 回答文本总量 | 16 MiB | `scheduler.ts:197` | 单次请求上限 |
| 每次尝试事件数 | 65536 | `scheduler.ts:186` | 防事件炸弹 |
| 非流式缓冲 | 1024 段 / 64 KiB | `scheduler.ts:205` | 触发 flush 阈值 |
| Antigravity 事件/字节 | 10000 / 8 MiB | `antigravity.ts:216` | 同 65536/16MiB 的更严版本 |
| 配置文件 | 1 MiB | `antigravity.ts:23` | profile 文件读取 |
| providers 数量 | 1–32 | `config.ts:48` | |
| 单 provider 模型数 | 1–64 | `config.ts:82` | |
| 额度窗口数 | 1–16 | `server.ts:108` | |

注意 `http.ts:16` 的 `while (received < 8192)` 循环体里 `value.subarray(0, 8192 - received)`——最后一次读取会**截断**而不是等够了再停。这意味着即使 chunk 很大也只取前 8 KiB，然后立刻 cancel。防的是"上游返回 1 GB 错误体"。

---

## 13. 测试地图

7 个测试文件，**不接触任何真实账号、不需要真实密钥**，全部用本地 HTTP 服务、SQLite `:memory:`/临时文件、和 `tests/fixtures/*.mjs` 假 CLI。

| 文件 | 覆盖 |
| --- | --- |
| `config.test.ts` | 默认值、重复 id、空模型、非法 host/port、内联密钥拒绝、**PowerShell BOM 文件能读** |
| `core.test.ts` | Router 全逻辑：瓶颈窗口、零额度、跨重启冷却、并发预留、取消记账、恢复探测、非流式聚合、探针不阻塞、负数 token 不增加可用额度 |
| `http.test.ts` | 端到端 HTTP：OpenAI 响应格式、401、零额度 429+Retry-After、回退生效、流式错误、**不读数据的 TCP 客户端**、非法 usage 被丢弃 |
| `adapters.test.ts` | 6 种适配器：demo、Ark 端点拒绝、Claude/CodeBuddy 预检、SSE 分片 UTF-8/CRLF、SIWC body、Codex RPC、CLI 参数白名单、临时目录恢复 |
| `antigravity.test.ts` | profile 审计、hooks 摘要审批、版本校验、init/step/result 协议校验、取消杀进程 |
| `ops.test.ts` | `doctor` 不泄露密钥、缺密钥时 `main` 明确失败 |
| `codebuddy-setup.test.ts` | 安装/入口解析脚本 |

### 13.1 测试风格：极简 fixture

`core.test.ts:10-14` 定义了全套测试脚手架，值得学：

```ts
const request = { model:'auto', messages:[{role:'user', content:'hello'}], stream:false };
const quota = (remaining, second?) => ({ source:'official', observedAt:Date.now(), windows:[...] });
function provider(id, q = unknown(), kind?) {
  return { id, models:['default'], enabled:true, priority:0, maxConcurrency:1,
           capabilities:{system:true,history:true},
           health: async()=>({available:true}), quota: async()=>q,
           invoke: async function*(){ if(kind) throw new GatewayError(kind, kind);
                                     yield {type:'text', text:id}; yield {type:'done'}; } };
}
const collect = async (iter) => { const out=[]; for await (const e of iter) out.push(e); return out; };
```

**一个 6 行的 `provider()` 工厂就能造出任意行为的供应商。** 因为 `Provider` 是纯数据 + 三个函数，测试完全不需要 mock 框架。`node:test` + `node:assert/strict` 就够了，这也是零运行时依赖的一部分。

### 13.2 假 CLI  Fixture 的巧思

`tests/fixtures/codebuddy.mjs` 只有 15 行，但它模拟了 CodeBuddy CLI 的**真实病态行为**：

```js
// 即使 tools:[] 也要注入协作工具 —— 模拟真实 CLI 的 bug
let tools = selected && selected.tools.length === 0 && selected.mcpServers.length === 0
  ? injected : ['Read','Write',...injected];
tools = tools.filter(t => !denies.includes(t));
console.log(JSON.stringify({ type:'system', subtype:'init', tools:['Read','Write',...injected].filter(...) }));
```

这让测试能验证"`tools: []` 时真的只有注入的那几个工具，且 `--disallowedTools` 列表能挡住它们"。

---

## 14. 扩展指南：加一个新适配器

假设要加一个 `type: "newvendor"`（走 HTTP，OpenAI 兼容）：

**1. 在 `types.ts` 不用改**（`Provider` 接口不变）。

**2. 在 `config.ts` 改三处白名单**：
- `fields` 里的 provider 字段（如果引入新字段）
- `providerFields` 加新字段名
- 类型检查处（如 `'newvendor'` 加入 type 枚举）

**3. 在 `adapters/index.ts`**：
```ts
// capabilities 里加：
system:  ..., history: ...,
// validate() 里：
if (config.type === 'newvendor') { /* 纯函数校验，不许 I/O */ }
// health() 里：
if (config.type === 'newvendor') return { available: !!process.env[config.apiKeyEnv!], detail: '...' };
// quota() 里：
if (config.type === 'newvendor') return unknown();   // 或实现真实查询
// invoke() 里：
if (config.type === 'newvendor') { yield* openAIStream(response, signal); return; }
```

**4. `config.example.json` 加一条 `enabled:false` 的样例。**

**5. `tests/adapters.test.ts` 加测试**，至少覆盖：`enabled` 双开关、纯函数预检不产生 I/O、错误分类。

**6. 在 `config.ts` 确认新 provider 不会撞上 `demoMode` 检查**（`:158`）。

---

## 15. 已知不一致与注意点

给后来的人提个醒，这些是读代码时会困惑的地方：

1. **Antigravity 版本**：`src/adapters/antigravity.ts:16` 是 `1.3.1`，但 `README.md:53` 和 `src/adapters/README.md:48` 都写 `1.3.0`。以代码为准，改版本要同时改三处 + 重新验证适配契约。

2. **`config.example.json` 里的模型名是占位符**：`REPLACE_WITH_ACCOUNT_MODEL` 是故意留下的，防止有人直接复制示例配置就以为能跑。

3. **`billingVerified` 不是网关能验证的东西**。它是一个"操作者声明"。网关没法检查账号权益、没法核对扣费。README 里那句"不能代替实际扣费核对"是认真的。

4. **`available` / `health` 只诊断本地状态**。`doctor.ts:10` 硬编码了 `liveVerified: false`——因为 CLI 存在 + 有环境变量 ≠ 账号有权限。测试 `doctor reports configuration without exposing or requiring secret values` 断言了 `liveVerified` 永远是 `false`。

5. **`statePath: ':memory:'`** 只在测试里用。生产用文件路径，WAL 模式（`state.ts:12`）保证并发读写。

6. **非流式模式下"配额消费"的语义**：网关按 `usage.total_tokens` 记账（`state.ts:191`），但如果上游没返回 usage（`validUsage` 返回 `undefined`），就退回到用**预留量**（输入字节 + 4096）记账。这意味着长期下来本地估算会偏离真实消耗。README 建议用 `/admin/quota` 定期人工校准。

7. **`scripts/codebuddy.ts` 和 `login-codebuddy.ts` 是辅助脚本**，不在网关运行时路径上。`tsconfig.json` 的 `include` 包含了 `scripts/**/*.ts`，所以它们也要过 typecheck。

---

## 16. 设计哲学总结

把这 16 节压缩成 7 条：

1. **在边界处一次性消解不确定性。** `config.ts`、`validateRequest`、`validateQuota`、`validateBootstrap` 全部在入口处把"可能不对的东西"拒掉。核心逻辑（`Router.run`）因此可以放心地假设输入合法。

2. **未知就是未知，不许伪装。** `QuotaSnapshot.source: 'unknown'`、`quotaScore` 返回 `null`、`liveVerified: false`、`usage` 缺失就省略而不是填 0。`validUsage`（`usage.ts`）甚至校验 `total === prompt + completion`，不一致就整个丢弃。

3. **承诺出去就不能反悔。** `committed` 标志 + 非流式缓冲，让"在交付前自由回退、交付后绝不混合"成为可证明的性质，而不是靠运气。

4. **默认拒绝 > 默认允许。** 白名单字段、host 只允许 loopback、`enabled` 双开关、hooks 需要摘要审批、未知 baseUrl 直接拒绝、写 `args` 只能是一个 JS 入口。

5. **参数是请求，运行时报告是事实。** `--tools ''` 只是请求，初始化事件报告有工具就拒绝。`billingVerified` 只是声明，实际扣费要人工核对。

6. **显式预算而非乐观重试。** `BEGIN IMMEDIATE` 事务预留、每 provider 一次尝试、冷却到期只放一个探测——宁可拒绝请求，也不要超卖额度或重复计费。

7. **所有清理都有 finally，所有 await 都有信号。** 子进程在 `finally` 里 kill、临时目录在 `finally` 里删（还带重试）、游标提前退出触发 `iterator.return()`、`server.ts` 的 `finally` 无条件 abort。每个可能挂住的地方都接了 `AbortSignal`。

---

## 附：文件与关键行速查

| 想看什么 | 打开 |
| --- | --- |
| 请求怎么进来、怎么出去 | `src/server.ts:159-372` |
| **回退逻辑在哪** | `src/scheduler.ts:127-272` |
| 候选怎么被筛掉 | `src/scheduler.ts:49-116` |
| 排序规则 | `src/scheduler.ts:118-126` |
| 并发预留/事务 | `src/state.ts:116-176` |
| 额度分数算法 | `src/quota.ts:2-35` |
| 冷却写入/清除 | `src/state.ts:77-99` |
| 配置校验 | `src/config.ts:23-171` |
| 适配器能力矩阵 | `src/adapters/index.ts:46-55` |
| 适配器启用双开关 | `src/adapters/index.ts:36-39` |
| CLI 参数白名单 | `src/adapters/subprocess.ts:120-135` |
| CLI 安全 flag 构造 | `src/adapters/claude.ts`、`src/adapters/codebuddy.ts`、`src/adapters/cli-stream.ts` |
| CodeBuddy 禁用工具目录 | `src/adapters/codebuddy.ts` |
| SSE 解析 | `src/adapters/http.ts:60-104` |
| Antigravity profile 审计 | `src/adapters/antigravity.ts:52-103` |
| Antigravity 调用与协议校验 | `src/adapters/antigravity.ts:157-301` |
| Codex 只读额度 RPC | `src/adapters/codex.ts:10-129` |
| 错误 → HTTP 映射 | `src/errors.ts:15-25` |
| 错误体脱敏 | `src/errors.ts:30-34` |
