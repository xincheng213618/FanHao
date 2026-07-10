import { createFanhaoRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "fanhao",
  title: "番号",
  description: "人物、作品、排行榜、厂商、VR、收藏和播放记录。",
  order: 10,
  client: {
    web: { href: "/fanhao", view: "people" },
    android: { view: "works", bottomKey: "fanhao" }
  },
  capabilities: ["people", "works", "rankings", "studios", "vr", "favorites", "history"]
};

export function createModule({ moduleDeps }) {
  return createFanhaoRuntime(moduleDeps.fanhao);
}
