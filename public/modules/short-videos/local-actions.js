const LOCAL_FILE_ACTIONS = new Set(["reveal", "open-author-folder"]);

export function createShortVideoLocalActions({ api, showToast, documentRef = globalThis.document } = {}) {
  if (typeof api !== "function") throw new TypeError("short-video local action api is required");
  const toast = typeof showToast === "function" ? showToast : () => {};

  return async function runShortVideoLocalAction(video = {}, action = "", trigger = null) {
    const videoId = String(video?.id || video?.awemeId || "").trim();
    if (!videoId) {
      toast("当前没有可用的本地作品");
      return false;
    }

    if (action === "download") {
      const link = documentRef?.createElement?.("a");
      if (!link) {
        toast("当前环境不支持文件下载");
        return false;
      }
      link.href = `/media/short-video/${encodeURIComponent(videoId)}?download=1`;
      link.download = String(video?.fileName || "").trim();
      link.hidden = true;
      documentRef.body?.append(link);
      link.click();
      link.remove();
      toast("已开始下载原文件");
      return true;
    }

    const normalizedAction = String(action || "").trim();
    if (!LOCAL_FILE_ACTIONS.has(normalizedAction)) {
      toast("不支持当前本地文件操作");
      return false;
    }

    if (trigger?.getAttribute?.("aria-busy") === "true") return false;
    const wasDisabled = Boolean(trigger?.disabled);
    if (trigger) {
      trigger.disabled = true;
      trigger.setAttribute("aria-busy", "true");
    }
    try {
      await api(`/api/short-videos/${encodeURIComponent(videoId)}/local-action`, {
        method: "POST",
        body: { action: normalizedAction }
      });
      toast(normalizedAction === "reveal" ? "已在资源管理器中定位原文件" : "已打开作者文件夹");
      return true;
    } catch (error) {
      toast(error?.message || (normalizedAction === "reveal" ? "定位原文件失败" : "作者文件夹打开失败"));
      return false;
    } finally {
      if (trigger?.isConnected) {
        trigger.disabled = wasDisabled;
        trigger.removeAttribute("aria-busy");
      }
    }
  };
}
