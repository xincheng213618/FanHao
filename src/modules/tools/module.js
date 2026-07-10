import { createToolsRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "tools",
  title: "小工具",
  description: "文本处理和离线小游戏。",
  order: 70,
  client: {
    web: { href: "/tools", view: "tools" },
    android: { view: "tools", bottomKey: "tools" }
  },
  capabilities: ["txt-format", "offline-games"]
};

export function createModule({ moduleDeps }) {
  return createToolsRuntime(moduleDeps.tools);
}
