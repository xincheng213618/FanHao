import { createNovelsRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "novels",
  title: "小说",
  description: "本地小说书库、章节和阅读进度。",
  order: 40,
  client: {
    web: { href: "/novels", view: "novels" },
    android: { view: "novels", bottomKey: "novels", order: 50, entry: "./modules/novels/android-module.js" }
  },
  capabilities: ["novel-library", "novel-reader"]
};

export function createModule({ moduleDeps }) {
  return createNovelsRuntime(moduleDeps.novels);
}
