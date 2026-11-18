import { createChannelViews } from "../../platform/content-index/channel-views.js?v=assets-78764ed05056";
import { captureMediaTrail, mediaBackTarget } from "../../js/media-navigation-state.js?v=assets-78764ed05056";
import { fetchJson } from "../../js/api.js?v=assets-78764ed05056";
import { isAccountOwnerCurrent } from "../../js/account-owner.js";
import { createContinueShelf } from "./continue-shelf.js?v=assets-78764ed05056";
import { createMediaWatchlist } from "./watchlist.js";

export function createAndroidModule({ host }) {
  const search = createSearchController(host);
  const chrome = createMediaChrome(host);
  const handleBack = (view, params) => {
    if (channelViews.closeEpisodePicker?.(true)) return true;
    const target = mediaBackTarget(view, params);
    if (!target) return false;
    if (host.navigation.returnToStackView()) return true;
    host.navigation.showView(target.view, target.params, { skipHistory: true, replaceHistory: true, resetStack: true });
    return true;
  };
  const continueWatching = createContinueWatching(host);
  const watchlist = createMediaWatchlist({ container: host.els.viewContent, getActiveUrl: host.getActiveUrl });
  const channelViews = createChannelViews(createChannelContext(host, chrome.update, handleBack, continueWatching, watchlist));
  return {
    bottomKey: "media",
    rootViews: ["channel"],
    isRootView: (view, params) => view === "channel" && !mediaBackTarget(view, params),
    routes: [
      { view: "channel", match: (params) => ["media", "movie", "tv", "anime"].includes(host.normalizeChannelMode(params.mode)), render: (params, guard) => channelViews.renderChannel(params, guard) },
      { view: "mediaDetail", render: (params, guard) => channelViews.renderMediaDetail(params.id, params.mode, guard) }
    ],
    search,
    handleBack,
    deactivate: channelViews.deactivate,
    renderChrome: chrome.render,
    api: { channelViews }
  };
}

function createChannelContext(host, updateChrome, handleBack, mediaContinueWatching, mediaWatchlist) {
  return {
    els: host.els,
    getActiveUrl: host.getActiveUrl,
    getChannelLimit: host.limits.getChannel,
    increaseChannelLimit: host.limits.increaseChannel,
    getPhotoImageLimit: host.limits.getPhotoImages,
    increasePhotoImageLimit: host.limits.increasePhotoImages,
    getMangaImageLimit: host.limits.getMangaImages,
    increaseMangaImageLimit: host.limits.increaseMangaImages,
    openInLibrary: host.navigation.openInLibrary,
    showPhotoDetail: (id) => host.navigation.showView("photoDetail", { id }, { push: true }),
    showMangaDetail: (id) => host.navigation.showView("mangaDetail", { id }, { push: true }),
    showMangaChapter: (id, chapterIndex) => host.navigation.showView("mangaChapter", { id, chapterIndex }, { push: true }),
    showMediaDetail: (id, mode, { replaceEpisode = false } = {}) => {
      const currentView = host.navigation.currentView();
      const currentParams = host.navigation.currentParams();
      const replace = replaceEpisode && currentView === "mediaDetail";
      const mediaTrail = captureMediaTrail(currentView, currentParams, host.normalizeChannelMode(mode));
      const navigation = replace ? { skipHistory: true, replaceHistory: true } : { push: true };
      host.navigation.showView("mediaDetail", { id, mode, ...(mediaTrail ? { mediaTrail } : {}) }, navigation);
    },
    setActiveBottom: host.ui.setActiveBottom,
    renderCurrentView: host.ui.renderCurrentView,
    renderCurrentViewPreservingScroll: host.ui.renderCurrentViewPreservingScroll,
    goBack: host.navigation.goBack,
    getMediaViewer: () => host.mediaViewer,
    recordRecentContent: host.recent.record,
    onChannelFavoriteChange: host.favorites.onChannelFavoriteChange,
    openMediaSearch: host.ui.openSearch,
    mediaContinueWatching,
    mediaWatchlist,
    updateModuleChrome: updateChrome,
    updateChannelQuery: host.contentIndex.updateChannelQuery,
    updateChannelParams: (updates, navigation = {}) => {
      const current = host.navigation.currentParams();
      const next = { ...current, ...updates };
      const mediaTrail = navigation.push && (next.seriesKey || next.tvView === "episodes")
        ? captureMediaTrail(host.navigation.currentView(), current, host.normalizeChannelMode(next.mode))
        : next.mediaTrail;
      host.contentIndex.updateChannelParams({ ...updates, mediaTrail }, navigation);
    },
    returnToMediaCatalog: () => handleBack(host.navigation.currentView(), host.navigation.currentParams())
  };
}

function createContinueWatching(host) {
  const container = host.els.viewContent;
  const candidateLimit = 24;
  let current = null;

  function clear() {
    current?.controller?.abort();
    current?.shelf?.dispose();
    current = null;
  }

  function owns(selection) {
    const { scope, account } = selection;
    return current === selection && scope.guard() && scope.activeUrl === host.getActiveUrl()
      && account.owner !== "pending" && isAccountOwnerCurrent(account);
  }

  function mount() {
    const section = current?.shelf?.section;
    if (section && owns(current) && section.parentElement !== container) container.prepend(section);
  }

  function select(mode, scope, play) {
    const { filters, accountScope } = scope;
    const unfiltered = !filters.query && !filters.seriesKey && !filters.collection && filters.tvView !== "episodes"
      && [filters.category, filters.person].every(value => !value || value === "all");
    if (!unfiltered || !["media", "movie", "tv", "anime"].includes(mode)) { clear(); return; }
    const kind = mode === "media" ? "all" : mode;
    const key = JSON.stringify([scope.activeUrl, accountScope.owner, accountScope.revision, kind]);
    if (current?.key !== key) {
      clear();
      current = { key, kind, account: accountScope, scope, play, controller: null, shelf: null, loaded: false };
    } else Object.assign(current, { scope, play });
    const selection = current;
    // A pagination render can adopt the same shelf during the guard handoff.
    scope.guard.signal?.addEventListener("abort", () => queueMicrotask(() => {
      if (current === selection && selection.scope === scope) clear();
    }), { once: true });
  }

  async function load(scope) {
    if (current?.scope !== scope) return;
    if (current.account.owner !== scope.accountScope.owner || current.account.revision !== scope.accountScope.revision) {
      const { kind, play } = current;
      select(kind === "all" ? "media" : kind, scope, play);
    }
    const selection = current;
    if (!selection || !owns(selection) || selection.loaded || selection.controller) return;
    const controller = new AbortController();
    selection.controller = controller;
    try {
      const data = await fetchJson(scope.activeUrl, `/api/gallery-media/continue-watching?kind=${selection.kind}&limit=${candidateLimit}&includeProgressRevision=1`, {
        accountScope: selection.account, signal: controller.signal, cache: "no-store", timeoutMs: 8000
      });
      if (!owns(selection)) return;
      const items = Array.isArray(data?.items) ? data.items.slice(0, candidateLimit).filter(item =>
        typeof item?.id === "string" && item.id && typeof item.title === "string" && item.title && Number.isFinite(item.percent)) : [];
      if (items.length) selection.shelf = createContinueShelf({ activeUrl: scope.activeUrl, account: selection.account, items,
        isCurrent: () => owns(selection), onPlay: id => selection.play(id, selection.account) });
      selection.loaded = true;
      mount();
    } catch (error) {
      // An older computer only recognizes the media-detail route. The optional
      // shelf stays absent while the catalogue and its playback continue.
      if (owns(selection) && [404, 405, 501].includes(error?.status)) selection.loaded = true;
    } finally {
      selection.controller = null;
    }
  }

  return { select, load, mount, clear };
}

function createMediaChrome(host) {
  return {
    update() {
      host.ui.refreshChrome();
    },
    render() {
      // Bottom navigation owns media type selection. Search lives beside the
      // list count, so there is no second navigation row or empty toolbar.
      return false;
    }
  };
}

function createSearchController(host) {
  return {
    mode: "channel",
    isExpanded: (view, params, expanded) => expanded || (view === "channel" && Boolean(String(params.query || "").trim())),
    placeholder: () => "搜电影、电视剧或动漫",
    value: (view, params) => view === "channel" ? String(params.query || "") : "",
    submit(query, context) {
      const detailMode = host.normalizeChannelMode(context.params.mode);
      const params = context.view === "channel" ? context.params : { mode: detailMode === "tv" || detailMode === "anime" ? detailMode : "movie" };
      host.contentIndex.updateSearch(params, query);
    },
    close(context) {
      if (context.view !== "channel" || !String(context.params.query || "").trim()) return false;
      host.navigation.showView("channel", { ...context.params, query: "" }, { skipHistory: true, replaceHistory: true });
      return true;
    }
  };
}
