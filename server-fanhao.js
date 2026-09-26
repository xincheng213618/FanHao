// Separate data/configuration by default; the aggregate entry remains server.js.
process.env.FANHAO_PRODUCT = "fanhao";
const { SERVER_CONFIG } = await import("./src/bootstrap/server-config.js");
const fs = await import("node:fs");
if (!fs.existsSync(SERVER_CONFIG.CORE_DB_PATH)) {
  throw new Error("番号独立服务需要已初始化的资料库。请通过 FANHAO_CORE_DB 指定资料库，并通过 FANHAO_CORE_IMAGE_DB 指定配套图片库；运行状态由 FANHAO_DATA_DIR 管理。");
}
export const { serverHost } = await import("./server.js");
