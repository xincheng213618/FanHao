import { createShortVideosRuntime } from "./server/runtime.js";
import { createShortVideoProduct } from "./server/product.js";

export const moduleDefinition = {
  id: "short-videos",
  title: "短视频",
  description: "短视频信息流、作者、收藏和本地播放。",
  order: 50,
  client: {
    web: { href: "/short-videos", view: "shortVideos" },
    android: { view: "shortVideos", bottomKey: "shortVideos", order: 40, entry: "./modules/short-videos/android-module.js" }
  },
  capabilities: ["short-video-feed", "short-video-authors"]
};

export function createModule({ moduleDeps }) {
  if (moduleDeps.shortVideos.config) return createShortVideoProduct(moduleDeps.shortVideos);
  return createShortVideosRuntime(moduleDeps.shortVideos);
}
