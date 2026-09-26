import { createShortVideoAuthorCleanup } from "./author-cleanup.js?v=20260917-author-delete-01";

export function createShortVideoAuthorDeleteAction(options = {}) {
  const { api, recovery, showToast, onDeleted = () => undefined } = options;
  const deletion = createShortVideoAuthorCleanup({
    api,
    recovery,
    showToast,
    onCompleted: ({ mode }) => mode === "delete" && onDeleted()
  });

  function button(author = {}, fallbackSecUid = "") {
    const secUid = String(author.secUid || fallbackSecUid || "").trim();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "short-video-author-page-delete";
    trigger.textContent = "删除用户";
    trigger.title = "删除这个用户的全部作品、作者文件夹以及本地和 8765 数据库记录";
    trigger.disabled = !secUid;
    trigger.addEventListener("click", () => deletion.runDeleteAll({ ...author, secUid }, trigger));
    return trigger;
  }

  return Object.freeze({ button });
}
