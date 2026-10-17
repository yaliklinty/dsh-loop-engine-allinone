# dsh-loop-engine-allinone

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Harness: 0.1.5 | 0.1.7 | 0.2.0](https://img.shields.io/badge/harness-0.1.5%20%7C%200.1.7%20%7C%200.2.0-6f42c1)](#版本兼容性)

**dsh-loop-engine-allinone** 是专为 [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh web`) 打造的 Agent 循环引擎全功能切换插件。支持**按会话独立切换** 10 家主流外部引擎与 Harness 原生 `in-process` 循环。

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
| **订阅模型选择** | 仅全局 default | **支持各引擎专属订阅模型列表**（Antigravity、Grok、MiniMax 等） |
| **UI 视觉与标识** | 基础显示 | **10 款引擎均具备专属图标与状态栏色彩字形** |

---

## 支持引擎一览

| 引擎名称 | 运行模式 / 协议 | 本机依赖与环境准备 | 专属模型 / 区域支持 |
|---|---|---|---|
| **Claude Code** | 捆绑 SDK / `ndjson` | 安装 Claude Code CLI 并登录（或使用 SDK 内置二进制） | 共享 `external` |
| **Codex** | 捆绑二进制 / `jsonrpc` | 执行 `codex login` 或配置 `CODEX_API_KEY` | 共享 `external` |
| **Pi** | 捆绑二进制 / `jsonrpc` | 配置 `~/.pi/agent/auth.json` 或对应 API Key | 共享 `external` |
| **Kimi Code** | 外部 CLI / `acp` | 安装 `kimi` CLI 并登录（位于 PATH 或配置 `kimiBin`） | 共享 `external` |
| **Antigravity** | 外部 CLI / `ndjson` | 安装 `agy` CLI 并完成 Google 账号登录 | 支持 Gemini / Claude 深度思考模型 |
| **ZCode** | 外部 CLI / `jsonrpc` | 安装 `zcode` CLI 并开通 GLM Coding Plan 订阅 | 共享 `external` |
| **Qoder CN** | 外部 CLI / `ndjson` | 安装 `qoderclicn` CLI 并登录 | 共享 `external` |
| **Hermes Agent** | 外部 CLI / `text` | 安装 `hermes` CLI 并配置认证 (`hermes setup`) | 共享 `external` |
| **Grok Build** | 外部 CLI / `acp` | 安装 `grok` CLI 并完成登录（ACP 需有效账号授权） | Grok 4.7 |
| **MiniMax Code** | 外部 CLI / `acp` | 全局安装 `@minimax-ai/code`，登录并切换至 Token Plan | MiniMax M3/M2.7 系列（支持 `cn`/`en` 区域） |

> **提示**：外部 CLI 引擎（`bundled: false`）直接调度本机已安装的工具，插件本身不捆绑、不替用户安装或登录外部 CLI。请确保对应命令行已在系统中安装就绪。

---

## 安装说明

通过 `dsh plugin` 命令行直接安装：

```sh
# 通过 GitHub 安装
dsh plugin --profile web add yaliklinty/dsh-loop-engine-allinone

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-loop-engine-allinone
```

启动 `dsh web`，打开 **Settings → Loop engine** 即可进行引擎管理与默认配置。

### 安装注意事项

- **Profile 自动配置**：安装时会自动在对应 Profile 的 `cordis.patch.yml` 中写入一段受管配置块，原有配置内容均逐字节安全保留。
- **非 Web Profile 部署**：若安装至桌面版 `desktop` 或 headless 等自定义 profile，需在配置中显式指定 `profile: <name>`：
  ```yaml
  - id: loop-engine
    config:
      profile: desktop
  ```
  *(若未指定，插件默认挂载到 `web` profile，导致自定义 profile 无法生效。)*
- **卸载插件**：执行 `dsh plugin --profile web remove dsh-loop-engine-allinone`，并手动清理 `cordis.patch.yml` 中残留的 `loop-engine` 受管块。
- **pnpm 10+ 构建拦截**：若遇到 `ERR_PNPM_IGNORED_BUILDS`（提示 `esbuild`、`@google/genai` 等构建被忽略），执行 `pnpm approve-builds` 允许即可。
- **源码模式运行 Harness**：若通过源码启动 Harness，需按照 [docs/source-checkout.md](docs/source-checkout.md) 说明配置 `file:` shim 桥接依赖包。

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
  - 声明了独立型号目录的引擎（如 **Antigravity**、**Grok Build**、**MiniMax Code**）会在模型列表中呈现其专属订阅模型，供用户灵活挑选。
  - 其余托管引擎统一归类至 `external` 分组。
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
