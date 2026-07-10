import { absoluteUrl } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatDate, formatDuration } from "../shared.js";
export function createShortVideoNativePlatform(context = {}) {
  const { getActiveUrl } = context;
  async function openNativeShortVideo(video) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.play || !video?.streamUrl) return false;
    try {
      await plugin.play({
        url: absoluteUrl(getActiveUrl(), video.streamUrl),
        title: video.title || video.fileName || "短视频",
        subtitle: [video.author?.name ? `@${video.author.name}` : "", formatDate(video.publishedAt), formatDuration(video.durationMs)].filter(Boolean).join(" · "),
        mode: "short-video",
        videoId: video.id,
        position: 0,
        duration: Math.max(0, Number(video.durationMs || 0) / 1000)
      });
      return true;
    } catch {
      return false;
    }
  }

  function nativePlayerPlugin() {
    return window.Capacitor?.Plugins?.FanHaoPlayer || null;
  }

  function systemPlugin() {
    return window.Capacitor?.Plugins?.FanHaoSystem || null;
  }

  function setImmersiveMode(immersive) {
    const plugin = systemPlugin();
    if (!plugin?.setImmersive) return;
    plugin.setImmersive({ immersive: Boolean(immersive) }).catch(() => {});
  }

  return {
    openNativeShortVideo,
    nativePlayerPlugin,
    systemPlugin,
    setImmersiveMode
  };
}
