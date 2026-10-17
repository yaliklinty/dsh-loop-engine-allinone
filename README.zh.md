# dsh-loop-engine-allinone

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Harness: 0.1.5 | 0.1.7 | 0.2.0](https://img.shields.io/badge/harness-0.1.5%20%7C%200.1.7%20%7C%200.2.0-6f42c1)](#版本兼容性)

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

`dsh plugin` 只装进**一个** profile，名字由 `--profile` 指定。用你**实际启动的那个**——
`web`、`desktop`、`headless`，或你自己建的 profile。**没有默认值；`web` 只是一个随附模板，
不是必需项。**

### 从 npm 安装

```sh
# 把 <你的 profile> 换成你启动的那个，例如 desktop 或 web
dsh plugin --profile <你的profile> add dsh-loop-engine-allinone
```

### 从 GitHub 安装

```sh
dsh plugin --profile <你的profile> add yaliklinty/dsh-loop-engine-allinone
```

### 从本地克隆安装

只在你**开发这个插件本身**时才需要：

```sh
git clone https://github.com/yaliklinty/dsh-loop-engine-allinone.git
dsh plugin --profile <你的profile> add ./dsh-loop-engine-allinone
```

### 然后

1. 启动一次那个 profile（`dsh --profile <你的profile>`；用 web 模板的话就是 `dsh web`），
   让安装器写的受管块生效。
2. 打开 **Settings → Loop engine**，选新会话默认用哪个引擎。

### 最容易漏的一步

组合条目里写的 profile 名，必须和**你装进去的那个**一致。在那个 profile 的
`cordis.patch.yml` 里加：

```yaml
- id: loop-engine
  config:
    profile: <你的profile>
```

不写的话条目默认按 `web` 处理，于是插件把受管块写进 `profiles/web/cordis.patch.yml`，
而你实际启动的 profile 永远读不到它：插件挂上了，但基础 `agent-loop` 行没被禁，
路由器拿不到 agent factory 槽位，**任何托管引擎都不可达**。而且**不会报错**——
所以「插件装了但什么都不工作」时，第一个该查的就是这里。

> 想同时装进多个 profile 完全可以：每个 profile 各跑一次 `add`，各自写自己的 `profile:` 值。

### 安装注意事项

- 安装会重写该 profile `cordis.patch.yml` 里的一段受管块；你写的其它内容逐字节保留，升级不需要手工改。
- **卸载**：`dsh plugin --profile <你的profile> remove dsh-loop-engine-allinone`，
  **然后手动删掉**该 profile `cordis.patch.yml` 里的 `loop-engine` 受管块。
  块会比插件活得久，而它还在时 profile 里没有任何 agent factory，会话一条也建不出来。
- **pnpm 10+** 可能拦下依赖的 build script（`ERR_PNPM_IGNORED_BUILDS`，列出 `esbuild`、`@google/genai`、`protobufjs`）。
  执行 `pnpm approve-builds`，或加一条 `allowBuilds`，然后重试——只有安装方能授予这个权限。
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
| **ZCode** | 外部 CLI / `jsonrpc` | 安装 `zcode` CLI，且 GLM Coding Plan 套餐有效 |
| **Qoder CN** | 外部 CLI / `ndjson` | 安装 `qoderclicn` CLI 并登录 |
| **Hermes Agent** | 外部 CLI / `text` | 安装 `hermes` CLI 并完成配置（`hermes setup`） |
| **Grok Build** | 外部 CLI / `acp` | 安装 `grok` CLI 并登录过一次（`grok login`） |
| **MiniMax Code** | 外部 CLI / `acp` | `npm i -g @minimax-ai/code`，然后 `mcode login --region cn\|global`，再 `mcode provider use token-plan` |

> **型号表是运行时发现的，不在这里列举。** 每家引擎的型号都来自引擎自己——Kimi Code 在启动时读它自己的配置文件，ACP 引擎在开会话时从 `session/new` 的响应里拿——所以厂家发新模型**不需要插件发版**。本版本读不到目录的引擎回落到声明表，两者都没有的显示共享 `external` 分组。设置页会标明当前是哪一种。

> **提示**：外部 CLI 引擎（`bundled: false`）直接调度本机已安装的工具，插件本身不捆绑、不替用户安装或登录外部 CLI。请确保对应命令行已在系统中安装就绪。

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
  - **Pi** 与 **ZCode** 故意没有声明型号表。Pi 的型号表是**运行时刷新**的（`pi update --models` 从各 provider 拉取），写死必然过期；ZCode 的型号表读不到，因为它的 GLM Coding Plan 套餐已到期——过期账号列不出自己能用什么。
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

| 插件版本系列 | 兼容的 DeepSeek Harness 版本 |
|---|---|
| `0.2.0-rcX` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.1.7-rcX` | `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.1.5-rcX` | `0.1.5-rc.1`, `0.1.5-rc.2` |

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
