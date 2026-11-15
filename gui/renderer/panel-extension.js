// ========================================
// 文件：gui/renderer/panel-extension.js
// 功能：扩展面板（集体管理 / 任务队列 / 日记 / 结构）——当前界面没有提供这些区块，只保留渲染函数
// 依赖：window.api（仅保留真实存在的通道）
// 导出：window.panelExtension（init / fillSwarmList / fillTaskList / fillDiaryList / fillStructureList）
// 说明：旧版本在这里绑定 swarmBroadcast / taskList / diaryList / structureList 四个按钮，
//       但 index.html 里根本没有这些区块，主进程也没有对应通道 —— 那就是「假按钮」。
//       现在：没有真接口就不画按钮、不发请求，等真做过这些功能再接线。
// 作者：MineBots
// ========================================

window.panelExtension = {
  // 功能 1：初始化——当前界面未提供扩展区块，直接返回 false（不绑定任何假事件）。
  init: function () {
    return false;
  },

  // 内部：把列表渲染进指定容器（元素不存在就安静返回 false）。
  renderList: function (boxId, list, className, textOf) {
    var box = null;
    try { box = document.getElementById(boxId); } catch (e) { return false; }
    if (!box) return false;
    try { box.innerHTML = ""; } catch (e2) { return false; }
    var items = Array.isArray(list) ? list : [];
    for (var i = 0; i < items.length; i++) {
      var item = document.createElement("div");
      item.className = className;
      item.textContent = textOf(items[i]);
      box.appendChild(item);
    }
    return true;
  },

  // 功能 2：渲染蜂群列表（id - 状态）。
  fillSwarmList: function (list) {
    return window.panelExtension.renderList("swarmList", list, "swarm-item", function (item) {
      return String((item && item.id) || "?") + " - " + String((item && item.status) || "?");
    });
  },

  // 功能 3：渲染任务队列列表（动作 - 状态）。
  fillTaskList: function (list) {
    return window.panelExtension.renderList("taskList", list, "task-item", function (item) {
      return String((item && item.action) || "?") + " - " + String((item && item.status) || "?");
    });
  },

  // 功能 4：渲染日记列表（日期 + 条数）。
  fillDiaryList: function (list) {
    return window.panelExtension.renderList("diaryList", list, "diary-item", function (item) {
      return String((item && item.date) || "?") + " (" + Number((item && item.count) || 0) + ")";
    });
  },

  // 功能 5：渲染结构列表（名字）。
  fillStructureList: function (list) {
    return window.panelExtension.renderList("structureList", list, "structure-item", function (item) {
      return String((item && item.name) || "?");
    });
  }
};