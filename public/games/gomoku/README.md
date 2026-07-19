# 五子棋 AI

这是 FanHao 网页端的 15×15 无禁手五子棋人机对战页面，AI 内核使用开源 Rapfi。

## 功能

- 人类可选择执黑或执白。
- 休闲、进阶、挑战三档 AI 强度与思考时间。
- 悔棋、重新开始、五连/长连胜负判定。
- 展示 Rapfi 搜索深度、估值、节点、速度和推荐变化。
- Rapfi 在 Web Worker 中通过 WebAssembly 本地运行，不依赖后端推理服务。

## 平台范围

本游戏是 **web-only**。源文件位于 `public/games/gomoku`，但 Android 的共享资产同步脚本明确排除此目录，所以 NNUE 数据不会进入 APK。

## 开源合规

- Rapfi 引擎：GPL-3.0，见 `LICENSE-RAPFI.txt`。
- Rapfi Networks 权重：CC0-1.0，见 `LICENSE-NETWORKS.txt`。
- 上游版本、官方分发地址与 SHA-256：见 `SOURCE.txt`。
