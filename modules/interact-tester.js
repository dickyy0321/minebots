// modules/interact-tester.js
const logger = require("./logger");
const knowledgeBase = require("./knowledge-base");

async function tryRightClick(bot, block) {
  try {
    if (bot.activateBlock) { await bot.activateBlock(block); return true; }
  } catch (e) {}
  return false;
}
async function tryStandOn(bot, block) {
  try {
    if (bot.lookAt && bot.entity) {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
      return true;
    }
  } catch (e) {}
  return false;
}
async function tryWait(ms) { await new Promise(function (r) { setTimeout(r, ms); }); return true; }

async function test(bot, block, name) {
  if (!block) return null;
  logger.system("interact-test on " + name);
  if (await tryRightClick(bot, block)) { record(name, "right_click"); return "right_click"; }
  if (await tryStandOn(bot, block)) { record(name, "stand_on"); return "stand_on"; }
  await tryWait(2000);
  record(name, "wait");
  return "wait";
}

function record(name, interaction) {
  const k = knowledgeBase.find(name);
  if (k) { k.bestInteraction = interaction; k.updatedAt = new Date().toISOString(); }
}

module.exports = { test: test };