# Open-source Mini Games Audit

规则：

- 一次只集成一个游戏。
- 必须能离线运行在当前 WebView 里。
- 优先选择有明确开源许可证的项目；如用户确认仅本地自用，可集成无许可证但来源清楚的 source-available 项目。
- 优先选择成熟、维护历史清楚、移动端交互简单的项目。
- 审计不充分的项目不进 `public/games` 和 `android-client/www/games`。

## 已集成

### 2048 AI Engine

- 来源：https://github.com/game-difficulty/2048EndgameTablebase
- 许可证：GPL-3.0
- 状态：已集成
- 证据：使用仓库 `docs/` 下的静态 Web/WASM 版本，`LICENSE`、`README.md`、`SOURCE.txt` 已随包保留，本地浏览器已验证页面、棋盘和控制按钮加载。
- 改动：仅添加 `返回资料库` 链接并修改页面标题，不改 AI/game 核心逻辑。

### 华容道

- 来源：https://github.com/jeantimex/hua-rong-dao-html
- 许可证：上游未提供许可证文件；按用户确认，仅作为本地自用 source-available 游戏集成。
- 状态：已集成
- 证据：使用仓库 `app/` 下的 AngularJS 静态版本，补齐本地前端依赖，`README.md`、`SOURCE.txt` 已随包保留；本地浏览器验证关卡列表、第一关棋盘、点按移动和 AI worker 自动解。
- 改动：移除 Google Analytics 和未使用的 Bootstrap JS 引用；添加 `返回资料库` 链接；修复 AngularJS hash 前缀、`$http.then()` 兼容和手机宽度溢出。

## 下一批只做候选，不集成

### 0hh1

- 来源：https://github.com/florisluiten/0hh1
- 许可证：MIT
- 初筛：逻辑小游戏，体量看起来适合离线；下一步需要本地运行和手机触控测试。

### HexGL

- 来源：https://github.com/BKcore/HexGL
- 许可证：MIT
- 初筛：项目成熟，但依赖 WebGL，手机端性能和包体需要先测；暂不集成。

### Tower Game

- 来源：https://github.com/iamkun/tower_game
- 许可证：MIT
- 初筛：Canvas 小游戏，可能适合手机；下一步需要确认资源完整性和触控体验。

## 暂不集成

### Clumsy Bird

- 来源：https://github.com/ellisonleao/clumsy-bird
- 原因：GPL-3.0，暂不引入。

### BrowserQuest

- 来源：https://github.com/mozilla/browserquest
- 原因：多人游戏/服务端形态，不适合作为当前离线小游戏直接集成；许可证还涉及代码和素材分开授权。

### A Dark Room

- 来源：https://github.com/doublespeakgames/adarkroom
- 原因：很成熟，但偏长篇文字冒险，不算轻量小游戏；可单独作为后续内容类功能评估。
