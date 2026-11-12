import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-06c1d7f13464";

const PLAYLIST_TRACK_LIMIT = 2000;

export function createMusicBatchQueue({
  isCurrent, appendTracks, createPlaylist, listPlaylists, addToPlaylist, openPlaylist, defaultPlaylistName, formatNumber
}) {
  const lists = new WeakMap();
  const entries = new WeakMap();
  let selection = null;
  let feedback = null;

  function registerRow(row, track, key = track?.id) {
    if (track?.id && key) entries.set(row, { track, key: String(key), label: row.getAttribute("aria-label") });
  }

  function mount(list, owner) {
    const toolbar = document.createElement("div");
    toolbar.className = "music-mobile-batch-queue";
    list.append(toolbar);
    const open = button("多选歌曲", "open");
    const status = document.createElement("span");
    status.className = "music-mobile-batch-status";
    status.setAttribute("role", "status");
    const all = button("全选已加载", "all");
    const add = button("加入队列", "add");
    const addPlaylist = button("添加到歌单", "add-playlist");
    const create = button("新建歌单", "create");
    const showPlaylist = button("查看歌单", "show-playlist");
    const cancel = button("取消", "cancel");
    toolbar.append(open, status, all, add, addPlaylist, create, cancel, showPlaylist);
    const view = { list, owner, toolbar, open, status, all, add, addPlaylist, create, cancel, showPlaylist };
    lists.set(list, view);
    const current = () => list.isConnected && isCurrent(owner);
    open.addEventListener("click", () => {
      if (!current() || selection?.owner === owner) return;
      selection = { owner, keys: new Set(), view, playlistName: defaultPlaylistName(), playlistError: "" };
      feedback = null;
      refresh(list);
      all.focus({ preventScroll: true });
    });
    all.addEventListener("click", () => {
      if (!current() || selection?.owner !== owner || selection.saving) return;
      const rows = selectableRows(list);
      selection.keys = new Set(selection.keys.size === view.total ? [] : rows.map(row => entries.get(row).key));
      selection.playlistError = "";
      refresh(list);
    });
    add.addEventListener("click", () => {
      if (!current() || selection?.owner !== owner || selection.saving) return;
      const tracks = selectedTracks(view, selection);
      if (!tracks.length) return;
      const result = appendTracks(tracks);
      if (!result) return;
      feedback = { owner, message: `已加入 ${formatNumber(result.added)} 首${result.skipped ? `，${formatNumber(result.skipped)} 首已在队列` : ""}` };
      finish(view);
    });
    create.addEventListener("click", () => {
      if (current() && selection?.owner === owner && !create.disabled) openPlaylistForm(selection);
    });
    addPlaylist.addEventListener("click", () => {
      if (current() && selection?.owner === owner && !addPlaylist.disabled) openPlaylistPicker(selection);
    });
    showPlaylist.addEventListener("click", () => {
      if (current() && feedback?.owner === owner && feedback.playlist?.id) openPlaylist(feedback.playlist);
    });
    cancel.addEventListener("click", () => { if (current() && selection?.owner === owner) finish(view); });
  }

  function finish(view, restoreFocus = true) {
    selection?.sheet?.close(false);
    selection = null;
    refresh(view.list);
    if (restoreFocus) view.open.focus({ preventScroll: true });
  }

  function selectableRows(list) {
    return [...list.querySelectorAll(".music-mobile-track")].filter(row => entries.has(row));
  }

  function selectedTracks(view, draft) {
    return selectableRows(view.list).map(row => entries.get(row))
      .filter(entry => draft.keys.has(entry.key)).map(entry => entry.track);
  }

  function selectedTrackIds(draft) {
    return [...new Set(selectedTracks(draft.view, draft).map(track => String(track.id)))];
  }

  function ownsDraft(draft) {
    return selection === draft && draft.view.list.isConnected && isCurrent(draft.owner);
  }

  function openPlaylistPicker(draft) {
    const trackIds = selectedTrackIds(draft);
    if (!trackIds.length || trackIds.length > PLAYLIST_TRACK_LIMIT || draft.saving) return;
    const sheet = openMobileActionSheet({
      title: "添加到歌单", trigger: () => ownsDraft(draft) ? draft.view.addPlaylist : null
    });
    draft.sheet = sheet;
    sheet.panel.classList.add("music-mobile-batch-playlist-picker");
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索歌单";
    search.setAttribute("aria-label", "搜索歌单");
    search.hidden = true;
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const options = document.createElement("div");
    options.className = "music-mobile-batch-playlist-options";
    sheet.panel.append(search, status, options);
    const current = () => sheet.overlay.isConnected && ownsDraft(draft);
    const selectionMessage = `选择歌单，添加 ${formatNumber(trackIds.length)} 首歌曲`;
    const choices = [];

    async function submit(playlist) {
      if (!current() || draft.saving) return;
      draft.saving = "正在添加到歌单";
      search.readOnly = true;
      for (const choice of options.children) choice.setAttribute("aria-disabled", "true");
      status.textContent = draft.saving;
      refresh(draft.view.list);
      try {
        const receipt = await addToPlaylist(draft.owner, playlist.id, trackIds);
        if (!ownsDraft(draft) || !receipt) return;
        const { addedCount, alreadyPresentCount, unavailableCount } = receipt;
        const message = [`「${playlist.name || "未命名歌单"}」新增 ${formatNumber(addedCount)} 首`];
        if (alreadyPresentCount) message.push(`${formatNumber(alreadyPresentCount)} 首已在歌单`);
        if (unavailableCount) message.push(`${formatNumber(unavailableCount)} 首不可用`);
        feedback = { owner: draft.owner, playlist, message: message.join("，") };
        finish(draft.view, sheet.overlay.contains(document.activeElement));
      } catch (error) {
        if (!ownsDraft(draft)) return;
        draft.playlistError = status.textContent = error?.message || "添加到歌单失败，请重试";
      } finally {
        draft.saving = "";
        if (ownsDraft(draft)) {
          search.readOnly = false;
          for (const choice of options.children) choice.removeAttribute("aria-disabled");
          refresh(draft.view.list);
        }
      }
    }

    function filterOptions() {
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const { choice, name } of choices) {
        choice.hidden = !name.includes(query);
        if (!choice.hidden) visible++;
      }
      status.textContent = visible ? selectionMessage : choices.length ? "没有匹配的歌单" : "还没有歌单";
    }

    function renderOptions(playlists) {
      const fragment = document.createDocumentFragment();
      for (const playlist of playlists) {
        const label = playlist.name || "未命名歌单";
        const choice = button("", "choose-playlist");
        choice.className = "fanhao-sort-option";
        const name = document.createElement("span");
        name.textContent = label;
        const count = document.createElement("small");
        count.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
        choice.append(name, count);
        choice.addEventListener("click", () => void submit(playlist));
        choices.push({ choice, name: label.toLocaleLowerCase() });
        fragment.append(choice);
      }
      if (!playlists.length) {
        const create = button("新建歌单", "create-from-picker");
        create.className = "fanhao-sort-option";
        create.addEventListener("click", () => { if (current()) openPlaylistForm(draft); });
        fragment.append(create);
      }
      options.append(fragment);
      filterOptions();
    }

    async function load() {
      status.textContent = "正在读取歌单";
      if (options.contains(document.activeElement)) sheet.closeButton.focus({ preventScroll: true });
      options.replaceChildren();
      try {
        const playlists = await listPlaylists(draft.owner);
        if (!current() || !playlists) return;
        search.hidden = !playlists.length;
        renderOptions(playlists);
      } catch (error) {
        if (!current()) return;
        status.textContent = error?.message || "读取歌单失败，请重试";
        const retry = button("重试读取歌单", "retry-playlists");
        retry.className = "fanhao-sort-option";
        retry.addEventListener("click", () => { if (current()) void load(); });
        options.append(retry);
      }
    }

    draft.playlistError = "";
    syncToolbar(draft.view);
    sheet.panel.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const controls = [sheet.closeButton, search, ...options.children].filter(control => !control.hidden);
      const boundary = event.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement !== boundary) return;
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0]).focus();
    });
    search.addEventListener("input", event => {
      if (!event.isComposing && current() && !draft.saving) filterOptions();
    });
    search.addEventListener("compositionend", () => { if (current() && !draft.saving) filterOptions(); });
    void load();
  }

  function openPlaylistForm(draft) {
    const trackIds = selectedTrackIds(draft);
    if (!trackIds.length || trackIds.length > PLAYLIST_TRACK_LIMIT || draft.saving) return;
    const current = () => ownsDraft(draft);
    const sheet = openMobileActionSheet({ title: "新建歌单", trigger: () => current() ? draft.view.create : null });
    draft.sheet = sheet;
    const form = document.createElement("form");
    form.className = "music-mobile-batch-playlist-form";
    const nameField = document.createElement("label");
    nameField.textContent = "歌单名称";
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 80;
    name.required = true;
    name.value = draft.playlistName;
    nameField.append(name);
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "fanhao-sort-option";
    save.textContent = `保存 ${formatNumber(trackIds.length)} 首歌曲`;
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.textContent = draft.playlistError;
    form.append(nameField, status, save);
    sheet.panel.append(form);
    name.focus({ preventScroll: true });
    name.select();
    name.addEventListener("input", () => {
      draft.playlistName = name.value;
      draft.playlistError = status.textContent = "";
      if (current()) syncToolbar(draft.view);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!current() || !sheet.overlay.isConnected || draft.saving) return;
      const clean = name.value.trim();
      if (!clean) { status.textContent = "请输入歌单名称"; name.focus(); return; }
      draft.playlistName = name.value;
      draft.playlistError = "";
      draft.saving = "正在创建歌单";
      name.readOnly = true;
      save.setAttribute("aria-disabled", "true");
      status.textContent = draft.saving;
      refresh(draft.view.list);
      try {
        const playlist = await createPlaylist(draft.owner, clean, trackIds);
        if (!current() || !playlist) return;
        const count = Number.isSafeInteger(playlist.trackCount) ? playlist.trackCount : trackIds.length;
        const skipped = Math.max(0, trackIds.length - count);
        feedback = { owner: draft.owner, playlist,
          message: `已创建「${playlist.name || clean}」 · ${formatNumber(count)} 首${skipped ? `，${formatNumber(skipped)} 首未加入` : ""}` };
        finish(draft.view, sheet.overlay.contains(document.activeElement));
      } catch (error) {
        if (!current()) return;
        draft.playlistError = status.textContent = error?.message || "创建歌单失败，请重试";
      } finally {
        draft.saving = "";
        if (current()) {
          name.readOnly = false;
          save.removeAttribute("aria-disabled");
          refresh(draft.view.list);
        }
      }
    });
  }

  function refresh(list) {
    const view = lists.get(list);
    if (!view) return;
    const selecting = selection?.owner === view.owner && isCurrent(view.owner);
    const result = feedback?.owner === view.owner ? feedback : null;
    view.toolbar.classList.toggle("is-selecting", Boolean(selecting));
    view.toolbar.classList.toggle("has-feedback", Boolean(result));
    view.open.hidden = Boolean(selecting);
    view.all.hidden = view.add.hidden = view.addPlaylist.hidden = view.create.hidden = view.cancel.hidden = !selecting;
    view.showPlaylist.hidden = Boolean(selecting) || !result?.playlist;
    if (!selecting && !list.querySelector(".music-mobile-batch-checkbox")) {
      view.status.textContent = result?.message || "";
      return;
    }
    const rows = selectableRows(list);
    if (selecting) {
      selection.view = view;
      const loaded = new Set(rows.map(row => entries.get(row).key));
      for (const key of selection.keys) if (!loaded.has(key)) selection.keys.delete(key);
      view.total = loaded.size;
    }
    for (const row of rows) setRowSelection(row, view, selecting);
    if (selecting) syncToolbar(view);
    else view.status.textContent = result?.message || "";
  }

  function setRowSelection(row, view, selecting) {
    let checkbox = row.querySelector(".music-mobile-batch-checkbox");
    const entry = entries.get(row);
    if (!selecting) {
      if (checkbox) {
        checkbox.remove();
        row.setAttribute("role", "button");
        row.setAttribute("aria-label", entry.label);
        row.tabIndex = 0;
      }
      return;
    }
    if (!checkbox) {
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "music-mobile-batch-checkbox";
      checkbox.dataset.musicBatchKey = entry.key;
      checkbox.setAttribute("aria-label", `选择 ${entry.track.title || entry.track.fileName || "歌曲"}`);
      row.prepend(checkbox);
      row.removeAttribute("role");
      row.removeAttribute("aria-label");
      row.removeAttribute("tabindex");
      checkbox.addEventListener("change", () => {
        if (!checkbox.isConnected || selection?.owner !== view.owner || selection.saving || !isCurrent(view.owner)) return;
        if (checkbox.checked) selection.keys.add(entry.key);
        else selection.keys.delete(entry.key);
        selection.playlistError = "";
        syncToolbar(view);
      });
    }
    checkbox.checked = selection.keys.has(entry.key);
    checkbox.disabled = Boolean(selection.saving);
  }

  function syncToolbar(view) {
    const count = selection.keys.size;
    view.all.textContent = count && count === view.total ? "取消全选" : "全选已加载";
    const overLimit = count > PLAYLIST_TRACK_LIMIT;
    view.all.disabled = Boolean(selection.saving);
    view.add.disabled = !count || Boolean(selection.saving);
    view.create.disabled = view.addPlaylist.disabled = view.add.disabled || overLimit;
    const note = selection.saving || selection.playlistError
      || (overLimit ? `每次最多向歌单添加 ${formatNumber(PLAYLIST_TRACK_LIMIT)} 首` : "");
    view.status.textContent = `已选 ${formatNumber(count)} / ${formatNumber(view.total)} 首${note ? ` · ${note}` : ""}`;
  }

  function handleRowClick(row, event) {
    const checkbox = row.querySelector(".music-mobile-batch-checkbox");
    if (!checkbox) return false;
    const view = lists.get(row.closest(".music-mobile-list"));
    if (event.target !== checkbox && view && isCurrent(view.owner)) checkbox.click();
    return true;
  }

  function cancel(root) {
    if (!selection) return false;
    if (selection.sheet?.close()) return true;
    const owner = selection.owner;
    for (const list of root.querySelectorAll(".music-mobile-list")) {
      const view = lists.get(list);
      if (view?.owner === owner && isCurrent(owner)) {
        finish(view);
        return true;
      }
    }
    selection = null;
    return false;
  }

  function captureFocus(root) {
    const control = document.activeElement;
    const key = control?.dataset?.musicBatchKey;
    const action = control?.dataset?.musicBatchAction;
    if (!key && !action) return null;
    const list = control.closest(".music-mobile-list");
    const owner = lists.get(list)?.owner;
    return root.contains(control) && owner && isCurrent(owner) ? { owner, key, action } : null;
  }

  function restoreFocus(root, focus) {
    if (!focus || !isCurrent(focus.owner)) return;
    for (const list of root.querySelectorAll(".music-mobile-list")) {
      if (lists.get(list)?.owner !== focus.owner) continue;
      const target = focus.key
        ? [...list.querySelectorAll("[data-music-batch-key]")].find(control => control.dataset.musicBatchKey === focus.key)
        : list.querySelector(`[data-music-batch-action="${focus.action}"]`);
      if (target && !target.hidden && !target.disabled) target.focus({ preventScroll: true });
      return;
    }
  }

  function reset() {
    selection?.sheet?.close(false);
    selection = null;
    feedback = null;
  }

  return { registerRow, mount, refresh, handleRowClick, captureFocus, restoreFocus, cancel, reset };
}

function button(label, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.dataset.musicBatchAction = action;
  return control;
}
