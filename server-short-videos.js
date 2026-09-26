process.env.FANHAO_PRODUCT = "short-videos";
const { startShortVideoServer } = await import("./src/apps/short-video-server.js");
export const serverHost = await startShortVideoServer();
