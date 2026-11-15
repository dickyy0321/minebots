// modules/crash-guard.js
const fs = require("fs");
const path = require("path");
const CRASH_DIR = path.resolve(process.cwd(), "logs");
function ensureDir() { if (!fs.existsSync(CRASH_DIR)) fs.mkdirSync(CRASH_DIR, { recursive: true }); }
function nowStamp() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0") + "-" + String(d.getHours()).padStart(2,"0") + String(d.getMinutes()).padStart(2,"0") + String(d.getSeconds()).padStart(2,"0");
}
function writeCrash(type, err) {
  try {
    ensureDir();
    const file = path.join(CRASH_DIR, "crash-" + nowStamp() + ".log");
    fs.writeFileSync(file, "[type] " + type + "\n[time] " + new Date().toISOString() + "\n[message] " + (err && err.message ? err.message : String(err)) + "\n[stack]\n" + (err && err.stack ? err.stack : "(no stack)"), "utf8");
    return file;
  } catch (e) { return null; }
}
function install() {
  process.on("uncaughtException", function (err) { writeCrash("uncaughtException", err); try { console.error("[CRASH] " + (err && err.message)); } catch (e) {} });
  process.on("unhandledRejection", function (reason) { const err = reason instanceof Error ? reason : new Error(String(reason)); writeCrash("unhandledRejection", err); try { console.error("[CRASH] " + err.message); } catch (e) {} });
  process.on("SIGINT", function () { try { process.exit(0); } catch (e) {} });
  process.on("SIGTERM", function () { try { process.exit(0); } catch (e) {} });
}
module.exports = { install: install, writeCrash: writeCrash };
