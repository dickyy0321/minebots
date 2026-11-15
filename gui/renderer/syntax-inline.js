// ========================================
// 文件：gui/renderer/syntax-inline.js
// 功能：语法规范内联数据（历史备用稿）；组装中英两套 HTML 片段并跟随主窗口语言
// 依赖：window.syntaxAPI（可选，缺失时直接渲染中文）
// 导出：无（只在被页面直接引入时自执行）
// 作者：MineBots
// ========================================

var ZH = [
"<h1>语法规范（只读）</h1>",
"<h2>1. 通用指令</h2>",
"<pre>action, range, time, back x y z</pre>",
"<p>范围、时间、back 都可省略。</p>",
"<h2>2. dig_tree 砍树</h2>",
"<pre>dig_tree\ndig_tree, blocks=10\ndig_tree, blocks=10, oak\ndig_tree, blocks=10, wood=oak</pre>",
"<ul><li>不带 blocks = 默认背包填满</li><li>背包满了 = 合成箱子，打开，把木头放进去</li><li>有 back = 箱子放 back 坐标上；没 back = 不做箱子</li></ul>",
"<h2>3. mine 挖矿</h2>",
"<pre>mine\nmine, blocks=10\nmine, blocks=10, (iron)\nmine, blocks=10, (iron), (gold)</pre>",
"<ul><li>不带括号 = 看到矿石就挖</li><li>多个括号 = 都有挖，看到就挖</li><li>不带 blocks = 默认背包填满</li></ul>",
"<h2>4. follow 跟随</h2>",
"<pre>follow, Steve\nfollow, Steve, Alex</pre>",
"<p>多个玩家名：跟最近的那个。</p>",
"<h2>5. stop 停止</h2>",
"<pre>stop</pre>",
"<ul><li>不限时间，手动 stop：有 back 先 back 再停；无 back 直接停。</li><li>有时间，时间到了：有 back 先干完再 back；无 back 直接停。</li><li>有时间，时间没到，手动 stop：不 back，直接停。</li></ul>",
"<h2>6. 定时上下线</h2>",
"<pre>join 9:00 AM, out 5:00 PM</pre>",
"<ul><li>时间格式：9:00 AM，数字和 AM/PM 之间必须有空格。</li><li>起始时间必须早于结束时间，否则报错。</li></ul>",
"<h2>7. 开关指令（高级面板）</h2>",
"<pre>test mode on\ntest mode off\nhive mind on\nhive mind off\nai code on\nai code off</pre>",
"<p class=\"note\">识别不了会报错。</p>",
"<h2>8. 千万别点（彩蛋）</h2>",
"<ul><li>第 1 次：窗口抖动。</li><li>第 2 次：假崩溃覆盖层，2 秒后恢复。</li><li>第 3 次：假机器人叛变终端。全是假的。</li><li>第 4 次：假蓝屏 + 进度条。全是假的。</li></ul>",
"<p class=\"note\">第 3、4 次不会真的删除数据、不会真的攻击、不会真的开摄像头。</p>"
].join("\n");

var EN = [
"<h1>Syntax Reference (Read-only)</h1>",
"<h2>1. General Commands</h2>",
"<pre>action, range, time, back x y z</pre>",
"<p>Range, time, back are optional.</p>",
"<h2>2. dig_tree</h2>",
"<pre>dig_tree\ndig_tree, blocks=10\ndig_tree, blocks=10, oak\ndig_tree, blocks=10, wood=oak</pre>",
"<ul><li>No blocks = fill inventory by default</li><li>When full = craft chest, open, put wood in</li><li>With back = chest at back position; without back = no chest</li></ul>",
"<h2>3. mine</h2>",
"<pre>mine\nmine, blocks=10\nmine, blocks=10, (iron)\nmine, blocks=10, (iron), (gold)</pre>",
"<ul><li>No brackets = mine any ore seen</li><li>Multiple brackets = mine all, as seen</li><li>No blocks = fill inventory by default</li></ul>",
"<h2>4. follow</h2>",
"<pre>follow, Steve\nfollow, Steve, Alex</pre>",
"<p>Multiple players: follow the nearest one.</p>",
"<h2>5. stop</h2>",
"<pre>stop</pre>",
"<ul><li>No time, manual stop: back first if set, otherwise stop.</li><li>Has time, time expires: finish then back if set.</li><li>Has time, manual stop early: no back, stop.</li></ul>",
"<h2>6. Scheduled Join/Out</h2>",
"<pre>join 9:00 AM, out 5:00 PM</pre>",
"<ul><li>Format: 9:00 AM with a space before AM/PM.</li><li>Join must be earlier than out.</li></ul>",
"<h2>7. Switch Commands (Advanced)</h2>",
"<pre>test mode on\ntest mode off\nhive mind on\nhive mind off\nai code on\nai code off</pre>",
"<p class=\"note\">Unknown commands will error.</p>",
"<h2>8. Do NOT Click (Easter Egg)</h2>",
"<ul><li>1st: window shake.</li><li>2nd: fake crash overlay, recovers in 2 seconds.</li><li>3rd: fake bot mutiny terminal. All fake.</li><li>4th: fake BSOD + progress bar. All fake.</li></ul>",
"<p class=\"note\">The 3rd and 4th do not delete data, attack, or access camera.</p>"
].join("\n");

// 切换语言：把对应语言的 HTML 片段画进 #content；找不到容器就静默跳过。
function setLang(lang) {
  var target = null;
  try { target = document.getElementById("content"); } catch (e) { target = null; }
  if (!target) return;
  target.innerHTML = lang === "en" ? EN : ZH;
}
// 启动：优先订阅主窗口语言事件，拿不到就按中文渲染。
if (window.syntaxAPI && typeof window.syntaxAPI.onSetLang === "function") {
  window.syntaxAPI.onSetLang(setLang);
} else { setLang("zh"); }

