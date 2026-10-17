# dsh-loop-engine-allinone

[English](README.md) · **简体中文**

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine-allinone?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine-allinone)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

像选模型一样选 **dsh web** 的 agent 循环引擎——**按会话**选：内置的 `in-process`（默认），或十家托管引擎
`claude-code` / `codex` / `pi` / `kimi` / `agy` / `zcode` / `qoderclicn` / `hermes` / `grok` / `minimaxcode`。
会话之间互不影响：一个对话跑 Codex，另一个可以同时跑 Kimi。只要会话打开且空闲，任何时候都能换引擎——
两个托管引擎之间是**原地换手**，有一边是 `in-process` 时会让**页面重新载入**（`dsh web` 进程本身**不重启**）。
以上**无需改动主仓库**。

> **本仓库 fork 自 [`kuun993/dsh-loop-engine`](https://github.com/kuun993/dsh-loop-engine)。**
> 上游插件已经能按会话切引擎。本 fork 的贡献是**一套架构**——一份数据驱动的引擎注册表
> 加一层可插拔驱动——以及这套架构让「加一家引擎」变得便宜的六家引擎。
>
> | | 上游 | 本 fork |
> |---|---|---|
> | 引擎名单 | 硬编码在五个地方 | **一张注册表**，其余全部派生 |
> | 加一家引擎 | 改五个文件 | **一行注册表 + 一个驱动** |
> | 引擎数 | 4 | **10** |
> | ACP 引擎 | 1（kimi） | **3**（kimi / grok / minimaxcode）共用一个骨架 |
> | 外部 CLI 驱动 | 每家各写 | `driver-cli/` + `driver-acp/` |
>
> 四家原有引擎的协议代码**一行未动**。`kimi` 迁到共享 ACP 骨架上时**行为不变**，
> 它那套没改过的测试就是这次迁移的回归钉。

## 引擎标记

每家引擎在引擎选择器里有自己的标记，在对话页的 turn-status 行上有自己的颜色与字形；
**只有 `in-process` 用 DeepSeek 的鱼**。

四家原有引擎用厂商公布的 path。本 fork 加的第一波四家（agy / zcode / qoderclicn / hermes）
是从**本机找到的厂商自己的 artwork** 描或量出来的——手工画的版本不像真标记，被用户否过。
第二波两家（grok / minimaxcode）从**用户提供的图**描出：Grok Build 的黑环加斜杠
（斜杠两个尖端只有约 1px 宽，所以那条描摹必须是 8 连通——4 连通会把尖端削掉约 6%），
MiniMax Code 在蓝色底上的白色团块（底色是渐变，所以掩码规则是"最暗通道仍然够亮"而不是亮度阈值）。
Grok 厂商公布的 ACP 图标是同一个标记**粗约一个像素**的版本，对照记录在 `docs/engine-registry.md`。

标记以**数据**形式放在 [`src/client/engine-marks.ts`](src/client/engine-marks.ts) 而不是 JSX 里，
所以测试能断言"每个注册的引擎都有自己的标记"。

## 引擎注册表

每一个跟引擎有关的决定都来自**一张表** [`src/engine-registry.ts`](src/engine-registry.ts)：
id 名单、能力声明、型号目录、显示文案。设置页的 schema、preset id 运算、驱动分派、
浏览器半边的选项与字形全部从它派生。第二张表
（[`src/engine-drivers.ts`](src/engine-drivers.ts)）是 node 侧唯一必须 import 各驱动类的模块。
两张表都对托管名单**全量**，所以「注册了引擎但忘了驱动」是编译错误，不是运行时才发现。

想加引擎？读 [docs/engine-registry.md](docs/engine-registry.md)——其中 §2 第 6 步是
**ACP 引擎的全部配方**：一个 profile 加四个小文件，共享层一行不用改。

## 安装

```sh
# 从本仓库装（npm 上的包名是本 fork 自己的）：
dsh plugin --profile web add dsh-loop-engine-allinone

# 或者从本地 checkout：
dsh plugin --profile web add /path/to/dsh-loop-engine-allinone
```

启动一次 `dsh web`（路由器会在有界窗口内重试，等基础 bundle 让出 factory 槽位），
然后打开 **Settings → Loop engine**。

**安装须知**

- 安装会重写 profile 的 `cordis.patch.yml` 里一小段**不带引擎 id** 的受管理块；文件里你写的其它部分逐字节保留。从更早版本升级**不需要手工改文件**。
- **装到 `web` 以外的 profile**（桌面版的 `desktop`、`headless` 部署、改过名的 profile）必须在该 profile 的组合条目里写上 `profile: <名字>`：
  ```yaml
  - id: loop-engine
    config:
      profile: desktop
  ```
  `profile` 默认是 `web`，不写的话插件会把受管块写进 `<home>/profiles/web/cordis.patch.yml`，而正在跑的那个 profile 永远不会读它：插件挂着，但基础 `agent-loop` 行没被禁，路由器拿不到 factory 槽位，任何托管引擎都不可达。（这是装进桌面版时踩出来的。）
- **卸载**是 `dsh plugin --profile web remove dsh-loop-engine-allinone` **再加上删掉那段受管理块**——块会比插件活得久，而它还在时 profile 里没有任何 agent factory，会话一条也建不出来。
- **pnpm 10+** 可能拦下依赖的 build script（`ERR_PNPM_IGNORED_BUILDS`，列出 `esbuild`、`@google/genai`、`protobufjs`）。执行 `pnpm approve-builds`（或加一条 `allowBuilds`）后重试；只有安装方能授予这个权限。
- **用源码启动 harness** 时还要多做一步：用 `file:` shim 把 profile 的 harness peer 包桥接到 checkout 源码，否则恢复会话会报 `agent-presets: refusing to compose an unscoped context`。步骤见 [docs/source-checkout.md](docs/source-checkout.md)。

## 环境要求

| 引擎 | 本机需要 |
|---|---|
| Claude Code | 已安装并登录 Claude Code CLI（或什么都不装：SDK 自带一个捆绑二进制） |
| Codex | 执行过 `codex login`，或配置 `CODEX_API_KEY` |
| Pi | `pi` 自己要求的认证方式（其 `~/.pi/agent/auth.json`，或提供方的 API-key 环境变量） |
| Kimi Code | 已安装并登录 `kimi` CLI，且在 `PATH` 上（或用 `bins.kimiBin` 固定路径） |
| Antigravity | 已安装 `agy` CLI 并完成 Google 登录 |
| ZCode | ZCode CLI 加一个有效的 GLM Coding Plan 订阅 |
| Qoder CN | 已安装 `qoderclicn` CLI 并登录 |
| Hermes Agent | 已安装 `hermes` CLI 并登录；它读自己的 `HERMES_HOME`，由子进程继承 |
| Grok Build | 已安装 `grok` CLI（`~/.grok/bin/grok.exe`，或 `npx @xai-official/grok@<pin> agent stdio`）并**登录过一次**（`grok` / `grok login`）——它的 ACP server 在没有账号时会拒绝 `session/new` |
| MiniMax Code | `npm i -g @minimax-ai/code`，然后 `mcode login --region cn\|global`，再 `mcode provider use token-plan` 才会花 M Plan 订阅额度而不是 API key |

**这些 CLI 由你自己安装，插件不装、也不登录。** 插件对 `bundled: false` 的引擎只做两件事：
探可执行文件、按 argv 起子进程（没有任何 `postinstall`，依赖里也没有这些包）。
没装时选中它会报「找不到可执行文件」，这是设计。

## 使用方法

- **新会话**——在 preset 选择器（工作区选择器旁的 chip）上选引擎；保留部署自己的默认（`standard`）则走 in-process。子 agent 沿用拉起它的那个 agent 的引擎。
- **Settings → Loop engine** 决定**新会话**的默认引擎：改完立即生效，已经在跑的会话不受影响。选 **In-process** 会把插件接手前的默认值恢复回去。
- **换当前这条会话**用对话页 composer 的引擎选择器（勾选 *在对话页显示引擎选择器*）。
  - 托管 → 托管：原地换手，当场生效。
  - 涉及 `in-process` 的方向：先弹确认框，确认后页面重新载入并回到同一条会话（滚动位置与未发出的草稿会丢，会话记录不丢）。
  - 正在跑一轮的会话会被**拒绝**，子 agent 的会话不能换。
- **对话头部那个标记**（preset 标签旁边）写的是这条会话**实际在跑**的引擎；取消勾选 *在对话头部显示引擎标记* 即可关掉它。
- **模型**——两种分组，刻意区分：
  - **声明了自己型号目录的引擎独占一组**，用引擎自己的名字（今天是 `Antigravity`、`Grok Build`、`MiniMax Code`），里面是 `default` 加该引擎订阅包含的型号。选一条就把那个 id 交给引擎（`agy --model …`，ACP 引擎则是 `session/set_config_option`），于是你能在自己的订阅里挑，而不是接受"引擎自己决定"。`default` 仍然就是那个意思。
  - **其余引擎共用 `external` 分组**，只有一条 `default`。这不是残留：模型目录是按 Host **代际**构建的、不按会话区分，一家一组会把十个一模一样的 `default` 塞进每个会话的菜单。
  - 型号表**在注册表里声明**，启动时不探测——插件开机不启动任何外部进程。订阅变了的部署改 `src/engine-registry.ts` 的 `models` 行；过期的 id 会在引擎处**响亮地失败**，这是诚实的结果。
- **`bins`**（组合条目，可选）——按每家引擎注册表的 `binConfigKey` 覆盖可执行文件：
  ```yaml
  - id: loop-engine
    config:
      bins:
        claudeBin: 'D:/tools/claude.exe'
        kimiBin: 'D:/tools/kimi.exe'
        grokBin: 'C:/Users/me/.grok/bin/grok.exe'
        minimaxcodeBin: 'D:/Programs/npm-global/node_modules/@minimax-ai/code/cli.js'
  ```
  **升级外部 CLI 后插件立刻认**：它不缓存版本、不比版本号，每次开会话都是现起进程。
  三家捆绑引擎里，`codexBin` 与 `piBin` 能让插件**彻底不依赖**捆绑包；
  `claudeBin` 只是换掉真正执行的二进制，`@anthropic-ai/claude-agent-sdk` 仍是硬依赖（value import）。
- **`regions`**（组合条目，可选）——按注册表 `region.configKey` 覆盖引擎账号区域。今天只有 MiniMax Code 声明（`regions.mcodeRegion`，默认 `cn`），因为它的登录端点与凭据都是按区域存的：
  ```yaml
  - id: loop-engine
    config:
      regions:
        mcodeRegion: 'en'
  ```
  值会写进子进程环境里**该 CLI 真正读的那个变量**（`MAVIS_REGION`——实测；`MCODE_REGION` 在 `mcode acp` 上无效）。未知值、或与 `env` 里同一个变量冲突，会在构造期失败而不是把子进程指向没人选的账号。
- **`childIdleMs`**（组合条目，毫秒，默认 `0` = 不启用）——Kimi、Codex、Grok、MiniMax Code **每条会话保有一个常驻子进程**跨 step 复用；设了它就在空闲这么久之后把子进程关掉，下一步再重新拉起。只关子进程，所以不会触发任何重载。Pi 与 Claude Code 每步各起一次，不受影响。
- **`engineContextWindow`**（组合条目，token，默认 `262144`）——dsh 给共享托管路由假设的上下文窗口。托管引擎不向 dsh 报自己的容量，这是 dsh 自动压缩算阈值用的数（默认在它的 80% 触发）。跑多家引擎时设成**最小的那个窗口**。
- **`summarizerProvider` / `summarizerModel`**（组合条目，**要么都设、要么都不设**）——托管会话**压缩**时用来做摘要的真实 dsh 模型。压缩是 dsh 自己的，但那次摘要调用是普通 llm 请求，而托管会话的路由模型是本插件的占位路由——没有这一对，托管会话永远压不下去：每次尝试只记一条警告然后继续。只设一个（或空串）会在启动期被拒。
- **dsh 自己的命令**（`/export`、`/feedback`、`/permission`）在托管引擎下照常可用。托管引擎的 preset 是 `standard` 的副本，去掉了被外部引擎接管的那几行（dsh 的 `/plan`、goal 工具与 `/goal`、技能相关行）。dsh 的**压缩是保留的**：它是让会话日志（也就是每步回放给引擎的 transcript）保持有界的唯一手段，而引擎自己的每轮压缩做不到（每步都新开一个引擎会话，引擎那边缩了、日志还在长）。配好 `summarizerProvider` / `summarizerModel`，否则那次摘要调用没有模型可用。

## 版本兼容

**一个发布版本同时服务三代 harness**：0.1.5 线（`>=0.1.5-rc.1 <0.1.6-0`）、0.1.7 线（`>=0.1.7-rc.1 <0.1.8-0`）
与 0.2.0 线（`>=0.2.0-rc.1 <0.2.1-0`）——它在加载期探测当前是哪一代、走对应分支。
这两个并集范围就是它在 `peerDependencies` 里声明的范围；超出范围的 harness 会在启动或会话恢复时**响亮地失败**。

版本读作 `<harness 线>-rcN`，其中 **`rcN` 是本插件对那条线的第 N 次发布号**，不是 harness 自己的 `rc` 号。
在被覆盖的线里，新的 harness `rc` **不需要**插件跟版——除非某个 API 面动了；
[docs/compatibility.md](docs/compatibility.md) §1 列出了这些面与判定命令。

## 已知限制

- **它替掉了 harness 的 agent factory。** 唯一那个门面服务所有会话，所以插件对此的承诺是：它读不出引擎的会话——包括跟托管引擎毫无关系的会话——一律**降级到 `in-process`**，而不是打不开。见 [docs/per-session-engine.md](docs/per-session-engine.md) §6。
- **引擎记录是侧车文件** `$DSH_HOME/.loop-engine/engines.json`，不在会话日志里：换机器或换 `DSH_HOME` 就丢，会话回退到自己的 preset。见 §5.5。
- **涉及 `in-process` 的换引擎会重新载入页面**——harness loop 既不交出活会话，也不接受不是它建的会话。见 §5.2/§5.4。
- **已经跑过一轮的会话**仍可换引擎，但只能在空闲时，且会重建那条会话的 agent。见 §5。
- **带旧 preset id `loop-engine` 的老会话**在重建一次之前显示为"旧版托管引擎"。见 §7。
- **同引擎的多条会话共享该 CLI 自己的认证目录**，插件不加锁。见 §6。
- **切回 `in-process` 之后**，模型菜单里那个共享的 `external` 分组仍在（模型目录不按会话裁剪）。
- **grok 的工具要走 harness 的 shell 服务**：它的 shell 工具通过客户端侧终端桥执行，没有 `ctx.shell` 的组合会**拒绝**而不是无约束执行。对话与推理两条路不受影响。
- **`claudeBin` 卸不掉捆绑 SDK**（见上），`codexBin` / `piBin` 可以。
- **捆绑引擎没有运行时升级按钮**，这是刻意的：它们的版本是本包的依赖钉，升级＝改依赖，不是原地改写。

## 细节都在哪

- [docs/engine-registry.md](docs/engine-registry.md) —— **加引擎的配方**；§2 第 6 步是 ACP 引擎的全部，另有 5 个踩过的坑。
- [docs/per-session-engine.md](docs/per-session-engine.md) —— 按会话选引擎的完整用户可见行为（上面引的 § 就是它）。
- [docs/architecture.md](docs/architecture.md) —— 插件核心：唯一 factory 槽位、受管理块、路由、provider 路由。
- [docs/compatibility.md](docs/compatibility.md) —— **harness 升级时先看这篇**。
- [docs/driver-core.md](docs/driver-core.md) —— 共享驱动层。
- [docs/engine-claude.md](docs/engine-claude.md) · [engine-codex](docs/engine-codex.md) · [engine-kimi](docs/engine-kimi.md) · [engine-pi](docs/engine-pi.md) —— 逐引擎内部实现。
- [CHANGELOG.md](CHANGELOG.md) —— 每个版本改了什么，含被实测推翻的假设与已知限制。
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 贡献规则（**probe first**：协议结论必须来自真实帧）。
- [docs/source-checkout.md](docs/source-checkout.md) —— 源码启动 harness 需要的 `file:` shim。
- `scripts/probe/` —— 协议探针：`probe.mjs`、`acp-handshake.mjs`、`smoke-driver.ts`、`smoke-acp.ts`。

## License

MIT —— 全文见 [LICENSE](LICENSE)。上游作者的版权声明与本 fork 的声明并列保留在其中；
本 fork 做了什么、刻意没动什么，见 [NOTICE](NOTICE)。
