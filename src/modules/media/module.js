import { createMediaRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "media",
  title: "影视",
  description: "电影、电视剧和本地媒体播放。",
  order: 30,
  client: {
    web: { href: "/media", view: "gallery", galleryMode: "media" },
    android: { channel: "media", bottomKey: "media" }
  },
  capabilities: ["movies", "tv", "media-playback"]
};

export function createModule({ moduleDeps }) {
  return createMediaRuntime(moduleDeps.media);
}
