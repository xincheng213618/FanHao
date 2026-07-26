import { createFanhaoRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "fanhao",
  title: "番号",
  description: "人物、番号前缀、作品、排行榜、厂商、VR、收藏和播放记录。",
  order: 10,
  client: {
    web: { href: "/fanhao", view: "people" },
    android: { view: "works", bottomKey: "fanhao", entry: "./modules/fanhao/android-module.js" }
  },
  capabilities: ["people", "code-prefixes", "works", "rankings", "studios", "vr", "favorites", "history"]
};

export function createModule({ moduleDeps }) {
  return createFanhaoRuntime(moduleDeps.fanhao);
}
