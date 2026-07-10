import { createShortVideosRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "short-videos",
  title: "短视频",
  description: "短视频信息流、作者、收藏和本地播放。",
  order: 50,
  client: {
    web: { href: "/short-videos", view: "shortVideos" },
    android: { view: "shortVideos", bottomKey: "shortVideos" }
  },
  capabilities: ["short-video-feed", "short-video-authors"]
};

export function createModule({ moduleDeps }) {
  return createShortVideosRuntime(moduleDeps.shortVideos);
}
