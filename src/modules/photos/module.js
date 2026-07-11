import { createPhotosRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "photos",
  title: "图库",
  description: "套图、写真和韩漫阅读。",
  order: 20,
  client: {
    web: { href: "/photo", view: "gallery", galleryMode: "photo" },
    android: { channel: "photo", bottomKey: "photo", entry: "./modules/photos/android-module.js" }
  },
  capabilities: ["photo-sets", "manga"]
};

export function createModule({ moduleDeps }) {
  return createPhotosRuntime(moduleDeps.photos);
}
