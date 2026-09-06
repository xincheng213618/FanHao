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

## 展示口径与走势图

- 汇率主值统一为外币兑人民币：美元/人民币（USD/CNY）、日元/人民币（JPY/CNY）、韩元/人民币（KRW/CNY），即 1 单位外币可兑换多少人民币；副值保留反向换算。
- 反向报价的开盘、昨收均取倒数，最高价取原最低价的倒数，最低价取原最高价的倒数；涨跌额和涨跌幅按换算后的最新价与昨收重新计算。
- 每项行情提供独立的 `chartUrl`，卡片的「查看走势」在新窗口打开对应品种的 TradingView 页面；`sourceUrl` 仍用于标明实际行情来源。
- 黄金链接为 `https://cn.tradingview.com/symbols/XAUUSD/`。汇率链接保持 CNY（不替换成 CNH）；纳斯达克使用综合指数 IXIC，台湾加权使用 TWSE-IX0001。
- 外部走势图与本页可能使用不同的报价来源和更新时间，不应假定两者数值完全同步。

## 验证

```powershell
npm run verify:market-dashboard
npm run verify:modules
```

修改 quote service 时注意缓存失效、上游超时、空 payload 和 `502` 错误分支。
