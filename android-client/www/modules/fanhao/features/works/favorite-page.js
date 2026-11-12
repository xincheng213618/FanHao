import { captureAccountOwner, isAccountOwnerCurrent } from "../../../../js/account-owner.js";
import { cacheAgeText } from "../../../../js/cache.js?v=assets-06c1d7f13464";
import { formatNumber } from "../../../../js/format.js";
import { openMobileActionSheet } from "../../../../js/mobile-action-sheet.js?v=assets-06c1d7f13464";
import { createWorkListState } from "../../../../js/work-filtering.js?v=assets-06c1d7f13464";
import { workCollectionPath } from "./collection-request.js?v=assets-06c1d7f13464";
import { createFavoriteFolderFeature } from "./favorite-folders.js?v=assets-06c1d7f13464";

const FAVORITE_BATCH_LIMIT = 500;
const QUERY_LIMIT = 120;

export function createFavoriteWorkViews(context) {
  const listState = createWorkListState({
    renderCurrentView: context.renderCurrentView,
    persist: false,
    initialFilterMode: "all",
    initialSortMode: context.initialSortMode
  });
  const folders = createFavoriteFolderFeature({
    getActiveUrl: context.getActiveUrl,
    getLibrary: context.getLibrary,
    onUserStateChange: context.onUserStateChange,
    pageDataService: context.pageDataService
  });
  const refreshPreservingScroll = context.renderCurrentViewPreservingScroll || context.renderCurrentView;
  let activePage = null;
  let batch = null;
  let pendingMove = null;
  let moveNotice = "";

  async function render(params = {}, isActive = () => true) {
    const requestedFolderId = String(params.folder || "all") || "all";
    const query = normalizeQuery(params.query);
    const activeUrl = context.getActiveUrl();
    const account = captureAccountOwner(activeUrl);
    const filter = listState.getServerFilterMode();
    const sort = listState.getServerSortMode();
    const key = JSON.stringify([activeUrl, account.owner, account.revision, requestedFolderId, query, filter, sort]);
    const pageIsActive = () => isActive() && context.getActiveUrl() === activeUrl && isAccountOwnerCurrent(account);
    if (batch && (!batch.continuing || batch.key !== key)) closeBatch(false);
    const page = { activeUrl, account, key, isActive: pageIsActive, mount: null };
    activePage = page;
    isActive.signal?.addEventListener("abort", () => {
      if (activePage !== page) return;
      activePage = null;
      if (!batch?.continuing) closeBatch(false);
    }, { once: true });
    if (batch) syncBatchToolbar(page);
    const notice = moveNotice;
    moveNotice = "";
    context.setActiveBottom("works");
    context.els.viewKicker.textContent = "作品";
    context.els.viewTitle.textContent = "我的收藏";
    context.els.viewMeta.textContent = "正在读取";
    const search = createFavoriteSearch(query, (value) => {
      if (!search.isConnected || !ownsPage(page) || value === query) return;
      context.showView("works", favoriteParams(page.mount?.folderId || requestedFolderId, value), {
        skipHistory: true, replaceHistory: true
      });
    });
    const loading = document.createElement("div");
    loading.className = "loading-row";
    loading.textContent = query ? "正在搜索收藏" : "正在加载收藏";
    context.els.viewContent.replaceChildren(search, loading);

    const path = workCollectionPath("favorites", {
      folderId: requestedFolderId,
      limit: context.getWorksLimit(),
      query, filter, sort
    });
    const acceptsQuery = data => !query || data?.query === query;
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      folders.rememberWorks(works);
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      context.els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} ${query ? "部匹配作品" : "个收藏"}${suffix}`;
    };
    const renderData = (data, cacheEntry = null) => {
      folders.rememberFolders(data.folders);
      const selectedFolderId = String(data.selectedFolderId || requestedFolderId || "all");
      if (selectedFolderId !== requestedFolderId) {
        closeBatch(false);
        context.replaceViewParams("works", favoriteParams(selectedFolderId, query));
      }
      const selectedFolder = folders.folders().find((folder) => folder.id === selectedFolderId);
      const works = data.works || [];
      const total = Number(data.total || works.length);
      applyHeader(data, cacheEntry);
      while (context.els.viewContent.lastElementChild !== search && search.parentElement === context.els.viewContent) {
        context.els.viewContent.lastElementChild.remove();
      }
      const controls = document.createElement("div");
      controls.className = "favorite-folder-controls";
      const mount = { folderId: selectedFolderId, cards: [], visible: [], entry: null };
      page.mount = mount;
      controls.append(folders.createFolderStrip(selectedFolderId, {
        onChanged(change) {
          if (!pageIsActive()) return;
          if (change.type === "deleted" && change.folderId === selectedFolderId) {
            context.replaceViewParams("works", favoriteParams(change.defaultFolderId || "default", query));
          }
          context.renderCurrentView();
        },
        onSelect(folderId) {
          if (!ownsPage(page, mount) || folderId === selectedFolderId) return;
          context.showView("works", favoriteParams(folderId, query), { push: true });
        }
      }));
      if (works.length && destinations(selectedFolderId).length) {
        mount.entry = createBatchButton("批量移动", () => openBatch(page, mount));
        controls.append(mount.entry);
      }
      context.els.viewContent.append(controls);
      if (notice) {
        const status = document.createElement("p");
        status.className = "favorite-batch-notice";
        status.setAttribute("role", "status");
        status.textContent = notice;
        context.els.viewContent.append(status);
      }
      const continuation = context.serverContinuationOptions(works, total);
      const empty = query ? "没有符合收藏搜索的作品。" : selectedFolder ? `“${selectedFolder.name}”里还没有收藏。` : "还没有收藏作品。";
      const rendered = context.renderWorks(works, empty, {
        compactMeta: true,
        compactSummary: true,
        coverGrid: true,
        facets: data.facets,
        listState,
        ...continuation,
        onLoadMore: () => continueBatch(page, continuation.onLoadMore),
        onVisibleMore: () => continueBatch(page, () => {
          context.increaseWorksLimit(40);
          return refreshPreservingScroll();
        }),
        onCardCreated: (card, work) => bindBatchCard(page, mount, card, work)
      });
      mount.visible = rendered?.visible || [];
      syncBatchPresentation(page);
    };

    try {
      const result = await context.pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive: pageIsActive,
        signature: context.workDataSignature,
        canCache: acceptsQuery,
        onCached(data, cacheEntry) {
          if (!acceptsQuery(data)) return;
          renderedCache = true;
          renderData(data, cacheEntry);
        }
      });
      if (!result || !pageIsActive()) return;
      if (!acceptsQuery(result.data)) throw new Error("当前服务不支持收藏搜索。可清除搜索继续浏览。");
      if (result.unchanged && renderedCache) applyHeader(result.data);
      else renderData(result.data);
    } catch (error) {
      if (!pageIsActive()) return;
      loading.remove();
      if (renderedCache) context.renderMessage(query ? "无法更新搜索，当前显示的是本地缓存结果。"
        : "电脑端暂时连不上，当前显示的是本地缓存收藏。", "quiet", false);
      else {
        context.renderMessage(error?.message || "收藏读取失败", "error", false);
        if (query || batch?.key === page.key) {
          const retry = createBatchButton("重试读取收藏", () => continueBatch(page, refreshPreservingScroll));
          retry.className = "favorite-batch-retry";
          context.els.viewContent.append(retry);
        }
      }
    }
  }

  function destinations(folderId) {
    return folders.folders().filter(folder => folder.id !== folderId);
  }

  function ownsPage(page, mount = page.mount) {
    return activePage === page && page.mount === mount && page.isActive();
  }

  function ownsBatch(page, mount = page.mount) {
    return Boolean(mount) && ownsPage(page, mount) && batch?.key === page.key;
  }

  function hasPendingMove(page) {
    return pendingMove?.activeUrl === page.activeUrl && isAccountOwnerCurrent(pendingMove.account);
  }

  function continueBatch(page, loadMore) {
    if (!ownsPage(page) || typeof loadMore !== "function") return;
    const selection = batch;
    if (selection) selection.continuing = true;
    try { return loadMore(); }
    finally {
      if (selection) selection.continuing = false;
      if (!activePage) closeBatch(false);
    }
  }

  function openBatch(page, mount) {
    if (!ownsPage(page, mount) || batch || hasPendingMove(page)) return;
    const toolbar = document.createElement("div");
    toolbar.className = "favorite-batch-toolbar";
    const summary = document.createElement("span");
    summary.setAttribute("role", "status");
    const message = document.createElement("div");
    message.className = "favorite-batch-message";
    message.setAttribute("role", "status");
    const all = createBatchButton("选中已显示", () => selectDisplayedWorks());
    const move = createBatchButton("移至收藏夹", () => pickBatchDestination());
    const exit = createBatchButton("退出", () => closeBatch());
    move.classList.add("favorite-batch-move");
    toolbar.append(summary, all, move, exit, message);
    batch = { key: page.key, toolbar, summary, message, move, all, ids: new Set() };
    document.body.append(toolbar);
    syncBatchPresentation(page);
    (mount.cards[0]?.card || all).focus({ preventScroll: true });
  }

  function closeBatch(restoreFocus = true) {
    if (!batch) return false;
    batch.toolbar.remove();
    batch = null;
    context.els.viewContent.classList.remove("favorite-batch-active");
    if (activePage && ownsPage(activePage)) {
      syncBatchPresentation(activePage);
      if (restoreFocus) activePage.mount?.entry?.focus({ preventScroll: true });
    }
    return true;
  }

  function bindBatchCard(page, mount, card, work) {
    if (!work.favorite || work.id == null || work.id === "") return;
    const record = { card, id: String(work.id), person: card.querySelector(".work-card-grid-person[data-person-id]"),
      folder: card.querySelector(".work-card-folder-button") };
    mount.cards.push(record);
    const toggle = (event) => {
      if (!ownsBatch(page, mount)) return;
      event.preventDefault();
      event.stopPropagation();
      if (hasPendingMove(page)) return;
      batch.message.textContent = "";
      if (!batch.ids.delete(record.id)) selectBatchId(record.id);
      syncBatchCard(record, batch);
      syncBatchToolbar(page);
    };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", event => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) toggle(event);
    });
    if (ownsBatch(page, mount)) syncBatchCard(record, batch);
  }

  function syncBatchPresentation(page) {
    if (!ownsPage(page) || !page.mount) return;
    const selection = ownsBatch(page) ? batch : null;
    context.els.viewContent.classList.toggle("favorite-batch-active", Boolean(selection));
    const { entry, cards } = page.mount;
    if (entry) {
      entry.hidden = Boolean(selection);
      entry.disabled = hasPendingMove(page);
    }
    for (const record of cards) syncBatchCard(record, selection);
    if (selection) syncBatchToolbar(page);
  }

  function syncBatchToolbar(page) {
    const pending = hasPendingMove(page);
    batch.summary.textContent = `已选 ${formatNumber(batch.ids.size)} 部`;
    batch.all.disabled = pending || !page.mount?.visible.some(work => work.favorite && work.id != null);
    batch.move.disabled = pending || !batch.ids.size || !page.mount || !destinations(page.mount.folderId).length;
    batch.move.textContent = pending ? "正在移动" : "移至收藏夹";
  }

  function selectBatchId(id) {
    if (batch.ids.has(id)) return;
    if (batch.ids.size < FAVORITE_BATCH_LIMIT) batch.ids.add(id);
    else batch.message.textContent = `每批最多移动 ${FAVORITE_BATCH_LIMIT} 部作品`;
  }

  function selectDisplayedWorks() {
    const page = activePage;
    if (!page || !ownsBatch(page) || hasPendingMove(page)) return;
    batch.message.textContent = "";
    for (const work of page.mount.visible) {
      if (work.favorite && work.id != null && work.id !== "") selectBatchId(String(work.id));
    }
    syncBatchPresentation(page);
  }

  function pickBatchDestination() {
    const page = activePage;
    const selection = batch;
    if (!page || !ownsBatch(page) || hasPendingMove(page) || !selection.ids.size) return;
    const status = document.createElement("div");
    status.className = "favorite-batch-notice";
    status.setAttribute("role", "status");
    const sheet = openMobileActionSheet({
      trigger: selection.move,
      title: `将 ${formatNumber(selection.ids.size)} 部作品移至收藏夹`,
      options: destinations(page.mount.folderId).map(folder => ({
        value: folder.id, label: folder.name, closeOnSelect: false,
        select: (_id, button) => submitBatchMove(page, selection, folder, sheet, status, button)
      }))
    });
    sheet.header.after(status);
  }

  async function submitBatchMove(page, selection, target, sheet, status, button) {
    if (!ownsBatch(page) || batch !== selection || hasPendingMove(page)) return;
    const workIds = [...selection.ids];
    const options = [...sheet.panel.querySelectorAll(".mobile-action-sheet-option")];
    const operation = { activeUrl: page.activeUrl, account: page.account };
    pendingMove = operation;
    selection.message.textContent = "";
    syncBatchToolbar(page);
    status.textContent = "正在移动";
    for (const option of options) option.disabled = true;
    sheet.closeButton.focus({ preventScroll: true });
    try {
      const result = await folders.moveFavoritesToFolder(workIds, target.id);
      if (batch === selection) {
        sheet.close(false);
        closeBatch(false);
        const destination = result.folders.find(folder => folder.id === target.id);
        if (activePage?.key === page.key) moveNotice = `已将 ${formatNumber(workIds.length)} 部作品归入「${destination.name}」`;
      }
      if (activePage?.activeUrl === operation.activeUrl && isAccountOwnerCurrent(operation.account)
        && ownsPage(activePage)) void refreshPreservingScroll();
    } catch (error) {
      if (batch !== selection || !activePage || !ownsBatch(activePage) || error?.code === "ACCOUNT_CHANGED") return;
      const reason = error?.message || "批量移动失败，请重试";
      selection.message.textContent = reason;
      status.textContent = reason;
      for (const option of options) option.disabled = false;
      if (sheet.overlay.isConnected) button.focus({ preventScroll: true });
    } finally {
      if (pendingMove === operation) pendingMove = null;
      if (activePage) syncBatchPresentation(activePage);
    }
  }

  return { closeBatch, folders, listState, render };
}

function favoriteParams(folder, query) {
  return { favorite: "1", ...(folder && folder !== "all" ? { folder } : {}), ...(query ? { query } : {}) };
}

function normalizeQuery(value) {
  return String(value || "").trim().slice(0, QUERY_LIMIT).trimEnd().replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

function createFavoriteSearch(query, onSearch) {
  const form = document.createElement("form");
  form.className = "favorite-search-form";
  form.setAttribute("role", "search");
  form.setAttribute("aria-label", "收藏内查找");
  const input = document.createElement("input");
  input.type = "search";
  input.setAttribute("aria-label", "搜索收藏");
  input.placeholder = "番号或标题";
  input.autocomplete = "off";
  input.enterKeyHint = "search";
  input.maxLength = QUERY_LIMIT;
  input.value = query;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "搜索";
  const clear = createBatchButton("清除搜索", () => onSearch(""));
  clear.hidden = !query;
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (composing) return;
    const value = normalizeQuery(input.value);
    input.value = value;
    onSearch(value);
  });
  form.append(input, submit, clear);
  return form;
}

function createBatchButton(text, click) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", click);
  return button;
}

function syncBatchCard({ card, id, person, folder }, selection) {
  if (selection) {
    card.role = "checkbox";
    card.setAttribute("aria-checked", String(selection.ids.has(id)));
    if (person) person.disabled = true;
    if (folder) folder.disabled = true;
  } else if (card.hasAttribute("aria-checked")) {
    card.role = "button";
    card.removeAttribute("aria-checked");
    if (person) person.disabled = false;
    if (folder) folder.disabled = false;
  }
}
