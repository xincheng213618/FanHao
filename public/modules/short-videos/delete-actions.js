import { requestShortVideoDelete } from "./delete-contract.js?v=20260813-delete-recovery-01";
import { shortVideoDeleteApiPath } from "./router.js?v=20260813-delete-recovery-01";

export function createShortVideoDeleteActions(options = {}) {
  const { api, recovery, showToast } = options;
  const confirmDelete = options.confirmDelete || ((message) => globalThis.window?.confirm?.(message));
  if (typeof api !== "function" || !recovery) throw new TypeError("delete action dependencies are required");
  let requestInFlight = false;

  function deleteOperationActive() {
    return requestInFlight || recovery.hasPending();
  }

  async function runDelete(prompt, request) {
    if (deleteOperationActive()) {
      showToast?.("请先等待上一项删除恢复完成");
      return null;
    }
    if (!confirmDelete(prompt)) return null;
    if (deleteOperationActive()) {
      showToast?.("请先等待上一项删除恢复完成");
      return null;
    }
    requestInFlight = true;
    try {
      const result = await request();
      recovery.track(result);
      return result;
    } finally {
      requestInFlight = false;
    }
  }

  async function deleteVideo(video, requestOptions = {}) {
    if (!video?.id) return null;
    const scope = requestOptions.scope === "group" ? "group" : "single";
    const title = String(video.title || "当前短视频").trim() || "当前短视频";
    const prompt = scope === "group"
      ? `确定删除同组短视频吗？\n\n${title}\n\n会删除同一个本地文件夹下的短视频记录，以及这些记录引用且未被组外引用的本地文件。`
      : `确定删除这条短视频吗？\n\n${title}\n\n会删除资料库记录以及这条记录引用的本地视频文件。`;
    return runDelete(prompt, () => requestShortVideoDelete(
      api,
      `${shortVideoDeleteApiPath(video.id)}${scope === "group" ? "?scope=group" : ""}`,
      { method: "DELETE" },
      { expectedIds: [video.id] }
    ));
  }

  async function deleteSelected(ids = []) {
    const selected = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!selected.length) return null;
    const prompt = `确定删除选中的 ${selected.length} 条短视频吗？\n\n会删除资料库记录以及这些记录引用且未被其他记录引用的本地文件。`;
    return runDelete(prompt, () => requestShortVideoDelete(api, "/api/short-videos", {
      method: "DELETE",
      body: { ids: selected }
    }, { expectedIds: selected }));
  }

  return { deleteSelected, deleteVideo };
}
