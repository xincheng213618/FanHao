export function createFavoriteFolderMergeDialog({ merge, canMerge, formatNumber, focusDestination }) {
  let active;

  function close({ restoreFocus = true } = {}) {
    if (!active) return;
    const { dialog, trigger } = active;
    active = null;
    dialog.close();
    dialog.remove();
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function open(source, destinations, trigger) {
    close({ restoreFocus: false });
    const dialog = document.createElement("dialog");
    dialog.className = "work-favorite-folder-picker favorite-folder-merge";
    dialog.setAttribute("aria-labelledby", "favoriteFolderMergeTitle");
    dialog.innerHTML = `
      <form>
        <header><h2 id="favoriteFolderMergeTitle">合并收藏夹</h2><button type="button" data-close>关闭</button></header>
        <p data-description></p>
        <label>目标收藏夹<select autofocus><option value="">选择目标收藏夹</option></select></label>
        <p role="status"></p>
        <footer><button type="submit" disabled>合并并删除源收藏夹</button></footer>
      </form>`;
    const form = dialog.querySelector("form");
    const select = dialog.querySelector("select");
    const submit = dialog.querySelector('[type="submit"]');
    const dismiss = dialog.querySelector("[data-close]");
    const status = dialog.querySelector("[role=status]");
    const request = active = { dialog, trigger, saving: false };
    dialog.querySelector("[data-description]").textContent =
      `「${source.name}」中的全部收藏将移入目标，随后删除源收藏夹。当前索引中有 ${formatNumber(source.count || 0)} 部作品。`;
    select.append(...destinations.map((folder) => new Option(`${folder.name} · ${formatNumber(folder.count || 0)} 部`, folder.id)));
    select.addEventListener("change", () => {
      submit.disabled = !select.value;
      status.textContent = "";
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (active !== request || request.saving || !select.value) return;
      const target = destinations.find((folder) => folder.id === select.value);
      if (!target || !canMerge(source.id, target.id)) {
        status.textContent = "收藏夹已变化，请关闭后重新选择。";
        return;
      }
      request.saving = true;
      select.disabled = submit.disabled = dismiss.disabled = true;
      status.textContent = "正在合并收藏夹…";
      try {
        await merge(source, target);
        if (active !== request) return;
        close({ restoreFocus: false });
        focusDestination(target.id);
      } catch (error) {
        if (active !== request) return;
        if (error?.code === "ACCOUNT_CHANGED") close({ restoreFocus: false });
        else status.textContent = error.message || "合并失败，请重试。";
      } finally {
        request.saving = false;
        if (active === request) select.disabled = submit.disabled = dismiss.disabled = false;
      }
    });
    dismiss.addEventListener("click", () => { if (!request.saving) close(); });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!request.saving) close();
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  return { open, close };
}
