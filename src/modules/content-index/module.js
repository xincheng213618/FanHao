import { createContentIndexRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "content-index",
  title: "内容索引",
  description: "套图和影视共用的只读内容索引。",
  order: 15,
  visible: false,
  capabilities: ["image-library-index"]
};

export function createModule({ moduleDeps }) {
  return createContentIndexRuntime(moduleDeps.contentIndex);
}
