// 音乐模块组合根 + 视图控制器。
// 只负责：装配 state / api / player / actions / 组件 / 视图；持有 DOM 索引表与渲染函数；
// 把 DOM 事件接到 actions（唯一编排层）；向 actions 提供 view 回调（视图更新）。
// 所有业务逻辑、HTTP、audio 控制都在其它模块，这里不再重复实现。

import { ensureMusicState } from "./state.js";
import { createMusicApi } from "./api.js?v=20261004-music-progress-01";
import { createMusicPlayer } from "./player/engine.js?v=20261004-music-progress-01";
import { createMusicActions } from "./actions.js?v=20261004-music-list-02";
import { createComponents } from "./views/components.js";
import { createLyricFinder } from "./views/lyric-finder.js";
import { createMusicHome } from "./views/home.js";
import { captureWebAccount } from "../../platform/accounts/session-context.js";
import { formatSeconds, collapseDuplicateTracks } from "./format.js";
import {
  MUSIC_SLEEP_TIMER_OPTIONS,
  MUSIC_PLAYBACK_SPEED_OPTIONS,
  MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS,
  MUSIC_LIBRARY_CLEAR_DEBOUNCE_MS,
  MUSIC_CATALOG_SEARCH_DEBOUNCE_MS,
  MUSIC_SUGGEST_MIN_CHARACTERS,
  MUSIC_KEYBOARD_SEEK_SECONDS,
  MUSIC_KEYBOARD_FAST_SEEK_SECONDS,
  DESKTOP_QUEUE_PREVIEW_LIMIT,
  DESKTOP_QUEUE_PAGE_SIZE
} from "./constants.js";

export function createMusicPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatBytes,
    formatNumber,
    hidePersonProfile,
    openAdminScript,
    pushRoute,
    replaceRoute,
    resetProgressiveCoverLoading,
    setMainHeader,
    state,
    syncRouteAfterNavigation
  } = deps;

  const musicApi = createMusicApi(api);

  // ---- DOM 索引表（视图控制器专属）----
  let searchTimer = null;
  let suggestTimer = null;
  let suggestController = null;
  let suggestionCache = new Map();
  let suggestionBox = null;
  let currentProgressEls = null;
  let playbackButtonEls = [];
  let currentTrackIndicatorMap = new Map();
  let musicTrackElementMap = new Map();
  let openingTrackElementId = "";
  let playbackSurfaceEls = [];
  let playbackErrorEls = [];
  let shuffleControlEls = [];
  let repeatControlEls = [];
  let sleepTimerControlEls = [];
  let lyricLineEls = [];
  let lyricFollowButtonEls = [];
  let activeLyricElement = null;
  let lyricRaf = 0;
  let currentLyricIndex = -1;
  let lyricViewport = null;
  let lyricFinderState = null;
  let visibilityInstalled = false;
  let keyboardShortcutsInstalled = false;
  let progressLifecycleInstalled = false;
  let favoriteFeedbackPosition = null;
  let trackReturnContext = null;
  let trackReturnHistoryAccount = null;
  let trackReturnHistoryOwner = "";
  const listMoreRecords = new WeakMap();
  const listResultRecords = new WeakMap();
  let appendFocusRestore = null;
  let pendingListAppend = null;
  let appendViewportRestore = null;
  let playlistDialogEvents = null;
  let queueSearchState = null;
  const queueViews = new WeakMap();

  // ---- 播放引擎（拥有 audio / 可视化 / MediaSession / 睡眠定时）----
  const player = createMusicPlayer({
    getState: () => state,
    callbacks: {
      onPlay: () => {
        setPlaybackError("");
        actions.reportPlayedOnce();
        updatePlaybackUi();
      },
      onPause: () => {
        actions.saveProgressSoon(null, { immediate: true });
        updatePlaybackUi();
      },
      onTimeUpdate: () => {
        updatePlaybackUi();
        updateLyricHighlight();
        actions.saveProgressSoon();
      },
      onEnded: () => {
        actions.saveProgressSoon(0, { immediate: true });
        if (state.music.repeat === "one") {
          const audio = player.getAudio();
          audio.currentTime = 0;
          player.play();
        } else {
          actions.playAdjacent(1, { autoplay: true, wrap: state.music.repeat === "all" }).catch(showError);
        }
      },
      onError: (message) => {
        setPlaybackError(message);
        updatePlaybackUi();
      },
      onSleepTimerChange: () => updateSleepTimerUi(),
      onSaveProgress: () => document.hidden ? actions.flushProgressKeepalive() : actions.saveProgressSoon(null, { immediate: true }),
      onLyricFollowResume: () => {
        setLyricFollowButtonsVisible(false);
        updateLyricHighlight(true);
      },
      onMediaPlay: () => {
        if (!state.music.current) actions.togglePlayback();
        else player.play();
      },
      onMediaPause: () => {
        const audio = player.getAudio();
        if (!audio.paused) audio.pause();
      },
      onMediaPrev: () => actions.playAdjacent(-1, { autoplay: true }).catch(showError),
      onMediaNext: () => actions.playAdjacent(1, { autoplay: true, wrap: state.music.repeat === "all" }).catch(showError),
      onMediaSeekBackward: (offset) => { player.seekRelative(-offset); void actions.claimProgressOwner(); },
      onMediaSeekForward: (offset) => { player.seekRelative(offset); void actions.claimProgressOwner(); },
      onMediaSeekTo: (time) => {
        player.seek(time);
        updatePlaybackUi();
        updateLyricHighlight(true);
        actions.saveProgressSoon();
        void actions.claimProgressOwner();
      }
    }
  });

  function ensureState() {
    ensureMusicState(state);
    player.ensureAudio();
    if (!progressLifecycleInstalled) {
      window.addEventListener("pagehide", () => actions.flushProgressKeepalive());
      window.addEventListener("pageshow", () => actions.resumeProgress());
      document.addEventListener("visibilitychange", () => { if (!document.hidden) actions.resumeProgress(); });
      progressLifecycleInstalled = true;
    }
    if (!visibilityInstalled) {
      player.installVisibilityHandler();
      visibilityInstalled = true;
    }
    if (!keyboardShortcutsInstalled) {
      installKeyboardShortcuts();
      keyboardShortcutsInstalled = true;
    }
    player.syncSleepTimer();
  }

  // ---- 视图更新接口（交给 actions）----
  const view = {
    refresh: () => renderView(),
    cancelNavigationTimers,
    setMusicListLoadingState,
    setTrackOpeningState,
    refreshQueueSurface,
    refreshCurrentTrackSurfaces,
    refreshLibrarySidebars,
    refreshPlaylistDialog,
    refreshMusicLibraryContent,
    appendLibraryTrackPage,
    appendArtistPage,
    appendAlbumPage,
    restoreMusicPanelScroll,
    clearMusicSuggestions,
    renderStats,
    syncFavoriteFeedback,
    refreshTrackMetadata,
    updatePlaybackUi,
    updatePlaybackModeControls
  };

  const router = {
    push: (route) => pushRoute(route),
    replace: (route) => replaceRoute(route),
    overrides: () => actions.musicRouteOverrides(),
    openAdminScript: (scriptId) => openAdminScript(scriptId)
  };

  function showError(error) {
    const ratingFailure = actions.getRatingFailure();
    if (ratingFailure && ratingFailure.error === error) {
      state.music.status = ratingFailure.message;
      const listFailure = actions.getListReadFailure();
      if (ratingFailure.saved && !state.music.playlistDialogOpen
          && listFailure?.message === ratingFailure.message && refreshMusicLibraryContent()) return;
      setMusicListLoadingState(Boolean(state.music.loading || state.music.loadingMore), { append: state.music.loadingMore });
      syncFavoriteFeedback();
      return;
    }
    const favoriteFailure = actions.getFavoriteFailure();
    if (favoriteFailure && favoriteFailure.error === error) {
      state.music.status = favoriteFailure.message;
      const listFailure = actions.getListReadFailure();
      if (favoriteFailure.saved && !state.music.playlistDialogOpen
          && listFailure?.message === favoriteFailure.message && refreshMusicLibraryContent()) return;
      setMusicListLoadingState(Boolean(state.music.loading || state.music.loadingMore), { append: state.music.loadingMore });
      syncFavoriteFeedback();
      return;
    }
    state.music.loading = false;
    state.music.status = error?.message || "音乐库读取失败";
    const listFailure = actions.getListReadFailure();
    if (!state.music.playlistDialogOpen && listFailure?.message === state.music.status && refreshMusicLibraryContent()) return;
    renderView();
  }

  function syncFavoriteFeedback() {
    const shell = els.workGrid?.querySelector?.(".music-shell");
    if (!shell) { clearFavoriteFeedbackPosition(); return; }
    const listFailure = actions.getListReadFailure();
    const recovery = shell.querySelector(".music-list-read-error");
    const banners = [];
    for (const [kind, failure] of [["favorite", actions.getFavoriteFailure()], ["rating", actions.getRatingFailure()]]) {
      const covered = failure?.saved && listFailure?.message === failure.message && recovery?.textContent.includes(failure.message);
      let banner = shell.querySelector(`:scope > .music-${kind}-feedback`);
      if (!failure || covered) { banner?.remove(); continue; }
      const message = kind === "favorite"
        ? `${failure.saved ? "收藏已保存，列表刷新失败" : "收藏保存失败"}：${failure.message}`
        : failure.saved ? `评分已保存，列表刷新失败：${failure.message}` : failure.message;
      if (!banner) {
        banner = document.createElement("div");
        banner.className = `music-${kind}-feedback`;
        banner.tabIndex = 0;
        banner.setAttribute("role", "alert");
        banner.setAttribute("aria-atomic", "true");
        shell.append(banner);
      }
      if (banner.textContent !== message) banner.textContent = message;
      banners.push(banner);
    }
    if (!banners.length) { clearFavoriteFeedbackPosition(); return; }
    if (favoriteFeedbackPosition?.shell !== shell || banners.length !== favoriteFeedbackPosition?.banners.length
        || banners.some((banner, index) => banner !== favoriteFeedbackPosition.banners[index])) {
      clearFavoriteFeedbackPosition();
      const position = { banners, shell, player: null, observer: null };
      favoriteFeedbackPosition = position;
      if (typeof ResizeObserver === "function") position.observer = new ResizeObserver(() => updateFavoriteFeedbackPosition(position));
      for (const banner of banners) position.observer?.observe(banner);
    }
    updateFavoriteFeedbackPosition(favoriteFeedbackPosition);
  }

  function clearFavoriteFeedbackPosition() {
    favoriteFeedbackPosition?.observer?.disconnect();
    favoriteFeedbackPosition = null;
  }

  function updateFavoriteFeedbackPosition(position) {
    if (favoriteFeedbackPosition !== position) return;
    const { banners, shell } = position;
    if (banners.some(banner => !banner.isConnected) || shell !== els.workGrid?.querySelector?.(".music-shell")
        || (!actions.getFavoriteFailure() && !actions.getRatingFailure())) {
      clearFavoriteFeedbackPosition();
      return;
    }
    const stage = shell.querySelector(".music-stage-player");
    const player = stage || shell.querySelector(".music-player-bar");
    if (position.player !== player) {
      position.observer?.disconnect();
      position.player = player;
      for (const banner of banners) position.observer?.observe(banner);
      if (player) position.observer?.observe(player);
    }
    // Observe the mobile static bar too: a responsive transition can make the
    // same element fixed without changing the alert's owner or DOM identity.
    const anchored = player?.isConnected && (stage || getComputedStyle(player).position === "fixed");
    const property = "--music-favorite-feedback-bottom";
    let bottom = anchored ? Math.max(12, Math.ceil(window.innerHeight - player.getBoundingClientRect().top + 12)) : null;
    for (const banner of banners) {
      if (bottom === null) {
        if (banner.style.getPropertyValue(property)) banner.style.removeProperty(property);
        const measured = Number.parseFloat(getComputedStyle(banner).bottom);
        bottom = Number.isFinite(measured) ? measured : 12;
      } else {
        const value = `${bottom}px`;
        if (banner.style.getPropertyValue(property) !== value) banner.style.setProperty(property, value);
      }
      bottom += Math.ceil(banner.getBoundingClientRect().height) + 8;
    }
  }

  const actions = createMusicActions({ state, api: musicApi, player, view, router, showError });

  // 共享渲染原语 + 视图
  const h = createComponents({
    music: state.music,
    actions,
    formatNumber,
    showError,
    registerMusicTrackElement,
    registerCurrentTrackIndicator,
    registerPlaybackButton
  });
  const home = createMusicHome({ music: state.music, actions, h, formatNumber, showError });

  // ================= 路由 / 入口 =================
  function enter(options = {}) {
    ensureState();
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    setMainHeader("音乐", "本地无损音乐库");
    setMusicBodyClass();
    renderStats();
    if (options.deferInitialLoad) {
      renderView();
      return;
    }
    if (!state.music.data || options.reload) {
      loadMusic({ skipRoute: true, keepCurrent: true, restoreLast: !state.music.current }).catch(showError);
    } else {
      renderView();
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    resetReader();
    trackReturnContext = readTrackReturnHistory(route) || (route.musicTrackId ? { fresh: true } : null);
    if (trackReturnContext?.route) route = { ...route, ...trackReturnContext.route, musicTrackId: route.musicTrackId };
    state.music.libraryDrawerOpen = false;
    state.music.playlistDialogOpen = false;
    state.music.playlistDialogTrackId = "";
    state.music.playlistDialogName = "";
    state.music.trackPageOpen = Boolean(route.musicTrackId);
    state.music.playerStageOpen = false;
    state.music.mode = route.musicMode || "home";
    state.music.query = route.musicQuery || "";
    state.music.artistId = route.musicArtistId || "all";
    state.music.albumId = route.musicAlbumId || "all";
    state.music.genre = route.musicGenre || "all";
    state.music.language = route.musicLanguage || "all";
    state.music.activePlaylistId = route.musicPlaylistId || "";
    state.music.activeSmartPlaylistId = route.musicSmartId || "";
    state.music.sort = route.musicSort || "album";
    state.music.artistSort = route.musicArtistSort === "name" ? "name" : "count";
    state.music.albumSort = ["updated", "title", "year", "tracks"].includes(route.musicAlbumSort) ? route.musicAlbumSort : "updated";
    state.music.favorite = Boolean(route.musicFavorite);
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    const navigation = resetReader();
    if (route.musicTrackId) {
      const track = await actions.openTrack(route.musicTrackId, { skipRoute: true, autoplay: false, openPage: true });
      if (!track || !actions.isNavigationCurrent(navigation) || state.music.openingTrackId || track.id !== state.music.current?.id) return;
      if (!state.music.data) actions.loadMusic({ skipRoute: true, background: true, keepCurrent: true, restoreLast: false }).catch(showError);
      return;
    }
    await actions.loadMusic({ skipRoute: true, keepCurrent: true, restoreLast: !state.music.current });
  }

  function cancelNavigationTimers() {
    window.clearTimeout(searchTimer);
    searchTimer = null;
    clearMusicSuggestions();
  }

  function resetReader() {
    ensureMusicState(state);
    cancelNavigationTimers();
    return actions.beginNavigation();
  }

  function loadMusic(options = {}) {
    if (!options.append && !options.background) resetReader();
    return actions.loadMusic(options);
  }

  // ================= 渲染骨架 =================
  function setMusicBodyClass() {
    document.body.classList.toggle("music-view", state.activeView === "music");
    document.body.classList.toggle("music-library-open", state.activeView === "music" && Boolean(state.music?.libraryDrawerOpen));
    document.body.classList.toggle("music-stage-open", state.activeView === "music" && Boolean(state.music?.trackPageOpen || state.music?.playerStageOpen));
  }

  function renderStats() {
    ensureState();
    if (!els.statsRow) return;
    const totals = state.music.summary?.totals || state.music.data?.summary?.totals || {};
    const items = [
      ["歌曲", formatNumber(totals.tracks || 0)],
      ["歌手", formatNumber(totals.artists || 0)],
      ["专辑", formatNumber(totals.albums || 0)],
      ["听过", formatNumber(totals.listenedTracks || 0)],
      ["播放", formatNumber(totals.plays || 0)],
      ["容量", formatBytes(totals.bytes || 0)]
    ];
    const renderKey = JSON.stringify(items);
    const mountedStats = [...els.statsRow.children];
    if (els.statsRow.dataset.musicStatsKey === renderKey
      && mountedStats.length === items.length
      && mountedStats.every((item) => item.classList.contains("music-stat"))) return;
    els.statsRow.dataset.musicStatsKey = renderKey;
    els.statsRow.innerHTML = "";
    for (const [label, value] of items) {
      const stat = document.createElement("div");
      stat.className = "music-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(strong, span);
      els.statsRow.append(stat);
    }
  }

  function renderView() {
    ensureState();
    if (!els.workGrid) return;
    const liveQueue = els.workGrid.querySelector(".music-queue");
    const queueView = queueViews.get(liveQueue);
    if (queueViewCurrent(queueView) && (queueView.model.raw || queueView.composing || queueView.form.contains(document.activeElement))
        && refreshMusicLibraryContent()) {
      setMusicBodyClass();
      refreshCurrentTrackSurfaces();
      if (Boolean(els.workGrid.querySelector(".music-playlist-dialog-backdrop")) !== Boolean(state.music.playlistDialogOpen)) refreshPlaylistDialog();
      if (Boolean(els.workGrid.querySelector(".music-library-layer")) !== Boolean(state.music.libraryDrawerOpen)) refreshLibraryDrawer();
      updatePlaybackUi();
      syncFavoriteFeedback();
      return;
    }
    const inputFocus = captureMusicInputFocus();
    const playlistFocus = capturePlaylistDialogFocus();
    setMusicBodyClass();
    currentProgressEls = null;
    playbackButtonEls = [];
    currentTrackIndicatorMap = new Map();
    musicTrackElementMap = new Map();
    openingTrackElementId = "";
    playbackSurfaceEls = [];
    playbackErrorEls = [];
    shuffleControlEls = [];
    repeatControlEls = [];
    sleepTimerControlEls = [];
    lyricLineEls = [];
    lyricViewport = null;
    if (!state.music.trackPageOpen) lyricFinderState = null;
    lyricFollowButtonEls = [];
    activeLyricElement = null;
    suggestionBox = null;
    currentLyricIndex = -1;
    if (lyricRaf) window.cancelAnimationFrame(lyricRaf);
    lyricRaf = 0;
    player.stopVisualizer();
    clearFavoriteFeedbackPosition();
    els.workGrid.innerHTML = "";

    const shell = document.createElement("section");
    const trackPageOpen = Boolean(state.music.trackPageOpen && state.music.current);
    shell.className = `music-shell${trackPageOpen ? " music-track-page" : " music-library-page"}`;
    if (trackPageOpen) shell.append(renderPlayerStage(), renderPlaylistDialog());
    else shell.append(renderLibraryLayout(), renderPlayerBar(), renderPlaylistDialog());
    els.workGrid.append(shell);
    setTrackOpeningState(state.music.openingTrackId);
    setMusicListLoadingState(Boolean(state.music.loading || state.music.loadingMore), { append: state.music.loadingMore });
    restoreMusicInputFocus(shell, inputFocus);
    restorePlaylistDialogFocus(shell.querySelector(".music-playlist-dialog-backdrop"), playlistFocus);
    updatePlaybackUi();
    updateLyricHighlight(!state.music.lyricFollowPaused);
    player.startVisualizer();
    syncFavoriteFeedback();
  }

  function refreshMusicLibraryContent() {
    const shell = els.workGrid?.querySelector?.(".music-shell.music-library-page");
    const currentPanel = shell?.querySelector?.(".music-track-panel");
    if (!shell || !currentPanel || state.music.trackPageOpen) return false;
    const mountedTrackId = shell.querySelector(".music-now-panel")?.dataset.musicTrackId || "";
    const inputFocus = captureMusicInputFocus();
    unregisterMusicTrackElements(currentPanel);
    currentTrackIndicatorMap = new Map();
    suggestionBox = null;
    const nextPanel = renderTrackPanel();
    const retained = retainMusicSortControls(currentPanel, nextPanel);
    if (!retained) currentPanel.replaceWith(nextPanel);
    refreshLibrarySidebars();
    setTrackOpeningState(state.music.openingTrackId);
    setMusicListLoadingState(Boolean(state.music.loading || state.music.loadingMore), { append: state.music.loadingMore });
    restoreMusicInputFocus(retained ? currentPanel : nextPanel, inputFocus);
    const surfacedTrackId = state.music.current?.id || state.music.queue[0]?.id || "";
    const emptyNowPanel = !surfacedTrackId && shell.querySelector(".music-now-empty");
    if (emptyNowPanel) emptyNowPanel.textContent = state.music.status || "选择一首歌开始播放。";
    if (mountedTrackId !== surfacedTrackId && !refreshCurrentTrackSurfaces(mountedTrackId)) return false;
    syncFavoriteFeedback();
    return true;
  }

  function retainMusicSortControls(currentPanel, nextPanel) {
    const mode = nextPanel.dataset.musicListMode;
    if (!["library", "artists", "albums"].includes(mode) || currentPanel.dataset.musicListMode !== mode
        || currentPanel.dataset.musicListQuery !== nextPanel.dataset.musicListQuery) return false;
    const selector = mode === "library" ? ".music-controls" : ".music-artist-browser-controls";
    const controls = currentPanel.querySelector(selector), nextControls = nextPanel.querySelector(selector);
    const sort = controls?.querySelector("select"), nextSort = nextControls?.querySelector("select");
    if (!sort || !nextSort || sort.options.length !== nextSort.options.length
        || [...sort.options].some((option, index) => option.value !== nextSort.options[index].value)) return false;
    for (let index = 0; index < sort.options.length; index++) {
      if (sort.options[index].textContent !== nextSort.options[index].textContent) sort.options[index].textContent = nextSort.options[index].textContent;
    }
    sort.value = nextSort.value;
    sort.disabled = nextSort.disabled;
    // Keep the select and both ancestors mounted: moving an active native
    // select into a replacement panel dismisses it and blurs keyboard focus.
    for (const child of [...controls.children]) if (child !== sort) child.remove();
    for (const child of [...nextControls.children]) if (child !== nextSort) controls.insertBefore(child, sort);
    for (const child of [...currentPanel.children]) if (child !== controls) child.remove();
    let afterControls = false;
    for (const child of [...nextPanel.children]) {
      if (child === nextControls) afterControls = true;
      else if (afterControls) currentPanel.append(child);
      else currentPanel.insertBefore(child, controls);
    }
    return true;
  }

  function captureMusicInputFocus() {
    const input = document.activeElement;
    const pending = isListOwnerCurrent(pendingListAppend?.owner) ? pendingListAppend : null;
    if (pending?.newerIntent) {
      const panel = els.workGrid?.querySelector(".music-track-panel");
      if (panel) appendViewportRestore = { owner: pending.owner, data: state.music.data, top: panel.scrollTop, windowY: window.scrollY };
    }
    const more = listMoreRecords.get(input);
    if (more && isListOwnerCurrent(more.owner)) {
      if (pending?.newerIntent) return { more: more.owner, keepViewport: true };
      const items = musicListItems(input.closest(".music-track-panel"));
      const records = items.map(item => listResultRecords.get(item)).filter(Boolean);
      return { more: more.owner, ids: new Set(records.flatMap(item => [item.id, ...(item.duplicateIds || [])]).filter(Boolean).map(String)), results: new Set(records) };
    }
    const alphabet = input?.closest?.(".music-alpha-index");
    if (alphabet && input.matches(".music-alpha-index-item")) return { letter: input.dataset.musicLetter || "", mode: alphabet.dataset.musicAlphaMode };
    const key = String(input?.dataset?.musicSearch || "");
    if (!key) {
      const box = input?.closest?.(".music-search-suggestions");
      if (!box || box.hidden || !input.matches(".music-search-suggest-item")) return null;
      return { key: "library", suggestion: [...box.querySelectorAll(".music-search-suggest-item")].indexOf(input), suggestionKey: input.dataset.musicSuggestionKey || "", query: state.music.query };
    }
    return {
      key,
      start: Number.isFinite(input.selectionStart) ? input.selectionStart : String(input.value || "").length,
      end: Number.isFinite(input.selectionEnd) ? input.selectionEnd : String(input.value || "").length
    };
  }

  function restoreMusicInputFocus(shell, focus) {
    const viewport = appendViewportRestore;
    appendViewportRestore = null;
    if (viewport && viewport.data === state.music.data && isListOwnerCurrent(viewport.owner)) {
      const panel = shell.matches(".music-track-panel") ? shell : shell.querySelector(".music-track-panel") || shell.closest(".music-track-panel");
      if (panel) { panel.scrollTop = viewport.top; window.scrollTo({ top: viewport.windowY, behavior: "instant" }); markAppendPosition(panel); }
    }
    if (focus?.more) {
      if (!isListOwnerCurrent(focus.more)) return;
      const panel = shell.matches(".music-track-panel") ? shell : shell.querySelector(".music-track-panel") || shell.closest(".music-track-panel");
      if (!panel) return;
      const items = musicListItems(panel);
      let target = !focus.keepViewport && items.find(item => {
        const result = listResultRecords.get(item);
        return result && !focus.results.has(result) && ![result.id, ...(result.duplicateIds || [])].some(id => id && focus.ids.has(String(id)));
      }) || panel.querySelector(".music-load-more");
      if (!target) {
        target = document.createElement("p");
        target.className = "music-list-complete";
        target.textContent = "已到列表末尾";
        target.tabIndex = -1;
        target.setAttribute("role", "status");
        target.addEventListener("keydown", event => { if (event.key !== "Escape") event.stopPropagation(); });
        (panel.querySelector(".music-track-table, .music-artist-browser-grid, .music-album-browser-grid") || panel).append(target);
      }
      target.focus({ preventScroll: true });
      if (!focus.keepViewport) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      markAppendPosition(panel);
      return;
    }
    if (focus?.letter !== undefined) {
      if (focus.mode === state.music.mode) [...shell.querySelectorAll(".music-alpha-index-item")].find(button => button.dataset.musicLetter === focus.letter)?.focus({ preventScroll: true });
      return;
    }
    if (!focus?.key) return;
    if (Number.isInteger(focus.suggestion)) {
      const box = shell.querySelector(".music-search-suggestions");
      if (focus.query === state.music.query && box && !box.hidden) {
        const buttons = [...box.querySelectorAll(".music-search-suggest-item")];
        const button = focus.suggestionKey ? buttons.find(item => item.dataset.musicSuggestionKey === focus.suggestionKey) : buttons[focus.suggestion];
        (button || shell.querySelector('[data-music-search="library"]'))?.focus({ preventScroll: true });
      }
      return;
    }
    const input = shell.querySelector(`[data-music-search="${focus.key}"]`);
    if (!input) return;
    input.focus({ preventScroll: true });
    const length = String(input.value || "").length;
    input.setSelectionRange(Math.min(length, focus.start), Math.min(length, focus.end));
  }

  function renderLibraryLayout() {
    const layout = document.createElement("section");
    layout.className = "music-layout";
    layout.append(renderLibraryLauncher(), renderSidebar({ embedded: true }), renderTrackPanel(), renderNowPanel());
    if (state.music.libraryDrawerOpen) layout.append(renderLibraryDrawer());
    return layout;
  }

  function renderLibraryLauncher() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-library-launcher";
    button.setAttribute("aria-controls", "music-library-drawer");
    button.setAttribute("aria-expanded", String(Boolean(state.music.libraryDrawerOpen)));
    button.setAttribute("aria-label", "打开音乐资料库");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "☰";
    const label = document.createElement("strong");
    label.textContent = "资料库";
    button.append(icon, label);
    button.addEventListener("click", openLibraryDrawer);
    return button;
  }

  function renderLibraryDrawer() {
    const layer = document.createElement("div");
    layer.className = "music-library-layer";
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-library-backdrop";
    backdrop.setAttribute("aria-label", "关闭音乐资料库");
    backdrop.addEventListener("click", closeLibraryDrawer);
    layer.append(backdrop, renderSidebar());
    return layer;
  }

  function openLibraryDrawer() {
    state.music.libraryDrawerOpen = true;
    if (!refreshLibraryDrawer({ focus: true })) renderView();
  }

  function closeLibraryDrawer() {
    state.music.libraryDrawerOpen = false;
    if (!refreshLibraryDrawer({ focus: true })) renderView();
  }

  function closeLibraryDrawerBefore(action) {
    state.music.libraryDrawerOpen = false;
    refreshLibraryDrawer({ focus: true });
    action();
  }

  function refreshLibraryDrawer({ focus = false } = {}) {
    const layout = els.workGrid?.querySelector?.(".music-layout");
    if (!layout) return false;
    layout.querySelector(".music-library-layer")?.remove();
    const launcher = layout.querySelector(".music-library-launcher");
    launcher?.setAttribute("aria-expanded", String(Boolean(state.music.libraryDrawerOpen)));
    if (state.music.libraryDrawerOpen) layout.append(renderLibraryDrawer());
    if (focus) {
      const target = state.music.libraryDrawerOpen
        ? layout.querySelector(".music-sidebar-close")
        : launcher;
      target?.focus({ preventScroll: true });
    }
    return true;
  }

  function renderSidebar({ embedded = false } = {}) {
    const side = document.createElement("aside");
    side.className = `music-sidebar${embedded ? " embedded" : ""}`;
    side.dataset.musicSidebarKey = musicSidebarRenderKey();
    if (!embedded) side.id = "music-library-drawer";
    side.setAttribute("aria-label", "音乐资料库");
    const navigationAction = action => () => {
      if (!side.isConnected || state.activeView !== "music") return;
      if (embedded) action();
      else closeLibraryDrawerBefore(action);
    };
    const filterButton = (id, label, count, active, action) => h.filterButton(id, label, count, active, navigationAction(action));
    const browseButton = (label, meta, action) => h.sidebarBrowseButton(label, meta, navigationAction(action));
    const drawerHeader = document.createElement("div");
    drawerHeader.className = "music-sidebar-header";
    const drawerTitle = document.createElement("strong");
    drawerTitle.textContent = "资料库";
    const drawerActions = document.createElement("div");
    drawerActions.className = "music-sidebar-head-actions";
    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "music-sidebar-scan";
    scan.textContent = state.music.rescanning ? "刷新中" : "刷新";
    scan.disabled = Boolean(state.music.rescanning);
    scan.addEventListener("click", () => actions.startMusicRescan().catch(showError));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "music-sidebar-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭音乐资料库");
    close.addEventListener("click", closeLibraryDrawer);
    drawerActions.append(scan);
    if (!embedded) drawerActions.append(close);
    drawerHeader.append(drawerTitle, drawerActions);
    const libraryList = document.createElement("div");
    libraryList.className = "music-artist-list";
    libraryList.append(filterButton("home", "发现", "", state.music.mode === "home", () => actions.selectMusicMode("home")));
    libraryList.append(filterButton("library", "全部歌曲", state.music.summary?.totals?.tracks || state.music.data?.total || 0, state.music.mode === "library" && !state.music.favorite, () => actions.selectMusicMode("library")));
    libraryList.append(filterButton("artists", "歌手浏览", state.music.summary?.totals?.artists || 0, state.music.mode === "artists", () => actions.selectMusicMode("artists")));
    libraryList.append(filterButton("albums", "专辑浏览", state.music.summary?.totals?.albums || 0, state.music.mode === "albums", () => actions.selectMusicMode("albums")));
    libraryList.append(filterButton("history", "最近播放", state.music.summary?.recent?.length || 0, state.music.mode === "history", () => actions.selectMusicMode("history")));
    libraryList.append(filterButton("report", "听歌报告", state.music.summary?.totals?.plays || 0, state.music.mode === "report", () => actions.selectMusicMode("report")));
    libraryList.append(filterButton("favorites", "我喜欢", "", state.music.mode === "library" && state.music.favorite, () => actions.selectMusicMode("library", { favorite: true })));

    const smartList = document.createElement("div");
    smartList.className = "music-playlist-list";
    for (const smart of state.music.smartPlaylists || []) {
      smartList.append(filterButton(smart.id, smart.name, smart.trackCount, state.music.mode === "smart" && state.music.activeSmartPlaylistId === smart.id, () => actions.selectMusicMode("smart", { smartId: smart.id })));
    }
    if (!(state.music.smartPlaylists || []).length) {
      const empty = document.createElement("div");
      empty.className = "music-sidebar-empty";
      empty.textContent = "刷新后自动生成";
      smartList.append(empty);
    }

    const playlists = document.createElement("div");
    playlists.className = "music-playlist-list";
    for (const playlist of state.music.playlists || []) {
      playlists.append(filterButton(playlist.id, playlist.name, playlist.trackCount, state.music.mode === "playlist" && state.music.activePlaylistId === playlist.id, () => actions.selectMusicMode("playlist", { playlistId: playlist.id })));
    }
    const createPlaylistButton = document.createElement("button");
    createPlaylistButton.type = "button";
    createPlaylistButton.className = "music-create-playlist";
    createPlaylistButton.textContent = "新建歌单";
    createPlaylistButton.addEventListener("click", () => actions.openPlaylistDialog().catch(showError));
    playlists.append(createPlaylistButton);
    const importPlaylistButton = document.createElement("button");
    importPlaylistButton.type = "button";
    importPlaylistButton.className = "music-create-playlist";
    importPlaylistButton.textContent = "导入 M3U";
    importPlaylistButton.addEventListener("click", () => actions.importPlaylistM3uFromPrompt().catch(showError));
    playlists.append(importPlaylistButton);

    const languageList = document.createElement("div");
    languageList.className = "music-artist-list music-language-list";
    languageList.append(filterButton("all", "全部", state.music.summary?.totals?.tracks || "", state.music.language === "all", () => {
      state.music.language = "all";
      state.music.artistId = "all";
      state.music.albumId = "all";
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    }));
    for (const language of state.music.languages || []) {
      languageList.append(filterButton(language.id || language.name, language.name, language.trackCount, state.music.language === language.name, () => {
        if (!["artists", "albums"].includes(state.music.mode)) state.music.mode = "library";
        state.music.language = language.name || "all";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      }));
    }

    const genreList = document.createElement("div");
    genreList.className = "music-artist-list";
    for (const genre of (state.music.genres || []).slice(0, 24)) {
      genreList.append(filterButton(genre.id || genre.name, genre.name, genre.trackCount, state.music.mode === "library" && state.music.genre === genre.name, () => actions.selectGenre(genre.name)));
    }

    const artistList = document.createElement("div");
    artistList.className = "music-artist-list";
    for (const artist of (state.music.artists || []).slice(0, 8)) {
      artistList.append(filterButton(artist.id, artist.name, artist.trackCount, state.music.mode === "library" && state.music.artistId === artist.id, () => {
        state.music.mode = "library";
        state.music.query = "";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = artist.id;
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true }).catch(showError);
      }));
    }
    artistList.append(browseButton("查看全部歌手", `${formatNumber(state.music.summary?.totals?.artists || 0)} 位`, () => actions.selectMusicMode("artists")));

    const albums = document.createElement("div");
    albums.className = "music-album-mini-list";
    for (const album of (state.music.albums || []).slice(0, 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `music-album-mini${state.music.mode === "library" && state.music.albumId === album.id ? " active" : ""}`;
      button.append(h.renderCover(album, "tiny"));
      const span = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title;
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`;
      span.append(strong, small);
      button.append(span);
      button.addEventListener("click", navigationAction(() => {
        state.music.libraryDrawerOpen = false;
        state.music.mode = "library";
        state.music.query = "";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = album.artistId || state.music.artistId || "all";
        state.music.albumId = album.id;
        state.music.genre = "all";
        loadMusic({ replaceRoute: true }).catch(showError);
      }));
      albums.append(button);
    }
    albums.append(browseButton("查看全部专辑", `${formatNumber(state.music.summary?.totals?.albums || 0)} 张`, () => actions.selectMusicMode("albums")));

    const smartSection = h.sidebarSection("智能歌单", smartList, { open: state.music.mode === "smart", meta: formatNumber((state.music.smartPlaylists || []).length) });
    const playlistSection = h.sidebarSection("歌单", playlists, { open: state.music.mode === "playlist", meta: formatNumber((state.music.playlists || []).length) });
    const languageSection = h.sidebarSection("语种", languageList, { open: state.music.language !== "all", meta: state.music.language === "all" ? "全部" : state.music.language });
    const genreSection = h.sidebarSection("风格", genreList, { open: state.music.mode === "library" && state.music.genre !== "all", meta: state.music.genre === "all" ? formatNumber((state.music.genres || []).length) : state.music.genre });
    const artistSection = h.sidebarSection("歌手", artistList, { open: state.music.mode === "artists" || (state.music.mode === "library" && state.music.artistId !== "all"), meta: formatNumber(state.music.artists?.length || 0) });
    const albumSection = h.sidebarSection("专辑", albums, { open: state.music.mode === "albums" || (state.music.mode === "library" && state.music.albumId !== "all"), meta: formatNumber(state.music.albums?.length || 0) });
    side.append(drawerHeader, libraryList, smartSection, playlistSection, languageSection, genreSection, artistSection, albumSection);
    return side;
  }

  function musicSidebarRenderKey() {
    const summary = state.music.summary || state.music.data?.summary || {};
    const totals = summary.totals || {};
    const itemKey = (items, limit = items?.length || 0) => (items || [])
      .slice(0, limit)
      .map((item) => [
        item.id || item.name || item.title || "",
        item.name || item.title || "",
        item.artistName || "",
        Number(item.trackCount || 0),
        Number(item.artistCount || 0),
        Number(item.albumCount || 0)
      ].join(":"))
      .join("|");
    return JSON.stringify([
      state.music.mode,
      state.music.favorite,
      state.music.activePlaylistId,
      state.music.activeSmartPlaylistId,
      state.music.language,
      state.music.genre,
      state.music.artistId,
      state.music.albumId,
      state.music.rescanning,
      Number(totals.tracks || state.music.data?.total || 0),
      Number(totals.artists || 0),
      Number(totals.albums || 0),
      Number(totals.plays || 0),
      Number(summary.recent?.length || 0),
      itemKey(state.music.smartPlaylists),
      itemKey(state.music.playlists),
      itemKey(state.music.languages),
      itemKey(state.music.genres, 24),
      itemKey(state.music.artists, 8),
      itemKey(state.music.albums, 6)
    ]);
  }

  // ================= 歌手 / 专辑浏览 =================
  function renderArtistPanel() {
    const failure = actions.getListReadFailure();
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-artist-browser";
    panel.dataset.musicListMode = "artists";
    panel.dataset.musicListQuery = state.music.query || "";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = state.music.language && state.music.language !== "all" ? `${state.music.language}歌手` : "全部歌手";
    const meta = document.createElement("small");
    meta.textContent = failure ? "列表读取失败" : `${formatNumber(state.music.data?.total || 0)} 位 · ${state.music.artistSort === "name" ? "按名称排序" : "按歌曲数排序"}`;
    headingText.append(title, meta);
    heading.append(headingText);
    const controls = document.createElement("div");
    controls.className = "music-artist-browser-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.dataset.musicSearch = "artists";
    search.value = state.music.query || "";
    search.placeholder = "搜索歌手";
    search.setAttribute("aria-label", "搜索歌手");
    bindMusicSearchInput(search, () => {
      resetReader();
      state.music.query = search.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError), MUSIC_CATALOG_SEARCH_DEBOUNCE_MS);
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "歌手排序");
    for (const [value, label] of [["count", "歌曲最多"], ["name", "按名称"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = state.music.artistSort === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => {
      if (!sort.isConnected || state.activeView !== "music" || state.music.mode !== "artists") return;
      state.music.artistSort = sort.value === "name" ? "name" : "count";
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    controls.append(search, sort);
    const alphaIndex = h.renderAlphaIndex(state.music.letter);
    const languages = document.createElement("div");
    languages.className = "music-artist-language-tabs";
    const languageItems = [{ name: "all", label: "全部", artistCount: state.music.summary?.totals?.artists || 0 }, ...(state.music.languages || []).map((item) => ({ ...item, label: item.name }))];
    for (const language of languageItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.music.language === language.name ? "active" : "";
      button.textContent = `${language.label} ${formatNumber(language.artistCount || 0)}`;
      button.addEventListener("click", () => {
        state.music.language = language.name;
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      languages.append(button);
    }
    const grid = document.createElement("div");
    grid.className = "music-artist-browser-grid";
    const artists = state.music.data?.artists || [];
    if (failure) grid.append(renderListReadRecovery(failure));
    else if (state.music.loading && !artists.length) grid.append(h.emptyRow("正在读取歌手资料库"));
    else if (!artists.length) grid.append(h.emptyRow(state.music.status || "没有匹配的歌手"));
    else for (const artist of artists) grid.append(renderArtistCard(artist));
    const more = !failure && renderArtistLoadMore(artists.length);
    if (more) grid.append(more);
    panel.append(heading, controls, alphaIndex, languages, grid);
    return panel;
  }

  function renderAlbumPanel() {
    const failure = actions.getListReadFailure();
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-album-browser";
    panel.dataset.musicListMode = "albums";
    panel.dataset.musicListQuery = state.music.query || "";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = state.music.language && state.music.language !== "all" ? `${state.music.language}专辑` : "全部专辑";
    const meta = document.createElement("small");
    const sortText = { updated: "最近入库", title: "按名称", year: "按年份", tracks: "歌曲最多" }[state.music.albumSort] || "最近入库";
    meta.textContent = failure ? "列表读取失败" : `${formatNumber(state.music.data?.total || 0)} 张 · ${sortText}`;
    headingText.append(title, meta);
    heading.append(headingText);
    const controls = document.createElement("div");
    controls.className = "music-artist-browser-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.dataset.musicSearch = "albums";
    search.value = state.music.query || "";
    search.placeholder = "搜索专辑或歌手";
    search.setAttribute("aria-label", "搜索专辑");
    bindMusicSearchInput(search, () => {
      resetReader();
      state.music.query = search.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError), MUSIC_CATALOG_SEARCH_DEBOUNCE_MS);
    });
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "专辑排序");
    for (const [value, label] of [["updated", "最近入库"], ["title", "按名称"], ["year", "按年份"], ["tracks", "歌曲最多"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = state.music.albumSort === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => {
      if (!sort.isConnected || state.activeView !== "music" || state.music.mode !== "albums") return;
      state.music.albumSort = ["updated", "title", "year", "tracks"].includes(sort.value) ? sort.value : "updated";
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    controls.append(search, sort);
    const alphaIndex = h.renderAlphaIndex(state.music.letter);
    const languages = document.createElement("div");
    languages.className = "music-artist-language-tabs";
    const languageItems = [{ name: "all", label: "全部", albumCount: state.music.summary?.totals?.albums || 0 }, ...(state.music.languages || []).map((item) => ({ ...item, label: item.name }))];
    for (const language of languageItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.music.language === language.name ? "active" : "";
      button.textContent = `${language.label} ${formatNumber(language.albumCount || 0)}`;
      button.addEventListener("click", () => {
        state.music.language = language.name;
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      languages.append(button);
    }
    const grid = document.createElement("div");
    grid.className = "music-album-browser-grid";
    const albums = state.music.data?.albums || [];
    if (failure) grid.append(renderListReadRecovery(failure));
    else if (state.music.loading && !albums.length) grid.append(h.emptyRow("正在读取专辑资料库"));
    else if (!albums.length) grid.append(h.emptyRow(state.music.status || "没有匹配的专辑"));
    else for (const album of albums) grid.append(renderAlbumCard(album));
    const more = !failure && renderAlbumLoadMore(albums.length);
    if (more) grid.append(more);
    panel.append(heading, controls, alphaIndex, languages, grid);
    return panel;
  }

  function renderArtistCard(artist) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-artist-browser-card";
    listResultRecords.set(button, artist);
    const avatar = document.createElement("b");
    avatar.textContent = Array.from(artist.name || "?")[0] || "?";
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = artist.name || "未知歌手";
    const detail = document.createElement("small");
    detail.textContent = `${artist.language || "其他"} · ${formatNumber(artist.trackCount || 0)} 首 · ${formatNumber(artist.albumCount || 0)} 专辑`;
    text.append(name, detail);
    button.append(avatar, text);
    button.addEventListener("click", () => actions.selectMusicMode("library", { artistId: artist.id, language: artist.language || "all" }));
    return button;
  }

  function renderAlbumCard(album) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-album-browser-card";
    listResultRecords.set(button, album);
    button.append(h.renderCover(album, "tiny"));
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = album.title || "未知专辑";
    const detail = document.createElement("small");
    detail.textContent = [album.artistName || "未知歌手", album.year || "", `${formatNumber(album.trackCount || 0)} 首`].filter(Boolean).join(" · ");
    text.append(name, detail);
    button.append(text);
    button.addEventListener("click", () => actions.selectMusicMode("library", { artistId: album.artistId || "all", albumId: album.id, language: album.language || state.music.language || "all" }));
    return button;
  }

  function renderArtistLoadMore(artistCount) {
    if (!state.music.hasMore) return null;
    return renderListLoadMore(`再加载 ${formatNumber(Math.min(80, Math.max(0, Number(state.music.data?.total || 0) - artistCount)))} 位`);
  }

  function appendArtistPage(artists, startIndex) {
    const grid = els.workGrid?.querySelector?.(".music-artist-browser-grid");
    if (!grid) return false;
    const focus = captureMusicInputFocus();
    grid.querySelector(".music-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    for (const artist of artists) fragment.append(renderArtistCard(artist));
    const more = renderArtistLoadMore(startIndex + artists.length);
    if (more) fragment.append(more);
    grid.append(fragment);
    restoreMusicInputFocus(grid.closest(".music-track-panel"), focus?.more ? focus : null);
    return true;
  }

  function renderAlbumLoadMore(albumCount) {
    if (!state.music.hasMore) return null;
    return renderListLoadMore(`再加载 ${formatNumber(Math.min(80, Math.max(0, Number(state.music.data?.total || 0) - albumCount)))} 张`);
  }

  function appendAlbumPage(albums, startIndex) {
    const grid = els.workGrid?.querySelector?.(".music-album-browser-grid");
    if (!grid) return false;
    const focus = captureMusicInputFocus();
    grid.querySelector(".music-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    for (const album of albums) fragment.append(renderAlbumCard(album));
    const more = renderAlbumLoadMore(startIndex + albums.length);
    if (more) fragment.append(more);
    grid.append(fragment);
    restoreMusicInputFocus(grid.closest(".music-track-panel"), focus?.more ? focus : null);
    return true;
  }

  // ================= 曲目列表 =================
  function renderTrackPanel() {
    if (state.music.mode === "home") return home.renderHomePanel();
    if (state.music.mode === "report") return home.renderReportPanel();
    if (state.music.mode === "artists") return renderArtistPanel();
    if (state.music.mode === "albums") return renderAlbumPanel();
    const failure = actions.getListReadFailure();
    const panel = document.createElement("section");
    panel.className = "music-track-panel";
    panel.dataset.musicListMode = state.music.mode;
    panel.dataset.musicListQuery = state.music.query || "";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = actions.currentMusicTitle();
    const headingMeta = document.createElement("small");
    headingMeta.textContent = failure ? "列表读取失败" : actions.currentMusicMeta();
    headingText.append(headingTitle, headingMeta);
    const headingActions = document.createElement("div");
    headingActions.className = "music-panel-actions";
    if (state.music.mode === "history" && (state.music.data?.tracks || []).length) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "music-inline-button";
      clear.textContent = "清空";
      clear.addEventListener("click", () => actions.clearHistory().catch(showError));
      headingActions.append(clear);
    }
    if (state.music.mode === "playlist" && state.music.activePlaylist) {
      const editPlaylist = document.createElement("button");
      editPlaylist.type = "button";
      editPlaylist.className = "music-inline-button";
      editPlaylist.textContent = "编辑";
      editPlaylist.addEventListener("click", () => actions.editActivePlaylist().catch(showError));
      headingActions.append(editPlaylist);
      const exportPlaylist = document.createElement("button");
      exportPlaylist.type = "button";
      exportPlaylist.className = "music-inline-button";
      exportPlaylist.textContent = "导出 M3U";
      exportPlaylist.addEventListener("click", () => actions.downloadPlaylistM3u(state.music.activePlaylist));
      headingActions.append(exportPlaylist);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "music-inline-button danger";
      remove.textContent = "删除歌单";
      remove.addEventListener("click", () => actions.deleteActivePlaylist().catch(showError));
      headingActions.append(remove);
    }
    heading.append(headingText, headingActions);
    const controls = document.createElement("div");
    controls.className = "music-controls";
    const search = document.createElement("div");
    search.className = "music-search";
    const input = document.createElement("input");
    input.type = "search";
    input.dataset.musicSearch = "library";
    input.placeholder = state.music.mode === "library" ? "搜索歌名、歌手、专辑或歌词，找到想听的歌" : "当前列表暂不支持搜索";
    input.setAttribute("aria-label", "搜索音乐");
    input.setAttribute("enterkeyhint", "search");
    input.value = state.music.query || "";
    input.disabled = state.music.mode !== "library";
    const ignoreSearchKey = bindMusicSearchInput(input, () => {
      resetReader();
      state.music.query = input.value.trim();
      queueMusicSuggest(state.music.query);
      window.clearTimeout(searchTimer);
      // This input already began its navigation. Restarting it here would
      // cancel the suggestion read belonging to this very query.
      searchTimer = window.setTimeout(() => actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError), state.music.query ? MUSIC_LIBRARY_SEARCH_DEBOUNCE_MS : MUSIC_LIBRARY_CLEAR_DEBOUNCE_MS);
    });
    input.addEventListener("focus", () => {
      if (suggestionBox) renderMusicSuggestions(suggestionBox);
    });
    input.addEventListener("keydown", (event) => {
      if (ignoreSearchKey(event)) return;
      if (event.key === "Escape") clearMusicSuggestions();
      if (event.key === "Enter" && state.music.mode === "library") {
        event.preventDefault();
        window.clearTimeout(searchTimer);
        clearMusicSuggestions();
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      }
    });
    const suggestions = document.createElement("div");
    suggestions.className = "music-search-suggestions";
    suggestionBox = suggestions;
    renderMusicSuggestions(suggestions);
    search.append(input, suggestions);
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `music-favorite-filter${state.music.favorite ? " active" : ""}`;
    favorite.textContent = "收藏";
    favorite.disabled = state.music.mode !== "library";
    favorite.addEventListener("click", () => {
      state.music.favorite = !state.music.favorite;
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    const sort = document.createElement("select");
    sort.className = "music-sort";
    for (const [value, label] of [
      ["album", state.music.query ? "按匹配度" : "按专辑"],
      ["artist", "按歌手"],
      ["title", "按歌名"],
      ["duration", "按时长"],
      ["played", "最近播放"],
      ["favorite", "收藏优先"],
      ["rating", "按评分"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.append(option);
    }
    sort.value = state.music.sort || "album";
    sort.disabled = state.music.mode !== "library";
    sort.addEventListener("change", () => {
      if (!sort.isConnected || state.activeView !== "music" || state.music.mode !== "library") return;
      state.music.sort = sort.value;
      loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
    });
    controls.append(search, favorite, sort);
    const table = document.createElement("div");
    table.className = "music-track-table";
    table.append(h.trackHeader());
    const tracks = state.music.data?.tracks || [];
    if (failure) table.append(renderListReadRecovery(failure));
    else if (state.music.loading && !tracks.length) table.append(h.emptyRow("正在读取音乐库"));
    else if (!tracks.length) table.append(h.emptyRow(state.music.status || "没有匹配的歌曲。"));
    else tracks.forEach((track, index) => { const row = h.trackRow(track, index); listResultRecords.set(row, track); table.append(row); });
    const more = !failure && renderTrackLoadMore(tracks.length);
    if (more) table.append(more);
    panel.append(heading, controls, table);
    return panel;
  }

  function renderListReadRecovery(failure) {
    const panel = document.createElement("div");
    panel.className = "music-list-read-error";
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = failure.message;
    const hint = document.createElement("span");
    hint.textContent = "当前条件尚未载入成功，重新读取会保留搜索和筛选。";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-control-button music-list-retry";
    button.textContent = "重新读取";
    let busy = false;
    button.addEventListener("click", async () => {
      if (busy || !button.isConnected || actions.getListReadFailure() !== failure) return;
      busy = true;
      const hadFocus = document.activeElement === button;
      const events = new AbortController();
      let newerIntent = false;
      const noteIntent = event => {
        const activation = event.type === "keydown" && !event.ctrlKey && !event.metaKey && !event.altKey && ["Enter", " ", "Spacebar"].includes(event.key);
        if (event.target === button && (activation || event.type === "pointerdown" || event.type === "focusin")) return;
        if (event.type !== "focusin" || event.target !== document.body) newerIntent = true;
      };
      for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: events.signal });
      button.setAttribute("aria-disabled", "true");
      button.textContent = "正在读取…";
      const retry = actions.retryListRead(failure);
      try { if (retry) await retry.pending; }
      catch (error) { if (retry?.isCurrent() && !refreshMusicLibraryContent()) showError(error); }
      finally {
        events.abort();
        busy = false;
        if (button.isConnected && actions.getListReadFailure() === failure) { button.removeAttribute("aria-disabled"); button.textContent = "重新读取"; }
      }
      if (hadFocus && !newerIntent && retry?.isCurrent() && !state.music.trackPageOpen) {
        const target = els.workGrid.querySelector(".music-list-retry") || els.workGrid.querySelector(".music-track-panel .music-panel-heading strong");
        if (target) { if (target.tagName !== "BUTTON") target.tabIndex = -1; target.focus({ preventScroll: true }); }
      }
    });
    panel.append(message, hint, button);
    return panel;
  }

  function renderTrackLoadMore(trackCount) {
    if (!state.music.hasMore) return null;
    return renderListLoadMore(`再加载 ${formatNumber(Math.min(120, Math.max(0, Number(state.music.data?.total || 0) - trackCount)))} 首`);
  }

  function currentListOwner() {
    try {
      const account = captureWebAccount();
      return { key: JSON.stringify([router.overrides(), state.music.letter]), account: account.owner, revision: account.revision };
    } catch { return null; }
  }

  function isListOwnerCurrent(owner) {
    if (!owner || state.activeView !== "music" || state.music.trackPageOpen) return false;
    const current = currentListOwner();
    return current && owner.key === current.key && owner.account === current.account && owner.revision === current.revision;
  }

  function musicListItems(panel) {
    return panel ? [...panel.querySelectorAll(".music-track-row:not(.head), .music-artist-browser-card, .music-album-browser-card")] : [];
  }

  function markAppendPosition(panel) {
    const restored = { panel, data: state.music.data };
    appendFocusRestore = restored;
    queueMicrotask(() => { if (appendFocusRestore === restored) appendFocusRestore = null; });
  }

  function setListMoreBusy(more, busy) {
    more.setAttribute("aria-disabled", String(busy));
    if (busy) more.setAttribute("aria-busy", "true");
    else more.removeAttribute("aria-busy");
    more.textContent = busy ? "正在加载…" : more.dataset.musicIdleLabel;
  }

  function renderListLoadMore(label) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-load-more";
    more.dataset.musicIdleLabel = label;
    const record = { owner: currentListOwner() };
    listMoreRecords.set(more, record);
    setListMoreBusy(more, state.music.loadingMore);
    more.addEventListener("click", async () => {
      if (!more.isConnected || !isListOwnerCurrent(record.owner) || state.music.loadingMore) return;
      more.closest(".music-track-panel")?.querySelector(".music-list-append-error")?.remove();
      const events = new AbortController(), pending = { owner: record.owner, newerIntent: false };
      pendingListAppend = pending;
      const noteIntent = event => {
        const activation = event.type === "keydown" && !event.ctrlKey && !event.metaKey && !event.altKey && ["Enter", " ", "Spacebar"].includes(event.key);
        if (isListOwnerCurrent(listMoreRecords.get(event.target)?.owner) && (activation || event.type === "pointerdown" || event.type === "focusin")) return;
        if (event.type !== "focusin" || event.target !== document.body) pending.newerIntent = true;
      };
      for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: events.signal });
      try { await loadMusic({ append: true, skipRoute: true, keepCurrent: true }); }
      catch (error) {
        if (!more.isConnected || !isListOwnerCurrent(record.owner) || state.music.loading || state.music.loadingMore) return;
        const message = document.createElement("p");
        message.className = "music-list-append-error";
        message.setAttribute("role", "alert");
        message.textContent = error?.message || "加载更多失败，请重试";
        more.before(message);
        more.textContent = "重试加载更多";
        if (document.activeElement === more && !pending.newerIntent) more.scrollIntoView({ block: "nearest", behavior: "instant" });
      } finally { events.abort(); if (pendingListAppend === pending) pendingListAppend = null; }
    });
    return more;
  }

  function appendLibraryTrackPage(tracks, startIndex) {
    const table = els.workGrid?.querySelector?.(".music-track-panel .music-track-table");
    if (!table) return false;
    const focus = captureMusicInputFocus();
    table.querySelector(".music-load-more")?.remove();
    const fragment = document.createDocumentFragment();
    tracks.forEach((track, index) => { const row = h.trackRow(track, startIndex + index); listResultRecords.set(row, track); fragment.append(row); });
    const more = renderTrackLoadMore(startIndex + tracks.length);
    if (more) fragment.append(more);
    table.append(fragment);
    restoreMusicInputFocus(table.closest(".music-track-panel"), focus?.more ? focus : null);
    return true;
  }

  function restoreMusicPanelScroll(scrollTop) {
    const panel = els.workGrid?.querySelector(".music-track-panel"), owner = currentListOwner();
    if (appendFocusRestore?.panel === panel && appendFocusRestore.data === state.music.data) return;
    const events = new AbortController();
    let newerIntent = false;
    const noteIntent = () => { newerIntent = true; };
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: events.signal });
    // Layout/content anchoring also emits scroll after a panel refresh. Actual
    // keyboard, wheel, touch and scrollbar-pointer intent is captured above.
    window.requestAnimationFrame(() => {
      events.abort();
      if (!newerIntent && panel?.isConnected && panel === els.workGrid?.querySelector(".music-track-panel") && isListOwnerCurrent(owner)
          && !state.music.loading && !state.music.loadingMore) panel.scrollTop = Math.max(0, Number(scrollTop || 0));
    });
  }

  function setMusicListLoadingState(loading, { append = false } = {}) {
    syncFavoriteFeedback();
    const panel = els.workGrid?.querySelector?.(".music-track-panel");
    if (!panel) return;
    panel.classList.toggle("list-loading", loading);
    if (loading) panel.setAttribute("aria-busy", "true");
    else panel.removeAttribute("aria-busy");
    let badge = panel.querySelector(".music-list-loading-badge");
    if (loading) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "music-list-loading-badge";
        badge.setAttribute("role", "status");
        badge.setAttribute("aria-live", "polite");
        (panel.querySelector(".music-panel-heading") || panel).append(badge);
      }
      badge.textContent = append ? "正在加载更多" : "正在更新";
    } else {
      badge?.remove();
    }
    const more = panel.querySelector(".music-load-more");
    if (more && more.dataset.musicIdleLabel !== undefined) setListMoreBusy(more, loading && append);
  }

  function setTrackOpeningState(trackId = "") {
    const shell = els.workGrid?.querySelector?.(".music-shell");
    const opening = Boolean(trackId);
    const affectedTrackIds = new Set([openingTrackElementId, trackId].filter(Boolean));
    openingTrackElementId = trackId;
    if (!shell) return;
    shell.classList.toggle("track-loading", opening);
    if (opening) shell.setAttribute("aria-busy", "true");
    else shell.removeAttribute("aria-busy");
    for (const affectedTrackId of affectedTrackIds) {
      const elements = (musicTrackElementMap.get(affectedTrackId) || []).filter((item) => item?.isConnected);
      if (elements.length) musicTrackElementMap.set(affectedTrackId, elements);
      else musicTrackElementMap.delete(affectedTrackId);
      for (const item of elements) {
        const active = opening && affectedTrackId === trackId;
        item.classList.toggle("opening", active);
        if (active) item.setAttribute("aria-busy", "true");
        else item.removeAttribute("aria-busy");
      }
    }
  }

  // ================= 搜索联想 =================
  function bindMusicSearchInput(input, acceptInput) {
    let composing = false;
    const current = () => input.isConnected && state.activeView === "music"
      && state.music.mode === input.dataset.musicSearch;
    const compositionKey = (event) => composing || event.isComposing || event.keyCode === 229;
    input.addEventListener("compositionstart", () => {
      if (!current()) return;
      composing = true;
      // Cancel both debounce work and reads that could replace the input while
      // the IME still owns its uncommitted text and candidate selection.
      resetReader();
    });
    input.addEventListener("compositionend", () => {
      composing = false;
      if (current()) acceptInput();
    });
    input.addEventListener("input", (event) => {
      if (!current() || composing || event.isComposing) return;
      acceptInput();
    });
    input.addEventListener("keydown", (event) => {
      // Keep candidate keys away from page-level Escape/navigation shortcuts;
      // their native IME behavior must remain available.
      if (compositionKey(event)) event.stopPropagation();
    });
    // Some browsers end composition before delivering the confirmation key.
    // keyCode 229 still marks that key as belonging to the input method.
    return (event) => !current() || compositionKey(event);
  }

  function clearMusicSuggestions() {
    window.clearTimeout(suggestTimer);
    suggestController?.abort();
    suggestController = null;
    state.music.suggestionQuery = "";
    state.music.suggestions = { query: "", tracks: [], artists: [], albums: [] };
    if (suggestionBox) renderMusicSuggestions(suggestionBox);
  }

  function queueMusicSuggest(query) {
    window.clearTimeout(suggestTimer);
    suggestController?.abort();
    suggestController = null;
    const normalized = String(query || "").trim();
    state.music.suggestionQuery = normalized;
    if (state.music.mode !== "library" || Array.from(normalized).length < MUSIC_SUGGEST_MIN_CHARACTERS) {
      clearMusicSuggestions();
      return;
    }
    const cached = suggestionCache.get(suggestionCacheKey(normalized));
    if (cached) {
      state.music.suggestions = { ...cached, query: normalized };
      if (suggestionBox) renderMusicSuggestions(suggestionBox);
      return;
    }
    suggestTimer = window.setTimeout(() => loadMusicSuggestions(normalized).catch(() => {}), 160);
  }

  async function loadMusicSuggestions(query) {
    const normalized = String(query || "").trim();
    if (!normalized) return;
    const key = suggestionCacheKey(normalized);
    const cached = suggestionCache.get(key);
    if (cached) {
      if (state.music.mode === "library" && state.music.query === normalized) {
        state.music.suggestions = { ...cached, query: normalized };
        if (suggestionBox) renderMusicSuggestions(suggestionBox);
      }
      return;
    }
    suggestController?.abort();
    const controller = new AbortController();
    suggestController = controller;
    let data;
    try {
      data = await musicApi.suggest(normalized, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (suggestController === controller) suggestController = null;
    }
    if (controller.signal.aborted) return;
    const suggestions = data
      ? { ...data, query: normalized, tracks: collapseDuplicateTracksSafe(data.tracks || []) }
      : { query: normalized, tracks: [], artists: [], albums: [] };
    rememberSuggestionCache(key, suggestions);
    if (state.music.mode !== "library" || state.music.query !== normalized) return;
    state.music.suggestions = suggestions;
    if (suggestionBox) renderMusicSuggestions(suggestionBox);
  }

  function suggestionCacheKey(query) {
    return String(query || "").trim().toLocaleLowerCase();
  }

  function rememberSuggestionCache(key, suggestions) {
    if (!key) return;
    suggestionCache.delete(key);
    suggestionCache.set(key, suggestions);
    while (suggestionCache.size > 24) suggestionCache.delete(suggestionCache.keys().next().value);
  }

  function collapseDuplicateTracksSafe(tracks) {
    try {
      return collapseDuplicateTracks(tracks || []);
    } catch {
      return tracks || [];
    }
  }

  function renderMusicSuggestions(box) {
    if (!box) return;
    box.innerHTML = "";
    const query = state.music.query || "";
    const suggestions = state.music.suggestions || {};
    const valid = state.music.mode === "library" && query && suggestions.query === query;
    if (!valid) {
      box.hidden = true;
      return;
    }
    let count = 0;
    const addGroup = (label, items, build) => {
      if (!items.length) return;
      const heading = document.createElement("div");
      heading.className = "music-search-suggest-heading";
      heading.textContent = label;
      box.append(heading);
      for (const item of items) {
        box.append(build(item));
        count += 1;
      }
    };
    const suggestButton = (key, main, sub, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-search-suggest-item";
      if (key) button.dataset.musicSuggestionKey = key;
      const strong = document.createElement("strong");
      strong.textContent = main;
      const small = document.createElement("small");
      small.textContent = sub;
      button.append(strong, small);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (!box.isConnected || suggestionBox !== box || state.activeView !== "music" || state.music.mode !== "library"
            || state.music.query !== query || state.music.suggestions !== suggestions) return;
        clearMusicSuggestions();
        action();
      });
      return button;
    };
    addGroup("歌曲", (suggestions.tracks || []).slice(0, 5), (track) =>
      suggestButton(track.id ? `track:${track.id}` : "", track.title || "未知歌曲", `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`, () => actions.openTrackFromList(track, [track], { autoplay: true }).catch(showError))
    );
    addGroup("歌手", (suggestions.artists || []).slice(0, 4), (artist) =>
      suggestButton(artist.id ? `artist:${artist.id}` : "", artist.name || "未知歌手", `${formatNumber(artist.trackCount || 0)} 首歌曲`, () => {
        state.music.mode = "library";
        state.music.query = artist.name || "";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      })
    );
    addGroup("专辑", (suggestions.albums || []).slice(0, 4), (album) =>
      suggestButton(album.id ? `album:${album.id}` : "", album.title || "未知专辑", `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`, () => {
        state.music.mode = "library";
        state.music.query = album.title || "";
        state.music.favorite = false;
        state.music.activePlaylistId = "";
        state.music.activeSmartPlaylistId = "";
        state.music.artistId = "all";
        state.music.albumId = "all";
        state.music.genre = "all";
        loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      })
    );
    if (!count) {
      const empty = document.createElement("div");
      empty.className = "music-search-suggest-empty";
      empty.textContent = "没有联想结果";
      box.append(empty);
    }
    box.hidden = false;
  }

  // ================= 当前播放 / 队列 =================
  function renderNowPanel({ includeQueue = true } = {}) {
    const panel = document.createElement("aside");
    panel.className = "music-now-panel";
    const track = state.music.current || state.music.queue[0] || null;
    panel.dataset.musicTrackId = track?.id || "";
    if (!track) {
      const empty = document.createElement("div");
      empty.className = "music-now-empty";
      empty.textContent = state.music.status || "选择一首歌开始播放。";
      panel.append(empty);
      return panel;
    }
    const summary = document.createElement("div");
    summary.className = "music-now-summary";
    const info = document.createElement("div");
    info.className = "music-now-info";
    const title = document.createElement("h3");
    title.textContent = track.title;
    const meta = document.createElement("p");
    meta.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
    const rating = h.renderRatingControl(track, "now");
    const actionsEl = document.createElement("div");
    actionsEl.className = "music-now-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-primary-button";
    play.textContent = state.music.playing ? "暂停" : "播放";
    play.addEventListener("click", () => actions.togglePlayback());
    registerPlaybackButton(play, "text");
    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = `music-secondary-button${track.favorite ? " active" : ""}`;
    fav.textContent = track.favorite ? "已收藏" : "收藏";
    fav.addEventListener("click", () => actions.toggleFavorite(track.id).catch(showError));
    const playlist = document.createElement("button");
    playlist.type = "button";
    playlist.className = "music-secondary-button";
    playlist.textContent = "加入歌单";
    playlist.addEventListener("click", () => actions.openPlaylistDialog(track.id).catch(showError));
    const download = document.createElement("button");
    download.type = "button";
    download.className = "music-secondary-button";
    download.textContent = "下载";
    download.disabled = !track.downloadUrl;
    download.addEventListener("click", () => actions.downloadTrack(track));
    actionsEl.append(play, fav, playlist, download);
    if (state.music.mode === "playlist" && state.music.activePlaylistId) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "music-secondary-button danger";
      remove.textContent = "移出歌单";
      remove.addEventListener("click", () => actions.removeTrackFromActivePlaylist(track.id).catch(showError));
      actionsEl.append(remove);
    }
    info.append(title, meta, rating, actionsEl);
    summary.append(h.renderCover(track, "large"), info);
    panel.append(summary);
    if (includeQueue) panel.append(renderQueuePanel());
    return panel;
  }

  function renderQueuePanel() {
    const panel = document.createElement("div");
    panel.className = "music-queue";
    const model = queueSearchModel();
    const view = { panel, model, composing: false, candidateSubmit: false };
    queueViews.set(panel, view);
    const head = document.createElement("div");
    head.className = "music-queue-head";
    const titleWrap = document.createElement("span");
    titleWrap.className = "music-queue-title";
    const title = document.createElement("strong");
    title.textContent = "播放队列";
    const count = document.createElement("small");
    view.count = count;
    titleWrap.append(title, count);
    const actionsEl = document.createElement("span");
    actionsEl.className = "music-queue-head-actions";
    {
      const toggle = document.createElement("button");
      view.toggle = toggle;
      toggle.type = "button";
      toggle.className = "music-inline-button";
      toggle.dataset.musicQueueAction = "expand";
      toggle.addEventListener("click", () => {
        if (!queueViewCurrent(view)) return;
        const expanding = !state.music.queueExpanded;
        state.music.queueExpanded = expanding;
        if (expanding) state.music.queueVisibleLimit = DESKTOP_QUEUE_PAGE_SIZE;
        refreshQueueSurface();
      });
      actionsEl.append(toggle);
    }
    const save = document.createElement("button");
    view.save = save;
    save.type = "button";
    save.className = "music-inline-button";
    save.dataset.musicQueueAction = "save";
    save.textContent = "存为歌单";
    save.addEventListener("click", () => { if (queueViewCurrent(view)) actions.saveQueueAsPlaylist().catch(showError); });
    actionsEl.append(save);
    const clear = document.createElement("button");
    view.clear = clear;
    clear.type = "button";
    clear.className = "music-inline-button";
    clear.dataset.musicQueueAction = "clear";
    clear.addEventListener("click", () => { if (queueViewCurrent(view)) actions.clearQueueAfterCurrent(); });
    actionsEl.append(clear);
    head.append(titleWrap, actionsEl);
    const list = document.createElement("div");
    view.list = list;
    queueViews.set(list, view);
    const form = document.createElement("form");
    view.form = form;
    form.className = "music-queue-search";
    form.setAttribute("role", "search");
    const label = document.createElement("label");
    label.textContent = "查找队列";
    const input = document.createElement("input");
    view.input = input;
    input.type = "search";
    input.setAttribute("aria-label", "查找播放队列");
    input.dataset.musicQueueAction = "search";
    input.placeholder = "歌名、歌手或专辑";
    input.autocomplete = "off";
    input.value = model?.raw || "";
    input.disabled = !model;
    label.append(input);
    const clearSearch = document.createElement("button");
    clearSearch.type = "button";
    clearSearch.textContent = "清除";
    clearSearch.setAttribute("aria-label", "清除队列查找");
    const result = document.createElement("p");
    view.result = result;
    result.className = "music-queue-search-count";
    result.setAttribute("role", "status");
    const note = document.createElement("p");
    note.className = "music-queue-search-note";
    note.textContent = "仅筛选显示；移动按完整队列顺序，保存歌单和清空作用于整个队列。";
    form.append(label, clearSearch, result, note);
    const commit = () => {
      if (!queueViewCurrent(view)) return;
      model.raw = input.value;
      if (view.composing) return;
      const query = normalizeQueueQuery(input.value);
      if (query === model.query) return;
      model.query = query; model.limit = DESKTOP_QUEUE_PAGE_SIZE;
      refreshQueueRows(view); list.scrollTop = 0;
    };
    const focusFirst = () => {
      if (!queueViewCurrent(view) || view.composing) return;
      const target = list.querySelector(".music-queue-play");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    };
    input.addEventListener("input", commit);
    input.addEventListener("search", commit);
    input.addEventListener("compositionstart", () => { if (queueViewCurrent(view)) { view.composing = true; view.candidateSubmit = false; } });
    input.addEventListener("compositionend", () => { view.composing = false; commit(); });
    input.addEventListener("keydown", event => {
      if (!queueViewCurrent(view) || event.defaultPrevented) return;
      if (view.composing || event.isComposing || event.keyCode === 229) {
        if (event.key === "Enter" || event.keyCode === 229) view.candidateSubmit = true;
        event.stopPropagation(); return;
      }
      view.candidateSubmit = false;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); commit(); focusFirst(); }
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!queueViewCurrent(view) || view.composing) return;
      if (view.candidateSubmit) { view.candidateSubmit = false; return; }
      commit(); focusFirst();
    });
    clearSearch.addEventListener("click", () => {
      if (!queueViewCurrent(view)) return;
      view.composing = false; view.candidateSubmit = false;
      input.value = ""; commit(); input.focus({ preventScroll: true });
    });
    panel.append(head, form, list);
    refreshQueueRows(view);
    return panel;
  }

  function normalizeQueueQuery(value) { return String(value || "").normalize("NFKC").toLowerCase().trim(); }

  function queueSearchModel() {
    let account;
    try { account = captureWebAccount(); } catch { queueSearchState = null; return null; }
    if (!queueSearchState || queueSearchState.owner !== account.owner || queueSearchState.revision !== account.revision) {
      queueSearchState = { owner: account.owner, revision: account.revision, raw: "", query: "", limit: DESKTOP_QUEUE_PAGE_SIZE, text: new WeakMap() };
    }
    return queueSearchState;
  }

  function queueViewCurrent(view) {
    if (!view?.model || !view.panel.isConnected || state.activeView !== "music" || state.music.trackPageOpen
        || els.workGrid?.querySelector(".music-queue") !== view.panel) return false;
    return queueSearchModel() === view.model;
  }

  function queueMatches(view) {
    const query = view.model?.query || "";
    return (state.music.queue || []).flatMap((track, index) => {
      if (!query) return [{ track, index }];
      const raw = JSON.stringify([track.title, track.artist, track.album]);
      let cached = view.model.text.get(track);
      if (!cached || cached.raw !== raw) { cached = { raw, value: normalizeQueueQuery([track.title, track.artist, track.album].join(" ")) }; view.model.text.set(track, cached); }
      return cached.value.includes(query) ? [{ track, index }] : [];
    });
  }

  function createQueueRow(track, index, list) {
    const view = queueViews.get(list);
    return h.queueRow(track, index, () => queueViewCurrent(view) && (state.music.queue || []).some(item => item.id === track.id));
  }

  function updateQueueHead(view, matches = (state.music.queue || []).length) {
    const queue = state.music.queue || [], query = view.model?.query;
    view.count.textContent = query ? `${formatNumber(queue.length)} 首` : queueCountText(queue);
    view.toggle.hidden = queue.length <= DESKTOP_QUEUE_PREVIEW_LIMIT || Boolean(query);
    view.toggle.textContent = state.music.queueExpanded ? "精简" : "全部";
    view.toggle.title = state.music.queueExpanded ? "只显示队列摘要" : "显示完整队列";
    view.save.disabled = !queue.length;
    view.save.title = queue.length ? `保存完整队列的 ${formatNumber(queue.length)} 首歌曲` : "队列为空";
    const removable = queueRemovableCountLocal();
    view.clear.textContent = state.music.current ? "清空其他" : "清空";
    view.clear.disabled = removable <= 0;
    view.clear.title = removable > 0 ? `清空完整队列中 ${formatNumber(removable)} 首待播歌曲` : "没有可清空的待播歌曲";
    view.result.textContent = `匹配 ${formatNumber(matches)} / 共 ${formatNumber(queue.length)} 首${query ? ` · 已显示 ${formatNumber(Math.min(matches, view.model.limit))}` : ""}`;
  }

  function refreshQueueRows(view) {
    const queue = state.music.queue || [], list = view.list;
    unregisterMusicTrackElements(list);
    list.replaceChildren();
    list.className = `music-queue-list${state.music.queueExpanded || view.model?.query ? " expanded" : ""}`;
    if (view.model?.query) {
      const matches = queueMatches(view), limit = Math.min(matches.length, view.model.limit);
      for (const { track, index } of matches.slice(0, limit)) list.append(createQueueRow(track, index, list));
      if (!matches.length) list.append(h.emptyQueueRow("没有匹配的歌曲"));
      appendQueueSearchTail(view, matches, limit);
      updateQueueHead(view, matches.length);
    } else {
      if (!queue.length) list.append(h.emptyQueueRow("队列为空")); else appendQueueRows(list, queue);
      updateQueueHead(view);
    }
  }

  function appendQueueSearchTail(view, matches, limit) {
    if (limit >= matches.length) return;
    const more = document.createElement("button");
    more.type = "button"; more.className = "music-queue-load-more"; more.dataset.musicQueueAction = "search-more";
    more.textContent = `再显示 ${formatNumber(Math.min(DESKTOP_QUEUE_PAGE_SIZE, matches.length - limit))} 条匹配`;
    more.addEventListener("click", () => {
      if (!queueViewCurrent(view) || !more.isConnected) return;
      const context = captureQueueContext(view.panel), focused = document.activeElement === more;
      const current = queueMatches(view), rows = [...view.list.querySelectorAll(".music-queue-row")];
      const oldIds = new Set(rows.map(row => row.dataset.musicTrackId));
      const prefixCurrent = rows.length === limit && rows.every((row, index) => row.dataset.musicTrackId === current[index]?.track.id && matches[index]?.index === current[index]?.index);
      view.model.limit = limit + DESKTOP_QUEUE_PAGE_SIZE;
      if (prefixCurrent) {
        const nextLimit = Math.min(current.length, view.model.limit), fragment = document.createDocumentFragment();
        more.remove();
        for (const { track, index } of current.slice(limit, nextLimit)) fragment.append(createQueueRow(track, index, view.list));
        view.list.append(fragment);
        appendQueueSearchTail(view, current, nextLimit);
        updateQueueHead(view, current.length);
      } else refreshQueueRows(view);
      const next = [...view.list.querySelectorAll(".music-queue-row")].find(row => !oldIds.has(row.dataset.musicTrackId));
      if (focused && next) context.focus = { tracks: [next.dataset.musicTrackId], action: "play" };
      restoreQueueContext(view.panel, context);
      if (focused) document.activeElement?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
    view.list.append(more);
  }

  function refreshQueueSurface({ queueMove = null } = {}) {
    const nowPanel = els.workGrid?.querySelector?.(".music-now-panel");
    if (!nowPanel || state.music.trackPageOpen) {
      renderView();
      return;
    }
    const expectedTrackId = state.music.current?.id || state.music.queue[0]?.id || "";
    const queuePanel = nowPanel.querySelector(".music-queue");
    const context = captureQueueContext(queuePanel);
    if (queueViewCurrent(queueViews.get(queuePanel))) {
      if (nowPanel.dataset.musicTrackId !== expectedTrackId) refreshNowSummaryKeepingQueue(nowPanel);
      const view = queueViews.get(queuePanel);
      if (!view.model.query && moveCompleteQueueRow(queuePanel, queueMove)) updateQueueHead(view);
      else refreshQueueRows(view);
      restoreQueueContext(queuePanel, context);
      pruneDetachedPlaybackControls(); updatePlaybackUi();
      return;
    }
    if (nowPanel.dataset.musicTrackId !== expectedTrackId) {
      unregisterMusicTrackElements(nowPanel);
      const nextPanel = renderNowPanel();
      nowPanel.replaceWith(nextPanel);
      restoreQueueContext(nextPanel.querySelector(".music-queue"), context);
      playbackButtonEls = playbackButtonEls.filter(({ button }) => button?.isConnected);
      updatePlaybackUi();
      return;
    }
    if (!queuePanel) {
      unregisterMusicTrackElements(nowPanel);
      const nextPanel = renderNowPanel();
      nowPanel.replaceWith(nextPanel);
      playbackButtonEls = playbackButtonEls.filter(({ button }) => button?.isConnected);
      updatePlaybackUi();
      return;
    }
    if (moveCompleteQueueRow(queuePanel, queueMove)) {
      restoreQueueContext(queuePanel, context);
      return;
    }
    unregisterMusicTrackElements(queuePanel);
    const nextQueuePanel = renderQueuePanel();
    queuePanel.replaceWith(nextQueuePanel);
    restoreQueueContext(nextQueuePanel, context);
  }

  function moveCompleteQueueRow(panel, move) {
    const queue = state.music.queue || [];
    if (!move || !state.music.queueExpanded || queue.length > Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0))) return false;
    const { trackId, fromIndex, toIndex } = move;
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || Math.abs(toIndex - fromIndex) !== 1) return false;
    const list = panel.querySelector(".music-queue-list");
    const row = list?.children[fromIndex], neighbor = list?.children[toIndex];
    if (list?.children.length !== queue.length || !row?.classList.contains("music-queue-row") || !neighbor?.classList.contains("music-queue-row")
        || row.dataset.musicTrackId !== trackId || queue[toIndex]?.id !== trackId || queue[fromIndex]?.id !== neighbor.dataset.musicTrackId) return false;
    // Only an explicitly described adjacent move in the fully mounted queue
    // can reuse rows. Membership, pagination and rollback retain full refresh.
    list.insertBefore(row, list.children[toIndex + (toIndex > fromIndex ? 1 : 0)] || null);
    for (const index of [fromIndex, toIndex]) {
      const currentRow = list.children[index];
      currentRow.querySelector('[aria-label="上移"]').disabled = index === 0;
      currentRow.querySelector('[aria-label="下移"]').disabled = index === queue.length - 1;
    }
    return true;
  }

  function refreshNowSummaryKeepingQueue(nowPanel) {
    const queue = nowPanel.querySelector(".music-queue");
    const next = renderNowPanel({ includeQueue: false });
    nowPanel.dataset.musicTrackId = next.dataset.musicTrackId;
    for (const child of [...nowPanel.children]) if (child !== queue) { unregisterMusicTrackElements(child); child.remove(); }
    for (const child of [...next.children]) nowPanel.insertBefore(child, queue);
  }

  function captureQueueContext(panel) {
    const list = panel?.querySelector(".music-queue-list");
    const focused = document.activeElement;
    const context = { scrollTop: list?.scrollTop || 0, focus: null };
    if (!focused || !panel?.contains(focused)) return context;
    const row = focused.closest(".music-queue-row");
    if (row) {
      const rows = [...list.querySelectorAll(".music-queue-row")];
      const index = rows.indexOf(row);
      context.focus = {
        tracks: [row, rows[index + 1], rows[index - 1]].filter(Boolean).map(item => item.dataset.musicTrackId),
        action: focused.classList.contains("music-queue-play") ? "play" : focused.getAttribute("aria-label")
      };
    } else if (focused.dataset.musicQueueAction) {
      context.focus = { control: focused.dataset.musicQueueAction };
    }
    return context;
  }

  function restoreQueueContext(panel, context) {
    const list = panel?.querySelector(".music-queue-list");
    if (!list || !context) return;
    list.scrollTop = context.scrollTop;
    if (!context.focus) return;
    // Removal normally leaves focus on body. Respect any new focus chosen by
    // another control during teardown rather than redirecting it back here.
    const active = document.activeElement;
    const available = control => !control.disabled && !control.closest("[hidden], [inert]") && control.getClientRects().length > 0;
    if (active?.isConnected && active !== document.body && active !== document.documentElement
        && (!panel.contains(active) || available(active))) return;
    let target = null;
    const focus = context.focus;
    if (focus.control) target = [...panel.querySelectorAll("[data-music-queue-action]")].find(button => button.dataset.musicQueueAction === focus.control && available(button));
    const rows = [...list.querySelectorAll(".music-queue-row")];
    for (const trackId of focus.tracks || []) {
      const row = rows.find(item => item.dataset.musicTrackId === trackId);
      if (!row) continue;
      const actions = [...row.querySelectorAll(".music-queue-action")].filter(button => !button.disabled);
      target = focus.action === "play" ? row.querySelector(".music-queue-play")
        : actions.find(button => button.getAttribute("aria-label") === focus.action) || actions[0] || row.querySelector(".music-queue-play");
      if (target) break;
    }
    target ||= list.querySelector(".music-queue-row.active .music-queue-play") || list.querySelector(".music-queue-play")
      || [...panel.querySelectorAll("[data-music-queue-action]")].find(available);
    target?.focus({ preventScroll: true });
  }

  function refreshCurrentTrackSurfaces(previousTrackId = "") {
    const shell = els.workGrid?.querySelector?.(".music-shell.music-library-page");
    const nowPanel = shell?.querySelector?.(".music-now-panel");
    const playerBar = shell?.querySelector?.(".music-player-bar");
    if (!shell || !nowPanel || !playerBar || state.music.trackPageOpen) return false;
    const context = captureQueueContext(nowPanel.querySelector(".music-queue"));
    updateBrowseTrackSelection(previousTrackId, state.music.current?.id || "");
    const queuePanel = nowPanel.querySelector(".music-queue"), view = queueViews.get(queuePanel);
    if (queueViewCurrent(view)) {
      refreshNowSummaryKeepingQueue(nowPanel);
      refreshQueueRows(view);
      restoreQueueContext(queuePanel, context);
      playerBar.replaceWith(renderPlayerBar());
      pruneDetachedPlaybackControls(); updatePlaybackUi();
      syncFavoriteFeedback();
      return true;
    }
    unregisterMusicTrackElements(nowPanel);
    const nextNowPanel = renderNowPanel();
    const nextPlayerBar = renderPlayerBar();
    nowPanel.replaceWith(nextNowPanel);
    restoreQueueContext(nextNowPanel.querySelector(".music-queue"), context);
    playerBar.replaceWith(nextPlayerBar);
    pruneDetachedPlaybackControls();
    updatePlaybackUi();
    syncFavoriteFeedback();
    return true;
  }

  function updateBrowseTrackSelection(previousTrackId, currentTrackId) {
    for (const indicator of currentTrackIndicatorMap.get(previousTrackId) || []) {
      if (!indicator.element?.isConnected) continue;
      indicator.element.closest?.("[data-music-track-id]")?.classList.remove("active");
      if (indicator.element.textContent !== indicator.idleLabel) indicator.element.textContent = indicator.idleLabel;
    }
    for (const indicator of currentTrackIndicatorMap.get(currentTrackId) || []) {
      if (!indicator.element?.isConnected) continue;
      indicator.element.closest?.("[data-music-track-id]")?.classList.add("active");
      const text = state.music.playing ? indicator.playingLabel : indicator.idleLabel;
      if (indicator.element.textContent !== text) indicator.element.textContent = text;
    }
  }

  function pruneDetachedPlaybackControls() {
    playbackButtonEls = playbackButtonEls.filter(({ button }) => button?.isConnected);
    playbackSurfaceEls = playbackSurfaceEls.filter((surface) => surface?.isConnected);
    playbackErrorEls = playbackErrorEls.filter((error) => error?.isConnected);
    shuffleControlEls = shuffleControlEls.filter((button) => button?.isConnected);
    repeatControlEls = repeatControlEls.filter((button) => button?.isConnected);
    sleepTimerControlEls = sleepTimerControlEls.filter(({ select, status }) => select?.isConnected || status?.isConnected);
  }

  function queueRemovableCountLocal() {
    const queue = state.music.queue || [];
    if (!state.music.current) return queue.length;
    return queue.filter((track) => track.id !== state.music.current.id).length;
  }

  function appendQueueRows(list, queue) {
    if (state.music.queueExpanded) {
      appendExpandedQueueRows(list, queue);
      return;
    }
    if (queue.length <= DESKTOP_QUEUE_PREVIEW_LIMIT) {
      queue.forEach((track, index) => list.append(createQueueRow(track, index, list)));
      return;
    }
    const shownIndexes = new Set();
    queue.slice(0, DESKTOP_QUEUE_PREVIEW_LIMIT).forEach((track, index) => {
      shownIndexes.add(index);
      list.append(createQueueRow(track, index, list));
    });
    const currentIndex = queue.findIndex((track) => track.id === state.music.current?.id);
    if (currentIndex >= DESKTOP_QUEUE_PREVIEW_LIMIT) {
      shownIndexes.add(currentIndex);
      list.append(h.emptyQueueRow(`当前播放在第 ${formatNumber(currentIndex + 1)} 首`));
      list.append(createQueueRow(queue[currentIndex], currentIndex, list));
    }
    const hiddenCount = queue.length - shownIndexes.size;
    if (hiddenCount > 0) list.append(h.emptyQueueRow(`还有 ${formatNumber(hiddenCount)} 首未显示，点“全部”查看`));
  }

  function appendExpandedQueueRows(list, queue) {
    const limit = Math.min(queue.length, Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0)));
    queue.slice(0, limit).forEach((track, index) => list.append(createQueueRow(track, index, list)));
    appendExpandedQueueTail(list, queue, limit);
  }

  function appendExpandedQueueTail(list, queue, limit) {
    const currentIndex = queue.findIndex((track) => track.id === state.music.current?.id);
    if (currentIndex >= limit) {
      const marker = h.emptyQueueRow(`当前播放在第 ${formatNumber(currentIndex + 1)} 首`);
      marker.classList.add("music-queue-current-context");
      const currentRow = createQueueRow(queue[currentIndex], currentIndex, list);
      currentRow.dataset.queueContextCurrent = "true";
      list.append(marker, currentRow);
    }
    if (limit >= queue.length) return;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "music-queue-load-more";
    more.dataset.musicQueueAction = "more";
    more.textContent = `再显示 ${formatNumber(Math.min(DESKTOP_QUEUE_PAGE_SIZE, queue.length - limit))} 首`;
    more.addEventListener("click", () => appendNextQueuePage(list, queue, more));
    list.append(more);
  }

  function appendNextQueuePage(list, queue, moreButton) {
    if (!queueViewCurrent(queueViews.get(list)) || !moreButton.isConnected) return;
    const panel = list.closest(".music-queue");
    const context = captureQueueContext(panel);
    const focusedMore = document.activeElement === moreButton;
    const oldLimit = Math.min(queue.length, Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0)));
    const nextLimit = Math.min(queue.length, oldLimit + DESKTOP_QUEUE_PAGE_SIZE);
    state.music.queueVisibleLimit = nextLimit;
    list.querySelector(".music-queue-current-context")?.remove();
    list.querySelector('[data-queue-context-current="true"]')?.remove();
    moreButton?.remove();
    const fragment = document.createDocumentFragment();
    for (let index = oldLimit; index < nextLimit; index += 1) fragment.append(createQueueRow(queue[index], index, list));
    list.append(fragment);
    appendExpandedQueueTail(list, queue, nextLimit);
    const count = list.closest(".music-queue")?.querySelector(".music-queue-title small");
    if (count) count.textContent = queueCountText(queue);
    if (focusedMore && queue[oldLimit]) context.focus = { tracks: [queue[oldLimit].id], action: "play" };
    restoreQueueContext(panel, context);
  }

  function queueCountText(queue) {
    if (!queue.length) return "空队列";
    if (!state.music.queueExpanded) return `${formatNumber(queue.length)} 首`;
    const visible = Math.min(queue.length, Math.max(DESKTOP_QUEUE_PAGE_SIZE, Number(state.music.queueVisibleLimit || 0)));
    return visible < queue.length
      ? `${formatNumber(queue.length)} 首 · 已显示 ${formatNumber(visible)}`
      : `${formatNumber(queue.length)} 首 · 全部`;
  }

  // ================= 播放栏 =================
  function renderPlayerBar() {
    const track = state.music.current || state.music.queue[0] || null;
    const bar = document.createElement("section");
    bar.className = "music-player-bar";
    const identity = document.createElement("div");
    identity.className = "music-player-identity";
    if (track) {
      identity.classList.add("interactive");
      identity.setAttribute("role", "button");
      identity.tabIndex = 0;
      identity.setAttribute("aria-label", "打开当前歌曲播放页");
      identity.addEventListener("click", () => openPlayerStage().catch(showError));
      identity.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openPlayerStage().catch(showError);
      });
    }
    identity.append(track ? h.renderCover(track, "bar") : h.renderCover({ title: "音乐" }, "bar"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const meta = document.createElement("small");
    meta.textContent = track ? `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}` : "从音乐库选择一首歌";
    text.append(title, meta, createPlaybackErrorElement());
    identity.append(text);
    const center = document.createElement("div");
    center.className = "music-player-center";
    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    controls.append(h.iconControlButton("enter-fullscreen", () => openPlayerStage().catch(showError), !track, "", "展开播放页"));
    controls.append(registerShuffleControl(h.controlButton("随机", () => actions.toggleShuffleMode(), false, `text${state.music.shuffle ? " active" : ""}`, "随机播放")));
    controls.append(h.iconControlButton("rewind", () => actions.playAdjacent(-1, { autoplay: true }).catch(showError), !track, "", "上一首"));
    const playButton = h.iconControlButton(state.music.playing ? "pause" : "play", () => actions.togglePlayback(), !track, "primary", state.music.playing ? "暂停" : "播放");
    registerPlaybackButton(playButton, "icon");
    controls.append(playButton);
    controls.append(h.iconControlButton("fast-forward", () => actions.playAdjacent(1, { autoplay: true }).catch(showError), !track, "", "下一首"));
    controls.append(registerRepeatControl(h.controlButton(repeatLabelLocal(state.music.repeat), () => actions.cycleRepeatMode(), false, `text${state.music.repeat === "none" ? "" : " active"}`, repeatLabelLocal(state.music.repeat))));
    const progressWrap = document.createElement("label");
    progressWrap.className = "music-progress";
    const current = document.createElement("span");
    current.textContent = "0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.addEventListener("input", () => {
      const audio = player.getAudio();
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = (Number(progress.value || 0) / 1000) * audio.duration;
      updatePlaybackUi();
      void actions.claimProgressOwner();
    });
    const total = document.createElement("span");
    total.textContent = track ? formatClockLocal(track.durationMs || 0) : "0:00";
    progressWrap.append(current, progress, total);
    center.append(controls, progressWrap);
    const options = document.createElement("div");
    options.className = "music-player-options";
    options.append(h.renderRatingControl(track, "bar"));
    options.append(h.controlButton(track?.favorite ? "已收藏" : "收藏", () => actions.toggleFavorite(track.id).catch(showError), !track, `text${track?.favorite ? " active heart" : ""}`, track?.favorite ? "取消收藏" : "收藏"));
    options.append(h.controlButton("歌单", () => actions.openPlaylistDialog(track.id).catch(showError), !track, "text", "加入歌单"));
    options.append(h.iconControlButton("download", () => actions.downloadTrack(track), !track?.downloadUrl, "", "下载原文件"));
    options.append(renderSleepTimerControl(track));
    options.append(renderPlaybackSpeedControl(track));
    options.append(renderVolumeControl());
    bar.append(identity, center, options);
    currentProgressEls = { current, progress, total };
    return bar;
  }

  function renderVolumeControl() {
    const volumeWrap = document.createElement("label");
    volumeWrap.className = "music-volume-wrap";
    const volumeLabel = document.createElement("span");
    volumeLabel.textContent = "音量";
    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = "0";
    volume.max = "100";
    // The mounted control reflects the live player, including a quiet volume
    // chosen before changing views when preference storage is unavailable.
    state.music.volume = player.getAudio().volume;
    volume.value = String(Math.round(state.music.volume * 100));
    volume.className = "music-volume";
    volume.setAttribute("aria-label", "音量");
    volume.addEventListener("input", () => {
      if (!volume.isConnected || state.activeView !== "music") return;
      const value = Math.max(0, Math.min(1, Number(volume.value || 0) / 100));
      state.music.volume = value;
      player.setVolume(value);
      writeVolumePreferenceLocal(value);
    });
    volumeWrap.append(volumeLabel, volume);
    return volumeWrap;
  }

  function renderPlayerStage() {
    const track = state.music.current || state.music.queue[0] || null;
    const stage = document.createElement("section");
    stage.className = `music-player-stage music-single-track-page${state.music.playing ? " playing" : ""}`;
    stage.setAttribute("aria-label", "单曲播放页");
    playbackSurfaceEls.push(stage);
    const backdrop = document.createElement("div");
    backdrop.className = "music-stage-backdrop";
    if (track?.coverUrl) {
      const image = document.createElement("img");
      image.src = track.coverUrl;
      image.alt = "";
      image.decoding = "async";
      backdrop.append(image);
    }
    const chrome = document.createElement("header");
    chrome.className = "music-stage-chrome";
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "music-stage-close";
    collapse.textContent = "返回音乐库";
    collapse.setAttribute("aria-label", "返回音乐库");
    collapse.addEventListener("click", closeTrackPage);
    chrome.append(collapse);
    const content = document.createElement("div");
    content.className = "music-stage-content";
    content.append(renderStageNow(track));
    stage.append(backdrop, chrome, content, renderStageWave(), renderStagePlayer(track));
    return stage;
  }

  function renderStageQueue(track) {
    const panel = document.createElement("section");
    panel.className = "music-stage-queue";
    const head = document.createElement("div");
    head.className = "music-stage-list-actions";
    head.append(h.stageActionButton("♡ 收藏", () => track && actions.toggleFavorite(track.id).catch(showError), !track));
    head.append(h.stageActionButton("+ 加到歌单", () => track && actions.openPlaylistDialog(track.id).catch(showError), !track));
    head.append(h.stageActionButton("↓ 下载", () => actions.downloadTrack(track), !track?.downloadUrl));
    head.append(h.stageActionButton("清空列表", () => actions.clearQueueAfterCurrent(), queueRemovableCountLocal() <= 0));
    panel.append(head);
    const list = document.createElement("div");
    list.className = "music-stage-track-list";
    const queue = state.music.queue || [];
    if (!queue.length) {
      const empty = document.createElement("div");
      empty.className = "music-stage-empty";
      empty.textContent = "播放列表为空";
      list.append(empty);
    } else {
      queue.slice(0, 80).forEach((item, index) => list.append(h.stageTrackRow(item, index)));
      if (queue.length > 80) {
        const more = document.createElement("div");
        more.className = "music-stage-empty";
        more.textContent = `还有 ${formatNumber(queue.length - 80)} 首未显示`;
        list.append(more);
      }
    }
    panel.append(list);
    return panel;
  }

  function renderStageNow(track) {
    const panel = document.createElement("section");
    panel.className = "music-stage-now";
    if (!track) {
      const empty = document.createElement("div");
      empty.className = "music-stage-empty";
      empty.textContent = "选择一首歌开始播放。";
      panel.append(empty);
      return panel;
    }
    const album = document.createElement("div");
    album.className = "music-stage-album";
    const turntable = document.createElement("img");
    turntable.className = "music-stage-turntable";
    turntable.src = "/assets/music/turntable-dark-v1.png";
    turntable.alt = "黑胶唱机";
    turntable.decoding = "async";
    const recordLabel = h.renderCover(track, "record-label");
    album.append(turntable, recordLabel);
    const meta = document.createElement("div");
    meta.className = "music-stage-meta";
    const title = document.createElement("h2");
    title.textContent = track.title || "未知歌曲";
    const artist = document.createElement("p");
    artist.className = "music-stage-context";
    const separator = document.createElement("span");
    separator.textContent = "·";
    separator.setAttribute("aria-hidden", "true");
    artist.append(renderCurrentTrackContext(track, "artist"), separator, renderCurrentTrackContext(track, "album"));
    meta.append(title, artist, renderStageLyrics());
    panel.append(album, meta);
    return panel;
  }

  function renderCurrentTrackContext(track, kind) {
    const idKey = kind === "artist" ? "artistId" : "albumId";
    const label = track[kind] || (kind === "artist" ? "未知歌手" : "未知专辑");
    const id = String(track[idKey] || "").trim();
    let account;
    try { account = captureWebAccount(); } catch { return document.createTextNode(label); }
    if (!id) return document.createTextNode(label);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-current-context";
    button.textContent = label;
    button.setAttribute("aria-label", `浏览${kind === "artist" ? "歌手" : "专辑"}：${label}`);
    button.addEventListener("click", () => {
      if (!button.isConnected || state.activeView !== "music" || !state.music.trackPageOpen || state.music.openingTrackId
          || state.music.current?.id !== track.id || String(state.music.current?.[idKey] || "").trim() !== id) return;
      try {
        const current = captureWebAccount();
        if (current.owner !== account.owner || current.revision !== account.revision) return;
      } catch { return; }
      rememberTrackReturnHistory();
      trackReturnContext = null;
      state.music.trackPageOpen = false;
      state.music.playerStageOpen = false;
      state.music.libraryDrawerOpen = false;
      actions.selectMusicMode("library", { artistId: kind === "artist" ? id : "all", albumId: kind === "album" ? id : "all", language: "all" });
      pushRoute({ ...router.overrides(), musicTrackId: "" });
      window.scrollTo({ top: 0, behavior: "instant" });
      renderView();
    });
    return button;
  }

  function renderStageLyrics() {
    const wrap = document.createElement("div");
    wrap.className = "music-stage-lyrics";
    const head = document.createElement("div");
    head.className = "music-stage-lyrics-head";
    const title = document.createElement("strong");
    title.textContent = "歌词";
    head.append(title);
    const lines = document.createElement("div");
    lines.className = "music-lyric-lines music-stage-lyric-lines";
    const lyrics = state.music.lyrics;
    const timedLines = lyrics?.lines || [];
    const timed = timedLines.length > 0;
    const raw = String(lyrics?.raw || "");
    const trackId = state.music.current?.id || "";
    const source = timed ? timedLines : raw;
    const lyricLines = timed ? timedLines : lyricFinderState?.trackId === trackId && lyricFinderState.source === source
      ? lyricFinderState.lines : raw.trim() ? raw.trim().split(/\r\n?|\n/).map(text => ({ text })) : [];
    if (!lyricLines.length) {
      lyricFinderState = null;
      const empty = document.createElement("p");
      empty.textContent = "暂无歌词";
      lines.append(empty);
    } else {
      if (lyricFinderState?.trackId !== trackId || lyricFinderState.lines !== lyricLines) {
        lyricFinderState = { trackId, source, lines: lyricLines, query: "", needle: "", matches: [], matchSet: new Set(), cursor: -1 };
      }
      const search = lyricFinderState;
      const owner = { startIndex: 0, show: null, finder: null };
      const isCurrent = () => lyricViewport === owner && wrap.isConnected && state.activeView === "music" && state.music.trackPageOpen
        && state.music.current?.id === trackId && state.music.lyrics === lyrics
        && (timed ? state.music.lyrics?.lines === lyricLines : state.music.lyrics?.raw === raw);
      lyricViewport = owner;
      const follow = document.createElement("button");
      follow.type = "button";
      follow.className = `music-lyric-follow${state.music.lyricFollowPaused ? " visible" : ""}`;
      follow.textContent = "回到当前";
      follow.addEventListener("click", () => { if (isCurrent()) resumeLyricFollow(); });
      if (timed) {
        lyricFollowButtonEls.push(follow);
        head.append(follow);
      } else {
        const description = document.createElement("small");
        description.className = "music-lyric-plain-label";
        description.textContent = "纯文本歌词 · 无时间轴";
        head.append(description);
      }
      const label = document.createElement("small");
      label.className = "music-lyric-window-label";
      label.hidden = lyricLines.length <= 120;
      const paragraphCount = Math.ceil(lyricLines.length / 120);
      const navigation = document.createElement("div");
      navigation.className = "music-lyric-window-controls";
      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "上一段";
      previous.setAttribute("aria-label", "上一段歌词");
      const paragraph = document.createElement("select");
      paragraph.setAttribute("aria-label", "歌词段落");
      for (let index = 0; index < paragraphCount; index++) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `第 ${index + 1} / ${paragraphCount} 段`;
        paragraph.append(option);
      }
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "下一段";
      next.setAttribute("aria-label", "下一段歌词");
      navigation.append(previous, paragraph, next, label);
      const browseParagraph = target => {
        if (!isCurrent()) return;
        const page = Number(target);
        if (!Number.isInteger(page) || page < 0 || page >= paragraphCount) return;
        const focused = document.activeElement;
        pauseLyricFollow(follow);
        owner.show(page * 120);
        centerLyricLine(lyricLineEls[0], true);
        if (isCurrent() && (focused === previous || focused === next) && focused.disabled
            && (document.activeElement === focused || document.activeElement === document.body)) {
          const fallback = !previous.disabled ? previous : !next.disabled ? next : paragraph;
          fallback.focus({ preventScroll: true });
        }
      };
      previous.addEventListener("click", () => browseParagraph(Math.floor(owner.startIndex / 120) - 1));
      next.addEventListener("click", () => browseParagraph(Math.floor(owner.startIndex / 120) + 1));
      paragraph.addEventListener("change", () => { if (paragraph.value !== "") browseParagraph(paragraph.value); });
      paragraph.addEventListener("keydown", event => { if (isCurrent()) event.stopPropagation(); });
      const paintMatches = () => lyricLineEls.forEach(button => owner.finder?.decorate(button, Number(button.dataset.index)));
      owner.show = index => {
        if (lyricLineEls.length && index >= owner.startIndex && index < owner.startIndex + lyricLineEls.length) return;
        owner.startIndex = Math.floor(Math.max(0, Math.min(index, lyricLines.length - 1)) / 120) * 120;
        const fragment = document.createDocumentFragment();
        lyricLineEls = [];
        currentLyricIndex = timed ? findLyricIndex(lyricLines, Math.round((player.getAudio().currentTime || 0) * 1000) + 180) : -1;
        activeLyricElement = null;
        for (let index = owner.startIndex; index < Math.min(lyricLines.length, owner.startIndex + 120); index++) {
          const button = timed ? createLyricLineButton(lyricLines[index], index, isCurrent) : createPlainLyricLine(lyricLines[index], index, isCurrent);
          if (index === currentLyricIndex) { button.classList.add("active"); activeLyricElement = button; }
          lyricLineEls.push(button); fragment.append(button);
        }
        lines.replaceChildren(fragment);
        paragraph.value = String(Math.floor(owner.startIndex / 120));
        previous.disabled = owner.startIndex === 0;
        next.disabled = owner.startIndex + lyricLineEls.length >= lyricLines.length;
        label.textContent = `第 ${owner.startIndex + 1}–${owner.startIndex + lyricLineEls.length} 行 · 共 ${lyricLines.length} 行`;
        paintMatches();
      };
      owner.finder = createLyricFinder({ state: search, lines: lyricLines, isCurrent, canSeek: timed, onChange: paintMatches,
        onLocate(index) {
          pauseLyricFollow(follow);
          owner.show(index); paintMatches();
          centerLyricLine(lyricLineEls[index - owner.startIndex], true);
        }
      });
      owner.show(owner.finder.selectedIndex() >= 0 ? owner.finder.selectedIndex() : timed ? findLyricIndex(lyricLines, Math.round((player.getAudio().currentTime || 0) * 1000) + 180) : 0);
      wrap.append(head, owner.finder.element, ...(paragraphCount > 1 ? [navigation] : []), lines);
      const pauseFollow = () => { if (isCurrent()) pauseLyricFollow(follow); };
      navigation.addEventListener("focusin", pauseFollow);
      lines.addEventListener("wheel", pauseFollow, { passive: true });
      lines.addEventListener("pointerdown", pauseFollow, { passive: true });
      lines.addEventListener("focusin", pauseFollow);
      return wrap;
    }
    wrap.append(head, lines);
    return wrap;
  }

  function createLyricLineButton(line, index, isCurrent) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = String(index);
    button.dataset.timeMs = String(line.timeMs || 0);
    button.textContent = line.text || "";
    button.addEventListener("click", () => {
      if (!isCurrent()) return;
      player.seekToLyricLine(line.timeMs || 0);
      void actions.claimProgressOwner();
    });
    return button;
  }

  function createPlainLyricLine(line, index, isCurrent) {
    const text = document.createElement("p");
    text.className = "music-lyric-plain-line";
    text.tabIndex = 0;
    text.dataset.index = String(index);
    text.textContent = line.text || "";
    text.addEventListener("keydown", event => { if (isCurrent() && event.key !== "Escape") event.stopPropagation(); });
    return text;
  }

  function renderStageWave() {
    const wave = document.createElement("canvas");
    wave.className = "music-stage-wave";
    wave.setAttribute("aria-hidden", "true");
    player.setVisualizerCanvas(wave);
    return wave;
  }

  function renderStagePlayer(track) {
    const footer = document.createElement("footer");
    footer.className = "music-stage-player";
    const identity = document.createElement("div");
    identity.className = "music-stage-player-title";
    const title = document.createElement("strong");
    title.textContent = track?.title || "未播放";
    const artist = document.createElement("small");
    artist.textContent = track ? `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}` : "从音乐库选择一首歌";
    identity.append(title, artist, createPlaybackErrorElement());
    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    controls.append(registerRepeatControl(h.controlButton(repeatLabelLocal(state.music.repeat), () => actions.cycleRepeatMode(), false, `text${state.music.repeat === "none" ? "" : " active"}`, repeatLabelLocal(state.music.repeat))));
    controls.append(h.iconControlButton("rewind", () => actions.playAdjacent(-1, { autoplay: true }).catch(showError), !track, "", "上一首"));
    const playButton = h.iconControlButton(state.music.playing ? "pause" : "play", () => actions.togglePlayback(), !track, "primary", state.music.playing ? "暂停" : "播放");
    registerPlaybackButton(playButton, "icon");
    controls.append(playButton);
    controls.append(h.iconControlButton("fast-forward", () => actions.playAdjacent(1, { autoplay: true }).catch(showError), !track, "", "下一首"));
    controls.append(registerShuffleControl(h.controlButton("随机", () => actions.toggleShuffleMode(), false, `text${state.music.shuffle ? " active" : ""}`, "随机播放")));
    const progressWrap = document.createElement("label");
    progressWrap.className = "music-progress music-stage-progress";
    const current = document.createElement("span");
    current.textContent = "0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.addEventListener("input", () => {
      const audio = player.getAudio();
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = (Number(progress.value || 0) / 1000) * audio.duration;
      updatePlaybackUi();
      void actions.claimProgressOwner();
    });
    const total = document.createElement("span");
    total.textContent = track ? formatClockLocal(track.durationMs || 0) : "0:00";
    progressWrap.append(current, progress, total);
    const options = document.createElement("div");
    options.className = "music-stage-options";
    options.append(h.controlButton(track?.favorite ? "已收藏" : "收藏", () => actions.toggleFavorite(track.id).catch(showError), !track, `text${track?.favorite ? " active" : ""}`, track?.favorite ? "取消收藏" : "收藏"));
    options.append(renderPlaybackSpeedControl(track));
    options.append(renderVolumeControl());
    footer.append(identity, controls, progressWrap, options);
    currentProgressEls = { current, progress, total };
    return footer;
  }

  function renderPlaybackSpeedControl(track) {
    const wrap = document.createElement("label");
    wrap.className = "music-speed-wrap";
    wrap.setAttribute("aria-label", "播放速度");
    const label = document.createElement("span");
    label.textContent = "速度";
    const select = document.createElement("select");
    select.disabled = !track;
    for (const speed of MUSIC_PLAYBACK_SPEED_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(speed);
      option.textContent = `${speed}x`;
      select.append(option);
    }
    select.value = String(state.music.playbackSpeed);
    select.addEventListener("change", () => actions.setPlaybackSpeed(Number(select.value || 1)));
    wrap.append(label, select);
    return wrap;
  }

  function renderSleepTimerControl(track) {
    const wrap = document.createElement("label");
    wrap.className = "music-sleep-wrap";
    wrap.setAttribute("aria-label", "睡眠定时");
    const label = document.createElement("span");
    label.textContent = "睡眠";
    const select = document.createElement("select");
    select.disabled = !track;
    for (const minutes of MUSIC_SLEEP_TIMER_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = minutes ? `${minutes} 分钟` : "关闭";
      select.append(option);
    }
    select.value = String(player.sleepTimerActive() ? state.music.sleepMinutes : 0);
    select.addEventListener("change", () => actions.setSleepTimer(Number(select.value || 0)));
    const status = document.createElement("em");
    status.textContent = player.sleepTimerActive() ? `${player.sleepTimerText()} 后暂停` : "未开启";
    sleepTimerControlEls.push({ select, status });
    wrap.append(label, select, status);
    return wrap;
  }

  // ================= 歌单对话框 =================
  function renderPlaylistDialog() {
    playlistDialogEvents?.abort();
    playlistDialogEvents = null;
    if (!state.music.playlistDialogOpen) return document.createDocumentFragment();
    const trackId = state.music.playlistDialogTrackId || "";
    const track = trackId ? findKnownTrack(trackId) : null;
    const backdrop = document.createElement("div");
    backdrop.className = "music-playlist-dialog-backdrop";
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop && ownsDialog()) actions.closePlaylistDialog();
    });
    const dialog = document.createElement("section");
    dialog.className = "music-playlist-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", trackId ? "加入歌单" : "新建歌单");
    dialog.tabIndex = -1;
    const ownsDialog = () => backdrop.isConnected && state.activeView === "music" && state.music.playlistDialogOpen
      && state.music.playlistDialogTrackId === trackId && els.workGrid?.querySelector(".music-playlist-dialog-backdrop") === backdrop;
    const controls = () => [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled)")]
      .filter(control => control.getClientRects().length > 0 && control.tabIndex >= 0);
    const focusInside = () => (controls().find(control => control.tagName === "INPUT") || controls()[0] || dialog).focus({ preventScroll: true });
    const events = new AbortController();
    playlistDialogEvents = events;
    document.addEventListener("focusin", event => {
      if (ownsDialog() && !dialog.contains(event.target)) focusInside();
    }, { signal: events.signal });
    let composing = false;
    dialog.addEventListener("compositionstart", () => { if (ownsDialog()) composing = true; });
    dialog.addEventListener("compositionend", () => { composing = false; });
    dialog.addEventListener("keydown", event => {
      if (!ownsDialog() || event.defaultPrevented) return;
      if (composing || event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        actions.closePlaylistDialog();
      } else if (event.key === "Tab") {
        const available = controls();
        const first = available[0], last = available[available.length - 1];
        if (!first || (event.shiftKey ? document.activeElement === first : document.activeElement === last)
            || document.activeElement === dialog) {
          event.preventDefault();
          (event.shiftKey ? last || dialog : first || dialog).focus({ preventScroll: true });
        }
      }
    });
    const head = document.createElement("div");
    head.className = "music-playlist-dialog-head";
    const title = document.createElement("strong");
    title.textContent = trackId ? "加入歌单" : "新建歌单";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "music-control-button";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", () => { if (ownsDialog()) actions.closePlaylistDialog(); });
    head.append(title, close);
    dialog.append(head);
    if (track) {
      const preview = document.createElement("div");
      preview.className = "music-playlist-dialog-track";
      preview.append(h.renderCover(track, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = track.title || "未知歌曲";
      const small = document.createElement("small");
      small.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
      text.append(strong, small);
      preview.append(text);
      dialog.append(preview);
    }
    if (trackId && state.music.playlists.length) {
      const choices = document.createElement("div");
      choices.className = "music-playlist-dialog-list";
      for (const playlist of state.music.playlists) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "music-playlist-choice";
        button.dataset.musicPlaylistId = playlist.id;
        const strong = document.createElement("strong");
        strong.textContent = playlist.name;
        const small = document.createElement("small");
        small.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
        button.append(strong, small);
        button.addEventListener("click", () => { if (ownsDialog()) actions.addTrackToPlaylistTarget(playlist.id).catch(showError); });
        choices.append(button);
      }
      dialog.append(choices);
    }
    const form = document.createElement("form");
    form.className = "music-playlist-dialog-form";
    const input = document.createElement("input");
    input.type = "text";
    input.value = state.music.playlistDialogName || "";
    input.placeholder = "歌单名称";
    input.autofocus = true;
    input.addEventListener("input", () => {
      if (ownsDialog()) state.music.playlistDialogName = input.value;
    });
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "music-primary-button";
    submit.textContent = trackId ? "新建并加入" : "创建";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!ownsDialog() || composing) return;
      actions.createPlaylistFromDialog().catch(showError);
    });
    dialog.append(form);
    backdrop.append(dialog);
    return backdrop;
  }

  function refreshPlaylistDialog({ focus = true } = {}) {
    const shell = els.workGrid?.querySelector?.(".music-shell");
    if (!shell) return false;
    const previous = shell.querySelector(".music-playlist-dialog-backdrop");
    const previousFocus = capturePlaylistDialogFocus(previous);
    playlistDialogEvents?.abort();
    playlistDialogEvents = null;
    previous?.remove();
    if (!state.music.playlistDialogOpen) return true;
    const next = renderPlaylistDialog();
    shell.append(next);
    if (focus) restorePlaylistDialogFocus(next, previousFocus);
    return true;
  }

  function capturePlaylistDialogFocus(previous = els.workGrid?.querySelector(".music-playlist-dialog-backdrop")) {
    const focused = document.activeElement;
    const previousControl = previous?.contains(focused) ? focused : null;
    return { focused, previousControl, selection: previousControl?.matches("input") ? [previousControl.selectionStart, previousControl.selectionEnd] : null };
  }

  function restorePlaylistDialogFocus(next, { focused, previousControl, selection }) {
    if (!next?.isConnected || state.activeView !== "music" || !state.music.playlistDialogOpen
        || els.workGrid?.querySelector(".music-playlist-dialog-backdrop") !== next
        || (document.activeElement !== document.body && document.activeElement !== focused)) return;
    const input = next.querySelector(".music-playlist-dialog-form input");
    const target = previousControl?.dataset.musicPlaylistId
      ? [...next.querySelectorAll(".music-playlist-choice")].find(button => button.dataset.musicPlaylistId === previousControl.dataset.musicPlaylistId)
      : previousControl?.matches('button[type="submit"]') ? next.querySelector('button[type="submit"]')
        : previousControl?.getAttribute("aria-label") === "关闭" ? next.querySelector('[aria-label="关闭"]') : input;
    (target || input)?.focus({ preventScroll: true });
    if (selection && document.activeElement === input) input.setSelectionRange(...selection);
  }

  function refreshLibrarySidebars() {
    if (state.activeView !== "music") return;
    const renderKey = musicSidebarRenderKey();
    const embedded = els.workGrid?.querySelector?.(".music-sidebar.embedded");
    if (embedded && embedded.dataset.musicSidebarKey !== renderKey) {
      const scrollTop = embedded.scrollTop;
      const next = renderSidebar({ embedded: true });
      embedded.replaceWith(next);
      next.scrollTop = scrollTop;
    }
    const drawer = els.workGrid?.querySelector?.(".music-sidebar:not(.embedded)");
    if (drawer && drawer.dataset.musicSidebarKey !== renderKey) {
      const scrollTop = drawer.scrollTop;
      const next = renderSidebar();
      drawer.replaceWith(next);
      next.scrollTop = scrollTop;
    }
  }

  function findKnownTrack(trackId) {
    const tracks = [
      state.music.current,
      ...(state.music.queue || []),
      ...(state.music.data?.tracks || [])
    ].filter(Boolean);
    return tracks.find((track) => track.id === trackId) || null;
  }

  // ================= 播放 UI 更新 =================
  function updatePlaybackUi() {
    const audio = player.getAudio();
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.music.current?.durationMs || 0) / 1000;
    const current = Number(audio.currentTime || 0);
    const playing = Boolean(state.music.current && !audio.paused);
    state.music.playing = playing;
    player.updateMediaSession(duration, current);
    updatePlaybackControls(playing);
    if (state.activeView !== "music" || !currentProgressEls?.current?.isConnected) return;
    const currentLabel = formatSeconds(current);
    const totalLabel = formatSeconds(duration);
    const progressValue = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
    if (currentProgressEls.current.textContent !== currentLabel) currentProgressEls.current.textContent = currentLabel;
    if (currentProgressEls.total.textContent !== totalLabel) currentProgressEls.total.textContent = totalLabel;
    if (currentProgressEls.progress.value !== progressValue) currentProgressEls.progress.value = progressValue;
  }

  function registerPlaybackButton(button, kind = "icon") {
    if (button) playbackButtonEls.push({ button, kind });
    return button;
  }

  function registerShuffleControl(button) {
    if (button) shuffleControlEls.push(button);
    updatePlaybackModeControls();
    return button;
  }

  function registerRepeatControl(button) {
    if (button) repeatControlEls.push(button);
    updatePlaybackModeControls();
    return button;
  }

  function updatePlaybackModeControls() {
    const shuffleLabel = state.music.shuffle ? "随机播放已开启" : "随机播放已关闭";
    for (const button of shuffleControlEls) {
      if (!button) continue;
      button.classList.toggle("active", state.music.shuffle);
      button.setAttribute("aria-pressed", String(state.music.shuffle));
      if (button.getAttribute("aria-label") !== shuffleLabel) button.setAttribute("aria-label", shuffleLabel);
      if (button.title !== shuffleLabel) button.title = shuffleLabel;
    }
    const repeatText = repeatLabelLocal(state.music.repeat);
    const repeatLabelText = `播放模式：${repeatText}`;
    for (const button of repeatControlEls) {
      if (!button) continue;
      if (button.textContent !== repeatText) button.textContent = repeatText;
      button.classList.toggle("active", state.music.repeat !== "none");
      button.dataset.repeatMode = state.music.repeat;
      if (button.getAttribute("aria-label") !== repeatLabelText) button.setAttribute("aria-label", repeatLabelText);
      if (button.title !== repeatLabelText) button.title = repeatLabelText;
    }
  }

  function createPlaybackErrorElement() {
    const error = document.createElement("em");
    error.className = "music-player-error";
    error.setAttribute("role", "status");
    error.setAttribute("aria-live", "polite");
    error.textContent = state.music.playbackError;
    error.hidden = !state.music.playbackError;
    playbackErrorEls.push(error);
    return error;
  }

  function setPlaybackError(message = "") {
    const text = String(message || "").trim();
    state.music.playbackError = text;
    for (const error of playbackErrorEls) {
      if (!error?.isConnected) continue;
      if (error.textContent !== text) error.textContent = text;
      error.hidden = !text;
    }
  }

  function registerCurrentTrackIndicator(element, trackId, idleLabel, playingLabel) {
    if (!element || !trackId) return element;
    const indicators = currentTrackIndicatorMap.get(trackId) || [];
    indicators.push({ element, idleLabel, playingLabel });
    currentTrackIndicatorMap.set(trackId, indicators);
    return element;
  }

  function registerMusicTrackElement(element, trackId) {
    if (!element || !trackId) return element;
    element.dataset.musicTrackId = trackId;
    const elements = musicTrackElementMap.get(trackId) || [];
    elements.push(element);
    musicTrackElementMap.set(trackId, elements);
    return element;
  }

  function unregisterMusicTrackElements(container) {
    if (!container) return;
    const trackIds = new Set(
      [...container.querySelectorAll("[data-music-track-id]")]
        .map((element) => element.dataset.musicTrackId)
        .filter(Boolean)
    );
    for (const trackId of trackIds) {
      const elements = (musicTrackElementMap.get(trackId) || [])
        .filter((element) => element?.isConnected && !container.contains(element));
      if (elements.length) musicTrackElementMap.set(trackId, elements);
      else musicTrackElementMap.delete(trackId);
    }
  }

  function updatePlaybackControls(playing) {
    const label = playAriaLabelLocal(playing);
    for (const { button, kind } of playbackButtonEls) {
      if (!button?.isConnected) continue;
      if (kind === "text") {
        const text = playing ? "暂停" : "播放";
        if (button.textContent !== text) button.textContent = text;
      } else {
        h.setControlButtonIcon(button, playing ? "pause" : "play");
      }
      if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
      if (button.title !== label) button.title = label;
    }
    const currentTrackId = state.music.current?.id || "";
    for (const indicator of currentTrackIndicatorMap.get(currentTrackId) || []) {
      if (!indicator.element?.isConnected) continue;
      const text = playing ? indicator.playingLabel : indicator.idleLabel;
      if (indicator.element.textContent !== text) indicator.element.textContent = text;
    }
    for (const surface of playbackSurfaceEls) {
      if (surface?.isConnected) surface.classList.toggle("playing", playing);
    }
  }

  function updateSleepTimerUi() {
    const active = player.sleepTimerActive();
    const value = String(active ? state.music.sleepMinutes : 0);
    const text = active ? `${player.sleepTimerText()} 后暂停` : "未开启";
    for (const { select, status } of sleepTimerControlEls) {
      if (select?.isConnected && select.value !== value) select.value = value;
      if (status?.isConnected && status.textContent !== text) status.textContent = text;
    }
  }

  function refreshTrackMetadata(updated, { allowStage = true } = {}) {
    if (state.activeView !== "music" || !updated?.id) return;
    if (state.music.trackPageOpen || state.music.playerStageOpen) {
      if (allowStage) renderView();
      return;
    }
    const visibleTrack = (state.music.data?.tracks || []).find((track) => track.id === updated.id) || updated;
    const rows = new Set();
    for (const indicator of currentTrackIndicatorMap.get(updated.id) || []) {
      const row = indicator.element?.closest?.("[data-music-track-id]");
      if (row?.isConnected) rows.add(row);
    }
    for (const row of rows) {
      const secondary = row.querySelector(".music-track-title small");
      if (secondary) secondary.textContent = h.trackSecondaryText(visibleTrack);
    }
    const surfacedTrackId = state.music.current?.id || state.music.queue[0]?.id || "";
    if (surfacedTrackId === updated.id && !refreshCurrentTrackSurfaces(updated.id)) renderView();
    else if (surfacedTrackId !== updated.id && (state.music.queue || []).some(track => track.id === updated.id)
        && queueViews.get(els.workGrid?.querySelector(".music-queue"))?.model?.query) refreshQueueSurface();
  }

  // ================= 歌词 =================
  function updateLyricHighlight(force = false) {
    if (state.activeView !== "music" || lyricRaf || !lyricLineEls[0]?.isConnected) return;
    lyricRaf = window.requestAnimationFrame(() => {
      lyricRaf = 0;
      if (state.activeView !== "music" || !lyricLineEls[0]?.isConnected) return;
      const lines = state.music.lyrics?.lines || [];
      if (!lines.length) return;
      const audio = player.getAudio();
      if (!audio) return;
      const timeMs = Math.round((audio.currentTime || 0) * 1000);
      const index = findLyricIndex(lines, timeMs + 180);
      if (!force && index === currentLyricIndex) return;
      if (!state.music.lyricFollowPaused || force) lyricViewport?.show(index);
      currentLyricIndex = index;
      const nextActive = lyricLineEls[index - (lyricViewport?.startIndex || 0)] || null;
      if (activeLyricElement !== nextActive) activeLyricElement?.classList.remove("active");
      nextActive?.classList.add("active");
      activeLyricElement = nextActive;
      if (nextActive && (!state.music.lyricFollowPaused || force)) centerLyricLine(nextActive, force);
    });
  }

  function findLyricIndex(lines, timeMs, visibleCount = lines.length) {
    const length = Math.min(lines.length, Math.max(0, Number(visibleCount || 0)));
    if (!length) return -1;
    let low = 0;
    let high = length - 1;
    let result = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (Number(lines[middle]?.timeMs || 0) <= timeMs) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  function centerLyricLine(item, immediate = false) {
    const container = item?.closest?.(".music-lyric-lines");
    if (!container) return;
    if (immediate) container.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const targetTop = container.scrollTop + itemRect.top - containerRect.top - ((container.clientHeight - itemRect.height) / 2);
    container.scrollTo({ top: Math.max(0, targetTop), behavior: immediate ? "instant" : "smooth" });
  }

  function pauseLyricFollow(button = null) {
    if (state.music.lyricFollowPaused || !(state.music.lyrics?.lines || []).length) return;
    state.music.lyricFollowPaused = true;
    button?.classList.add("visible");
  }

  function resumeLyricFollow() {
    state.music.lyricFollowPaused = false;
    setLyricFollowButtonsVisible(false);
    updateLyricHighlight(true);
  }

  function setLyricFollowButtonsVisible(visible) {
    for (const button of lyricFollowButtonEls) {
      if (button?.isConnected) button.classList.toggle("visible", visible);
    }
  }

  // ================= 播放页 / 路由 =================
  async function openPlayerStage() {
    const navigation = resetReader();
    let openedTrack = null;
    if (!state.music.current && state.music.queue[0]?.id) {
      openedTrack = await actions.openTrack(state.music.queue[0].id, { autoplay: false, skipRoute: true });
      if (!openedTrack) return;
    }
    if (!actions.isNavigationCurrent(navigation) || !state.music.current || state.music.openingTrackId) return;
    if (openedTrack && openedTrack.id !== state.music.current.id) return;
    trackReturnContext = {
      route: router.overrides(),
      scroll: captureLibraryScroll()
    };
    state.music.trackPageOpen = true;
    state.music.playerStageOpen = false;
    pushRoute({ ...router.overrides(), musicTrackId: state.music.current.id });
    rememberTrackReturnHistory();
    window.scrollTo({ top: 0, behavior: "instant" });
    renderView();
  }

  function closePlayerStage() {
    state.music.playerStageOpen = false;
    renderView();
  }

  function closeTrackPage() {
    const returnContext = trackReturnContext;
    const navigation = resetReader();
    trackReturnContext = null;
    state.music.trackPageOpen = false;
    state.music.playerStageOpen = false;
    // Route-restored stages need their source read again. A live openPage
    // still owns any list response accepted while the song was being opened.
    if (returnContext?.fresh) state.music.data = null;
    replaceRoute({ ...(returnContext?.route || router.overrides()), musicTrackId: "" });
    renderView();
    restoreLibraryScroll(returnContext?.scroll, navigation);
    if (!state.music.data) actions.loadMusic({ skipRoute: true, keepCurrent: true, restoreLast: false }).catch(showError);
  }

  function currentTrackReturnHistoryOwner() {
    try {
      const account = captureWebAccount();
      if (!trackReturnHistoryAccount || account.owner !== trackReturnHistoryAccount.owner || account.revision !== trackReturnHistoryAccount.revision) {
        trackReturnHistoryAccount = account;
        trackReturnHistoryOwner = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
      }
      return trackReturnHistoryOwner;
    } catch {
      trackReturnHistoryAccount = null;
      trackReturnHistoryOwner = "";
      return "";
    }
  }

  function rememberTrackReturnHistory() {
    const owner = currentTrackReturnHistoryOwner();
    if (!owner || !trackReturnContext?.route || !state.music.trackPageOpen) return;
    // Only small route/scroll scalars belong to this history entry; no library
    // snapshots or account credentials survive a navigation through history.
    history.replaceState({ ...history.state, fanhaoMusicTrackReturn: {
      owner, route: trackReturnContext.route, scroll: trackReturnContext.scroll
    } }, "");
  }

  function readTrackReturnHistory(route) {
    if (!route.musicTrackId) return null;
    const saved = history.state?.fanhaoMusicTrackReturn;
    if (!saved?.owner || saved.owner !== currentTrackReturnHistoryOwner() || !saved.route) return null;
    return { route: saved.route, scroll: saved.scroll, fresh: true };
  }

  function captureLibraryScroll() {
    return {
      windowY: Math.max(0, Number(window.scrollY || 0)),
      sidebar: Math.max(0, Number(document.querySelector(".music-sidebar.embedded")?.scrollTop || 0)),
      tracks: Math.max(0, Number(document.querySelector(".music-track-panel")?.scrollTop || 0)),
      now: Math.max(0, Number(document.querySelector(".music-now-panel")?.scrollTop || 0))
    };
  }

  function restoreLibraryScroll(scroll, navigation) {
    if (!scroll) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    window.requestAnimationFrame(() => {
      if (!actions.isNavigationCurrent(navigation) || state.activeView !== "music" || state.music.trackPageOpen) return;
      window.scrollTo({ top: scroll.windowY || 0, behavior: "instant" });
      const targets = [
        [".music-sidebar.embedded", scroll.sidebar],
        [".music-track-panel", scroll.tracks],
        [".music-now-panel", scroll.now]
      ];
      for (const [selector, scrollTop] of targets) {
        const element = document.querySelector(selector);
        if (element) element.scrollTop = Math.max(0, Number(scrollTop || 0));
      }
    });
  }

  function installKeyboardShortcuts() {
    window.addEventListener("keydown", handleKeyboardShortcut);
  }

  function handleKeyboardShortcut(event) {
    if (event.defaultPrevented || state.activeView !== "music" || state.music.playlistDialogOpen) return;
    if (event.target?.closest?.(".music-favorite-feedback, .music-rating-feedback")) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape" && (state.music.trackPageOpen || state.music.openingTrackId)) {
      event.preventDefault();
      closeTrackPage();
      return;
    }
    if (event.key === "Escape" && state.music.libraryDrawerOpen) {
      event.preventDefault();
      closeLibraryDrawer();
      return;
    }
    if (event.key === "Escape" && state.music.playerStageOpen) {
      event.preventDefault();
      closePlayerStage();
      return;
    }
    if (isKeyboardShortcutTargetLocal(event.target)) return;
    if (event.code === "Space" || event.key === " " || event.key === "Space" || event.key === "Spacebar") {
      event.preventDefault();
      if (!event.repeat) actions.togglePlayback();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!state.music.current) return;
      event.preventDefault();
      const step = event.shiftKey ? MUSIC_KEYBOARD_FAST_SEEK_SECONDS : MUSIC_KEYBOARD_SEEK_SECONDS;
      player.seekRelative(event.key === "ArrowLeft" ? -step : step);
      void actions.claimProgressOwner();
    }
  }

  // ================= 本地辅助 =================
  function repeatLabelLocal(value) {
    if (value === "one") return "单曲";
    if (value === "none") return "顺序";
    return "循环";
  }

  function playAriaLabelLocal(playing) {
    return playing ? "暂停" : "播放";
  }

  function formatClockLocal(value) {
    const total = Math.max(0, Math.floor(Number(value || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function isKeyboardShortcutTargetLocal(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("input, textarea, select, button, a, [contenteditable='true']"));
  }

  function writeVolumePreferenceLocal(value) {
    try {
      window.localStorage?.setItem("fanhao.music.volume", String(value));
    } catch {}
  }

  return {
    applyRouteState,
    enter,
    loadMusic,
    openRouteTarget,
    openTrack: (id, options) => actions.openTrack(id, options),
    renderStats,
    renderView,
    resetReader
  };
}
