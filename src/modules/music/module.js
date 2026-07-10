import { createMusicRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "music",
  title: "音乐",
  description: "本地音乐、播放队列和歌单。",
  order: 60,
  client: {
    web: { href: "/music", view: "music", target: "_blank" },
    android: { view: "music", bottomKey: "music" }
  },
  capabilities: ["music-library", "playlists"]
};

export function createModule({ moduleDeps }) {
  return createMusicRuntime(moduleDeps.music);
}
