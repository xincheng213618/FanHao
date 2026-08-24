# `market-dashboard` 模块

## 定位

`market-dashboard` 是独立的行情模块，展示贵金属、汇率和全球主要指数。它不写入 FanHao 主库，数据由 quote service 获取并在进程内缓存。

入口：`src/modules/market-dashboard/module.js`、`src/modules/market-dashboard/server/runtime.js`。

## 代码结构

- `server/quote-service.js`：外部行情请求、规范化和缓存。
- `server/runtime.js`：健康检查、行情接口和缓存失效。
- `public/modules/market-dashboard/`：独立 HTML、脚本和样式。

## API

- `GET /api/market-dashboard/health`：模块自身可达性检查。
- `GET /api/market-dashboard/quotes`：返回行情 payload；外部上游失败时返回 `502`，不伪造成功数据。

前端页面通过服务端接口读取，不应在浏览器中直接耦合外部行情供应商。行情属于易变外部数据，展示时保留生成时间和错误状态。

## 验证

```powershell
npm run verify:market-dashboard
npm run verify:modules
```

修改 quote service 时注意缓存失效、上游超时、空 payload 和 `502` 错误分支。
