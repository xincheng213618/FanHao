# 模块开发

## 最小目录

```text
src/modules/example/
├── module.js
└── server/
    ├── runtime.js
    ├── routes.js
    └── store.js

public/modules/example/                 # 有 Web 页面时
android-client/www/modules/example/    # 有 Android 页面时
```

模块目录名使用小写英文和连字符，并与模块 id 完全一致。`module.js` 是注册表唯一认识的入口，其他文件均为模块私有实现。

## 描述符

```js
import { createExampleRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "example",
  title: "示例",
  description: "这个模块提供什么。",
  order: 80,
  visible: true,
  client: {
    web: { href: "/example", view: "example" },
    android: { view: "example", bottomKey: "example" }
  },
  capabilities: ["example-library"]
};

export function createModule({ moduleDeps }) {
  return createExampleRuntime(moduleDeps.example);
}
```

- `id`：稳定技术标识，也是目录名。
- `title`：用户看到的导航标题。
- `order`：模块顺序；相同顺序再按 id 排序。
- `visible: false`：隐藏能力模块，不出现在客户端导航中。
- `client.web` / `client.android`：壳层创建导航和打开页面所需的声明。
- `capabilities`：给诊断、未来扩展和能力检查使用，不作为路由匹配。

只新增服务端能力时可以省略 `client`。完全静态的模块也可以不导出 `createModule`。

## 运行时

运行时按需实现以下方法：

```js
export function createExampleRuntime(deps) {
  return {
    async routeApi(req, res, url) {
      if (url.pathname !== "/api/example" || req.method !== "GET") return false;
      deps.sendJson(res, 200, { ok: true });
      return true;
    },
    async routeMedia(req, res, url) {
      return false;
    },
    async start() {},
    async stop() {},
    invalidate(reason) {}
  };
}
```

返回 `true` 表示请求已经发送响应；返回 `false` 让注册表继续询问下一个模块。不要匹配过宽的路径，不要在未响应时返回 `true`。

## 依赖与复用

- 通用 HTTP/文件/鉴权/媒体能力放在 `src/platform/server/`。
- 只被一个形态使用的 store、service、SQL 和缓存留在该模块。
- 套图与影视目前通过隐藏的 `content-index` 复用只读内容索引；类似共享能力应提供窄接口，不能让两个可见模块直接导入彼此内部文件。
- 新模块优先在自己的 `createModule` / runtime 中构造 store。确需壳层资源时，只从 `moduleDeps.<id>` 接收必要依赖。
- 模块拥有自己的缓存，并对外暴露 `invalidate()`；调用方不能直接修改其内部缓存变量。

## 客户端接入

服务端 `/api/modules` 是 Web 和 Android 导航的唯一模块清单。增加描述符后，导航会自动出现，但页面控制器仍需显式支持描述符里的 `view` 或 `channel`，因为浏览器不能安全地执行服务端任意路径下发的代码。Web 的顶部模块链接必须保留普通 `href`，并统一使用 `target="_blank"` 与 `rel="noopener"` 打开新标签页或窗口；不要在 `public/app.js` 中拦截成单页视图切换。

Web 代码放在 `public/modules/<id>/`，Android WebView 代码和模块样式放在 `android-client/www/modules/<id>/`。壳层负责导航、历史记录和通用缓存；业务数据、渲染和交互属于模块控制器。

## 完成检查

```powershell
node --check src/modules/example/module.js
npm run verify:modules
npm run verify
```

然后启动本地服务，至少检查：

- `/api/health` 正常；
- `/api/modules` 包含正确的 id、标题、顺序和双端声明；
- 模块代表 API 返回预期状态；
- Web 和 Android 壳层能显示并进入模块；
- 删除或禁用模块目录后，其他模块仍能启动。
