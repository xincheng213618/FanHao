import { createPhotosRuntime } from "./server/runtime.js";

export const moduleDefinition = {
  id: "photos",
  title: "套图",
  description: "套图、写真和漫画阅读。",
  order: 20,
  client: {
    web: { href: "/photo", view: "gallery", galleryMode: "photo" },
    android: { channel: "photo", bottomKey: "photo" }
  },
  capabilities: ["photo-sets", "manga"]
};

export function createModule({ moduleDeps }) {
  return createPhotosRuntime(moduleDeps.photos);
}
