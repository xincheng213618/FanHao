# `system` 模块

## 定位

`system` 是隐藏的基础模块，不出现在业务导航中，负责服务状态、后台管理、本机文件操作、远程图片缓存和 Android 更新。入口是 `src/modules/system/module.js`，runtime 由 `src/modules/system/server/runtime.js` 组合。

## 代码结构

| 层 | 入口 | 说明 |
| --- | --- | --- |
| 模块描述 | `src/modules/system/module.js` | `visible: false`，声明 `status`、`admin`、`android-update`、`local-open` 能力 |
| 状态 | `server/status/` | `/api/health` 和服务健康信息 |
| 管理 | `server/admin/` | 后台作业、脚本注册表、设置、访问统计和维护动作 |
| 本机打开 | `server/local-open/` | 在受信网络下打开文件或文件夹 |
| Android 更新 | `server/android-update/` | 更新元数据和 APK 下载 |
| 通用能力 | `app-config-service.js`、`auth.js`、`access-log.js` 等 | 配置、鉴权、日志由 server 组装后注入 |

## 路由与权限

- `GET /api/health`：健康检查。
- `GET /api/admin/*`、`POST /api/admin/*`：管理接口；写操作需要本机管理员或可信网络策略。
- `GET /api/android/update`、`GET /api/android/update/apk/...`：Android 更新检查与下载。
- `POST /api/open-file`、`POST /api/open-folder`：本机打开能力，必须经过可信请求校验。
- `GET /media/remote-image`：读取已缓存的远程图片，不承担任意 URL 代理。

管理页的前端控制器位于 `public/modules/system/`，后台作业的实际脚本主要位于 `tools/`，不要把长时间扫描直接写进请求处理器。

## 数据与配置

系统模块使用的持久化资源包括：

- `data/app-config.json`：运行期配置。
- `data/auth-secret.txt`：鉴权密钥；远程访问还需要配置 `FANHAO_WEB_PASSWORD`。
- `data/admin-tasks.json`：后台任务历史。
- `logs/access.log` 与 `data/access-analytics.sqlite`：访问日志和统计。
- `data/android-update/`：Android 更新产物。

服务端默认只绑定局域网地址并对本机 / 局域网放宽访问；部署到不可信网络前必须配置密码并限制端口暴露，详见 [配置说明](../configuration.md) 和 [API 参考](../api-reference.md#访问权限级别)。

## 修改与验证

修改管理接口时同时检查 `public/admin.js`、`public/modules/system/` 和权限验证脚本；至少运行：

```powershell
npm run verify:auth
npm run verify:mutation-auth
npm run verify:access-log
npm run verify:access-analytics
npm run verify:startup
```
