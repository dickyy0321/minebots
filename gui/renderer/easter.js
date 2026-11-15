// gui/renderer/easter.js
// 千万别点 · 4 阶段彩蛋

window.easter = {
  trigger: function () {
    if (window.state.eggBusy) return;
    var msg = document.getElementById("easterEggMsg");
    var app = document.querySelector(".app");
    window.state.eggCount++;

    // 第 1 次：抖动
    if (window.state.eggCount === 1) {
      if (msg) msg.textContent = window.t("egg1");
      if (app) {
        app.classList.add("egg-shake");
        setTimeout(function () { app.classList.remove("egg-shake"); }, 700);
      }
      return;
    }

    // 第 2 次：假崩溃
    if (window.state.eggCount === 2) {
      window.easter.showFakeCrash(function () {
        if (msg) msg.textContent = window.t("egg3");
      });
      return;
    }

    // 第 3 次：假终端
    if (window.state.eggCount === 3) {
      window.easter.showFakeTerminal(window.t("eggTerminal"), function () {
        if (msg) msg.textContent = window.t("egg3");
      });
      return;
    }

    // 第 4 次及以后：假蓝屏
    window.easter.showFakeBSOD(function () {
      if (msg) msg.textContent = window.t("egg4");
    });
  },

  showFakeCrash: function (doneCb) {
    window.state.eggBusy = true;
    var box = document.getElementById("fakeCrash");
    var txt = document.getElementById("fakeCrashText");
    if (!box) { window.state.eggBusy = false; return; }
    box.classList.remove("hidden");
    if (txt) txt.textContent = window.t("egg2");
    setTimeout(function () {
      box.classList.add("hidden");
      window.state.eggBusy = false;
      if (doneCb) doneCb();
    }, 2200);
  },

  showFakeTerminal: function (content, doneCb) {
    window.state.eggBusy = true;
    var box = document.getElementById("fakeTerminal");
    var pre = document.getElementById("fakeTerminalContent");
    if (!box || !pre) { window.state.eggBusy = false; return; }
    box.classList.remove("hidden");
    pre.textContent = "";
    var lines = content.split("\n");
    var i = 0;
    var timer = setInterval(function () {
      if (i >= lines.length) {
        clearInterval(timer);
        setTimeout(function () {
          box.classList.add("hidden");
          window.state.eggBusy = false;
          if (doneCb) doneCb();
        }, 1500);
        return;
      }
      pre.textContent += lines[i] + "\n";
      i++;
    }, 700);
  },

  showFakeBSOD: function (doneCb) {
    window.state.eggBusy = true;
    var box = document.getElementById("fakeBSOD");
    var t1 = document.getElementById("bsodText1");
    var t2 = document.getElementById("bsodText2");
    var prog = document.getElementById("bsodProgress");
    if (!box || !prog) { window.state.eggBusy = false; return; }
    box.classList.remove("hidden");
    if (t1) t1.textContent = window.t("bsod1");
    if (t2) t2.textContent = window.t("bsod2");

    var p = 0;
    function render() {
      prog.textContent = p + "% " + (window.state.currentLang === "zh" ? "完成" : "complete");
    }
    render();
    var timer = setInterval(function () {
      p += Math.floor(Math.random() * 4) + 1;
      if (p >= 100) {
        p = 100;
        render();
        clearInterval(timer);
        setTimeout(function () {
          box.classList.add("hidden");
          window.state.eggBusy = false;
          if (doneCb) doneCb();
        }, 1000);
        return;
      }
      render();
    }, 180);
  }
};