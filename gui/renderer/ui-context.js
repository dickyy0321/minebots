// gui/renderer/ui-context.js
// 上下文列表渲染

window.uiContext = {
  render: function (data) {
    var box = document.getElementById("ctxList");
    if (!box) return;
    box.innerHTML = "";
    var perm = (data && data.permanent) || [];
    var temp = (data && data.temporary) || [];
    if (perm.length === 0 && temp.length === 0) {
      var empty = document.createElement("div");
      empty.className = "ctx-empty";
      empty.textContent = window.t("ctxEmpty");
      box.appendChild(empty);
      return;
    }
    window.uiContext.renderOne(box, perm, "permanent");
    window.uiContext.renderOne(box, temp, "temporary");
  },

  renderOne: function (box, list, mode) {
    for (var i = 0; i < list.length; i++) {
      (function (idx) {
        var item = document.createElement("div");
        item.className = "ctx-item";
        var txt = document.createElement("span");
        txt.className = "ctx-text";
        txt.textContent = list[idx].text;
        var modeSpan = document.createElement("span");
        modeSpan.className = "ctx-mode";
        modeSpan.textContent = mode === "permanent" ? "P" : "T";
        var del = document.createElement("button");
        del.className = "ctx-del";
        del.textContent = "x";
        del.addEventListener("click", function () {
          window.api.contextRemove({ index: idx, mode: mode });
        });
        item.appendChild(txt);
        item.appendChild(modeSpan);
        item.appendChild(del);
        box.appendChild(item);
      })(i);
    }
  },

  refresh: function () {
    window.api.contextLoad();
  }
};