# 为什么它在模组服上不崩（工程细节）

> 本文是 MineBots 1.0 的原始英文技术说明，保留下来给想看实现细节的人。

# MineBots

**Your bot crashes on modded servers? This one doesn't.**

MineBots is an off-road [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot with an Electron glass UI, a bilingual (Chinese / English) chat brain, and a mod-understanding layer that keeps it alive on servers nobody designed it for.

Vanilla bots assume they know every block, item and entity. Modded servers break that assumption on the first chunk: `bot.findBlock` throws, the pathfinder dead-ends on an unknown node, and the process dies with an unhandled rejection. MineBots treats "unknown" as a normal state instead of an error.

## Why it doesn't crash

- **Unknown-tolerant lookups.** Every external call (file, network, timer, Mineflayer API, JSON parse) sits inside `try/catch`. Failures degrade and log; nothing reaches the top level.
- **Off-road scanning fallback.** If `bot.findBlock` fails or returns nothing, the bot sweeps blocks itself and skips whatever the server refuses to describe.
- **Mod detector.** Unknown block names are sampled, deduplicated per bot, and looked up once (knowledge base, then mod context, then online sources). A name that cannot be resolved lands in a `failed` set and is never retried, so a weird server cannot turn into a network storm.
- **Modded-server protocol passthrough.** The client announces a Forge-style brand (`fml,forge,neoforge`) on connect, and if a `minecraft-protocol-forge` style layer is installed it is attached to the connection automatically. Login errors caused by a missing mod registry (`unknown block`, `missing registry`, `mod rejection`, ...) are classified instead of crashing the process: the exact reason is logged and the bot retries up to 3 times before giving up.
- **Mod blocks are not walls.** Before `Movements` are applied, every non-`minecraft:` block in the registry is normalised — diggable, hardness capped — and digging is enabled whenever mod blocks exist. Modded trees (`create:*_log`), machines and pipes stop being impassable barriers the pathfinder can never route around.
- **Anti-stuck recovery.** Every `moveTo` runs a 3-second watchdog. If the coordinates stop changing while the goal is still far away, the bot jumps, then digs the block in front of it or under its feet; after three failed rescues it drops that goal and tells the AI why. A stalled walk can no longer loop silently until the task times out.
- **Unknown entities and items never throw.** A mob name the registry cannot explain is classified as `unknown_entity`; if an unknown entity hits the bot, `bot_under_attack` is still raised and the log says "attacked by unknown mod entity". Items the registry cannot resolve are rendered as `未知模组物品 / unknown mod item` instead of raising.
- **Safe pathing.** Pathfinding is optional. When the pathfinder is missing or gives up, the bot falls back to short look-and-pulse movement: slower, but never fatal.
- **Crash guard and auto reconnect.** Disconnects, kicks and unexpected errors are logged, then the reconnect loop takes over.

## What's inside

- Electron GUI with a Chinese / English switch and an iOS-style glass layout
- Full-screen settings page (the old sliding drawer is gone), grouped by AI / state / actions / engine / channels / models / roster
- Bilingual chat brain: full grammar first (`dig_tree, blocks=10, oak`), keyword matching second (`砍树然后跟随` / `chop then follow`)
- Action queue with preemption: a new order interrupts the running one, and `stop` halts everything without re-clearing control state
- Task narration: template based, step by step, throttled — no AI call, no chat spam
- Mod understanding layer: block scan, knowledge base, vector similarity, Modrinth / Wiki / GitHub fallback
- Mod survival layer: modded-server protocol passthrough (brand + optional Forge support + registry-error retry), pathfinder mod-block "open eyes", anti-stuck watchdog inside `moveTo`, and unknown entity / item fallback
- **Local runtime tabs**: one tab = one framework (Ollama / LM Studio / llama.cpp / SGLang / custom) plus its model, port, exe path and sampling parameters (`temperature` / `top_p` / `max_tokens`). Tabs are independent and **several can run at the same time**, each on its own port
- **Per-bot model binding**: every bot picks its own tab (framework + model + parameters) or a cloud profile; two bots can run on two different frameworks at once
- **Skins and a bot roster**: import a 64x64 PNG skin per bot, then save the whole bot profile (config + skin) to a backend folder under `%APPDATA%/MineBots/roster`; it survives a local wipe and only a permanent delete removes it
- **Self-healing QA harness**: `scripts/auto-game-demo.js` runs nine end-to-end checks, and on failure asks a model for a JSON patch, validates it (protected files, unique match, syntax, 600-line limit) and retries — rolling back anything that does not pass
- 15 optional Mineflayer plugins (pathfinder, baritone, anti-afk, pvp, auto-armor, trajectories, viaproxy, and more) loaded through a resolver that understands 9 different `module.exports` styles. Load order matters: `mineflayer-pathfinder` goes first so baritone can build on it, `antiafk` waits for the `spawn` event, and pure API libraries are skipped silently instead of showing as failures
- Persistent logs in `logs/bot-YYYY-MM-DD.log`, with LAN / SERVER / SYSTEM log types
- Test mode: `modules/fake-bot.js` drives the whole stack with a simulated bot, no server required

## Requirements

- Node.js 18 or newer
- Windows, macOS or Linux
- Optional: [Ollama](https://ollama.com) / LM Studio / llama.cpp / SGLang for local AI. Nothing is installed for you — the app never probes or downloads a local runtime at startup, and the default provider is cloud
- Optional: a cloud API key (DeepSeek by default) if you want the AI brain on day one

## Install (one time only)

Step 1 / 第一步 — open a terminal **in the MineBots folder** and install the dependencies:

```bat
cd MineBots
npm install
```

> No Node.js yet? Install the LTS build from [nodejs.org](https://nodejs.org) first; nothing else is required.

Step 2 / 第二步 — double-click **`启动MineBots.bat`** in the project folder. That is the whole start-up. If you skipped Step 1, the launcher runs `npm install` for you on the first run.

The launcher first checks that Node.js and npm are on the PATH — if either is missing it prints a bilingual, human-readable message with the download link and keeps the window open instead of flashing a black box and vanishing. It installs dependencies on first run, then calls `npm run mb`, and the Electron window appears a few seconds later. Keep the console window open while the bot runs — it also stays open after the GUI closes (and after any launch error), so every message stays readable.

Optional plugins are declared as `optionalDependencies`, so `npm install` fetches them without ever blocking startup. Missing ones are reported in the plugin panel and skipped; pure API libraries are listed as loaded-library, not as errors.

## Run

Windows, easiest path: double-click **`启动MineBots.bat`** in the project folder.

The file contains nothing magic — simplified excerpt of the current launcher / 当前启动脚本的简化节选（完整版见 `启动MineBots.bat`，含更多错误分支 / the real file has more error branches）:

```bat
@echo off
chcp 65001 >nul
setlocal
title MineBots 控制台 / Console
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误 / ERROR] 这台电脑没有检测到 Node.js / Node.js was NOT found.
  echo   请先安装 Node.js 18 或更高版本 / Please install Node.js 18 or newer:
  echo   https://nodejs.org/   -- 选 LTS 版本 / choose the LTS build
  echo   装完之后重新双击本文件 / then double-click this file again.
  pause >nul
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误 / ERROR] 找到了 Node.js 但没找到 npm / npm is missing.
  pause >nul
  exit /b 1
)

if not exist "node_modules" (
  echo [提示 / INFO] 首次运行，正在安装依赖 / first run, installing dependencies ...
  call npm install
)

echo [提示 / INFO] 正在打开界面 / opening GUI ...
call npm run mb

echo 按任意键关闭窗口 / press any key to close.
pause >nul
endlocal
exit /b 0
```

Same thing from a terminal:

```bat
npm run mb
```

`mb`, `start` and `gui` are aliases for `electron gui/main.js`. In the GUI you add a bot, pick an account, then join LAN or a server.

## Local runtime tabs and per-bot models

Open **设置 / Settings → AI 配置** and switch **运行模式 / Mode** to **本地模型 / Local**. The top of the panel is a row of tabs; each tab is one independent runtime:

```
● Ollama · ollama · 11434 · phi    ○ LM Studio · lmstudio · 1234    ○ llama.cpp · 8080    ○ SGLang · 30000    ○ 自定义 / Custom
```

- **Fill a tab**: label, framework, port, launch model, executable path, launch args, and `temperature` / `top_p` / `max_tokens`. Every tab keeps its own values.
- **Probe / run**: 探测路径 (`Detect`) finds the executable — for SGLang it also checks that the Python interpreter really has `sglang` installed. 检测状态 (`Status`) lists the models; 启动 / 停止 (`Start` / `Stop`) only touches processes this app started.
- **Add more**: `＋ 新建标签` adds another tab of any framework (a second SGLang on 30001 is fine — ports are picked automatically), `删除此标签` removes one.
- **Run several at once**: tabs are separate processes on separate ports. Starting a tab whose port is already used by another tab is refused with a clear message instead of silently talking to the wrong server.
- **Import a model**: `导入模型` registers a model name for the selected tab (Ollama additionally supports pulling by name).

Then on the main page every bot has a **大脑 / Brain** row with two dropdowns: source (a local tab, or a cloud profile) and model. The choice is stored per bot in `state/model-bindings.json`, together with the tab's address, port and sampling parameters — so bot-1 can run `phi` on Ollama while bot-2 runs `Qwen3-8B` on SGLang. Binding wins over the global AI config; switching the dropdown back to a cloud profile removes the binding.

## Skins and the bot roster

Every bot card has a skin row: import a 64x64 (or 64x32 / 128x128 / 256x256) PNG and the card shows the head immediately. `保存到后台` writes the whole profile — connection, account mode, persona, brain binding and the skin file — to `%APPDATA%/MineBots/roster`, outside `state/`, so wiping the project folder does not lose it. **设置 → Bot 仓库** can restore one or all profiles; only 永久删除 removes them for good.

Note: a skin imported here is a local profile skin (card preview + storage). Making it appear **in game** on an offline server needs a server-side skin plugin, because vanilla only trusts Mojang-signed skin properties.

## Build a Windows installer

```bat
npm install
npm run pack      :: unpacked build in dist\win-unpacked (fast, good for testing)
npm run dist      :: NSIS installer + portable exe in dist\
```

- `build.electronDist` points at `node_modules/electron/dist`, so packaging works offline and never re-downloads Electron.
- The packaged app writes `state/` and `logs/` to `%APPDATA%/MineBots`, not next to the exe (install directories are usually read-only). Set `MINEBOTS_STATE_DIR` to override it — that is also what the self-test uses for isolation.
- No code-signing certificate is configured; Windows SmartScreen will warn on first run of an unsigned build.

## Chat commands

Type in game chat or in the GUI input. Chinese and English keywords are both accepted.

| Order | Example |
| --- | --- |
| Chop trees | `砍树` / `chop` / `dig tree` |
| Mine | `挖矿` / `mine` |
| Attack hostiles | `攻击` / `attack` |
| Follow a player | `跟随 Steve` / `follow Steve` |
| Stop now | `停` / `stop` |
| Collect drops | `捡` / `collect` |
| Place a block | `放` / `place` |
| Craft | `合成` / `craft` |
| Walk somewhere | `走过去` / `go` |

The grammar form adds parameters: `dig_tree, blocks=10, oak`, `mine, (iron)`, `follow, Steve`.

## Project layout

```
index.js                 headless entry (crash guard + bot manager); the GUI entry is gui/main.js
启动MineBots.bat         Windows launcher: double-click to start the app
guard.js                 boundary checker (line limit, banned syntax, protected files)
modules/                 bot logic: intent, chat, commands, queue, narration, mod detector,
                         protocol-forge, mod-guard, anti-stuck, plugin loader, AI client,
                         pathfinding, state, logging, local-runtime (framework tabs),
                         local-probe (detect / HTTP), model-profile (per-bot binding),
                         bot-roster + skin-manager (skins and backend profiles)
gui/main.js              Electron main process and IPC handlers
gui/app-paths.js         packaged-mode paths: state / logs go to %APPDATA%/MineBots
gui/ipc-*.js             extra IPC groups: telemetry, channels, models, roster, local runtimes, account / safety
gui/preload.js           context bridge (channel names and window.botAPI)
gui/renderer/            UI only: panels, events, state, view (no require allowed here)
scripts/                 installers, the self-test suite, the QA harness and gui-shot.js (screenshots)
logs/                    runtime logs and self-test reports
state/                   runtime data: AI config (git-ignored), model bindings, local runtimes, player profiles
dist/                    packaged output (git-ignored)
LICENSE                  MIT license text
.gitignore               keeps node_modules, state, logs, dist and .guard out of git
```

## Self-test and guardrails

```bat
node scripts/selftest.js
node guard.js check
```

- `scripts/selftest.js` runs static checks (header comments, banned syntax, Chinese identifiers, 600-line limit, exports) plus functional suites for the parser, intent, chat, executor, combat, queue, narration, gaze heartbeat, mod detector, plugin loader, model profiles, local runtimes, roster / skins and the QA harness. The current suite runs **2206 assertions, all green**. It writes `logs/p0-selftest-YYYYMMDD-HHMMSS.txt` and exits non-zero on any failure.
- `node guard.js check` verifies the project rules on every `.js` file: CommonJS only (no `?.` / `??` / `import` / `export`), no Chinese identifiers, header comment present, every file under 600 lines, and protected files (`package.json`, `settings.js`, `index.js`, `guard.js`, `README.md`, `structure.md`, `LICENSE`) untouched.
- `node guard.js init` rebuilds the baseline snapshot. `node guard.js restore` rolls back to it.

## Design rules

- CommonJS everywhere: `require` / `module.exports`, ES5 style `var` + `function`.
- Every file starts with a header block, every function has a one-line comment above it.
- Every external call is guarded; timers are `unref()`-ed so nothing hangs the process.
- Logs are bilingual (`中文 / English`). High-frequency heartbeats go to file only, never to the GUI.
- Every exported function returns an object with `ok`; failures carry a bilingual `message`.

## FAQ

**The AI panel says it cannot connect. How do I configure the API key? / AI 面板连不上，怎么配 API Key？**

1. Open the side panel and switch to **AI** (`AI 配置`).
2. Fill in three fields:
   - **API Base URL / API 地址** — an OpenAI-compatible base URL: `https://api.deepseek.com/v1`, `https://api.openai.com/v1`, or a local Ollama at `http://127.0.0.1:11434/v1`.
   - **API Key** — your provider key. Leave it empty for Ollama / LM Studio.
   - **Model / 模型** — for example `deepseek-chat`, `gpt-4o-mini` or `phi`.
3. Press **Test connection / 测试连接**. The panel shows either OK plus the model's first words, or "failed / no response"; the real cause (`401` wrong key, `404` wrong path, DNS error, timeout) is written by the AI client into the log panel above. A base URL that works with OpenAI-compatible providers usually ends with `/v1`.
4. The panel saves on blur to `state/ai-config.json`. That file is git-ignored: never commit it and never paste a key into an issue.

No key at all? Run it fully local: install [Ollama](https://ollama.com), run `ollama pull phi`, set the base URL to `http://127.0.0.1:11434/v1` and leave the key empty. Local control (movement, chop / mine / follow / stop) and the mod detector never depend on the AI, so the bot stays usable even with a broken or missing AI config; only free-form chat replies to other players need it.

**A plugin shows up as failed.** That is expected when an `optionalDependencies` package was skipped during install; run `npm install` again to fetch it. The bot keeps running either way, and pure API libraries are reported as loaded, not failed.

**`npm run gui` prints the banner and exits immediately, no window. / 终端里只打印启动横幅，窗口没出现就退出了。**

Check the environment: if `ELECTRON_RUN_AS_NODE` is set (some IDE terminals set it to `1`), Electron runs as plain Node.js and your `main.js` never becomes an app. Clear it for the launch:

```bat
set ELECTRON_RUN_AS_NODE=
npm run gui
```

PowerShell: `$env:ELECTRON_RUN_AS_NODE=$null; npm run gui`. The same applies to the packaged `MineBots.exe` when you start it from such a terminal — double-clicking it is unaffected.

**A local tab says "未运行 / not running" right after Start. / 本地标签点了启动还是未运行。**

Read the status line: it either names the missing executable ("先探测或手填"), the missing model (llama.cpp / SGLang need a model or model path), "端口已被标签 xxx 占用" (two tabs on one port), or "启动后立刻退出（code N）". For SGLang that last one usually means the selected Python has no `sglang` installed — `pip install "sglang[all]"`, then 探测路径 again. Local runtimes are optional: the bot works with a cloud profile while you fix the local one.

## License

License: MIT — see [LICENSE](LICENSE). Copyright (c) 2026 MineBots.
