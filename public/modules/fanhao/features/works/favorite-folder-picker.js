export function createFavoriteFolderPicker({ readFolders, save, onSaved }) {
  let active = null;

  function close({ restoreFocus = true } = {}) {
    if (!active) return;
    const { dialog, trigger, controller } = active;
    active = null;
    controller.abort();
    dialog.close();
    dialog.remove();
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function open(work, trigger) {
    close({ restoreFocus: false });
    const dialog = document.createElement("dialog");
    dialog.className = "work-favorite-folder-picker";
    dialog.setAttribute("aria-labelledby", "workFavoriteFolderPickerTitle");
    dialog.innerHTML = `
      <form>
        <header><h2 id="workFavoriteFolderPickerTitle">选择收藏夹</h2><button type="button" data-close>关闭</button></header>
        <p class="work-favorite-folder-picker-work"></p>
        <label>收藏夹 <select disabled></select></label>
        <p role="status"></p>
        <footer><button type="button" data-retry hidden>重新读取收藏夹</button><button type="submit" disabled>保存</button></footer>
      </form>`;
    dialog.querySelector(".work-favorite-folder-picker-work").textContent = work.title;
    const form = dialog.querySelector("form"), select = dialog.querySelector("select");
    const submit = dialog.querySelector('[type="submit"]'), retry = dialog.querySelector("[data-retry]");
    const status = dialog.querySelector('[role="status"]');
    const request = active = { dialog, trigger, controller: new AbortController() };
    const current = () => active === request;
    let loading = false, saving = false;

    async function loadFolders() {
      if (!current() || loading || saving) return;
      const focusedRetry = document.activeElement === retry;
      loading = true;
      select.disabled = submit.disabled = retry.disabled = true;
      status.textContent = "正在读取收藏夹…";
      try {
        const result = await readFolders(request.controller.signal);
        if (!current()) return;
        if (!Array.isArray(result.folders) || !result.folders.length) throw new Error("没有收到可用的收藏夹");
        const previous = select.value || work.favoriteFolderId || "default";
        select.replaceChildren(...result.folders.map(folder => new Option(folder.name, folder.id)));
        if ([...select.options].some(option => option.value === previous)) select.value = previous;
        retry.hidden = true;
        status.textContent = "";
      } catch (error) {
        if (!current()) return;
        retry.hidden = false;
        status.textContent = error.message || "收藏夹读取失败";
      } finally {
        loading = false;
        if (current()) {
          retry.disabled = false;
          select.disabled = submit.disabled = !retry.hidden || !select.value;
          if (focusedRetry && (document.activeElement === document.body || document.activeElement === retry)) {
            (select.disabled ? retry : select).focus({ preventScroll: true });
          }
        }
      }
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!current() || loading || saving || submit.disabled || !select.value) return;
      saving = true;
      select.disabled = submit.disabled = retry.disabled = true;
      status.textContent = "正在保存…";
      try {
        const data = await save(work.id, select.value);
        if (current()) close();
        onSaved(data);
      } catch (error) {
        if (!current()) return;
        retry.hidden = Number(error.status || error.statusCode) !== 404;
        status.textContent = error.message || "收藏保存失败，请重试";
      } finally {
        saving = false;
        if (current()) {
          retry.disabled = false;
          select.disabled = submit.disabled = !retry.hidden;
        }
      }
    });
    retry.addEventListener("click", loadFolders);
    dialog.querySelector("[data-close]").addEventListener("click", () => close());
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    document.body.append(dialog);
    dialog.showModal();
    void loadFolders();
  }

  return { open, close };
}
