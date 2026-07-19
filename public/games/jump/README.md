# 蓄力跳台

基于 [`shenmaxg/web-jump`](https://github.com/shenmaxg/web-jump) 的网页小游戏集成。

- 按住游戏画面蓄力，松开起跳。
- 成功落到下一个跳台后得 1 分。
- 最佳成绩保存在浏览器 `localStorage`。
- 游戏只在网页端提供，不会同步进 Android APK。

## 本地适配

- 使用 Pointer Events 统一鼠标与手机触控。
- 添加分数、最佳成绩、失败提示、重新开始和返回资料库入口。
- 限制高分屏渲染倍率，避免手机 GPU 负担过高。
- 移除上游未启用的调试、FPS 和后处理模块。
- 保留修改后的完整上游源码于 `source/`。

上游许可证见 `LICENSE.txt`，固定版本和构建信息见 `SOURCE.txt`。
