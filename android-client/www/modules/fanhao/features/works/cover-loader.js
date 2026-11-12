import { createViewportImageLoader } from "../shared/viewport-image-loader.js?v=assets-06c1d7f13464";

const WORK_COVER_ROOT_MARGIN = "720px 0px";

export function createWorkCoverLoader(options) {
  return createViewportImageLoader({
    ...options,
    rootMargin: WORK_COVER_ROOT_MARGIN
  });
}
