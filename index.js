// index.js
const crashGuard = require("./modules/crash-guard");
crashGuard.install();
const botManager = require("./modules/bot-manager");
const logger = require("./modules/logger");
function main() { logger.system("index.js started. Use npm run gui for Electron GUI."); }
if (require.main === module) main();
module.exports = { startBot: botManager.startBot, stopBot: botManager.stopBot };
