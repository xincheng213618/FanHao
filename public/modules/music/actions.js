// 音乐模块编排层（应用逻辑的唯一归属）。
// 视图层只调用这里暴露的方法；这里读取/写入 state.music、调用 api 与 player，
// 并通过 view 接口触发视图更新。不持有任何 DOM 渲染状态。
//
// 依赖（全部由组合根注入，单向）：
//   state    宿主全局状态（含 .music 与 .activeView）
//   api      createMusicApi(...) 返回的命名方法集合
//   player   createMusicPlayer(...) 返回的播放引擎
//   view     组合根提供的视图更新回调（refresh / 局部刷新 / loading 状态等）
//   router   路由写入 { push, replace, overrides }
//   showError 错误展示回调

import { ensureMusicState } from "./state.js";
import { collapseDuplicateTracks, compactTrack, normalizePlaybackSpeed, nextRepeat } from "./format.js";
import {
  writeLastTrackPreference,
  readLastTrackPreference,
  writeVolumePreference,
  writePlaybackSpeedPreference,
  writeRepeatPreference,
  writeShufflePreference
} from "./prefs.js";
import {
  MUSIC_PAGE_LIMIT,
  MUSIC_ARTIST_PAGE_LIMIT,
  MUSIC_ALBUM_PAGE_LIMIT
} from "./constants.js";
import { createMusicProgressWriter } from "./music-progress-writer.js?v=20261004-music-progress-01";
import { createMusicProgressSession, createMusicPlayedReport, musicProgressBody } from "./progress-session.js?v=20261004-music-progress-01";
import { captureWebAccount } from "../../platform/accounts/session-context.js";

export function createMusicActions({ state, api, player, view, router, showError }) {
  let musicLoadGeneration = 0;
  let musicLoadController = null;
  let musicLoadRequest = null;
  let trackOpenGeneration = 0;
  let trackOpenController = null;
  let trackOpenRestoreOwner = null;
  let navigationGeneration = 0;
  let foregroundGeneration = 0;
  let requestStatusOwner = null;
  const sideListRequests = { playlists: null, smartPlaylists: null };
  const sideListGenerations = { playlists: 0, smartPlaylists: 0 };
  let restoreAttemptKey = "";
  let playReportSession = 0;
  let lastProgressSavedAt = 0;
  let progressSession = null;
  let playedReport = null;
  let progressClockRequest = null;
  let progressHidden = false;
  let playlistDialogReturnFocus = null;

  const music = () => state.music;
  const progressWriter = createMusicProgressWriter({
    async send(record, played) {
      checkProgressAccount(record);
      const result = await api.setProgress(record.trackId, musicProgressBody(record, played));
      lastProgressSavedAt = Date.now();
      return result;
    },
    sendKeepalive(record, played) {
      checkProgressAccount(record);
      return api.setProgressKeepalive?.(record.trackId, musicProgressBody(record, played));
    },
    onError(error, record) {
      if (error?.code === "MUSIC_PROGRESS_SESSION_EXPIRED" && record?.trackId === music().current?.id
          && record.progressSessionId === progressSession?.id) {
        void refreshProgressClock();
      } else if (["MUSIC_PROGRESS_QUEUE_FULL", "MUSIC_PLAYED_QUEUE_FULL", "MUSIC_PROGRESS_KEEPALIVE_FULL", "MUSIC_PROGRESS_CAPACITY"].includes(error?.code)) {
        showError(error);
      }
    },
    onPlayed(record) {
      if (record.session === playReportSession && music().current?.id === record.trackId) {
        music().playReportedTrackId = record.trackId;
      }
    }
  });

  // Navigation owns pending reads only. Playback and progress writes keep their
  // existing lifetime when the user leaves a reader or changes the route.
  function cancelPendingRequests() {
    view.cancelNavigationTimers?.();
    navigationGeneration += 1;
    foregroundGeneration += 1;
    musicLoadGeneration += 1;
    trackOpenGeneration += 1;
    const hadList = Boolean(musicLoadController);
    const hadTrack = Boolean(trackOpenController);
    musicLoadController?.abort();
    trackOpenController?.abort();
    for (const kind of Object.keys(sideListRequests)) {
      sideListGenerations[kind] += 1;
      sideListRequests[kind]?.controller.abort();
      sideListRequests[kind] = null;
    }
    musicLoadController = null;
    musicLoadRequest = null;
    trackOpenController = null;
    if (trackOpenRestoreOwner) restoreAttemptKey = "";
    trackOpenRestoreOwner = null;
    if (state.music) {
      if (hadList) {
        music().loading = false;
        music().loadingMore = false;
        view.setMusicListLoadingState(false);
      }
      if (hadTrack) {
        music().openingTrackId = "";
        view.setTrackOpeningState("");
      }
      if (requestStatusOwner && music().status === requestStatusOwner.status) music().status = "";
    }
    requestStatusOwner = null;
    return navigationGeneration;
  }

  function beginNavigation() {
    return cancelPendingRequests();
  }

  function isNavigationCurrent(token) {
    return token === navigationGeneration;
  }

  function setRequestStatus(owner, status) {
    owner.status = status;
    requestStatusOwner = owner;
    music().status = status;
  }

  function settleRequestStatus(owner, status) {
    if (requestStatusOwner !== owner || music().status !== owner.status) return;
    music().status = status;
    requestStatusOwner = null;
  }

  function listSelectionKey() {
    return JSON.stringify([
      music().mode, musicListParams().toString(), music().artistSort,
      music().albumSort, music().letter, music().activePlaylistId, music().activeSmartPlaylistId
    ]);
  }

  function listOffset(artistMode, albumMode) {
    return artistMode ? music().data?.artists?.length || 0
      : albumMode ? music().data?.albums?.length || 0
        : music().data?.rawLoaded ?? music().data?.tracks?.length ?? 0;
  }

  function ownsMusicLoad(request) {
    return musicLoadRequest === request && request.generation === musicLoadGeneration
      && request.navigation === navigationGeneration && !request.controller.signal.aborted;
  }

  function isMusicLoadCurrent(request) {
    return ownsMusicLoad(request) && request.selection === listSelectionKey()
      && (!request.append || request.offset === listOffset(request.artistMode, request.albumMode));
  }

  function isForegroundCurrent(request) {
    return request.navigation === navigationGeneration && request.foreground === foregroundGeneration;
  }

  function cancelTrackRequest() {
    trackOpenGeneration += 1;
    if (trackOpenRestoreOwner) restoreAttemptKey = "";
    trackOpenRestoreOwner = null;
    if (!trackOpenController) return;
    trackOpenController.abort();
    trackOpenController = null;
    music().openingTrackId = "";
    view.setTrackOpeningState("");
    if (requestStatusOwner?.kind === "track") settleRequestStatus(requestStatusOwner, "");
  }

  // ---------- 列表加载 ----------
  function loadMusic(options = {}) {
    ensureMusicState(state);
    const artistMode = music().mode === "artists";
    const albumMode = music().mode === "albums";
    const append = Boolean(options.append && (music().mode === "library" || artistMode || albumMode));
    const selection = listSelectionKey();
    const offset = append ? listOffset(artistMode, albumMode) : 0;
    if (append && musicLoadRequest?.append && isMusicLoadCurrent(musicLoadRequest)
      && musicLoadRequest.selection === selection && musicLoadRequest.offset === offset) {
      return musicLoadRequest.promise;
    }
    if (!options.keepCurrent && !options.background && !append) {
      foregroundGeneration += 1;
      cancelTrackRequest();
    }
    const appendScrollTop = append ? Math.max(0, Number(document.querySelector(".music-track-panel")?.scrollTop || 0)) : 0;
    const generation = ++musicLoadGeneration;
    if (trackOpenRestoreOwner && trackOpenRestoreOwner === musicLoadRequest) cancelTrackRequest();
    musicLoadController?.abort();
    const controller = new AbortController();
    musicLoadController = controller;
    const request = {
      controller, generation, selection, offset, append, artistMode, albumMode,
      background: Boolean(options.background),
      navigation: navigationGeneration, foreground: foregroundGeneration
    };
    musicLoadRequest = request;
    request.promise = performMusicLoad(request, options, appendScrollTop);
    return request.promise;
  }

  async function performMusicLoad(request, options, appendScrollTop) {
    const { controller, append, artistMode, albumMode, background } = request;
    const signal = controller.signal;
    if (background) {
      const hadLoading = music().loading || music().loadingMore;
      music().loading = false;
      music().loadingMore = false;
      if (hadLoading) view.setMusicListLoadingState(false);
    } else {
      music().loading = !append;
      music().loadingMore = append;
      if (!trackOpenController) setRequestStatus(request, append ? "正在加载更多" : "正在读取音乐库");
      view.setMusicListLoadingState(true, { append });
    }
    const listsPromise = append ? Promise.resolve() : Promise.all([
      sideListCacheFresh(music().playlistsLoadedAt) ? Promise.resolve() : loadPlaylists(signal, request),
      sideListCacheFresh(music().smartPlaylistsLoadedAt) ? Promise.resolve() : loadSmartPlaylists(signal, request)
    ]);
    const params = musicListParams();
    params.set("limit", String(artistMode ? MUSIC_ARTIST_PAGE_LIMIT : albumMode ? MUSIC_ALBUM_PAGE_LIMIT : MUSIC_PAGE_LIMIT));
    if (append) {
      params.set("offset", String(request.offset));
    }
    let data;
    try {
      if (artistMode) {
        const artistParams = new URLSearchParams();
        artistParams.set("limit", String(MUSIC_ARTIST_PAGE_LIMIT));
        artistParams.set("sort", music().artistSort);
        if (append) artistParams.set("offset", params.get("offset") || "0");
        if (music().query) artistParams.set("q", music().query);
        if (music().language && music().language !== "all") artistParams.set("language", music().language);
        if (music().letter) artistParams.set("letter", music().letter);
        data = await api.getArtists(artistParams, signal);
      } else if (albumMode) {
        const albumParams = new URLSearchParams();
        albumParams.set("limit", String(MUSIC_ALBUM_PAGE_LIMIT));
        albumParams.set("sort", music().albumSort);
        if (append) albumParams.set("offset", params.get("offset") || "0");
        if (music().query) albumParams.set("q", music().query);
        if (music().language && music().language !== "all") albumParams.set("language", music().language);
        if (music().letter) albumParams.set("letter", music().letter);
        data = await api.getAlbums(albumParams, signal);
      } else if (music().mode === "history") {
        data = await api.getHistory(MUSIC_PAGE_LIMIT, signal);
      } else if (music().mode === "playlist" && music().activePlaylistId) {
        data = await api.getPlaylist(music().activePlaylistId, signal);
      } else if (music().mode === "smart" && music().activeSmartPlaylistId) {
        const smartParams = new URLSearchParams();
        smartParams.set("limit", String(MUSIC_PAGE_LIMIT));
        if (append) smartParams.set("offset", params.get("offset"));
        data = await api.getSmartPlaylist(music().activeSmartPlaylistId, smartParams, signal);
      } else if (music().mode === "report") {
        data = await api.getReport(signal);
      } else if (music().mode === "home") {
        data = await api.getHome(signal);
      } else {
        music().mode = "library";
        data = await api.getTracks(params, signal);
      }
      await listsPromise;
    } catch (error) {
      if (!isMusicLoadCurrent(request) || !isForegroundCurrent(request) || requestStatusOwner !== request) {
        finishMusicLoad(request);
        return;
      }
      music().loading = false;
      music().loadingMore = false;
      settleRequestStatus(request, error?.message || "音乐列表读取失败");
      finishMusicLoad(request);
      view.refresh();
      throw error;
    }
    if (!isMusicLoadCurrent(request)) {
      finishMusicLoad(request);
      return;
    }
    const incomingTracks = data.tracks || [];
    const previousRawTracks = append ? music().data?.rawTracks || music().data?.tracks || [] : [];
    const mergedRawTracks = append ? [...previousRawTracks, ...incomingTracks] : incomingTracks;
    const mergedTracks = music().mode === "library" && music().query
      ? collapseDuplicateTracks(mergedRawTracks)
      : mergedRawTracks;
    const previousArtists = append && artistMode ? music().data?.artists || [] : [];
    const mergedArtists = artistMode ? (append ? [...previousArtists, ...(data.artists || [])] : data.artists || []) : data.artists;
    const previousAlbums = append && albumMode ? music().data?.albums || [] : [];
    const mergedAlbums = albumMode ? (append ? [...previousAlbums, ...(data.albums || [])] : data.albums || []) : data.albums;
    music().data = artistMode
      ? { ...data, artists: mergedArtists, tracks: [] }
      : albumMode
        ? { ...data, albums: mergedAlbums, tracks: [] }
        : { ...data, tracks: mergedTracks, rawTracks: mergedRawTracks, rawLoaded: mergedRawTracks.length };
    music().summary = data.summary || music().summary;
    music().artists = mergedArtists || music().artists || [];
    music().albums = mergedAlbums || music().albums || [];
    music().genres = data.genres || music().genres || [];
    music().languages = data.languages || data.summary?.languages || music().languages || [];
    music().activePlaylist = data.playlist || null;
    music().activeSmartPlaylist = data.smartPlaylist || null;
    if (!background && !artistMode && !albumMode && !music().current && !trackOpenController && isForegroundCurrent(request)) music().queue = mergedTracks;
    music().loading = false;
    music().loadingMore = false;
    music().hasMore = Boolean(data.hasMore);
    settleRequestStatus(request, artistMode
      ? (data.total ? "" : "没有匹配的歌手")
      : albumMode
        ? (data.total ? "" : "没有匹配的专辑")
        : emptyMusicMessage(data.total || music().queue.length));
    const appendedInPlace = !background && append && isForegroundCurrent(request) && (
      artistMode
        ? view.appendArtistPage(data.artists || [], previousArtists.length)
        : albumMode
          ? view.appendAlbumPage(data.albums || [], previousAlbums.length)
          : !music().query && Boolean(music().current) && view.appendLibraryTrackPage(incomingTracks, previousRawTracks.length)
    );
    const restoreAllowed = !background && (options.restoreLast === true || (!options.keepCurrent && options.restoreLast !== false));
    if (!artistMode && !albumMode && restoreAllowed && isForegroundCurrent(request)) await restoreLastTrack(request);
    if (!ownsMusicLoad(request) || request.selection !== listSelectionKey()) {
      finishMusicLoad(request);
      return;
    }
    finishMusicLoad(request);
    if (background || !isForegroundCurrent(request)) return;
    view.renderStats();
    if (!appendedInPlace && !view.refreshMusicLibraryContent()) view.refresh();
    if (append && !appendedInPlace) view.restoreMusicPanelScroll(appendScrollTop);
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? router.replace : router.push;
      writer(router.overrides());
    }
  }

  function finishMusicLoad(request) {
    if (!ownsMusicLoad(request)) return;
    musicLoadController = null;
    musicLoadRequest = null;
    request.controller.abort();
    music().loading = false;
    music().loadingMore = false;
    settleRequestStatus(request, "");
    if (!request.background) view.setMusicListLoadingState(false);
  }

  function loadPlaylists(signal, owner) {
    return loadSideList("playlists", "playlistsLoadedAt", "getPlaylists", signal, owner);
  }

  function loadSmartPlaylists(signal, owner) {
    return loadSideList("smartPlaylists", "smartPlaylistsLoadedAt", "getSmartPlaylists", signal, owner);
  }

  async function loadSideList(kind, loadedAt, method, signal, owner) {
    ensureMusicState(state);
    sideListRequests[kind]?.controller.abort();
    const controller = new AbortController();
    const request = { controller, generation: ++sideListGenerations[kind], navigation: navigationGeneration };
    sideListRequests[kind] = request;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const isCurrent = () => !controller.signal.aborted && request.navigation === navigationGeneration
      && request.generation === sideListGenerations[kind] && sideListRequests[kind] === request
      && (!owner || ownsMusicLoad(owner));
    try {
      const data = await api[method](controller.signal);
      if (!isCurrent()) return false;
      music()[kind] = data[kind] || [];
      music()[loadedAt] = Date.now();
      return true;
    } catch {
      if (!isCurrent()) return false;
      music()[kind] = music()[kind] || [];
      return true;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (sideListRequests[kind] === request) sideListRequests[kind] = null;
    }
  }

  function sideListCacheFresh(loadedAt) {
    return Number(loadedAt || 0) > 0 && Date.now() - Number(loadedAt) < 60000;
  }

  // ---------- 打开单曲 ----------
  async function openTrack(trackId, options = {}) {
    ensureMusicState(state);
    if (!trackId) return null;
    const restoreOwner = options.restoreOwner;
    const restoring = Boolean(restoreOwner || options.restoreGuard);
    const restoreIsCurrent = () => (!restoreOwner || (isMusicLoadCurrent(restoreOwner) && isForegroundCurrent(restoreOwner)))
      && (!options.restoreGuard || options.restoreGuard());
    if (restoring && !restoreIsCurrent()) return null;
    if (!restoring) {
      foregroundGeneration += 1;
      view.cancelNavigationTimers?.();
    }
    cancelTrackRequest();
    const request = { kind: "track", navigation: navigationGeneration, foreground: foregroundGeneration };
    const previousTrackId = music().current?.id || "";
    if (music().current?.id === trackId && player.getAudio().src && !options.forceReload) {
      if (options.openPage) {
        music().trackPageOpen = true;
        music().playerStageOpen = false;
        view.refresh();
        if (!options.skipRoute) router.push({ ...router.overrides(), musicTrackId: trackId });
      }
      if (options.autoplay !== false) player.play();
      return music().current;
    }
    if (music().current?.id && music().current.id !== trackId) {
      saveProgressSoon(null, { immediate: true });
    }
    const generation = ++trackOpenGeneration;
    trackOpenController?.abort();
    const controller = new AbortController();
    trackOpenController = controller;
    trackOpenRestoreOwner = restoring ? restoreOwner || request : null;
    const isCurrent = () => {
      if (controller.signal.aborted || generation !== trackOpenGeneration) return false;
      return isForegroundCurrent(request) && restoreIsCurrent();
    };
    const discardStaleRequest = () => {
      if (trackOpenController !== controller || generation !== trackOpenGeneration) return;
      if (trackOpenRestoreOwner) restoreAttemptKey = "";
      trackOpenController = null;
      trackOpenRestoreOwner = null;
      music().openingTrackId = "";
      settleRequestStatus(request, "");
      view.setTrackOpeningState("");
    };
    music().openingTrackId = trackId;
    setRequestStatus(request, "正在打开歌曲");
    view.setTrackOpeningState(trackId);
    let data;
    try {
      data = await api.getTrack(trackId, musicListParams(), controller.signal);
    } catch (error) {
      if (!isCurrent()) {
        discardStaleRequest();
        return null;
      }
      music().openingTrackId = "";
      settleRequestStatus(request, error?.message || "歌曲打开失败");
      trackOpenController = null;
      trackOpenRestoreOwner = null;
      view.setTrackOpeningState("");
      if (state.activeView === "music") view.refresh();
      throw error;
    }
    if (!isCurrent()) {
      discardStaleRequest();
      return null;
    }
    if (!data?.track?.id) {
      music().openingTrackId = "";
      settleRequestStatus(request, "歌曲资料不完整");
      trackOpenController = null;
      trackOpenRestoreOwner = null;
      view.setTrackOpeningState("");
      if (state.activeView === "music") view.refresh();
      throw new Error(music().status);
    }
    music().current = data.track;
    music().lyrics = data.lyrics || { raw: "", lines: [] };
    music().prevId = data.prevId || "";
    music().nextId = data.nextId || "";
    music().openingTrackId = "";
    settleRequestStatus(request, "");
    playReportSession += 1;
    cancelProgressClock();
    progressSession = createMusicProgressSession(data.track.id, "", data.serverClockMs);
    playedReport = null;
    music().playReportedTrackId = "";
    music().lyricFollowPaused = false;
    music().libraryDrawerOpen = false;
    const shouldOpenPage = Boolean(options.openPage || music().trackPageOpen);
    music().trackPageOpen = shouldOpenPage;
    music().playerStageOpen = false;
    currentLyricIndexReset();
    if (!music().queue.length || !music().queue.some((track) => track.id === data.track.id)) {
      music().queue = [data.track];
    }
    rememberLastTrack(data.track);
    player.load(data.track, options.autoplay !== false);
    trackOpenController = null;
    trackOpenRestoreOwner = null;
    view.setTrackOpeningState("");
    if (state.activeView === "music") {
      if (shouldOpenPage || !view.refreshCurrentTrackSurfaces(previousTrackId)) view.refresh();
    }
    if (!options.skipRoute && shouldOpenPage) {
      router.push({ ...router.overrides(), musicTrackId: data.track.id });
    }
    return data.track;
  }

  let currentLyricIndexValue = -1;
  function currentLyricIndexReset() {
    currentLyricIndexValue = -1;
  }

  function openTrackFromList(track, tracks = [], options = {}) {
    const item = normalizeQueueTrack(track);
    if (!item) return Promise.resolve(null);
    const source = uniqueQueueTracks(tracks);
    music().queue = source.some((candidate) => candidate.id === item.id) ? source : [item];
    music().queueVisibleLimit = 120;
    return openTrack(item.id, options);
  }

  function uniqueQueueTracks(tracks = []) {
    const seen = new Set();
    const result = [];
    for (const track of tracks || []) {
      const item = normalizeQueueTrack(track);
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result;
  }

  function normalizeQueueTrack(track) {
    if (!track?.id) return null;
    return {
      ...track,
      title: track.title || track.fileName || "未知歌曲",
      artist: track.artist || "未知歌手",
      album: track.album || "未知专辑"
    };
  }

  function withoutQueueTrack(queue, trackId) {
    return (queue || []).filter((track) => track.id !== trackId);
  }

  // ---------- 队列操作 ----------
  function queueTrackNext(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const currentId = music().current?.id || "";
    const queue = withoutQueueTrack(music().queue || [], item.id);
    const currentIndex = currentId ? queue.findIndex((entry) => entry.id === currentId) : -1;
    queue.splice(currentIndex >= 0 ? currentIndex + 1 : 0, 0, item);
    music().queue = queue;
    music().status = `下一首播放「${item.title || "歌曲"}」`;
    view.refreshQueueSurface();
  }

  function appendTrackToQueue(track) {
    const item = normalizeQueueTrack(track);
    if (!item) return;
    const queue = withoutQueueTrack(music().queue || [], item.id);
    queue.push(item);
    music().queue = queue;
    music().status = `已加入队列「${item.title || "歌曲"}」`;
    view.refreshQueueSurface();
  }

  function moveQueueTrack(trackId, direction) {
    const previousQueue = [...(music().queue || [])];
    const queue = [...previousQueue];
    const index = queue.findIndex((track) => track.id === trackId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= queue.length) return;
    const [item] = queue.splice(index, 1);
    queue.splice(nextIndex, 0, item);
    music().queue = queue;
    music().status = `已调整「${item.title || "歌曲"}」顺序`;
    view.refreshQueueSurface();
    persistPlaylistQueueOrder(queue).catch((error) => {
      music().queue = previousQueue;
      view.refreshQueueSurface();
      showError(error);
    });
  }

  function removeTrackFromQueue(trackId) {
    if (!trackId || music().current?.id === trackId) return;
    const queue = music().queue || [];
    const removed = queue.find((track) => track.id === trackId);
    music().queue = queue.filter((track) => track.id !== trackId);
    music().status = removed ? `已移出队列「${removed.title || "歌曲"}」` : "已更新队列";
    view.refreshQueueSurface();
  }

  function clearQueueAfterCurrent() {
    const current = music().current;
    const removable = queueRemovableCount();
    if (removable <= 0) return;
    const ok = window.confirm(current
      ? `清空队列中的其他 ${formatNumberSafe(removable)} 首歌曲？`
      : `清空播放队列中的 ${formatNumberSafe(removable)} 首歌曲？`);
    if (!ok) return;
    if (!current) {
      music().queue = [];
    } else {
      music().queue = (music().queue || []).filter((track) => track.id === current.id);
    }
    music().queueVisibleLimit = 120;
    music().status = current ? "已清空其他队列歌曲" : "已清空播放队列";
    view.refreshQueueSurface();
  }

  function queueRemovableCount() {
    const queue = music().queue || [];
    if (!music().current) return queue.length;
    return queue.filter((track) => track.id !== music().current.id).length;
  }

  function queueTrackIds() {
    return uniqueTrackIds(music().queue || []);
  }

  async function persistPlaylistQueueOrder(queue = music().queue || []) {
    const playlistId = music().mode === "playlist" ? String(music().activePlaylistId || "").trim() : "";
    if (!playlistId) return null;
    const trackIds = uniqueTrackIds(queue);
    if (!trackIds.length) return null;
    const data = await api.reorderPlaylist(playlistId, { trackIds });
    music().activePlaylist = data.playlist || music().activePlaylist;
    if (music().data?.playlist?.id === playlistId) music().data.playlist = data.playlist || music().data.playlist;
    music().status = "歌单顺序已保存";
    return data;
  }

  function uniqueTrackIds(queue = []) {
    const seen = new Set();
    const result = [];
    for (const track of queue || []) {
      const id = String(track?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  // ---------- 播放控制 ----------
  async function playAdjacent(direction, options = {}) {
    ensureMusicState(state);
    const queue = music().queue || [];
    if (!queue.length) return;
    if (music().shuffle && queue.length > 1) {
      const candidates = queue.filter((track) => track.id !== music().current?.id);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (target) await openTrack(target.id, { autoplay: options.autoplay !== false });
      return;
    }
    const currentIndex = queue.findIndex((track) => track.id === music().current?.id);
    let nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= queue.length) {
      if (!options.wrap) return;
      nextIndex = nextIndex < 0 ? queue.length - 1 : 0;
    }
    const target = queue[nextIndex] || queue[0];
    if (target) await openTrack(target.id, { autoplay: options.autoplay !== false });
  }

  function togglePlayback() {
    ensureMusicState(state);
    if (!music().current) {
      const first = music().queue[0];
      if (first) openTrack(first.id, { autoplay: true }).catch(showError);
      return;
    }
    const audio = player.getAudio();
    if (audio.paused) player.play();
    else player.pause();
  }

  function setPlaybackSpeed(value) {
    const speed = normalizePlaybackSpeed(value);
    music().playbackSpeed = speed;
    player.setRate(speed);
    writePlaybackSpeedPreference(speed);
    view.updatePlaybackUi();
  }

  function setSleepTimer(minutes) {
    player.setSleepTimer(minutes);
  }

  function toggleShuffleMode() {
    music().shuffle = !music().shuffle;
    writeShufflePreference(music().shuffle);
    view.updatePlaybackModeControls();
  }

  function cycleRepeatMode() {
    music().repeat = nextRepeat(music().repeat);
    writeRepeatPreference(music().repeat);
    view.updatePlaybackModeControls();
  }

  // ---------- 收藏 / 评分 ----------
  function applyTrackUpdate(updated) {
    if (music().current?.id === updated.id) music().current = { ...music().current, ...updated };
    music().queue = (music().queue || []).map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    if (music().data?.tracks) {
      music().data.tracks = music().data.tracks.map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    }
  }

  function trackMetadataRequiresReload(kind) {
    if (music().mode === "smart") return true;
    if (kind === "favorite" && (music().favorite || music().sort === "favorite")) return true;
    if (kind === "rating" && music().sort === "rating") return true;
    return false;
  }

  async function toggleFavorite(trackId) {
    const id = String(trackId || "").trim();
    if (!id) return;
    const source = music().current?.id === id
      ? music().current
      : (music().queue || []).find((track) => track.id === id)
        || (music().data?.tracks || []).find((track) => track.id === id);
    const data = await api.setFavorite(id, !Boolean(source?.favorite));
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    if (trackMetadataRequiresReload("favorite")) await loadMusic({ replaceRoute: true, keepCurrent: true });
    else view.refreshTrackMetadata(updated);
  }

  async function setTrackRating(trackId, rating) {
    const data = await api.setRating(trackId, rating);
    const updated = data.track;
    if (!updated) return;
    applyTrackUpdate(updated);
    if (trackMetadataRequiresReload("rating")) await loadMusic({ replaceRoute: true, keepCurrent: true });
    else view.refreshTrackMetadata(updated);
  }

  // ---------- 下载 ----------
  function downloadTrack(track) {
    if (!track?.downloadUrl) return;
    const link = document.createElement("a");
    link.href = new URL(track.downloadUrl, window.location.href).href;
    link.download = track.fileName || track.title || "music";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function downloadPlaylistM3u(playlist) {
    if (!playlist?.id) return;
    const href = playlist.exportUrl || `/api/music/playlists/${encodeURIComponent(playlist.id)}/export.m3u8`;
    const link = document.createElement("a");
    link.href = new URL(href, window.location.href).href;
    link.download = `${playlist.name || "playlist"}.m3u8`;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  // ---------- 模式切换 ----------
  function selectMusicMode(mode, options = {}) {
    ensureMusicState(state);
    beginNavigation();
    view.clearMusicSuggestions();
    music().mode = mode;
    music().activePlaylistId = mode === "playlist" ? options.playlistId || "" : "";
    music().activeSmartPlaylistId = mode === "smart" ? options.smartId || "" : "";
    music().activePlaylist = null;
    music().activeSmartPlaylist = null;
    music().playlistDialogOpen = false;
    music().playlistDialogTrackId = "";
    music().playlistDialogName = "";
    music().favorite = mode === "library" ? Boolean(options.favorite) : false;
    if (mode === "library") {
      music().artistId = options.artistId || "all";
      music().albumId = options.albumId || "all";
      music().genre = options.genre || "all";
      if (options.language) music().language = options.language;
    }
    if (mode !== "library") {
      music().query = "";
      music().artistId = "all";
      music().albumId = "all";
      music().genre = "all";
    }
    loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
  }

  function selectGenre(genre) {
    ensureMusicState(state);
    beginNavigation();
    view.clearMusicSuggestions();
    music().mode = "library";
    music().favorite = false;
    music().activePlaylistId = "";
    music().activeSmartPlaylistId = "";
    music().artistId = "all";
    music().albumId = "all";
    music().genre = String(genre || "").trim() || "all";
    loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
  }

  function selectFirstSmartPlaylist() {
    const smart = (music().smartPlaylists || []).find((item) => item?.id);
    if (smart) {
      selectMusicMode("smart", { smartId: smart.id });
      return;
    }
    const navigation = beginNavigation();
    const foreground = foregroundGeneration;
    loadSmartPlaylists()
      .then((loadedCurrent) => {
        if (!loadedCurrent || !isNavigationCurrent(navigation) || foreground !== foregroundGeneration) return;
        const loaded = (music().smartPlaylists || []).find((item) => item?.id);
        if (loaded) selectMusicMode("smart", { smartId: loaded.id });
        else view.refresh();
      })
      .catch(showError);
  }

  async function openPlaylistDialog(trackId = "") {
    ensureMusicState(state);
    playlistDialogReturnFocus = document.activeElement?.isConnected ? document.activeElement : null;
    music().playlistDialogOpen = true;
    music().playlistDialogTrackId = trackId || "";
    music().playlistDialogName = "";
    if (state.activeView === "music" && !view.refreshPlaylistDialog()) view.refresh();
    const requestedTrackId = music().playlistDialogTrackId;
    const navigation = navigationGeneration;
    const loadedCurrent = await loadPlaylists();
    if (loadedCurrent && isNavigationCurrent(navigation) && music().playlistDialogOpen
      && music().playlistDialogTrackId === requestedTrackId) view.refreshPlaylistDialog();
  }

  function closePlaylistDialog() {
    const returnFocus = playlistDialogReturnFocus;
    playlistDialogReturnFocus = null;
    music().playlistDialogOpen = false;
    music().playlistDialogTrackId = "";
    music().playlistDialogName = "";
    if (state.activeView === "music" && !view.refreshPlaylistDialog({ focus: false })) view.refresh();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  // ---------- 歌单 ----------
  async function createPlaylistFromDialog() {
    const name = String(music().playlistDialogName || "").trim();
    if (!name) return null;
    const trackId = music().playlistDialogTrackId || "";
    closePlaylistDialog();
    music().status = "正在创建歌单";
    const data = await api.createPlaylist({ name, ...(trackId ? { trackIds: [trackId] } : {}) });
    await loadPlaylists();
    if (data.playlist?.id) {
      music().mode = "playlist";
      music().activePlaylistId = data.playlist.id;
      music().favorite = false;
      music().query = "";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refresh();
    }
    return data.playlist || null;
  }

  async function saveQueueAsPlaylist() {
    const trackIds = queueTrackIds();
    if (!trackIds.length) {
      music().status = "播放队列为空";
      view.refresh();
      return null;
    }
    const name = window.prompt("歌单名称", defaultQueuePlaylistName());
    const clean = String(name || "").trim();
    if (!clean) return null;
    music().status = "正在保存播放队列";
    view.refresh();
    const data = await api.createPlaylist({
      name: clean,
      description: "从播放队列保存",
      trackIds
    });
    await loadPlaylists();
    if (data.playlist?.id) {
      music().mode = "playlist";
      music().activePlaylistId = data.playlist.id;
      music().favorite = false;
      music().query = "";
      music().artistId = "all";
      music().albumId = "all";
      music().genre = "all";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      music().status = "播放队列已保存";
      view.refresh();
    }
    return data.playlist || null;
  }

  async function importPlaylistM3uFromPrompt() {
    const value = window.prompt("输入 .m3u/.m3u8 文件路径，或粘贴 #EXTM3U 内容", "");
    const source = String(value || "").trim();
    if (!source) return null;
    music().status = "正在导入 M3U 歌单";
    view.refresh();
    const body = source.includes("\n") || source.toUpperCase().startsWith("#EXTM3U")
      ? { content: source }
      : { path: source };
    const data = await api.importM3u(body);
    await loadPlaylists();
    if (data.playlist?.id) {
      const summary = data.importSummary || {};
      music().status = `已导入歌单：匹配 ${formatNumberSafe(summary.matched || 0)} 首，缺失 ${formatNumberSafe(summary.missing || 0)} 项`;
      music().mode = "playlist";
      music().activePlaylistId = data.playlist.id;
      music().favorite = false;
      music().query = "";
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refresh();
    }
    return data.playlist || null;
  }

  async function editActivePlaylist() {
    const playlist = music().activePlaylist;
    if (!playlist?.id) return null;
    const name = window.prompt("歌单名称", playlist.name || "");
    if (name === null) return null;
    const cleanName = String(name || "").trim();
    if (!cleanName) return null;
    const description = window.prompt("歌单说明", playlist.description || "");
    if (description === null) return null;
    const data = await api.updatePlaylist(playlist.id, {
      name: cleanName,
      description: String(description || "").trim()
    });
    music().activePlaylist = data.playlist || music().activePlaylist;
    await loadPlaylists();
    await loadMusic({ replaceRoute: true, keepCurrent: true });
    return data.playlist || null;
  }

  async function addTrackToPlaylistTarget(playlistId) {
    const trackId = music().playlistDialogTrackId;
    const playlist = (music().playlists || []).find((item) => item.id === playlistId);
    if (!trackId || !playlist?.id) return;
    closePlaylistDialog();
    music().status = `正在加入「${playlist.name}」`;
    await api.addTrackToPlaylist(playlist.id, { trackId });
    music().status = `已加入「${playlist.name}」`;
    await loadPlaylists();
    if (music().mode === "playlist" && music().activePlaylistId === playlist.id) {
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refreshLibrarySidebars();
    }
  }

  async function removeTrackFromActivePlaylist(trackId) {
    if (!music().activePlaylistId) return;
    await api.removeTrackFromPlaylist(music().activePlaylistId, trackId);
    music().status = "已移出歌单";
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function deleteActivePlaylist() {
    const playlist = music().activePlaylist;
    if (!playlist?.id) return;
    if (!window.confirm(`删除歌单「${playlist.name}」？歌曲文件不会被删除。`)) return;
    await api.deletePlaylist(playlist.id);
    music().mode = "library";
    music().activePlaylistId = "";
    music().activePlaylist = null;
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function clearHistory() {
    if (!window.confirm("清空最近播放记录？播放进度和收藏会保留。")) return;
    await api.clearHistory();
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function startMusicRescan() {
    ensureMusicState(state);
    const rootText = (music().summary?.roots || music().data?.summary?.roots || [])
      .map((root) => root.path)
      .filter(Boolean)
      .join("\n") || "D:\\Music";
    music().rescanning = true;
    music().status = "正在启动音乐库刷新";
    view.refresh();
    try {
      await api.runScript({
        scriptId: "music-library-rescan",
        options: { roots: rootText, limit: 0, dryRun: false }
      });
      music().status = "音乐库刷新已启动，后台作业完成后会自动更新。";
      router.openAdminScript("music-library-rescan");
    } catch (error) {
      music().status = error?.message || "音乐库刷新启动失败";
    } finally {
      music().rescanning = false;
      view.refresh();
    }
  }

  // ---------- 进度保存 ----------
  function reportPlayedOnce() {
    // Every explicit play can reclaim ownership from another document. The
    // original played receipt remains stable across pause/resume and retries.
    void refreshProgressClock();
    const record = captureProgressRecord();
    const reportKey = record ? `${playReportSession}:${record.trackId}` : "";
    if (!record || music().playReportedTrackId === record.trackId) return;
    playedReport ||= createMusicPlayedReport(progressSession);
    progressWriter.reportPlayed({ ...record, ...playedReport, reportKey, session: playReportSession });
  }

  function captureProgressRecord(positionOverride = null) {
    const track = music().current;
    const audio = player.getAudio();
    if (!track || !audio) return null;
    const account = captureWebAccount();
    const record = {
      trackId: track.id,
      webAccountOwner: account.owner,
      webAccountRevision: account.revision,
      positionMs: positionOverride === null
        ? Math.round((Number.isFinite(audio.currentTime) ? audio.currentTime : 0) * 1000)
        : Number(positionOverride || 0),
      durationMs: Math.round((Number.isFinite(audio.duration) ? audio.duration : 0) * 1000) || track.durationMs || 0
    };
    return progressSession?.trackId === track.id ? progressSession.capture(record) : record;
  }

  function cancelProgressClock() {
    progressClockRequest?.controller.abort();
    progressClockRequest = null;
  }

  function checkProgressAccount(record) {
    const account = captureWebAccount();
    if (account.owner !== record.webAccountOwner || account.revision !== record.webAccountRevision) {
      throw Object.assign(new Error("账号已切换，请重新操作"), { code: "ACCOUNT_CHANGED", statusCode: 409 });
    }
  }

  async function refreshProgressClock() {
    const trackId = music().current?.id;
    if (!trackId || progressHidden || typeof api.claimProgressSession !== "function") return;
    if (progressClockRequest?.trackId === trackId && progressClockRequest.session === playReportSession) return;
    cancelProgressClock();
    const request = { trackId, session: playReportSession, controller: new AbortController() };
    progressClockRequest = request;
    try {
      const data = await api.claimProgressSession(trackId, progressSession?.id, request.controller.signal);
      if (progressClockRequest !== request || request.controller.signal.aborted || progressHidden
          || request.session !== playReportSession || music().current?.id !== trackId) return;
      const next = createMusicProgressSession(trackId, "", data?.progressSessionStartedAt, data?.progressSessionId);
      if (!next) return;
      if (next.id !== progressSession?.id) progressSession = next;
      saveProgressSoon(null, { immediate: true });
    } catch {
      // Retain the captured owner; a failed refresh must not relabel old work.
    } finally {
      if (progressClockRequest === request) progressClockRequest = null;
    }
  }

  function flushProgressKeepalive() {
    progressHidden = true;
    cancelProgressClock();
    progressWriter.flushKeepalive(captureProgressRecord());
  }

  function resumeProgress() {
    progressHidden = false;
    progressWriter.resume();
  }

  function saveProgressSoon(positionOverride = null, { immediate = false } = {}) {
    const record = captureProgressRecord(positionOverride);
    if (!record) return;
    const elapsed = Date.now() - lastProgressSavedAt;
    const delay = Math.max(700, 10000 - Math.max(0, elapsed));
    progressWriter.save(record, { immediate, delayMs: delay });
  }

  // ---------- 恢复上次播放 ----------
  async function restoreLastTrack(owner) {
    const navigation = navigationGeneration;
    const foreground = foregroundGeneration;
    const isCurrent = () => navigation === navigationGeneration && foreground === foregroundGeneration
      && (!owner || isMusicLoadCurrent(owner));
    if (!isCurrent() || !canRestoreLastTrack()) return;
    const saved = readLastTrackPreference();
    const trackId = String(saved?.trackId || "").trim();
    if (!trackId) return;
    const key = trackId;
    if (restoreAttemptKey === key) return;
    restoreAttemptKey = key;
    if (saved.track?.id === trackId && !(music().queue || []).some((track) => track.id === trackId)) {
      music().queue = [normalizeQueueTrack(saved.track), ...(music().queue || [])].filter(Boolean);
    }
    try {
      await openTrack(trackId, { autoplay: false, skipRoute: true, restoreGuard: isCurrent, ...(owner ? { restoreOwner: owner } : {}) });
    } catch {
      if (!isCurrent()) return;
      music().queue = withoutQueueTrack(music().queue || [], trackId);
      music().loading = false;
      music().status = emptyMusicMessage(music().data?.total || music().queue.length);
      writeLastTrackPreference({});
    }
  }

  function canRestoreLastTrack() {
    if (music().current || music().loading || music().openingTrackId) return false;
    if (music().mode !== "home") return false;
    return !music().query
      && music().artistId === "all"
      && music().albumId === "all"
      && music().genre === "all"
      && !music().favorite
      && !music().activePlaylistId
      && !music().activeSmartPlaylistId;
  }

  function rememberLastTrack(track) {
    if (!track?.id) return;
    writeLastTrackPreference({
      trackId: track.id,
      track: compactTrack(track),
      updatedAt: new Date().toISOString()
    });
  }

  // ---------- 文本 / 路由辅助（供视图层复用）----------
  function musicListParams() {
    const params = new URLSearchParams();
    if (music().mode === "playlist" && music().activePlaylistId) params.set("playlist", music().activePlaylistId);
    if (music().mode === "smart" && music().activeSmartPlaylistId) params.set("smart", music().activeSmartPlaylistId);
    if (music().query) params.set("q", music().query);
    if (music().artistId && music().artistId !== "all") params.set("artist", music().artistId);
    if (music().albumId && music().albumId !== "all") params.set("album", music().albumId);
    if (music().genre && music().genre !== "all") params.set("genre", music().genre);
    if (music().language && music().language !== "all") params.set("language", music().language);
    if (music().sort && music().sort !== "album") params.set("sort", music().sort);
    if (music().favorite) params.set("favorite", "1");
    return params;
  }

  function currentMusicTitle() {
    if (music().mode === "home") return "发现";
    if (music().mode === "report") return "听歌报告";
    if (music().mode === "artists") return "歌手浏览";
    if (music().mode === "albums") return "专辑浏览";
    if (music().mode === "history") return "最近播放";
    if (music().mode === "playlist") return music().activePlaylist?.name || "歌单";
    if (music().mode === "smart") return music().activeSmartPlaylist?.name || "智能歌单";
    if (music().favorite) return "我喜欢";
    if (music().genre && music().genre !== "all") return music().genre;
    if (music().albumId && music().albumId !== "all") {
      return music().albums.find((album) => album.id === music().albumId)?.title || "专辑";
    }
    if (music().artistId && music().artistId !== "all") {
      return music().artists.find((artist) => artist.id === music().artistId)?.name || "歌手";
    }
    if (music().language && music().language !== "all") return `${music().language}音乐`;
    return "全部歌曲";
  }

  function currentMusicMeta() {
    const total = music().data?.total ?? music().queue.length;
    const count = `${formatNumberSafe(total || 0)} 首`;
    if (music().mode === "home") return `${count} · 快速入口`;
    if (music().mode === "report") return `${formatNumberSafe(music().data?.counts?.plays || 0)} 次播放 · 听歌统计`;
    if (music().mode === "artists") return `${formatNumberSafe(music().data?.total || 0)} 位歌手`;
    if (music().mode === "albums") return `${formatNumberSafe(music().data?.total || 0)} 张专辑`;
    if (music().mode === "playlist") return `${count} · 自建歌单`;
    if (music().mode === "smart") return `${count} · ${music().activeSmartPlaylist?.description || "动态规则"}`;
    if (music().mode === "history") return `${count} · 按最近播放排序`;
    if (music().data?.relevance) {
      const visible = Number(music().data?.tracks?.length || 0);
      return visible && visible < Number(total || 0)
        ? `${formatNumberSafe(visible)} 首 · ${count.replace(" 首", " 个文件")} · 按匹配度`
        : `${count} · 按匹配度`;
    }
    if (music().favorite) return `${count} · 收藏歌曲`;
    if (music().language && music().language !== "all") return `${count} · ${music().language}歌手`;
    if (music().genre && music().genre !== "all") return `${count} · 风格`;
    return `${count} · ${sortLabelSafe(music().sort)}`;
  }

  function emptyMusicMessage(total) {
    if (total) return "";
    if (music().mode === "home") return "这里还没有音乐，先运行“刷新音乐库”。";
    if (music().mode === "report") return "还没有听歌统计，先播放几首歌。";
    if (music().mode === "history") return "还没有最近播放，先听一首歌。";
    if (music().mode === "playlist") return "这个歌单还没有歌曲，先从右侧当前歌曲加入。";
    if (music().mode === "smart") return "这个智能歌单当前没有匹配歌曲。";
    if (music().genre && music().genre !== "all") return "这个风格下没有歌曲。";
    if (music().favorite) return "还没有收藏歌曲。";
    return "这里还没有音乐，先运行“刷新音乐库”。";
  }

  function musicRouteOverrides() {
    return {
      view: "music",
      musicMode: music().mode || "home",
      musicPlaylistId: music().mode === "playlist" ? music().activePlaylistId || "" : "",
      musicSmartId: music().mode === "smart" ? music().activeSmartPlaylistId || "" : "",
      musicArtistId: music().artistId && music().artistId !== "all" ? music().artistId : "",
      musicAlbumId: music().albumId && music().albumId !== "all" ? music().albumId : "",
      musicGenre: music().genre && music().genre !== "all" ? music().genre : "",
      musicLanguage: music().language && music().language !== "all" ? music().language : "",
      musicTrackId: "",
      musicQuery: music().query || "",
      musicSort: music().sort || "album",
      musicArtistSort: music().artistSort || "count",
      musicAlbumSort: music().albumSort || "updated",
      musicFavorite: Boolean(music().favorite)
    };
  }

  // 视图层需要 formatNumber / sortLabel 做展示，这里用轻量本地实现避免循环依赖
  function formatNumberSafe(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("zh-CN");
  }

  function sortLabelSafe(sort) {
    return {
      album: "按专辑",
      artist: "按歌手",
      title: "按歌名",
      duration: "按时长",
      played: "最近播放",
      favorite: "收藏优先",
      rating: "按评分"
    }[sort] || "按专辑";
  }

  function defaultQueuePlaylistName() {
    const date = new Date();
    return `播放队列 ${date.getMonth() + 1}-${date.getDate()}`;
  }

  return {
    beginNavigation,
    cancelPendingRequests,
    isNavigationCurrent,
    loadMusic,
    loadPlaylists,
    loadSmartPlaylists,
    openTrack,
    openTrackFromList,
    queueTrackNext,
    appendTrackToQueue,
    moveQueueTrack,
    removeTrackFromQueue,
    clearQueueAfterCurrent,
    togglePlayback,
    setPlaybackSpeed,
    setSleepTimer,
    toggleShuffleMode,
    cycleRepeatMode,
    playAdjacent,
    selectMusicMode,
    selectGenre,
    selectFirstSmartPlaylist,
    openPlaylistDialog,
    closePlaylistDialog,
    createPlaylistFromDialog,
    saveQueueAsPlaylist,
    importPlaylistM3uFromPrompt,
    editActivePlaylist,
    addTrackToPlaylistTarget,
    removeTrackFromActivePlaylist,
    deleteActivePlaylist,
    clearHistory,
    startMusicRescan,
    toggleFavorite,
    setTrackRating,
    downloadTrack,
    downloadPlaylistM3u,
    restoreLastTrack,
    canRestoreLastTrack,
    applyTrackUpdate,
    sideListCacheFresh,
    persistPlaylistQueueOrder,
    reportPlayedOnce,
    saveProgressSoon,
    flushProgressKeepalive,
    resumeProgress,
    claimProgressOwner: refreshProgressClock,
    // 文本 / 路由辅助（供视图层 import）
    currentMusicTitle,
    currentMusicMeta,
    emptyMusicMessage,
    musicRouteOverrides,
    musicListParams
  };
}
