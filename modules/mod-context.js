// modules/mod-context.js
const axios = require("axios");
const logger = require("./logger");
const settings = require("../settings");

function timeout() { return { timeout: settings.mods.contextTimeoutMs }; }

async function tryModrinth(name) {
  try {
    const url = "https://api.modrinth.com/v2/search?query=" + encodeURIComponent(name) + "&limit=1";
    const res = await axios.get(url, timeout());
    if (res.data && res.data.hits && res.data.hits.length > 0) {
      const h = res.data.hits[0];
      return { purpose: h.title || name, interaction: "unknown", confidence: 0.5, source: "modrinth", description: h.description || "" };
    }
  } catch (e) {}
  return null;
}

async function tryWiki(name) {
  try {
    const url = "https://minecraft.wiki/api.php?action=query&list=search&srsearch=" + encodeURIComponent(name) + "&format=json";
    const res = await axios.get(url, timeout());
    if (res.data && res.data.query && res.data.query.search && res.data.query.search.length > 0) {
      const s = res.data.query.search[0];
      return { purpose: s.title || name, interaction: "unknown", confidence: 0.55, source: "wiki", description: s.snippet || "" };
    }
  } catch (e) {}
  return null;
}

async function tryGitHub(name) {
  try {
    const url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(name);
    const res = await axios.get(url, timeout());
    if (res.data && res.data.items && res.data.items.length > 0) {
      const r = res.data.items[0];
      return { purpose: r.name || name, interaction: "unknown", confidence: 0.5, source: "github", description: r.description || "" };
    }
  } catch (e) {}
  return null;
}

function fallback(name) {
  const lower = String(name).toLowerCase();
  let type = "unknown";
  if (lower.indexOf("chair") >= 0 || lower.indexOf("seat") >= 0) type = "seat";
  else if (lower.indexOf("machine") >= 0 || lower.indexOf("machine") >= 0) type = "machine";
  else if (lower.indexOf("door") >= 0) type = "door";
  return { purpose: name, interaction: type, confidence: 0.3, source: "fallback", description: "" };
}

async function getContext(name, bot) {
  let r = await tryModrinth(name);
  if (!r) r = await tryWiki(name);
  if (!r) r = await tryGitHub(name);
  if (!r) r = fallback(name);
  return r;
}

function warmup(bot, id) { logger.system("[" + id + "] mod-context warmup done."); }

module.exports = { getContext: getContext, warmup: warmup };