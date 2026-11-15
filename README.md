# MineBots

> **让 AI 在方块世界里真的干活。**
> 一个把大语言模型接进 Minecraft 的机器人框架 —— 听得懂人话、自己会决策、能真的把东西盖出来。

<p>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-6ee7a8">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-7cc4ff">
  <img alt="tests" src="https://img.shields.io/badge/selftest-2206%20passed-6ee7a8">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-9aa7b4">
  <img alt="version" src="https://img.shields.io/badge/version-1.0.0-ffffff">
</p>

MineBots 不是按键精灵，也不是预设动作的假人。它是一个**完整的机器人运行时**：自然语言进，动作队列出，中间有意图解析、寻路、建造、红石、模组理解，外面还有一个能同时管十只 Bot 的桌面端。

```
「帮我砍十棵树，然后跟着我」
        ↓  意图解析 · 关键词兜底 · 中英混说
   动作队列（可抢占、可中断、可排队）
        ↓  寻路 · 采集 · 建造 · 战斗 · 红石
   Minecraft 里的真实角色
```

---

## 目录

- [30 秒上手](#30-秒上手)
- [它能做什么](#它能做什么)
- [架构](#架构)
- [工程质量：我们最在意的部分](#工程质量我们最在意的部分)
- [模型接入](#模型接入)
- [系统要求](#系统要求)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [English](#english)

---

## 30 秒上手

```bash
git clone https://github.com/dickyy0321/minebots.git
cd minebots
npm install
npm run gui          # 打开桌面端
```

首次启动只要三步：

1. **设置 → 模型**：选一个本地推理框架（Ollama / LM Studio / llama.cpp / SGLang），或直接填任意 OpenAI 兼容的地址与 Key；
2. **新建 Bot**：填游戏 ID，选正版 / 离线登录；
3. **进服务器**：填地址进服，或者在游戏里开个局域网，MineBots 会自动发现。

命令行模式同样可用：

```bash
npm start            # 控制台模式
npm run selftest     # 跑一遍自检（2206 条断言）
npm run guard check  # 检查有没有越过代码红线
```

> 没有游戏本体也能玩：`npm run selftest` 会用内置的模拟 Bot 驱动整条链路，不需要联网、不需要开游戏。

---

## 它能做什么

| 能力 | 说明 | 成熟度 |
|---|---|---|
| **自然语言指令** | 中英混说都认：`砍树然后跟随`、`chop then follow`、`把它围起来`。先走完整语法树，再退到关键词匹配 | 稳定 |
| **双引擎模型** | 本地 5 种推理框架，或任意 OpenAI 兼容云端；**可以按 Bot 分别绑定**，一只跑本地小模型、一只跑云端大模型 | 稳定 |
| **蓝图建造** | 一句需求 → 模型出建筑方案 → 引擎展开成逐块几何 → 多 Bot 按任务编号分片施工 | 稳定 |
| **红石电路** | 逻辑门模板（AND / OR / NOT / XOR）+ A\* 自动布线 + 中继器补位 + 供电与安全校验 | 单门可用 |
| **模组理解** | 方块 / 实体 / 配方检索，向量相似度召回，Modrinth / Wiki / GitHub 兜底；模组服协议透传（brand / Forge / registry 重试） | 稳定 |
| **多 Bot 协作** | 任务池分工、缺料互相补位、群聊频道里对话；桌面端最多同时挂 10 只 | 稳定 |
| **皮肤与花名册** | 皮肤上传、后台仓库同步、按 Bot 绑定外观 | 稳定 |
| **自愈式 QA** | 内建自检套件 + 真机脚本，改完必须全绿才允许交付 | 稳定 |

真实跑出来的数据（不是模拟）：

- **8,714 个方块**：两只 Bot 协作建成一座 77 格高的退台塔楼，0 失败；
- **2,206 条自检断言**：全部通过，覆盖解析、意图、聊天、执行、战斗、队列、旁白、模组检测、插件加载；
- **一扇真的红石门**：拉杆 → 红石线 → 铁门开合，断电即闭合。

---

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 桌面端                                          │
│  全屏设置页 · 本地标签 · 多 Bot 面板 · 聊天频道 · 皮肤仓库   │
└───────────────┬──────────────────────────────────────────┘
                │ IPC（contextBridge，渲染层不允许 require）
┌───────────────▼──────────────────────────────────────────┐
│  Bot Core                                                 │
│  意图解析 · 动作队列 · 寻路 · 建造 · 红石 · 战斗 · 旁白      │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────┐      ┌──────────────────────┐
│  Mineflayer                  │      │  模型适配层            │
│  协议 · 实体 · 背包 · 方块交互 │◄────►│  Ollama / LM Studio   │
└───────────────┬──────────────┘      │  llama.cpp / SGLang   │
                │                     │  OpenAI 兼容云         │
┌───────────────▼──────────────┐      └──────────────────────┘
│  Minecraft Java 1.21         │        可按 Bot 分别绑定
│  原版 · 模组服 · 局域网       │
└──────────────────────────────┘
```

几个刻意的设计：

- **渲染层是纯 UI**：`gui/renderer/` 里禁止 `require`，只能通过 preload 暴露的 API 说话，避免 UI 里长出业务逻辑；
- **动作可抢占**：新指令打断旧指令，`stop` 立刻停手但不破坏控制状态；
- **一切外部调用必须降级**：文件、网络、定时器、Mineflayer API 全部包 `try/catch`，失败只写日志，绝不把异常抛到顶层。

更细的抗崩设计见 [docs/mods-and-crash-resistance.md](docs/mods-and-crash-resistance.md)。

---

## 工程质量：我们最在意的部分

这个项目有一份**会失败的自检**和一套**会拦人的护栏**，不是摆设。

| 机制 | 作用 |
|---|---|
| `npm run selftest` | 2,206 条断言：静态检查（文件头注释、禁用语法、中文标识符、600 行上限、导出完整性）+ 功能套件（解析 / 意图 / 聊天 / 执行 / 战斗 / 队列 / 旁白 / 模组 / 插件）|
| `npm run guard check` | 禁改清单、越界扫描、基线快照；动到红线直接报错 |
| `npm run guard restore` | 改坏了按快照回滚 |
| 单文件 600 行上限 | 强制分层，不允许堆屎山 |
| 真机脚本 | 每次改动都要进游戏跑一遍，不只是单测 |

**这套机制救过很多次命**：红石主线铺在活塞格上被截断、建筑 Bot 各建一遍全量任务（等于建两遍）、桌面端回填配置把本地标签的框架覆盖掉——都是自检或真机脚本先发现的。

---

## 模型接入

本地推理（推荐，零成本、不联网）：

| 框架 | 默认端口 | 说明 |
|---|---|---|
| Ollama | 11434 | 一条 `ollama pull` 就能用 |
| LM Studio | 1234 | 图形界面里开 Local Server |
| llama.cpp | 8080 | `llama-server` 直接起 |
| SGLang | 30000 | 高吞吐，适合多 Bot 并发 |
| 自定义 | 8000 | 任何 OpenAI 兼容地址 |

云端：填 `baseURL` + `apiKey` + 模型名即可，兼容 OpenAI 协议的服务都能接。

**每个 Bot 可以绑不同模型**：一只挂本地 7B 做日常，另一只挂云端大模型做规划，互不干扰。参数（temperature / top_p / max_tokens）按 Bot 单独存。

---

## 系统要求

- **Node.js** ≥ 18
- **操作系统**：Windows / macOS / Linux（桌面端主要在 Windows 上验证）
- **可选**：任意一款 Minecraft Java 版 1.21 客户端（不内置游戏本体）

---

## 目录结构

```
index.js                控制台入口
gui/main.js             Electron 主进程与 IPC
gui/app-paths.js        打包态把 state/logs 指到用户数据目录
gui/preload.js          contextBridge（通道名与 window.botAPI）
gui/renderer/           纯 UI：面板、事件、状态、视图（禁止 require）
modules/                机器人核心：意图、聊天、指令、队列、旁白、建造、
                        红石、寻路、模组检测、协议透传、状态机、日志
scripts/                安装器、自检套件、真机脚本、录制工具
docs/                   设计文档
state/                  运行时数据（AI 配置、玩家档案，已 gitignore）
logs/                   运行日志与自检报告（已 gitignore）
guard.js                边界检查器（行数、禁用语法、禁改文件）
```

---

## 常见问题

**Q：会不会被封号？**
A：这是第三方客户端，和任何自动化工具一样存在风险。建议只在自己的服务器或单人世界使用，不要用于公开服务器。

**Q：必须用大模型才能跑吗？**
A：不是。模型只负责"听懂"和"出方案"，动作执行、寻路、建造都是本地代码。没有模型时仍可用完整语法指令（`dig_tree, blocks=10, oak`）。

**Q：为什么我的本地模型返回空？**
A：多半是 token 预算不够。推理模型会把思考过程算进 `max_tokens`，给到 8000 以上通常就正常了。

**Q：桌面端空白 / 打不开？**
A：如果从某些终端启动，注意 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 当作 Node 运行并静默退出，用 `env -u ELECTRON_RUN_AS_NODE npm run gui` 即可。

**Q：AI 建的房子为什么还要引擎补屋顶？**
A：单次回复装不下上万块坐标，模型负责出方案（尺寸、层数、开间、配色），几何由引擎展开。模型方案不完整时引擎会补齐结构性部分——这点我们写清楚了，不假装全是 AI 画的。

---

## 已知限制

我们宁愿把话说清楚：

- **极速通关（下界 → 要塞 → 末地 → 屠龙）尚未实现**：`speedrun_mc` 状态机的节点仍是占位参数，自检只校验定义合法，不代表能打通。
- **红石只到"单门可用"**：多门级联的网表组合与网表级真值表验证还没做。
- **安装包未做代码签名**：Windows 首次运行会弹 SmartScreen「未知发布者」，点"仍要运行"即可。
- **不是所有模组都兼容**：模组服协议做了尽力兼容，遇到重写注册表的整合包仍可能失败。

---

## 参与贡献

欢迎 Issue 和 PR。提 PR 之前请先跑：

```bash
npm run selftest && npm run guard check
```

两条都得绿。改动请保持 CommonJS + 文件头注释 + 单文件 600 行以内。

---

## English

**MineBots** is an LLM-powered Minecraft bot framework with an Electron desktop app. You talk to your bots in natural language (Chinese or English); they plan, pathfind, build, wire redstone, and cooperate.

Highlights:

- **Dual-engine AI** — 5 local runtimes (Ollama / LM Studio / llama.cpp / SGLang / custom) or any OpenAI-compatible endpoint, **bound per bot**.
- **AI blueprint building** — the model designs, the engine expands it into block geometry, multiple bots place in parallel (8,714 blocks verified in-game).
- **Mod awareness** — block/entity/recipe retrieval with Modrinth/Wiki/GitHub fallback, plus modded-server protocol passthrough.
- **Engineering discipline** — 2,206 self-test assertions, a guard that blocks off-limits edits, and a hard 600-line-per-file cap.

Requirements: Node.js ≥ 18, any Minecraft Java 1.21 client (not bundled).

```bash
git clone https://github.com/dickyy0321/minebots.git
cd minebots && npm install && npm run gui
```

Not affiliated with Mojang or Microsoft. Use at your own risk — automation on public servers may violate their rules.

---

## License

[MIT](LICENSE)

> Minecraft is a trademark of Mojang Synergies AB. This project is not affiliated with or endorsed by Microsoft or Mojang.
