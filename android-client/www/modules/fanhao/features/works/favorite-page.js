import { cacheAgeText } from "../../../../js/cache.js?v=20260811-favorite-folders-01";
import { formatNumber } from "../../../../js/format.js";
import { createWorkListState } from "../../../../js/work-filtering.js?v=20260726-work-sort-01";
import { workCollectionPath } from "./collection-request.js?v=20260720-fanhao-collection-filter-01";
import { createFavoriteFolderFeature } from "./favorite-folders.js?v=20260811-favorite-folders-01";

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

  async function render(params = {}, isActive = () => true) {
    context.setActiveBottom("works");
    context.els.viewKicker.textContent = "作品";
    context.els.viewTitle.textContent = "我的收藏";
    context.els.viewMeta.textContent = "正在读取";
    context.els.viewContent.innerHTML = `<div class="loading-row">正在加载收藏</div>`;

    const requestedFolderId = String(params.folder || "all") || "all";
    const path = workCollectionPath("favorites", {
      folderId: requestedFolderId,
      limit: context.getWorksLimit(),
      filter: listState.getServerFilterMode(),
      sort: listState.getServerSortMode()
    });
    const activeUrl = context.getActiveUrl();
    const pageIsActive = () => isActive() && context.getActiveUrl() === activeUrl;
    pageIsActive.signal = isActive.signal;
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      context.els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个收藏${suffix}`;
    };
    const renderData = (data, cacheEntry = null) => {
      folders.rememberFolders(data.folders);
      const selectedFolderId = String(data.selectedFolderId || requestedFolderId || "all");
      if (selectedFolderId !== requestedFolderId) {
        context.replaceViewParams("works", {
          favorite: "1",
          ...(selectedFolderId !== "all" ? { folder: selectedFolderId } : {})
        });
      }
      const selectedFolder = folders.folders().find((folder) => folder.id === selectedFolderId);
      const works = data.works || [];
      const total = Number(data.total || works.length);
      applyHeader(data, cacheEntry);
      context.els.viewContent.innerHTML = "";
      context.els.viewContent.append(folders.createFolderStrip(selectedFolderId, {
        onSelect(folderId) {
          if (folderId === selectedFolderId) return;
          context.showView("works", {
            favorite: "1",
            ...(folderId && folderId !== "all" ? { folder: folderId } : {})
          }, { push: true });
        }
      }));
      context.renderWorks(works, selectedFolder ? `“${selectedFolder.name}”里还没有收藏。` : "还没有收藏作品。", {
        compactMeta: true,
        compactSummary: true,
        coverGrid: true,
        facets: data.facets,
        listState,
        ...context.serverContinuationOptions(works, total)
      });
    };

    try {
      const result = await context.pageDataService.load(activeUrl, path, {
        signal: pageIsActive.signal,
        isActive: pageIsActive,
        signature: context.workDataSignature,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderData(data, cacheEntry);
        }
      });
      if (!result || !pageIsActive()) return;
      if (result.unchanged) applyHeader(result.data);
      else renderData(result.data);
    } catch (error) {
      if (!pageIsActive()) return;
      if (renderedCache) context.renderMessage("电脑端暂时连不上，当前显示的是本地缓存收藏。", "quiet", false);
      else context.renderMessage(error?.message || "收藏读取失败", "error");
    }
  }

  return { folders, listState, render };
}
