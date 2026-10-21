# dsh-loop-engine-allinone

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Harness: 0.1.5 | 0.1.7 | 0.2.0 | 0.2.1](https://img.shields.io/badge/harness-0.1.5%20%7C%200.1.7%20%7C%200.2.0%20%7C%200.2.1-6f42c1)](#版本兼容性)

**dsh-loop-engine-allinone** 是专为 [DeepSeek Harness](https://github.com/deepseek-ai)（`dsh`）打造的 Agent 循环引擎全功能切换插件。支持**按会话独立切换** 10 家主流外部引擎与 Harness 原生 `in-process` 循环。

> `dsh` 是 harness 的命令行程序；`dsh --profile <名字>` 启动它的某个 **profile**。引擎选择器与本插件的设置页出现在**任何渲染 web UI 的 profile** 里（随附的 `web` 模板是其中之一，桌面版用的是 `desktop`）。

各会话完全隔离互不干扰：一个窗口运行 Codex，另一个窗口可同时运行 Kimi Code 或 Antigravity。托管引擎之间支持**无缝原地热换**；切换至原生 `in-process` 时会自动刷新页面重新挂载（无需重启 `dsh web` 后端进程）。**全程无需修改 DeepSeek Harness 主仓库源码**。

> **Fork 说明**：本项目基于 [`kuun993/dsh-loop-engine`](https://github.com/kuun993/dsh-loop-engine) 进行深度重构与扩展。  
> 上游插件实现了初代 4 款引擎的按会话切换。本 Fork 将其重构为**统一的数据驱动引擎注册表**与**可插拔的共享驱动架构**，将支持的引擎一举扩充至 **10 款**，并支持外部 CLI 自由配置与独立订阅模型选择。

---

### 核心亮点与对比

| 功能特性 | 上游仓库 (`kuun993`) | 本 Fork (`allinone`) |
|---|---|---|
| **支持引擎数** | 4 款 | **10 款**（+ 原生 `in-process`） |
| **引擎名单维护** | 分散硬编码在 5+ 处文件 | **单张注册表统一声明** (`src/engine-registry.ts`) |
| **接入新引擎** | 需修改 5 个文件 | **1 行注册表 + 1 个驱动实现** |
| **ACP 协议支持** | 仅 1 款（Kimi） | **3 款**（Kimi / Grok / MiniMax）共享一套标准化 ACP 驱动骨架 |
| **外部 CLI 适配** | 零散处理 | 标准化 `driver-cli/` 与 `driver-acp/` 运行时 |
| **订阅模型选择** | 仅全局 default | **按引擎独立的订阅型号表，运行时自动发现**（厂家发新模型无需插件发版） |
| **UI 视觉与标识** | 基础显示 | **10 款引擎均具备专属图标与状态栏色彩字形** |

---

## 安装说明

```sh
dsh plugin --profile web add dsh-loop-engine-allinone
```

重启 `dsh web`，打开 **Settings → Loop engine**。

### 想从 GitHub 装而不是 npm

```sh
dsh plugin --profile web add yaliklinty/dsh-loop-engine-allinone
```

### 从本地克隆安装

只在开发插件本身时才需要：

```sh
git clone https://github.com/yaliklinty/dsh-loop-engine-allinone.git
dsh plugin --profile web add ./dsh-loop-engine-allinone
```

### 不是 `web` profile？

`web` 是 harness 自己的 CLI 文档里用的那个 profile（`dsh web` 就是 `dsh --profile web`
的简写），所以它是正确的默认值。但桌面版启动的是 `desktop`，CI 部署可能用 `headless`，
你也可能自己建过一个。这种情况下：

1. 用那个 profile 的名字安装 —— `dsh plugin --profile desktop add dsh-loop-engine-allinone`；
2. **并且**在组合条目里写上同一个名字：

   ```yaml
   - id: loop-engine
     config:
       profile: desktop
   ```

**第 2 步才是会咬人的地方。** 该字段默认是 `web`，漏写会让插件把受管块写进
`profiles/web/cordis.patch.yml`，而你实际启动的 profile 永远读不到它：插件挂上了，
但基础 `agent-loop` 行没被禁，路由器拿不到 agent factory 槽位，**任何托管引擎都不可达**
——而且不报错。本版本会在检测到这种情形时告警，并指出该设哪个字段。

### 安装注意事项

- 安装会重写该 profile `cordis.patch.yml` 里的一段受管块；你写的其它内容逐字节保留，升级不需要手工改。
- **卸载**：`dsh plugin --profile web remove dsh-loop-engine-allinone`，**然后手动删掉**
  该 profile `cordis.patch.yml` 里的 `loop-engine` 受管块。块会比插件活得久，而它还在时
  profile 里没有任何 agent factory，会话一条也建不出来。
- **一次性脚本授权**。pnpm 10+ 默认不执行依赖包自带的安装脚本，要由安装方批准，
  所以首次 `dsh plugin add` 可能停在 `ERR_PNPM_IGNORED_BUILDS`，点名 `@google/genai` 与
  `protobufjs`。**这不是缺依赖，也没有任何东西要你手动装**——整棵树（含捆绑的 Pi 引擎）
  已经落盘，pnpm 只是在问要不要执行这两个包自带的脚本：

  | 包 | 脚本 | 实际做的事 |
  |---|---|---|
  | `@google/genai` | `preinstall` | `echo 'preinstall: no-op'` |
  | `protobufjs` | `postinstall` | 读自己的 `package.json`，打印一行版本方案警告 |

  两个都是空操作，**所以批准或拒绝都安全**：批准就执行，`allowBuilds: false` 就跳过。
  拒绝这条路径已实测——两者设为 `false` 后，`@google/genai` 正常加载（145 个导出）、
  `protobufjs` 正常加载、Pi 的 `dist/cli.js` 也在。这两个包**只由捆绑的 Pi 引擎带进来**；
  Claude Code 与 Codex 不带安装脚本，永远不会因为它们弹这个窗。

  **每个 profile 只问一次**——答案写进该 profile 的 `pnpm-workspace.yaml`，
  之后的安装与升级都不再问。想在首次安装前就预先回答，往该 profile 的
  `pnpm-workspace.yaml` 加：

  ```yaml
  allowBuilds:
    '@google/genai': false
    protobufjs: false
  ```
- **用源码启动 harness** 时，要用 `file:` shim 把 profile 的 harness peer 包桥接到 checkout 源码，
  否则恢复会话会报 `agent-presets: refusing to compose an unscoped context`。
  步骤见 [docs/source-checkout.md](docs/source-checkout.md)。

## 支持引擎一览

| 引擎名称 | 运行模式 / 协议 | 本机依赖与环境准备 |
|---|---|---|
| **Claude Code** | 捆绑 SDK / `ndjson` | 默认什么都不用装（SDK 自带二进制）；要跑自己的那份就设 `bins.claudeBin` |
| **Codex** | 捆绑 / `jsonrpc` | 执行 `codex login` 或配置 `CODEX_API_KEY` |
| **Pi** | 捆绑 / `jsonrpc` | `~/.pi/agent/auth.json`，或提供方的 API-key 环境变量 |
| **Kimi Code** | 外部 CLI / `acp` | 安装 `kimi` CLI 并登录（`kimi login`） |
| **Antigravity** | 外部 CLI / `ndjson` | 安装 `agy` CLI 并完成 Google 账号登录 |
| **ZCode** | 外部 CLI / `ndjson` | 安装 `zcode` CLI；跑它自己的型号需要有效的 GLM Coding Plan，跑 dsh 模型则走交接 |
| **Qoder CN** | 外部 CLI / `ndjson` | 安装 `qoderclicn` CLI 并登录；跑 dsh 模型还要求启动时权益检查能访问 Qoder API（`allow_byok >= 2`） |
| **Hermes Agent** | 外部 CLI / `ndjson` | 安装 `hermes` CLI 并完成配置（`hermes setup`） |
| **Grok Build** | 外部 CLI / `acp` | 安装 `grok` CLI 并登录过一次（`grok login`） |
| **MiniMax Code** | 外部 CLI / `acp` | `npm i -g @minimax-ai/code`，然后 `mcode login --region cn\|global`，再 `mcode provider use token-plan` |

> **型号表是运行时发现的，不在这里列举。** 每家引擎的型号都来自引擎自己——Kimi Code 在启动时读它自己的配置文件，ACP 引擎在开会话时从 `session/new` 的响应里拿——所以厂家发新模型**不需要插件发版**。本版本读不到目录的引擎回落到声明表，两者都没有的显示共享 `external` 分组。设置页会标明当前是哪一种。

> **提示**：外部 CLI 引擎（`bundled: false`）直接调度本机已安装的工具，插件本身不捆绑、不替用户安装或登录外部 CLI。请确保对应命令行已在系统中安装就绪。

### 哪些引擎能用 dsh 里配置的模型

每家引擎都**能跑它自己的型号**。而"dsh 里配的模型"（DeepSeek、`llm-pi-ai` 里的第三方、你自己填的 API key）是另一回事：插件必须
把那个模型的端点与凭据交给引擎，而每家引擎接受这件事的方式不同——有的根本不接受。

| 引擎 | 能用 dsh 模型 | 交接方式 | 备注 |
|---|---|---|---|
| **Claude Code** | ✅ | 捆绑 SDK 的 `Options.env` | 端点随 SDK 环境变量走 |
| **Codex** | ✅ | `codex app-server` 的 `-c` 覆盖项 | 协议必须是 OpenAI 兼容 |
| **Pi** | ✅ | 插件自建 agent 目录（`PI_CODING_AGENT_DIR`）+ `--api-key` | 绝不写你的 `~/.pi`；该会话看不到 `~/.pi` 里的技能/登录态 |
| **Kimi Code** | ✅ | `KIMI_MODEL_NAME` / `KIMI_MODEL_BASE_URL` / `KIMI_MODEL_API_KEY` | 纯环境变量，不落盘 |
| **Grok Build** | ✅ | `GROK_MODELS_BASE_URL` + `XAI_API_KEY` + 插件自建空 `GROK_HOME` | **只支持 OpenAI 兼容端点。** 那个空 home 是安全措施：用你自己的 `~/.grok` 时，CLI 会把账号的会话 JWT 附在一个发往该端点的辅助请求上 |
| **MiniMax Code** | ✅ | 插件自建 data 目录（`MINIMAX_DATA_DIR`）里的 BYOK `custom_provider` | 支持 `anthropic-messages`、`openai-completions`、`openai-responses`；密钥写进 `0700` 目录下的 `0600` 文件（该 CLI 没有环境变量入口），退出时删除 |
| **Antigravity** | ✅ | `AGY_LLM_GATEWAY_URL` + `AGY_LLM_GATEWAY_API_KEY` + `AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai` | 纯环境变量：改的是它自己的 LLM 网关，登录态不动 |
| **ZCode** | ✅ | 插件私有的 `provider_config.json`，由 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（外加 App 的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`）指给子进程 | 每步写一份、步末删除：`defaultModelSelection` 把 ZCode 指到 dsh 端点和 dsh 密钥。**不改也不读**你的 `~/.zcode` 配置。支持 `anthropic-messages` 与 `openai-completions`，其余协议以 `ZCODE_UNSUPPORTED_API` 拒绝。 |
| **Qoder CN** | ✅ | 插件私有的 `--config-dir` 根，内含明文 `providers` 表和 `.auth` 副本 | 每步建一个根、步末删除：`-m dsh-handover/<model>` 选中端点。你的 `~/.qoder-cn` 设置、插件和加密型号库都不动。要求账号已登录，且启动时能访问 Qoder API（`allow_byok >= 2`）；支持 `openai-completions` 与 `anthropic-messages`。 |
| **Hermes Agent** | ✅ | `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `--provider openai` | 纯环境变量：不写任何文件，且你的 `HERMES_HOME`（会话/技能/`auth.json`）照常生效 |

十家托管引擎现在都能跑 dsh 模型；差别在交接的代价：

- **协议不支持就明确拒绝，不会瞎猜。** 上限是引擎自己的协议支持——Grok 的自定义端点只吃 OpenAI 兼容，ZCode 与 Qoder CN 接受 `anthropic-messages` 或 `openai-completions`——不匹配会在子进程启动前被拒绝，并带上该引擎自己的错误码（`GROK_UNSUPPORTED_API`、`ZCODE_UNSUPPORTED_API`、`QODERCLICN_UNSUPPORTED_API`）。如果 dsh 无法披露端点或凭据，则以 `UNSERVABLE_MODEL` 失败并说明两条出路。
- **其余引擎要么纯环境变量、要么用插件自建并在步末删除的目录。** Claude Code、Codex、Hermes、Antigravity 不写文件；Pi、Kimi、Grok、MiniMax、ZCode、Qoder CN 会为跑 dsh 模型的会话换一个插件自建目录。

#### Qoder CN：两条拆不掉的硬前置

这两条属于 CLI 自己，插件无法绕过：

1. **必须已登录 Qoder CN。** `-p` 跑在 CLI 的 `local` provider-access 模式，强制
   `isAuthenticated()`。交接每步都会把 `~/.qoder-cn/.auth` 复制进私有 config 根；
   这个目录不存在时，子进程不会启动，这一轮直接以 `QODERCLICN_NOT_LOGGED_IN` 失败，
   并提示去跑 `qoderclicn login`。
2. **启动时的权益检查必须能访问 Qoder。** CLI 在放行自定义 Provider 之前会请求
   `GET https://openapi.qoder.com.cn/api/v3/user/status`，要求
   `featureSwitches.allow_byok >= 2`。断网——或网络屏蔽了该域名——检查返回 null，
   自定义 Provider 被拒，请求根本到不了 dsh 端点。**这不是离线方案**；失败时这一轮
   以 CLI 自己的错误结束，不会悄悄退回 Qoder 自己的模型。

> **ZCode 也有一条同类前置：** 必须能找到桌面 App 的
> `resources/config/provider/zcode-builtin.json`，因为 CLI 要求内置 provider 文件
> 与个人文件**同时**给出。正常安装 ZCode 即可（`%LOCALAPPDATA%\Programs\ZCode`、
> `%ProgramFiles%\ZCode` 或 `%ZCODE_HOME%`），也可以用
> `env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 自己指一份 catalog。只有一个 PATH 上的
> 裸 `zcode`、没有 catalog，交接跑不起来。

设置页里有一张同样的表（"各引擎能否使用 dsh 里配置的模型"），不翻这个文件也能看到答案。
> **工具卡片**：十家托管引擎现在都会把 `tool/call` 与 `tool/result` 连同引擎自己的参数和输出写入日志。Hermes Agent 与 ZCode 走的是它们自己文档化的 JSONL 事件流（`hermes chat -q … --format stream-json` / `zcode -p … --output-format stream-json`），也就是桌面版消费的同一套结构化接口——旧的 `-z` / 纯 `-p` 只打印最终答案。


---

---

## 配置参考

在 profile 的配置文件（`cordis.patch.yml`）中可自定义各项参数：

```yaml
- id: loop-engine
  config:
    # 1. 自定义可执行文件路径（可选，覆盖 PATH 或替换默认二进制）
    bins:
      claudeBin: 'D:/tools/claude.exe'
      kimiBin: 'D:/tools/kimi.exe'
      agyBin: 'D:/tools/agy.exe'
      qoderclicnBin: 'D:/tools/qoderclicn.exe'
      grokBin: 'C:/Users/username/.grok/bin/grok.exe'
      minimaxcodeBin: 'D:/npm-global/node_modules/@minimax-ai/code/cli.js'
      zcodeBin: 'D:/Programs/ZCode/resources/glm/zcode.cjs'

    # 2. 账号区域设置（可选，MiniMax Code 支持 'cn' 或 'en'）
    regions:
      mcodeRegion: 'cn'

    # 3. 常驻子进程空闲回收时间（毫秒，默认 0 为不回收）
    # 适用于具备常驻会话进程的引擎（Kimi、Codex、Grok、MiniMax Code）。
    childIdleMs: 300000

    # 4. 托管会话上下文上限（token，默认 262144）
    # 用于 dsh 自动上下文压缩（默认达到 80% 触发）。建议设置为使用中最小引擎的窗口。
    engineContextWindow: 262144

    # 5. 托管会话压缩摘要模型（必须成对配置）
    # 托管会话进行上下文压缩时，通过此模型进行内容摘要总结。
    summarizerProvider: 'deepseek-official'
    summarizerModel: 'deepseek-flash'
```

---

## 使用指南

- **创建新会话**：在工作区旁的 Preset 下拉栏选择目标引擎；选择 `standard` 则使用 Harness 原生 `in-process` 引擎。子 Agent 自动继承父会话的引擎。
- **修改全局默认**：在 **Settings → Loop engine** 中设置新会话的默认引擎，立即生效且不影响既有会话。
- **会话中途切换引擎**：在设置中开启「在对话页显示引擎选择器」后，可在输入框底部随时更换：
  - **托管引擎 ↔ 托管引擎**：原地热换，即刻生效。
  - **托管引擎 ↔ 原生 in-process**：弹出确认提示，确认后刷新浏览器标签页重载会话（会话历史完整保留；未发送草稿和滚动位置重置）。
  - *注意*：正在执行推理的会话不可切换，必须在会话空闲时进行。
- **状态徽标**：会话标题栏会实时显示当前正在驱动该会话的引擎图标与名称，可通过设置开关控制显隐。
- **模型与订阅选择**：
  - 声明了独立型号目录的引擎（**Antigravity**、**Codex**、**Kimi Code**、**Grok Build**、**MiniMax Code**）会在模型列表中呈现其专属订阅模型，选中即把该 id 交给引擎。
  - **菜单是按会话隔离的。** 每个会话只列它自己引擎的订阅分组，加上你在 DSH 里配置的 provider 分组；宿主每次 Host generation 只构建一张全局目录，其他引擎的分组由客户端做视图过滤（路由仍然注册着，后台会话照常可用）。所以 MiniMax 会话里不会再出现 Antigravity 或 Grok 的型号。
  - **Pi** 与 **ZCode** 故意没有声明型号表。Pi 的型号表是**运行时刷新**的（`pi update --models` 从各 provider 拉取），写死必然过期；ZCode 没有声明型号表：它自己的型号列表需要有效的 GLM Coding Plan，过期账号列不出自己能用什么——但 dsh 模型仍可通过上面的交接跑起来。
  - 其余托管引擎统一归类至 `external` 分组，组内只有一条 `default`，含义是「交给引擎自己决定」。**这不是功能限制**：它只是菜单把「本版本还没实测过型号的引擎」折叠在一起；在注册表里加一行 `models`，该引擎立刻就有自己的分组。
  - 也可以选一个**真实的 dsh 模型**：插件会把该模型的端点与凭据一并交给引擎。引擎能不能用是引擎的事，被拒会如实报错而不是悄悄吞掉。
  - 原生命令（`/export`、`/feedback`、`/permission`）及自动压缩机制完全可用。

---

## 架构设计与扩展

本插件采用严格的数据驱动设计，扩展一款新引擎仅需以下步骤：

1. **注册元数据**：在 `src/engine-registry.ts` 中添加引擎 ID 至 `HOSTED_ENGINE_IDS` 并填写配置属性与能力声明（TypeScript 保证类型完全穷举）。
2. **实现驱动逻辑**：继承 `src/driver-cli/` 或 `src/driver-acp/` 基础能力，实现核心 `runStep` 交互。
3. **注册分派表**：在 `src/engine-drivers.ts` 中绑定引擎 ID 与驱动类。
4. **UI 与文案**：在 `src/client/locales.ts` 补充显示文案，并可在 `src/client/engine-marks.ts` 中配置专属 SVG 矢量字形。

完整开发步骤与最佳实践详见 [docs/engine-registry.md](docs/engine-registry.md)。

---

## 版本兼容性

单一版本通过动态探测，全面兼容 DeepSeek Harness 多代版本：

| 插件版本 | 兼容的 DeepSeek Harness |
|---|---|
| `0.7.4` 起 | `0.2.0-rc.1` … `0.2.1-rc.1` |
| `0.7.0` – `0.7.3` | `0.1.5-rc.1` … `0.2.0-rc.2` |

并集范围是 `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.2.2-0`。
`0.2.0` 与 `0.2.1` 共用末段，因为 harness 在这两代之间没有改 API 形状，一段范围就够了。
`dsh` 的兼容性判定读的就是这些 peer，差一条就拒绝加载——这正是 `0.7.3` 在 `0.2.1` 上装不上的原因。

版本号 `<harness 线>-rcN` 中的 `rcN` 为本插件对应分支的迭代发布号。详见 [docs/compatibility.md](docs/compatibility.md)。

---

## 技术细节与已知限制

- **Agent Factory 统一门面**：本插件接管了 Harness 的 Agent 工厂。若遇到无法识别或异常的会话，会自动平滑降级至原生 `in-process` 循环，保证服务可用性。
- **会话与引擎映射**：当前会话与引擎的对应关系保存在 Sidecar 配置文件 `$DSH_HOME/.loop-engine/engines.json` 中；若环境重置则自动回退至预设默认引擎。
- **多会话并发**：同一引擎的并发会话共享该 CLI 本机的用户登录态与配置目录。
- **Grok Build Shell 支持**：Grok 相关命令行工具依赖 Harness 客户端终端桥接能力（`ctx.shell`）。

---

## 文档索引

- [docs/engine-registry.md](docs/engine-registry.md) — 引擎注册表规范与 ACP 新引擎添加指南
- [docs/per-session-engine.md](docs/per-session-engine.md) — 按会话切换引擎的详细交互机制与生命周期说明
- [docs/architecture.md](docs/architecture.md) — 插件核心架构：路由分发、Factory 槽位与 Patch 注入
- [docs/driver-core.md](docs/driver-core.md) — 共享驱动层设计与生命周期管理
- [docs/compatibility.md](docs/compatibility.md) — Harness 跨代版本兼容指南与排错说明
- [docs/source-checkout.md](docs/source-checkout.md) — 基于 Harness 源码仓库的运行调试方案
- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发规范与协议抓包探测工作流

---

## 开源协议

本项目采用 [MIT](LICENSE) 开源许可证。保留上游 `kuun993/dsh-loop-engine` 及本 Fork 贡献者的版权声明，改动范围与细节说明请参阅 [NOTICE](NOTICE)。
