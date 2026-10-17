# Adding a hosted engine: the registry and the CLI driver layer

> **Language note**: this guide was written in Chinese during the fork, matching
> the report it came from. The upstream `docs/` are in English; translating this
> file is a natural follow-up (its content is the same either way).

## 0. 一句话

**加一家引擎 = 注册表加一行 + 驱动表加一行 + 一个驱动目录 + 词典加四条。**
TypeScript 会在每个漏掉的地方报错，不会半落地。

---

## 1. 先看清分层（改哪一层是有讲究的）

| 层 | 文件 | 能 import 什么 | 为什么 |
|---|---|---|---|
| **数据层**（两侧共用） | `engine-registry.ts`、`agent-preset-ids.ts` | **零 import** | 浏览器半要读它（设置页渲染下拉、渲染能力），所以**任何 host 包**（`dsh-settings`/`schemastery`/`node:fs`）跟进去都会污染 client 产物。`tests/agent-preset-ids.spec.ts` 用源码文本钉住这条 |
| **分派层**（仅 node） | `engine-drivers.ts` | 驱动类 | 唯一 import 各引擎驱动的模块。`./client/**` 绝不许碰它 |
| **驱动层**（仅 node） | `engine-<id>/**` | 宿主服务、子进程 seam | 协议、argv、权限、agent |

**红线**：不要在 `engine-registry.ts` 里 `import` 任何东西，也不要让它 `import` 任何东西。
凡是需要 host 的（探二进制、读登录文件、spawn 子进程）一律放 node 侧，
按 `descriptor.id` 关联。

---

## 2. 五步清单

### 第 1 步：加 id（`src/engine-registry.ts`）

```ts
export const HOSTED_ENGINE_IDS = [
  'claude-code', 'codex', 'pi', 'kimi',
  'agy', 'zcode', 'qoderclicn', 'hermes',
  'myengine',            // ← 追加在最后
] as const
```

> ⚠️ **只能追加，不能删、不能换位置。** 这些 id 被写进会话日志、侧车记录
> （`$DSH_HOME/.loop-engine/engines.json`）和 preset id（`loop-engine-<id>`），
> 是**持久化事实**，不是展示顺序。要下线一家，保留 id、把能力声明改掉，
> 而不是从数组里拿掉。`tests/engine-registry.spec.ts` 把前四家的字面顺序钉死了。

### 第 2 步：加注册表行（同一文件）

`ENGINE_REGISTRY` 是 `as const satisfies Readonly<Record<HostedEngineId, EngineDescriptor>>`
——**漏一行就编译不过**。字段含义：

| 字段 | 填什么 | 不填会怎样 |
|---|---|---|
| `id` | 与数组里一致 | — |
| `label` | 人类可读名，用于**自动生成的 preset 元数据** | 设置页与 preset 名空 |
| `repo` | 仓库/官网 URL | 设置页"引擎管理"区没有链接 |
| `bundled` | npm 依赖捆绑型 = `true`；外部 CLI = `false` | UI 会错误地给出运行时升级按钮 |
| `binConfigKey` | 组合项 `bins` 映射里的键，如 `'myengineBin'` | 部署无法指定自己的可执行文件 |
| `versionArgv` | 探版本用的 argv（**不含可执行文件本身**），如 `['--version']` | 诊断显示不出当前版本 |
| `updateArgv` | 外部 CLI 自更新 argv（如 `['update']`） | **捆绑型必须省略**（见下） |
| `loginHint` | 没登录时给用户的一句话 | 用户看到裸报错 |
| `authPaths` | home 相对路径数组，用于"是否登录过"诊断 | 诊断说不了登录态 |
| `localeKey` | 词典键，形如 `engineMyEngine` | 下拉里显示空白 |
| `capabilities` | 见 §2.1 | UI 会承诺引擎做不到的事 |
| `models` | **可选**：这家引擎自己订阅里的型号清单 `{id, label}[]` | 不填 = 模型菜单里只有一个 `default`（见 §2.2） |

**`bundled: true` ⇒ 必须没有 `updateArgv`。**
理由：捆绑型的版本由本包 `package.json` 锁死，运行时改写依赖是反模式。
`tests/engine-registry.spec.ts` 有断言，不靠评审把关。

#### 2.1 `capabilities`：声明，不是发现

```ts
capabilities: {
  streaming: boolean,              // 能不能逐 token 出
  protocol: 'ndjson'|'jsonrpc'|'acp'|'text',
  sessionResume: boolean,          // 能不能跨进程按 id 续接
  permissionModes?: string[],      // 引擎自己的权限档位名
  images: boolean,                 // 能不能原生吃图
  reasoningLevels: boolean,
}
```

**规则是"表面绝不宣称超过已实测的"**：

- 拿不准的能力一律 `false`，然后在 §6 记 TODO——**不要**填 `true` 再靠运行期报错。
- `images: false` 而这一步真带了图 → 驱动**明确拒绝**（`unsupportedImagesRefusal`），
  带上引擎名、张数和下一步动作；**不静默丢图**（丢了用户会以为引擎看过图）。
- `streaming: false` 而引擎其实能流式 → 如实写 `false` 并记 TODO。
  这个字段描述的是**驱动做了什么**，不是 CLI 能做什么（ZCode 就是这样）。
#### 2.2 `models`：让用户能选订阅里的型号

填了 `models` 的引擎会在模型菜单里获得**自己的分组**（以引擎 id 命名），组内是
`default` + 你列的型号；选一个就把**那个 id** 交给引擎（`--model <id>`）。

**为什么不是自动探测**：探测要 spawn CLI，而本插件的契约是**宿主启动时不起任何外部进程**。
所以清单是**声明**的，订阅变了就改这张表；过期 id 会在引擎侧响亮失败——这是诚实的结果。

**为什么其他引擎没有分组**：模型目录是**按 Host 世代**构建的、不按会话。
给每家都开分组 = 每个会话的菜单里出现 8 个一模一样的 `default`。
**分组只有带上别人没有的型号才算挣到位置。**

agy 的清单来自 `agy models` 实测（2026‑10‑17，已登录主机），并逐个验证可选：

```
gemini-3.8-flash-high / -medium / -low
claude-sonnet-4-6 / claude-opus-4-6-thinking
gpt-oss-120b-medium
```

加一家的清单时：跑一次 `agy models`（或该引擎的等价命令）拿到 id 与显示名，
填进注册表，再跑 `smoke-driver.ts <engine> <model-id>` 确认真能选上。


### 第 3 步：写驱动目录 `src/engine-<id>/`

推荐形状（照 `engine-qoderclicn/` 抄最省事）：

```
src/engine-myengine/
├── process.ts   # 可执行文件解析 + argv 构造 + 权限映射（纯函数，最好测）
├── agent.ts     # CliHostedAgent 子类：只实现 runStep
└── loop.ts      # Config(schemastery) + CliEngineRuntime 子类：只实现 buildAgent
```

**绝大多数逻辑都是继承来的**，你只需要写 `runStep`：

```ts
export class MyAgent extends CliHostedAgent {
  protected override async runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed' } | null> {
    // 1) 能力守卫（做不到就明确拒绝）
    const refusal = unsupportedImagesRefusal(messages, ENGINE_REGISTRY[MY_ENGINE])
    if (refusal !== undefined) throw new Error(refusal)

    // 2) 组装 prompt（几乎总是这两行）
    const cwd = this.session.header.cwd ?? (() => { throw new Error('no cwd') })()
    const history = this.history()
    const prompt = engineSlashPrompt(history) ?? serializeHistory(history, this.imageAccess)

    this.assertRequestHeader()

    // 3) spawn 一趟，把帧喂给 this.sink
    const transport = this.spawn(mySpawnRequest({ bin, prompt, cwd, env: this.config.env, signal }))
    const accept = (frame: CliFrame): void => { this.sink.accept(frame, position) }
    await runNdjson({ transport, map: doc => mapMyFrames(doc, accept, run) }, () => {})

    // 4) 收尾：失败必须 throw（base 会把它记成 turn/end 的 error）
    const outcome = this.sink.finish(position)
    if (outcome.kind === 'failed') throw new Error(outcome.message)
    return { kind: 'completed' }
  }
}
```

**基类已经替你做好、不要重写的东西**（新引擎不该重新踩一遍这些坑）：

- turn/step 相位机、`agent/error` 上报、`turn/end` 的 reason 归属
- durable 收件箱（`DriverInbox`）、`send/followup/steer/inject/cancel`
- `agent/pre-step` waterfall、`agent/turn-stopping`
- `/name` 技能手势扫描与注入
- maintenance 相位、`whenIdle`、状态迁移

**`SessionSink` 替你做好、更不要重写的东西**（这些是"写错就整条日志打不开"的）：

- assistant 消息生命周期（live 帧 + 紧凑 stream + durable 消息）
- **一个 tool call 只能有一条 `tool/result`**（引擎重复上报时丢重复）
- **`tool/result` 之前必定先有承载其 `tool-call` 块的 assistant 消息**
- `tool/call` 事件写在所属消息**之后**（日志顺序 assistant/message → tool/call → tool/result）
- step 轮转（已结算段落后开新 step；**还欠结果就不轮转**）
- 关 step 时给所有未结算调用补一条失败结果（否则 `step/end` 带未决宣告，V4 拒绝加载）

### 第 4 步：挂进分派表（`src/engine-drivers.ts`）

```ts
export const ENGINE_DRIVER_FACTORIES: Readonly<Record<HostedEngineId, EngineDriverFactory>> = {
  // …
  myengine: (ctx, config) => {
    const bin = pinnedBin(config, 'myengineBin')
    return new MyEngineLoop(ctx, {
      ...config.model === undefined ? {} : { model: config.model },
      ...config.env === undefined ? {} : { env: config.env },
      ...bin === undefined ? {} : { bin },
    })
  },
}
```

同样是**全量 Record**，漏了就编译不过。

**组合项字段**：优先复用已有的通用字段（`model` / `env` / `childIdleMs` / `bins`）。
只有当某家的旋钮真的独一无二时才往 `EngineDriverConfig` 加字段——
`bins` 这个开放映射就是为了让"可执行文件指定"永远不必再加字段。

### 第 5 步：加词典（`src/client/locales.ts`）

`engineMyEngine: 'My Engine CLI'`，**中英各一条**。

引擎名标签是从注册表 `localeKey` **派生**的映射类型：

```ts
export type LoopEngineKey = LoopEngineFixedKey & { [K in EngineLocaleKey]: string }
```

所以**只加注册表行、不加词典 = 编译不过**（不是运行期显示空白）。
这是刻意的：漏一条文案应该是构建失败，不是用户看到空白下拉。

---

## 3. 协议适配器：先看能不能复用

`src/driver-cli/` 已有四种骨架。**先判断你这家属于哪一种，能复用就别新写映射**：

| 骨架 | 文件 | 覆盖 | 复用者 |
|---|---|---|---|
| 行分隔 JSON | `ndjson.ts` | 分帧（行切分、跨 chunk 重组、**保留无换行的末行**、跳过空行） | 所有 ndjson 家族 |
| Claude `stream-json` 方言 | `stream-json.ts` | `system/init`·`assistant`·`user(tool_result)`·`result` → 帧 | **qoderclicn**（Claude Code 本体及同族 fork 通用） |
| 纯文本 | `text.ts` | 整段 stdout 即回答；**退出码算答案的一部分** | **hermes**、**zcode** |
| JSON-RPC | — （见 §6 TODO） | codex 的 app-server / zcode 的 app-server | 待补公共骨架 |
| `event` 信封 | `engine-agy/frames.ts` | `event` + `step_update`（`step_type`/`state`）+ `result` | **agy**（样板：init 取会话 id、`text_delta` 流式、`step_type:"tool"` 工具） |

判定顺序：

1. CLI 有 `--output-format stream-json` 且帧里有 `type/subtype/session_id/message`
   → 大概率就是 Claude 方言，直接 `mapStreamJsonDocument`，**只写 transport**。
2. CLI 有"一行一条 JSON"但字段名不同 → 用 `ndjson.ts` 分帧 + 自己写 `map(document) → CliFrame[]`。
3. CLI 只打印散文 → `text.ts`，并在注册表写 `protocol: 'text'`、`streaming: false`。
4. CLI 是 JSON-RPC → 目前没有公共骨架，见 TODO；先按 1~3 里最像的落地，
   **不要**照方法名猜参数形状（见 §5 的 zcode 教训）。

### 3.1 归一化帧词汇（`frames.ts`）

映射器只需要产出这几种帧，其余全部丢掉：

```ts
{ kind: 'segment' }                                    // 新助手段开始（会清掉上一次的失败裁决）
{ kind: 'text',      text, index? }                    // 答案增量
{ kind: 'reasoning', text, index? }                    // 思考增量
{ kind: 'tool-call',   call: { id, name, arguments } }
{ kind: 'tool-result', result: { id, text, isError } }
{ kind: 'usage', usage: { input, output, cacheRead?, cacheWrite?, thinking? } }
{ kind: 'error', message }                             // 引擎自己的失败裁决（记录，不立刻抛）
{ kind: 'settle' }                                     // 这一趟结束
```

**未知帧一律丢，不许抛。** CLI 长出新通知不能把正在工作的驱动搞崩。
`index` 是可选的协议内容块下标：给了就保住模型自己的块布局，不给就按 kind 各攒一块。

---

## 4. 加完之后必须做的验证

```sh
cd src/dsh-loop-engine

# 1) 类型 + 全量测试（注册表的全量 Record 会在这里把所有漏掉的地方抖出来）
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit
node node_modules/vitest/vitest.mjs run

# 2) 构建 + 浏览器产物纪律（只许出现那四个外部依赖）
node build.mjs
grep -o 'require("[^"]*")' lib/client.js | sort -u
#   期望：react / react/jsx-runtime / dsh-client-store / dsh-client-ui-primitives
#   冒出 node:* / dsh-settings / dsh-agent-presets ⇒ 有 host 包漏进 client 产物

# 3) 协议探测（先探再写；报告进 output/probes/）
node scripts/probe/probe.mjs myengine --out ../../output/probes

# 4) 驱动侧端到端（真 CLI + 你自己的 argv 构造器 + 帧映射器）
node node_modules/tsx/dist/cli.mjs scripts/probe/smoke-driver.ts myengine
```

第 4 步是**最有价值的一步**：它证明"驱动真会说这家的协议"，
而不只是"单测里的假子进程会说"。qoderclicn/hermes 的 SMOKE OK 就是它给的。

---

## 5. 已知的坑（都是踩过的）

### 5.0 stdin 每一行必须带 `event` 判别字段（agy）

`{"type":"user","message":{…}}` → `error: stream input message is missing the "event" field`。
正确形状是 `{"event":"user","message":{…}}`。实测 `message` / `prompt` / `user_message`
只是 **warning 并被忽略**，而 `user` 少了 `message` 成员才是 error。

**通用教训**：①别照搬别家 CLI 的字段名（Claude 方言用 `type`，agy 用 `event`）；
②"未知判别值只 warning 不失败"是好设计——将来引擎加输入类型不会搞崩驱动。

### 5.0b 协议不给 call id 时怎么合成（agy）

dsh 的 pending-tool 映射按 id 索引，且**一个 id 只允许一条结果**。
agy 只用 `step_index` 标识会话内的工具，所以驱动合成
`` `${conversation_id}-tool-${step_index}` ``。
**前提是"每趟都开新会话"**（驱动不传 `--conversation`）；一旦改成复用会话，
这个 id 就不再唯一，必须换成真正的全局计数器。

### 5.0c 权限开关可能不是你猜的那个旗标（agy）

agy 的 `--mode`（accept-edits/auto/plan）**不改变** `permission_mode`；
headless 下它固定是 `request-review`，**任何需要授权的工具都被自动拒绝**
（CLI 原话：`a tool required the "command" permission that headless mode cannot
prompt for, so it was auto-denied`）。真正让它跑工具的是
`--dangerously-skip-permissions`（→ `always-proceed`）。

**通用教训**：接入前把"哪个旗标真的改变了权限行为"实测出来
（看 init 帧里的 `permission_mode` 之类字段），不要照名字猜。

### 5.1 可选值旗标会吃掉下一个参数（agy）

`agy --print` 的 `--print` 是**可选值**。裸写会把 `--input-format` 当 prompt 吃掉。
**修法**：`--print=`（空值钉住参数位）。
`tests/engine-agy/process.spec.ts` 有回归断言——一次"顺手清掉空值"会让每一步坏掉。

### 5.2 桌面 App 内的 Node bundle 要过 node 跑（zcode）

`zcode.cjs` 是 Node 脚本，`argv[0]` 必须是 `process.execPath`，
直接 spawn 会 `EFTYPE`。所以解析器返回的是**argv 前缀数组**而不是单一路径。

### 5.3 脱离 App 跑 bundle 会找不到自己的资源（zcode）

需要 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指到 App 自带的那份
`resources/config/provider/zcode-builtin.json`。驱动提供**探测到的默认值**，
部署在 `env` 里显式给的**优先**。

### 5.4 账号相关的档位不是全局常量（agy）

`--mode auto` 在某些账号上是 `not available for this account`。
**教训**：不要给"引擎自己也没保证"的档位设默认值——宁可不传，让它用自己的默认。

### 5.5 状态目录必须靠**继承**环境拿到（hermes）

`HERMES_HOME` 一旦被插件整个替换掉环境，会话就会对着空状态目录启动
（等于未登录安装），而报错看起来像"模型坏了"。
`tests/engine-hermes/process.spec.ts` 钉死"驱动不伪造 `HERMES_HOME`"。
**通用规则**：spawn 的 `env` 永远是**叠加**在 seam 清洗过的父环境之上，不是替换。

### 5.6 prompt 是 argv 参数时不要开 stdin 管道

开了就是一个子进程永远不读的管道。`stdin: 'ignore'` 与 `'pipe'` 的选择
由 `cliSpawner(spawn, graceMs, pipeStdin)` 的第三个参数决定。

---

## 6. TODO 清单（按价值排序）

| # | 事项 | 为什么值得做 | 前置 |
|---|---|---|---|
| 1 | **agy 流式块映射** | 主机登录后即可拿到逐 token 输出 | 用户重新登录 Google |
| 2 | **JSON-RPC 公共骨架** | codex 与 zcode 两家的 app-server 是同一形态，值得抽一层 | 探到 zcode 的 `initialize`/`session/create` 请求参数 |
| 3 | **zcode app-server 驱动** | 换取结构化流式输出与工具事件 | 同上 + 续订 GLM 套餐 |
| 4 | **grok / minimaxcode 探针落地** | 加两家 | 先装 CLI |
| 5 | **把现有四家驱动迁到 `CliHostedAgent`** | 消掉约 4 × 450 行重复相位机 | 高风险，需逐家回归；**当前刻意不动**，免得碰已验证的协议 |
| 6 | **设置页"引擎管理"子区**（阶段 D） | 版本 / 升级 / 诊断集中展示 | 完成，见 `output/交付说明.md` |

---

## 7. 一句话记住的原理

> **注册表是数据的唯一来源，分派表是 node 侧的唯一来源，`CliHostedAgent` + `SessionSink`
> 是"会写错的地方"的唯一实现。** 加一家引擎 = 往这三处各投一行 + 写一个 `runStep`。
