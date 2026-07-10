import { createSystemRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "system",
  title: "系统",
  description: "FanHao 壳层、状态、管理和本机能力。",
  order: 0,
  visible: false,
  capabilities: ["status", "admin", "android-update", "local-open"]
};

export function createModule({ moduleDeps }) {
  return createSystemRuntime(moduleDeps.system);
}
