// gui/renderer/syntax.js
// 语法规范窗口内容 / syntax reference window content
// 数据源 / data: window.SYNTAX_ZH、window.SYNTAX_EN 两个数组，每个元素是一段 HTML
// two arrays, one HTML string per item
// 注：gui/renderer/syntax.html + syntax-view.js 直接读本文件，是本项目唯一的语法数据源
// note: syntax.html + syntax-view.js read this file; it is the single source of truth
// 写法约束 / style rules: 单引号包字符串，HTML 属性用双引号，不用反斜杠转义引号
// single-quoted strings, double quotes inside HTML, no backslash-escaped quotes

window.SYNTAX_ZH = [
  '<h1>语法规范 · 只读</h1>',
  '<p class="note">本窗口只读：所有指令都在主窗口的输入框里输入。</p>',

  '<h2>1. 通用格式 · general</h2>',
  '<pre>action, range, time, back x y z</pre>',
  '<p>用逗号分段，每一段都可以省略。</p>',
  '<ul><li>range 省略 = 无限范围</li><li>time 省略 = 一直做下去</li><li>back 可选，写法 back 10 64 10（x y z 用空格隔开）</li></ul>',
  '<p>完整示例：dig_tree, range=5*5, time=10m, back 10 64 10</p>',

  '<h2>2. 砍树 · dig_tree</h2>',
  '<pre>dig_tree\ndig_tree, blocks=10\ndig_tree, blocks=10, oak\ndig_tree, blocks=10, wood=oak</pre>',
  '<ul><li>省略 blocks = 背包填满为止</li><li>背包满了 = 合成箱子、打开、把木头放进去</li><li>有 back = 箱子放在 back 坐标；没有 back = 不做箱子</li><li>木种写 oak 或 wood=oak 都行</li></ul>',

  '<h2>3. 挖矿 · mine</h2>',
  '<pre>mine\nmine, blocks=10\nmine, blocks=10, (iron)\nmine, blocks=10, (iron), (gold)</pre>',
  '<ul><li>不写括号 = 看到矿石就挖</li><li>写多个括号 = 都要挖，看到就挖</li><li>省略 blocks = 背包填满为止</li></ul>',

  '<h2>4. 跟随 · follow</h2>',
  '<pre>follow, Steve\nfollow, Steve, Alex</pre>',
  '<p>写多个玩家名时，跟最近的那一个。</p>',

  '<h2>5. 停止 · stop</h2>',
  '<pre>stop</pre>',
  '<ul><li>没写 time，手动停：有 back 先回 back 再停，没 back 直接停</li><li>写了 time，时间到：有 back 先干完再回 back，没 back 直接停</li><li>写了 time，时间没到就手动停：不回 back，直接停</li></ul>',

  '<h2>6. 定时上下线 · join / out</h2>',
  '<pre>join 9:00 AM, out 5:00 PM</pre>',
  '<ul><li>时间格式 9:00 AM，数字和 AM/PM 之间必须有空格</li><li>起始时间必须早于结束时间，否则报错</li></ul>',

  '<h2>7. 隐蔽指令 · whisper</h2>',
  '<pre>whisper bot1 内容\nwhisper bot2 内容\nwhisper bot1-2 内容\nwhisper all 内容</pre>',
  '<p class="note">只有本地 GUI 能触发；在游戏聊天里说 whisper 无效。</p>',

  '<h2>8. 参数设置 · set / get</h2>',
  '<pre>set ai.temperature=0.8\nset maxBots=100\nset bot1.typingSpeed=5\nget ai.model\nget all</pre>',
  '<ul><li>全局：set maxBots=100</li><li>AI：前缀 ai.</li><li>单个机器人：前缀 bot1. 或 bot2.</li><li>查看全部：get all</li></ul>',

  '<h2>9. 开关指令 · switches</h2>',
  '<pre>test mode on / off\nhive mind on / off\nai code on / off\nbot chat on / off\ntyping on / off\nvoice on / off</pre>',
  '<p>值只能是 on 或 off；识别不了会报错。</p>',

  '<h2>10. 目标 bot 写法 · targets</h2>',
  '<pre>bot1\nbot2\nbot1-2\nall</pre>',
  '<ul><li>bot1 / bot2 = 单个机器人</li><li>bot1-2 = 从 bot1 到 bot2 的范围</li><li>all = 全部</li><li>可以放在指令前面：bot1 dig_tree</li></ul>',

  '<h2>11. 范围写法 · range</h2>',
  '<pre>range=5*5\nrange=10</pre>',
  '<ul><li>用 * 不用 ×（输入 × 会自动当成 *）</li><li>range=5*5 = 横 5 格、纵 5 格</li><li>省略 range = 无限</li></ul>',

  '<h2>12. 千万别点（彩蛋）· do not click</h2>',
  '<ul><li>第 1 次：窗口抖动</li><li>第 2 次：假崩溃覆盖层，2 秒后自己恢复</li><li>第 3 次：假机器人叛变终端</li><li>第 4 次：假蓝屏加进度条</li></ul>',
  '<p class="note">第 3、4 次不会真的删数据、不会真的攻击、不会真的开摄像头，全是假的。</p>'
];

window.SYNTAX_EN = [
  '<h1>Syntax Reference · Read-only</h1>',
  '<p class="note">This window is read-only: type every command in the main window.</p>',

  '<h2>1. General format · 通用格式</h2>',
  '<pre>action, range, time, back x y z</pre>',
  '<p>Separate the fields with commas; every field is optional.</p>',
  '<ul><li>No range = infinite</li><li>No time = keep doing</li><li>back is optional: back 10 64 10 (x y z separated by spaces)</li></ul>',
  '<p>Full example: dig_tree, range=5*5, time=10m, back 10 64 10</p>',

  '<h2>2. Chop trees · dig_tree</h2>',
  '<pre>dig_tree\ndig_tree, blocks=10\ndig_tree, blocks=10, oak\ndig_tree, blocks=10, wood=oak</pre>',
  '<ul><li>No blocks = fill the inventory</li><li>Inventory full = craft a chest, open it, put the wood in</li><li>With back = the chest goes to the back position; without back = no chest</li><li>Wood type can be oak, or wood=oak</li></ul>',

  '<h2>3. Mining · mine</h2>',
  '<pre>mine\nmine, blocks=10\nmine, blocks=10, (iron)\nmine, blocks=10, (iron), (gold)</pre>',
  '<ul><li>No brackets = mine any ore seen</li><li>Several brackets = mine all of them, as seen</li><li>No blocks = fill the inventory</li></ul>',

  '<h2>4. Follow · follow</h2>',
  '<pre>follow, Steve\nfollow, Steve, Alex</pre>',
  '<p>With several names, follow the nearest one.</p>',

  '<h2>5. Stop · stop</h2>',
  '<pre>stop</pre>',
  '<ul><li>No time, manual stop: go back first if back is set, otherwise stop</li><li>Has time, time is up: finish the job then go back if set</li><li>Has time, manual stop early: no going back, stop right away</li></ul>',

  '<h2>6. Scheduled join and out · join / out</h2>',
  '<pre>join 9:00 AM, out 5:00 PM</pre>',
  '<ul><li>Time format is 9:00 AM, a space is required before AM/PM</li><li>Join time must be earlier than out time, otherwise it errors</li></ul>',

  '<h2>7. Covert command · whisper</h2>',
  '<pre>whisper bot1 text\nwhisper bot2 text\nwhisper bot1-2 text\nwhisper all text</pre>',
  '<p class="note">Local GUI only. Saying whisper in game chat does nothing.</p>',

  '<h2>8. Parameters · set / get</h2>',
  '<pre>set ai.temperature=0.8\nset maxBots=100\nset bot1.typingSpeed=5\nget ai.model\nget all</pre>',
  '<ul><li>Global: set maxBots=100</li><li>AI scope: ai. prefix</li><li>Single bot: bot1. or bot2. prefix</li><li>Use get all to print everything</li></ul>',

  '<h2>9. Switches · switches</h2>',
  '<pre>test mode on / off\nhive mind on / off\nai code on / off\nbot chat on / off\ntyping on / off\nvoice on / off</pre>',
  '<p>Values are on or off only; anything else errors.</p>',

  '<h2>10. Bot targets · targets</h2>',
  '<pre>bot1\nbot2\nbot1-2\nall</pre>',
  '<ul><li>bot1 / bot2 = a single bot</li><li>bot1-2 = the range from bot1 to bot2</li><li>all = every bot</li><li>Can lead a command: bot1 dig_tree</li></ul>',

  '<h2>11. Range · range</h2>',
  '<pre>range=5*5\nrange=10</pre>',
  '<ul><li>Use * not × (a typed × is treated as *)</li><li>range=5*5 = 5 blocks wide and 5 blocks deep</li><li>No range = infinite</li></ul>',

  '<h2>12. Do not click (easter egg) · 千万别点</h2>',
  '<ul><li>1st: the window shakes</li><li>2nd: fake crash overlay, recovers by itself after 2 seconds</li><li>3rd: fake bot mutiny terminal</li><li>4th: fake BSOD with a progress bar</li></ul>',
  '<p class="note">The 3rd and 4th never delete data, never attack, never open the camera. All fake.</p>'
];

