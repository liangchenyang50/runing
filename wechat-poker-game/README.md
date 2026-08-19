# 微信四人扑克小程序

这是一个可导入微信开发者工具的 **微信小程序** 四人扑克原型，同时带一个可创建房间、邀请好友的横屏网页牌桌：

- 一副标准扑克牌，52 张。
- 四个玩家：你、左家、对家、右家。
- 每人 13 张牌。
- 开始前可以设置目标分，默认选项为 100、200、500 分。
- 每一局重新洗牌。
- 牌从小到大为：3、4、5、6、7、8、9、10、J、Q、K、A、2。
- 可出牌型：单张、对子、三张、四张、四张顺子。
- 四张顺子范围：A234 到 JQKA。
- 出牌顺序固定为：你、右家、对家、左家，随后回到你并循环。
- 下家如果有同牌型且更大的牌能接，必须打出来，不能过牌。
- 谁先出完谁赢，赢家下一轮第一个出牌。
- 输家按剩牌张数计分：1-7 张为张数 x1，8-9 张为张数 x2，10-12 张为张数 x3，13 张为 52 分。
- 有人累计分数达到目标分后，整场游戏结束。
- 最终结算：每个分数高的人，向每个分数低的人给出两者分数差值；界面显示每人的净结算。
- 特殊规则：一人拿到四张 2，其余每人加 52 分。
- 特殊规则：一人拿到全部小于等于 10 的牌，其余每人加 52 分。
- 特殊规则：一人拿到全部大于 10 的牌，其余每人加 52 分。
- 网页牌桌提供提示、出牌、过牌、重开和表情互动；三名对手分别布局在左、上、右，自己的手牌横向铺在屏幕底部。
- 网页联机模式支持创建六位房间号、输入房间号加入、四人到齐后开始，并通过实时状态流同步出牌和表情。
- 玩家可自行设置昵称、选择表情头像或上传小于 220 KB 的图片头像；对手的完整手牌不会发送到浏览器。

## 如何运行

### 本机调试网页

在项目目录运行：

```bash
node preview/local-debug.mjs
```

服务启动后打开输出的本地地址，例如：

```text
http://127.0.0.1:5178/
```

这个启动器固定只监听 `127.0.0.1`，同一 Wi-Fi 下的其他设备无法访问。它与公网版共用 `preview/public/` 中的网页界面，适合在本机边试玩边修改细节；如 5178 已被占用，会自动尝试后续端口。

需要直接检查完整牌桌时，在本机地址后加 `?debug=solo`，例如 `http://127.0.0.1:5178/?debug=solo`。这个快捷入口只在本机调试服务中生效，公网网页不会启用。

打开网页后：

1. 点击“创建房间”，会得到一个六位房间号。
2. 将房间号发给另外三名玩家；他们打开同一个网址，输入房间号加入。
3. 四人到齐后由房主点击“开始对局”。

这个预览页面复用 `js/poker_core.js` 规则逻辑，适合边看界面边改规则或样式。网页界面文件在 `preview/public/`，本机调试入口在 `preview/local-debug.mjs`，服务实现位于 `preview/server.mjs`。

### 部署为公网网页

GitHub 仓库保存的是源码；联网房间需要一个持续运行的 Node.js 服务，因此不能只用 GitHub Pages。可将 `wechat-poker-game` 目录部署到任意支持 Node.js 或 Docker 的主机，并设置：

```text
启动命令：node preview/server.mjs
HOST：0.0.0.0
PORT：由托管平台提供，或使用 3000
```

也可在该目录运行：

```bash
docker build -t four-player-poker .
docker run --rm -p 3000:3000 four-player-poker
```

部署时请保持单个服务实例。当前房间状态存放在服务内存中，服务重启或扩容到多个独立实例会清空或分隔正在进行的房间；适合好友房试玩。若要长期正式运营，应将房间状态迁移到带持久状态的实时服务。

### 发布到 Cloudflare Workers

项目已包含独立的 Cloudflare Workers 版本。它会把网页静态资源部署到 Workers，并为每个六位房间号创建一个 Durable Object；房间状态会持久化，玩家通过 WebSocket 实时收到出牌、昵称和表情更新。

在项目目录执行：

```bash
cd cloudflare
npm install
npm run check
npm test
npm run deploy
```

首次发布前如未登录 Cloudflare，先运行：

```bash
npx wrangler login
```

发布完成后，终端会输出一个 `https://...workers.dev` 公网网址。把该网址发给朋友，他们即可创建或输入房间号加入。要使用自己的域名，可在 Cloudflare 控制台的 `Workers & Pages` -> 对应 Worker -> `Settings` -> `Domains & Routes` 中添加自定义域名。

Cloudflare 版本的房间会在连续 24 小时没有互动且没有连接时自动清理；它面向四人联机开房，因此首页不显示本地单人试玩入口。本地 Node 预览仍保留单人试玩和 SSE 同步。Cloudflare 部署配置在 `cloudflare/wrangler.jsonc`，本地模拟命令为：

```bash
cd cloudflare
npm run dev -- --port 8787
```

### 微信开发者工具

1. 安装微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择本文件夹：`wechat-poker-game`。
4. AppID 可先使用测试号，或在 `project.config.json` 中替换为你的小程序 AppID。
5. 导入后点击“编译”，即可在模拟器里试玩。

## 文件说明

- `app.json` / `pages/index/*`：微信小程序入口和页面。
- `game.js`：微信小游戏入口，负责 Canvas 绘制、四人牌桌、按钮和触摸交互。
- `game.json`：小游戏基础配置。
- `js/poker_core.js`：一副牌、四人发牌、轮流出牌等核心流程。
- `js/rules/custom_rules.js`：你后续指定正式规则后，主要改这里。
- `preview/server.mjs`：本地侧栏网页预览服务。
- `preview/room_service.mjs`：联网房间、身份校验和实时状态流服务。
- `cloudflare/src/index.mjs`：Cloudflare Worker 与每个联网房间的 Durable Object。
- `cloudflare/wrangler.jsonc`：Cloudflare 静态资源、WebSocket 和 Durable Object 部署配置。
- `tests/poker_core.test.js`：核心流程和计分测试。
- `tests/special_rules.test.js`：特殊规则和必须接牌测试。
- `tests/room_server.test.mjs`：创建/加入房间、手牌隔离和实时状态流测试。
- `tests/game_smoke.test.js`：微信 Canvas 入口烟测。

## 规则文件

当前正式规则写在 `js/rules/custom_rules.js`。如果后面还要改牌型、接牌方式、计分方式，优先改这个文件。

## 后续可扩展

- 增加启动页、结算弹窗、音效和动画。
- 接入微信分享、好友排行榜、开放数据域。
- 接入云开发保存最高胜率或连续胜场。
- 增加联网房间、好友邀请和断线重连。

注意：当前项目是娱乐玩法原型，不包含现金、筹码提现或博彩逻辑。正式上线前需要按微信平台的小游戏类目、隐私、广告和内容规则完成配置与审核。
