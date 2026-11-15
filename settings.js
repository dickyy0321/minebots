// settings.js
module.exports = {
  minecraft: { version: "auto", auth: "offline" },
  bot: {
    maxBots: 10, autoReconnect: true, reconnectDelay: 5000,
    testMode: false, testVersion: "1.21.1"
  },
  ai: {
    rpm: 20, cacheTTL: 300, timeoutFactor: 1.5,
    cloudUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    localUrl: "http://127.0.0.1:11434"
  },
  ollama: {
    host: "http://127.0.0.1:11434",
    embedModel: "bge-small-en-v1.5",
    generateApi: "/api/generate",
    chatApi: "/api/chat"
  },
  mods: {
    scanOnChunkLoad: true, scanOnBlockUpdateThreshold: 10,
    learnRatePerMinute: 10, similarityThreshold: 0.88,
    contextTimeoutMs: 3000,
    skipNamespaces: ["minecraft","sodium","optifine","iris","shader","sound","fps","performance"]
  },
  logs: { dir: "logs", flushIntervalMs: 2000, flushMaxLines: 20 },
  gui: { defaultLang: "zh", windowWidth: 1180, windowHeight: 760 },
  player: {
    autoJudge: true,
    levels: ["owner","close_friend","friend","normal","hostile","targeted"]
  }
};