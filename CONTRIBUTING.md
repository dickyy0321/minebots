# 参与贡献 / Contributing

> **先说清楚：这份代码肯定还有 bug。**
> 它由一个人在无数个深夜里写出来，自检有 2,206 条断言，但断言覆盖不到的地方就是坑。你遇到的每一个问题，大概率是真的问题，不是你的错。

**English below.** ↓

---

## 遇到问题怎么办

1. 先跑一遍 `npm run selftest`，把输出里失败的那几条贴进 issue；
2. 附上你的环境：操作系统、Node 版本、Minecraft 版本、用的是本地模型还是云端、模型名；
3. 如果能复现，写清楚「我说了什么话 → 它做了什么 → 我期望它做什么」；
4. 有日志就贴 `logs/` 里对应的那一段，**记得先把 API Key 和服务器地址涂掉**。

## 想改代码

提 PR 之前请先跑这两条，都要绿：

```bash
npm run selftest
npm run guard check
```

代码风格是硬约束，不是建议：

- CommonJS（`require` / `module.exports`），不用 `import`、不用可选链 `?.`；
- 每个文件开头有文件头注释，每个函数上方有一行中文注释；
- 单文件不超过 600 行；
- 所有外部调用（文件、网络、定时器、Mineflayer API）必须 `try/catch`，失败只降级写日志；
- 渲染层 `gui/renderer/` 里禁止 `require`。

不确定怎么改也行，先开个 issue 聊。**半成品 PR 也欢迎**，我可以接着补。

## 我们不做什么

- 不做挂机刷资源、不做多账号养号、不做绕过服务器反作弊；
- 不保证在公开服务器上安全，用之前先看服务器规则。

---

## English

**This code has bugs. We know.** It was written by one person, late at night, with 2,206 self-test assertions as the only safety net. If something breaks, it is probably us, not you.

### Found a bug?

Open an issue with:

- the failing output of `npm run selftest`;
- your environment (OS, Node version, Minecraft version, local model or cloud model);
- what you said, what the bot did, what you expected;
- the relevant chunk of `logs/` — **redact your API keys and server addresses first**.

### Want to send a patch?

Run these two first, both must be green:

```bash
npm run selftest
npm run guard check
```

House rules (enforced by `guard.js`, not by vibes):

- CommonJS only — no `import`, no `?.`, no `??`;
- a header comment per file, one line of comment above each function;
- 600 lines per file, hard cap;
- every external call wrapped in `try/catch`, failures degrade and log;
- `gui/renderer/` must not `require` anything.

Work-in-progress PRs are welcome. If you are halfway there, open it anyway and say so — we will finish it together.

### What this project is not

No AFK farming, no multi-account grinding, no anti-cheat bypassing. Use it on your own server, and read the rules before you point it at someone else's.

---

## 关于「爱发电」/ Built with love

This is a hobby project. **No company, no funding, no roadmap handed down from above** — just a person who wanted to talk to Minecraft and have it answer.

If MineBots saved you an afternoon, the best thanks is a bug report with a reproducible case, or a PR that closes one. Star the repo if you just want to see where it goes.

> 用爱发电，但是真的在发电。
