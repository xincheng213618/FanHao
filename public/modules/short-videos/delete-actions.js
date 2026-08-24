import { requestShortVideoDelete } from "./delete-contract.js?v=20260813-delete-recovery-01";
import { shortVideoDeleteApiPath } from "./router.js?v=20260813-delete-recovery-01";

export function createShortVideoDeleteActions(options = {}) {
  const { api, recovery, showToast } = options;
  const confirmDelete = options.confirmDelete || showShortVideoDeleteConfirm;
  if (typeof api !== "function" || !recovery) throw new TypeError("delete action dependencies are required");
  let requestInFlight = false;
  let confirmationInFlight = false;

  function deleteOperationActive() {
    return confirmationInFlight || requestInFlight || recovery.hasPending();
  }

  async function runDelete(prompt, request) {
    if (deleteOperationActive()) {
      showToast?.("请先等待上一项删除恢复完成");
      return null;
    }
    confirmationInFlight = true;
    let confirmed = false;
    try {
      confirmed = Boolean(await confirmDelete(prompt));
    } finally {
      confirmationInFlight = false;
    }
    if (!confirmed) return null;
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

export function showShortVideoDeleteConfirm(message, options = {}) {
  const doc = options.document || globalThis.document;
  if (!doc?.body || typeof doc.createElement !== "function") {
    return Promise.resolve(Boolean(globalThis.window?.confirm?.(message)));
  }
  return new Promise((resolve) => {
    const returnFocus = doc.activeElement;
    const dialog = doc.createElement("dialog");
    dialog.className = "short-video-delete-confirm";
    dialog.setAttribute("aria-labelledby", "short-video-delete-confirm-title");

    const content = doc.createElement("div");
    content.className = "short-video-delete-confirm-content";
    const title = doc.createElement("h2");
    title.id = "short-video-delete-confirm-title";
    title.textContent = options.title || "确认删除";
    const description = doc.createElement("div");
    description.className = "short-video-delete-confirm-description";
    for (const paragraphText of String(message || "").split(/\n\s*\n/).filter(Boolean)) {
      const paragraph = doc.createElement("p");
      paragraph.textContent = paragraphText;
      description.append(paragraph);
    }

    const actions = doc.createElement("div");
    actions.className = "short-video-delete-confirm-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "short-video-delete-confirm-cancel";
    cancel.textContent = "取消";
    const commit = doc.createElement("button");
    commit.type = "button";
    commit.className = "short-video-delete-confirm-commit";
    commit.textContent = options.commitLabel || "确认删除";
    actions.append(cancel, commit);
    content.append(title, description, actions);
    dialog.append(content);

    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      if (!confirmed && returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
      resolve(confirmed);
    };
    cancel.addEventListener("click", () => finish(false));
    commit.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => finish(false));
    doc.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    cancel.focus?.({ preventScroll: true });
  });
}
