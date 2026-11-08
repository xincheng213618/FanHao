import { createViewportImageLoader } from "../shared/viewport-image-loader.js?v=assets-8faf7a80cb7b";

const WORK_COVER_ROOT_MARGIN = "720px 0px";

export function createWorkCoverLoader(options) {
  return createViewportImageLoader({
    ...options,
    rootMargin: WORK_COVER_ROOT_MARGIN
  });
}
