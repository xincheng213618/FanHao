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
import { collapseDuplicateTracks, createDuplicateTrackAccumulator, compactTrack, normalizePlaybackSpeed, nextRepeat } from "./format.js";
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
  let lastAcceptedListRead = null;
  let musicListFailure = null;
  let searchDuplicateSession = null;
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
  const playlistOrderWrites = new Map();
  const playlistOrderCapacity = 8;
  const ratingWrites = new Map();
  let ratingErrorStatus = null;
  let latestRatingUiIntent = null;
  let ratingFeedbackSequence = 0;
  let favoriteFeedbackSequence = 0;
  let latestFavoriteFailureId = 0;
  let favoriteFailure = null;

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
    musicListFailure = null;
    favoriteFailure = null;
    ratingErrorStatus = null;
    searchDuplicateSession = null;
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
    lastAcceptedListRead = null;
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
    view.syncFavoriteFeedback?.();
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

  function collapseSearchAppend(request, previousRawTracks, incomingTracks, mergedRawTracks) {
    let account;
    try { account = captureWebAccount(); } catch {
      searchDuplicateSession = null;
      return collapseDuplicateTracks(mergedRawTracks);
    }
    const data = music().data, session = searchDuplicateSession;
    const reusable = session && session.data === data && session.raw === previousRawTracks
      && session.tracks === data?.tracks && session.rawLength === previousRawTracks.length
      && session.selection === request.selection && session.navigation === request.navigation
      && session.account.owner === account.owner && session.account.revision === account.revision;
    const next = reusable ? session : {
      accumulator: createDuplicateTrackAccumulator(), selection: request.selection,
      navigation: request.navigation, account
    };
    let tracks;
    try {
      tracks = next.accumulator.append(reusable ? incomingTracks : mergedRawTracks);
    } catch (error) {
      searchDuplicateSession = null;
      throw error;
    }
    searchDuplicateSession = next;
    return tracks;
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
  function getListReadFailure() {
    const failure = musicListFailure;
    if (!failure || state.activeView !== "music" || failure.navigation !== navigationGeneration
        || failure.generation !== musicLoadGeneration || failure.selection !== listSelectionKey()) return null;
    let account;
    try { account = captureWebAccount(); } catch { return null; }
    return account.owner === failure.account.owner && account.revision === failure.account.revision ? failure : null;
  }

  function retryListRead(failure) {
    if (getListReadFailure() !== failure) return null;
    beginNavigation();
    const pending = loadMusic({ replaceRoute: true, keepCurrent: true, restoreLast: failure.restoreLast, retryFailure: failure });
    const owner = { navigation: navigationGeneration, generation: musicLoadGeneration, foreground: foregroundGeneration, selection: listSelectionKey(), account: captureWebAccount() };
    return { pending, isCurrent: () => {
      let account;
      try { account = captureWebAccount(); } catch { return false; }
      return state.activeView === "music" && owner.navigation === navigationGeneration && owner.generation === musicLoadGeneration
        && owner.foreground === foregroundGeneration && owner.selection === listSelectionKey()
        && account.owner === owner.account.owner && account.revision === owner.account.revision;
    } };
  }

  function loadMusic(options = {}) {
    ensureMusicState(state);
    const artistMode = music().mode === "artists";
    const albumMode = music().mode === "albums";
    const append = Boolean(options.append && (music().mode === "library" || artistMode || albumMode));
    if (!append) searchDuplicateSession = null;
    if (append && getListReadFailure()) return Promise.resolve(null);
    if (!append) musicListFailure = null;
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
      background: Boolean(options.background), account: captureWebAccount(),
      navigation: navigationGeneration, foreground: foregroundGeneration
    };
    musicLoadRequest = request;
    const feedback = options.preserveFavoriteFailure;
    if (feedback && favoriteFailure === feedback && feedback.generation === generation - 1
        && isFavoriteContextCurrent(feedback)) {
      // An older confirmed favorite still maintains list membership. That
      // read is not a new user intent which may dismiss a newer save failure.
      favoriteFailure = { ...feedback, generation };
      request.preservedFavoriteFailure = favoriteFailure;
    }
    const ratingFeedback = options.preserveRatingFailure;
    if (ratingFeedback && ratingErrorStatus === ratingFeedback && ratingFeedback.generation === generation - 1
        && isRatingContextCurrent(ratingFeedback)) {
      ratingErrorStatus = { ...ratingFeedback, generation };
      request.preservedRatingFailure = ratingErrorStatus;
    }
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
      if (!trackOpenController && (!request.preservedFavoriteFailure || getFavoriteFailure() !== request.preservedFavoriteFailure)
          && (!request.preservedRatingFailure || getRatingFailure() !== request.preservedRatingFailure)) {
        setRequestStatus(request, append ? "正在加载更多" : "正在读取音乐库");
      }
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
      if (options.canReportFailure && !options.canReportFailure()) {
        // This maintenance read still finishes its own loading lifecycle, but
        // must not turn an obsolete failure into a new status or retry panel.
        if (requestStatusOwner === request) requestStatusOwner = null;
        finishMusicLoad(request);
        return;
      }
      const preservedFavoriteFailure = request.preservedFavoriteFailure && options.canReportFailure?.();
      const preservedRatingFailure = request.preservedRatingFailure && options.canReportFailure?.();
      if (!isMusicLoadCurrent(request) || !isForegroundCurrent(request)
          || (requestStatusOwner !== request && !preservedFavoriteFailure && !preservedRatingFailure)) {
        // A new song can take foreground ownership while this same list is
        // retrying. Keep its previous recovery usable without reporting the
        // background rejection over the newly chosen song.
        if (isMusicLoadCurrent(request) && options.retryFailure && !append && !background) {
          musicListFailure = Object.assign(options.retryFailure, { navigation: request.navigation, generation: request.generation,
            selection: request.selection, account: request.account });
        }
        finishMusicLoad(request);
        return;
      }
      music().loading = false;
      music().loadingMore = false;
      if (!append && !background && ["library", "artists", "albums"].includes(music().mode)) {
        musicListFailure = { navigation: request.navigation, generation: request.generation, selection: request.selection,
          account: request.account, message: error?.message || "音乐列表读取失败", restoreLast: options.restoreLast === true };
      }
      // A carried favorite hint kept its status while this read was pending.
      // Once it is cleared, the still-current read owns its failure again.
      if (preservedFavoriteFailure || preservedRatingFailure) setRequestStatus(request, music().status);
      settleRequestStatus(request, error?.message || "音乐列表读取失败");
      finishMusicLoad(request);
      // UI callers present the rejection through showError; rendering here
      // would rebuild the entire music view a second time in their catch.
      throw error;
    }
    if (!isMusicLoadCurrent(request)) {
      finishMusicLoad(request);
      return;
    }
    const incomingTracks = data.tracks || [];
    const previousRawTracks = append ? music().data?.rawTracks || music().data?.tracks || [] : [];
    const mergedRawTracks = append ? [...previousRawTracks, ...incomingTracks] : incomingTracks;
    const searching = music().mode === "library" && Boolean(music().query);
    if (!searching) searchDuplicateSession = null;
    const mergedTracks = searching
      ? (append ? collapseSearchAppend(request, previousRawTracks, incomingTracks, mergedRawTracks) : collapseDuplicateTracks(mergedRawTracks))
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
    if (searchDuplicateSession) {
      searchDuplicateSession.data = music().data;
      searchDuplicateSession.raw = mergedRawTracks;
      searchDuplicateSession.rawLength = mergedRawTracks.length;
      searchDuplicateSession.tracks = mergedTracks;
    }
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
    const appendedInPlace = !background && append && (
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
    lastAcceptedListRead = { generation: request.generation, navigation: request.navigation,
      selection: request.selection, account: request.account };
    finishMusicLoad(request);
    if (background) return;
    if (!isForegroundCurrent(request)) {
      // Picking a song changes playback ownership, but this request still owns
      // the selected list. Update only a mounted library panel, never its route
      // or player page. Appends retain their previous scroll position.
      const refreshedInPlace = !appendedInPlace && view.refreshMusicLibraryContent();
      if (append && refreshedInPlace) view.restoreMusicPanelScroll(appendScrollTop);
      return;
    }
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
      view.syncFavoriteFeedback?.();
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
    view.refreshQueueSurface({ queueMove: { trackId, fromIndex: index, toIndex: nextIndex } });
    const request = queueOrderOwner(queue);
    request.rollbackQueue = previousQueue;
    persistPlaylistQueueOrder(queue, request).catch((error) => {
      if (!isQueueOrderCurrent(request)) return;
      music().queue = request.rollbackQueue;
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

  function queueOrderOwner(queue) {
    const account = captureWebAccount();
    return { queue, navigation: navigationGeneration, foreground: foregroundGeneration,
      mode: music().mode, playlistId: music().activePlaylistId,
      webAccountOwner: account.owner, webAccountRevision: account.revision };
  }

  function isQueueOrderCurrent(request) {
    if (!isQueueOrderAccountCurrent(request)) return false;
    return isForegroundCurrent(request) && state.activeView === "music" && music().queue === request.queue
      && music().mode === request.mode && music().activePlaylistId === request.playlistId;
  }

  function isQueueOrderAccountCurrent(request) {
    try {
      const account = captureWebAccount();
      return account.revision === request.webAccountRevision && (!request.webAccountOwner || account.owner === request.webAccountOwner);
    } catch { return false; }
  }

  function restoreConfirmedQueueOrder(confirmedQueue, members) {
    const current = new Map(members.map(track => [track.id, track]));
    const known = new Set(confirmedQueue.map(track => track.id));
    const ordered = confirmedQueue.filter(track => current.has(track.id)).map(track => current.get(track.id));
    let index = 0;
    // Only undo ordering. Later membership edits and their new-track slots
    // belong to the user, even when an earlier full-order write has settled.
    return members.map(track => known.has(track.id) ? ordered[index++] : track);
  }

  function writePlaylistQueueOrder(playlistId, queue, trackIds, owner) {
    const key = JSON.stringify([owner.webAccountOwner, owner.webAccountRevision, playlistId]);
    let writes = playlistOrderWrites.get(key);
    if (!writes) {
      if (playlistOrderWrites.size >= playlistOrderCapacity) return Promise.reject(new Error("歌单排序保存繁忙，请稍后重试"));
      writes = { active: null, pending: null, confirmedQueue: owner.rollbackQueue || queue };
      playlistOrderWrites.set(key, writes);
    }
    return new Promise((resolve, reject) => {
      const job = { queue, trackIds, owner, resolve, reject };
      if (writes.active) {
        // A full order replaces earlier unsent adjustments for this playlist.
        // Keep one physical write and only the user's latest pending order.
        writes.pending?.resolve(null);
        writes.pending = job;
      } else {
        void send(job);
      }
    });

    async function send(job) {
      writes.active = job;
      try {
        if (!isQueueOrderAccountCurrent(job.owner)) throw Object.assign(new Error("账号已切换，请重新操作"), { code: "ACCOUNT_CHANGED" });
        const data = await api.reorderPlaylist(playlistId, { trackIds: job.trackIds });
        writes.confirmedQueue = job.queue;
        job.resolve(data);
      } catch (error) {
        job.owner.rollbackQueue = restoreConfirmedQueueOrder(writes.confirmedQueue, job.owner.rollbackQueue || job.queue);
        job.reject(error);
      } finally {
        const next = writes.pending;
        writes.pending = null;
        if (next) void send(next);
        else playlistOrderWrites.delete(key);
      }
    }
  }

  async function persistPlaylistQueueOrder(queue = music().queue || [], request = queueOrderOwner(queue)) {
    const playlistId = music().mode === "playlist" ? String(music().activePlaylistId || "").trim() : "";
    if (!playlistId) return null;
    const trackIds = uniqueTrackIds(queue);
    if (!trackIds.length) return null;
    const data = await writePlaylistQueueOrder(playlistId, queue, trackIds, request);
    if (!data) return null;
    if (!isQueueOrderAccountCurrent(request)) return data;
    invalidatePlaylistCache();
    if (!isQueueOrderCurrent(request)) return data;
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
      const wrap = options.wrap ?? (music().repeat === "all");
      if (!wrap) return;
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
    searchDuplicateSession = null;
    if (music().current?.id === updated.id) music().current = { ...music().current, ...updated };
    music().queue = (music().queue || []).map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    if (music().data?.tracks) {
      music().data.tracks = music().data.tracks.map((track) => (track.id === updated.id ? { ...track, ...updated } : track));
    }
    if (Array.isArray(music().data?.rawTracks)) {
      music().data.rawTracks = music().data.rawTracks.map((track) => (track?.id === updated.id ? { ...track, ...updated } : track));
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
    let account;
    try { account = captureWebAccount(); } catch { return; }
    const owner = { account, navigation: navigationGeneration, foreground: foregroundGeneration,
      selection: listSelectionKey(), generation: musicLoadGeneration, pendingRead: Boolean(musicLoadRequest),
      feedbackId: ++favoriteFeedbackSequence };
    const source = favoriteTrackSource(id);
    let data;
    try { data = await api.setFavorite(id, !Boolean(source?.favorite)); }
    catch (error) {
      if (canReportFavoriteFailure(owner) && owner.generation === musicLoadGeneration) {
        publishFavoriteFailure(owner, error, owner.generation, false);
        throw error;
      }
      return;
    }
    if (!isFavoriteAccountCurrent(owner.account)) return;
    const updated = data.track;
    if (!updated || updated.id !== id) return;
    const confirmed = { id, favorite: Boolean(updated.favorite) };
    const timely = isFavoriteContextCurrent(owner) && owner.generation === musicLoadGeneration && !owner.pendingRead
      && source && favoriteTrackSource(id) === source;
    // A late receipt still confirms this field for known copies of the song,
    // but its older metadata must not replace a newer title, rating or detail.
    applyTrackUpdate(timely ? updated : confirmed);
    if (!isFavoriteContextCurrent(owner)) return;
    clearFavoriteFailure(owner);

    const reading = musicLoadRequest;
    if (reading) {
      if (reading.navigation !== owner.navigation || reading.selection !== owner.selection
          || reading.generation !== musicLoadGeneration || reading.account.owner !== account.owner
          || reading.account.revision !== account.revision) return;
      try { await reading.promise; } catch { return; }
      if (!isFavoriteContextCurrent(owner) || reading.generation !== musicLoadGeneration) return;
      // The read may have captured its body before the POST was confirmed.
      applyTrackUpdate(confirmed);
    }
    if (!isFavoriteContextCurrent(owner)) return;
    if (owner.pendingRead || owner.generation !== musicLoadGeneration) {
      const accepted = lastAcceptedListRead;
      // A failed append has no first-page recovery object. Its generation must
      // not be mistaken for a successful read or have its error replaced.
      if (!accepted || accepted.generation !== musicLoadGeneration || accepted.navigation !== owner.navigation
          || accepted.selection !== owner.selection || accepted.account.owner !== account.owner
          || accepted.account.revision !== account.revision) return;
    }
    const known = music().current?.id === id ? music().current
      : (music().queue || []).find(track => track.id === id)
        || (music().data?.tracks || []).find(track => track.id === id)
        || (music().data?.rawTracks || []).find(track => track?.id === id);
    if (known) view.refreshTrackMetadata(known);
    if (!isFavoriteContextCurrent(owner) || !trackMetadataRequiresReload("favorite")) return;
    let refreshed;
    try {
      const feedback = getFavoriteFailure();
      const pending = loadMusic({ replaceRoute: true, keepCurrent: true, canReportFailure: () => canReportFavoriteFailure(owner),
        preserveFavoriteFailure: feedback && feedback.feedbackId > owner.feedbackId ? feedback : null,
        preserveRatingFailure: getRatingFailure() });
      refreshed = musicLoadRequest;
      await pending;
    } catch (error) {
      // Successful reads clear/abort their request too; compare the actual
      // maintenance generation rather than its live request/controller.
      if (canReportFavoriteFailure(owner) && refreshed?.generation === musicLoadGeneration
          && refreshed.selection === listSelectionKey() && isForegroundCurrent(refreshed)) {
        publishFavoriteFailure(owner, error, refreshed.generation, true);
        throw error;
      }
    }
  }

  function favoriteTrackSource(id) {
    return music().current?.id === id ? music().current
      : (music().queue || []).find(track => track.id === id) || (music().data?.tracks || []).find(track => track.id === id);
  }

  function canReportFavoriteFailure(owner) {
    // Once a newer failure has been cleared, a still-required maintenance read
    // may report its own failure instead of leaving a confirmed write stranded.
    return isFavoriteContextCurrent(owner) && (!getFavoriteFailure() || owner.feedbackId >= latestFavoriteFailureId);
  }

  function publishFavoriteFailure(owner, error, generation, saved) {
    latestFavoriteFailureId = owner.feedbackId;
    favoriteFailure = { ...owner, generation, saved, error, message: error?.message || "音乐库读取失败" };
  }

  function getFavoriteFailure() {
    const failure = favoriteFailure;
    return failure && failure.feedbackId === latestFavoriteFailureId && failure.generation === musicLoadGeneration
      && isFavoriteContextCurrent(failure) ? failure : null;
  }

  function clearFavoriteFailure(owner) {
    const failure = favoriteFailure;
    if (!failure || failure.feedbackId > owner.feedbackId || failure.navigation !== owner.navigation
        || failure.foreground !== owner.foreground || failure.selection !== owner.selection
        || failure.account.owner !== owner.account.owner || failure.account.revision !== owner.account.revision) return;
    const current = getFavoriteFailure() === failure;
    favoriteFailure = null;
    if (current && music().status === failure.message) music().status = "";
    view.syncFavoriteFeedback?.();
  }

  function isFavoriteAccountCurrent(expected) {
    try {
      const account = captureWebAccount();
      return account.owner === expected.owner && account.revision === expected.revision;
    } catch { return false; }
  }

  function isFavoriteContextCurrent(owner) {
    return state.activeView === "music" && isForegroundCurrent(owner) && owner.selection === listSelectionKey()
      && isFavoriteAccountCurrent(owner.account);
  }

  async function setTrackRating(trackId, rating) {
    const id = String(trackId || "").trim();
    if (!id) return;
    let account;
    try { account = captureWebAccount(); } catch { return; }
    const owner = { navigation: navigationGeneration, foreground: foregroundGeneration,
      webAccountOwner: account.owner, webAccountRevision: account.revision,
      selection: listSelectionKey(), generation: musicLoadGeneration, pendingRead: Boolean(musicLoadRequest),
      feedbackId: ++ratingFeedbackSequence };
    latestRatingUiIntent = owner;
    let result;
    try { result = await writeTrackRating(id, rating, owner); }
    catch (error) {
      const known = favoriteTrackSource(id);
      result = { track: { id, rating: Number(known?.rating || 0) }, error };
    }
    if (!result || !isRatingAccountCurrent(owner)) return;
    const updated = result.track;
    if (!updated) return;
    const previous = music().current?.id === id ? music().current : (music().data?.tracks || []).find(track => track.id === id);
    const changed = Number(previous?.rating || 0) !== Number(updated.rating || 0);
    applyTrackUpdate(updated);
    if (state.activeView !== "music") return;
    const current = isRatingContextCurrent(owner) && latestRatingUiIntent === owner
      && owner.generation === musicLoadGeneration;
    // A confirmed score still updates known copies after navigation. Only its
    // original UI may rebuild the stage; library rows can update in place.
    if (!result.error || changed) view.refreshTrackMetadata(updated, { allowStage: current });
    const reading = musicLoadRequest;
    if (result.error && current && reading && (!changed || !trackMetadataRequiresReload("rating"))) {
      // The save failure is already known. Do not hide it behind an unrelated
      // held read; repair its older snapshot only after that read is accepted.
      void settleRatingListRead(owner, updated).then(accepted => {
        if (accepted) view.refreshTrackMetadata(updated, { allowStage: false });
      }).catch(error => {
        if (isRatingContextCurrent(owner) && latestRatingUiIntent === owner) showError(error);
      });
      const error = new Error(`评分未保存，已保留${Number(updated.rating) ? ` ${updated.rating} 星` : "未评分"}：${result.error.message || "请重试"}`);
      publishRatingFailure(owner, id, error, false);
      throw error;
    }
    if (!await settleRatingListRead(owner, updated)) return;
    if (reading) view.refreshTrackMetadata(updated, { allowStage: current });
    if (result.error) {
      let refreshError = null;
      let errorGeneration = owner.generation;
      if (current && changed && trackMetadataRequiresReload("rating")) {
        const pending = loadMusic({ replaceRoute: true, keepCurrent: true,
          canReportFailure: () => canReportRatingFailure(owner), preserveFavoriteFailure: getFavoriteFailure(),
          preserveRatingFailure: getRatingFailure() });
        const refreshed = musicLoadRequest;
        try { await pending; } catch (failure) { refreshError = failure; }
        // A normal completion clears its request object. Compare its generation
        // and selection after await so a newer read/error keeps the UI.
        if (!refreshed || refreshed.generation !== musicLoadGeneration || refreshed.selection !== listSelectionKey()
            || !isRatingContextCurrent(owner) || !isForegroundCurrent(refreshed)) return;
        if (latestRatingUiIntent !== owner) {
          // A newer confirmed score can be waiting on this same required read.
          // Report its read error, without reviving the older score-save cause.
          if (refreshError && canReportRatingFailure(owner)) {
            publishRatingFailure(owner, id, refreshError, true);
            throw refreshError;
          }
          return;
        }
        errorGeneration = refreshed.generation;
      }
      if (current && errorGeneration === musicLoadGeneration && isRatingContextCurrent(owner) && latestRatingUiIntent === owner) {
        const detail = refreshError ? `；列表刷新失败：${refreshError.message || "请重试"}` : "";
        const error = new Error(`评分未保存，已保留${Number(updated.rating) ? ` ${updated.rating} 星` : "未评分"}：${result.error.message || "请重试"}${detail}`);
        publishRatingFailure(owner, id, error, false);
        throw error;
      }
    } else {
      clearRatingFailure(owner, id);
      // The write is confirmed even if its dependent list read later fails.
      if (isRatingContextCurrent(owner) && latestRatingUiIntent === owner && trackMetadataRequiresReload("rating")) {
        const pending = loadMusic({ replaceRoute: true, keepCurrent: true,
          canReportFailure: () => canReportRatingFailure(owner), preserveFavoriteFailure: getFavoriteFailure(),
          preserveRatingFailure: getRatingFailure() });
        const refreshed = musicLoadRequest;
        try { await pending; } catch (failure) {
          if (canReportRatingFailure(owner) && refreshed?.generation === musicLoadGeneration
              && refreshed.selection === listSelectionKey() && isForegroundCurrent(refreshed)
              && isRatingContextCurrent(owner)) {
            publishRatingFailure(owner, id, failure, true);
            throw failure;
          }
        }
      }
    }
  }

  function isRatingContextCurrent(owner) {
    return state.activeView === "music" && isForegroundCurrent(owner) && owner.selection === listSelectionKey()
      && isRatingAccountCurrent(owner);
  }

  async function settleRatingListRead(owner, updated) {
    if (!isRatingContextCurrent(owner) || latestRatingUiIntent !== owner) return false;
    const reading = musicLoadRequest;
    if (reading) {
      if (reading.navigation !== owner.navigation || reading.foreground !== owner.foreground
          || reading.selection !== owner.selection || reading.generation !== musicLoadGeneration
          || reading.account.owner !== owner.webAccountOwner || reading.account.revision !== owner.webAccountRevision) return false;
      try { await reading.promise; } catch { return false; }
      if (!isRatingContextCurrent(owner) || latestRatingUiIntent !== owner || reading.generation !== musicLoadGeneration) return false;
      applyTrackUpdate(updated);
    }
    if (owner.pendingRead || owner.generation !== musicLoadGeneration) {
      const accepted = lastAcceptedListRead;
      if (!accepted || accepted.generation !== musicLoadGeneration || accepted.navigation !== owner.navigation
          || accepted.selection !== owner.selection || accepted.account.owner !== owner.webAccountOwner
          || accepted.account.revision !== owner.webAccountRevision) return false;
    }
    return isRatingContextCurrent(owner) && latestRatingUiIntent === owner;
  }

  function canReportRatingFailure(owner) {
    const failure = getRatingFailure();
    return isRatingContextCurrent(owner) && (!failure || owner.feedbackId >= failure.feedbackId);
  }

  function publishRatingFailure(owner, trackId, error, saved) {
    ratingErrorStatus = { ...owner, generation: musicLoadGeneration, trackId, error, saved,
      message: error?.message || "评分保存失败" };
  }

  function getRatingFailure() {
    const failure = ratingErrorStatus;
    return failure && failure.generation === musicLoadGeneration && isRatingContextCurrent(failure) ? failure : null;
  }

  function clearRatingFailure(owner, trackId) {
    const failure = ratingErrorStatus;
    if (!failure || latestRatingUiIntent !== owner || failure.trackId !== trackId
        || failure.navigation !== owner.navigation || failure.foreground !== owner.foreground
        || failure.selection !== owner.selection || failure.webAccountOwner !== owner.webAccountOwner
        || failure.webAccountRevision !== owner.webAccountRevision || !isRatingContextCurrent(owner)) return;
    const current = getRatingFailure() === failure;
    ratingErrorStatus = null;
    if (current && music().status === failure.message) music().status = "";
    view.syncFavoriteFeedback?.();
  }

  function isRatingAccountCurrent(owner) {
    try {
      const account = captureWebAccount();
      return account.owner === owner.webAccountOwner && account.revision === owner.webAccountRevision;
    } catch { return false; }
  }

  function writeTrackRating(trackId, rating, owner) {
    const key = JSON.stringify([owner.webAccountOwner, owner.webAccountRevision, trackId]);
    let writes = ratingWrites.get(key);
    if (!writes) {
      if (ratingWrites.size >= 8) return Promise.reject(new Error("评分保存繁忙，请稍后重试"));
      const track = music().current?.id === trackId ? music().current
        : (music().queue || []).find(item => item.id === trackId) || (music().data?.tracks || []).find(item => item.id === trackId);
      writes = { active: null, pending: null, confirmed: track ? { id: trackId, rating: Number(track.rating || 0) } : null };
      ratingWrites.set(key, writes);
    }
    return new Promise(resolve => {
      const job = { rating, owner, resolve };
      if (writes.active) {
        // Scores replace unsent choices for this track. Keep only one physical
        // write and the latest choice so an older commit cannot win later.
        writes.pending?.resolve(null);
        writes.pending = job;
      } else void send(job);
    });

    async function send(job) {
      writes.active = job;
      let error = null;
      try {
        if (!isRatingAccountCurrent(job.owner)) { job.resolve(null); return; }
        const data = await api.setRating(trackId, job.rating);
        if (!isRatingAccountCurrent(job.owner)) { job.resolve(null); return; }
        if (data.track) writes.confirmed = { id: trackId, rating: data.track.rating };
      } catch (failure) { error = failure; }
      finally {
        const next = writes.pending;
        writes.pending = null;
        job.resolve(!next && isRatingAccountCurrent(job.owner) ? { track: writes.confirmed, error } : null);
        if (next) void send(next);
        else ratingWrites.delete(key);
      }
    }
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
    music().query = "";
    music().favorite = mode === "library" ? Boolean(options.favorite) : false;
    if (mode === "library") {
      music().artistId = options.artistId || "all";
      music().albumId = options.albumId || "all";
      music().genre = options.genre || "all";
      if (options.language) music().language = options.language;
    }
    if (mode !== "library") {
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
    music().query = "";
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
  function invalidatePlaylistCache() {
    music().playlistsLoadedAt = 0;
    sideListGenerations.playlists += 1;
    sideListRequests.playlists?.controller.abort();
    sideListRequests.playlists = null;
  }

  async function createPlaylistFromDialog() {
    const name = String(music().playlistDialogName || "").trim();
    if (!name) return null;
    const trackId = music().playlistDialogTrackId || "";
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    closePlaylistDialog();
    music().status = "正在创建歌单";
    let data;
    try {
      data = await api.createPlaylist({ name, ...(trackId ? { trackIds: [trackId] } : {}) });
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return null;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return data.playlist || null;
    const loadedCurrent = await loadPlaylists();
    if (!loadedCurrent || !isForegroundCurrent(request)) return data.playlist || null;
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
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    music().status = "正在保存播放队列";
    view.refresh();
    let data;
    try {
      data = await api.createPlaylist({
        name: clean,
        description: "从播放队列保存",
        trackIds
      });
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return null;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return data.playlist || null;
    const loadedCurrent = await loadPlaylists();
    if (!loadedCurrent || !isForegroundCurrent(request)) return data.playlist || null;
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
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    music().status = "正在导入 M3U 歌单";
    view.refresh();
    const body = source.includes("\n") || source.toUpperCase().startsWith("#EXTM3U")
      ? { content: source }
      : { path: source };
    let data;
    try {
      data = await api.importM3u(body);
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return null;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return data.playlist || null;
    const loadedCurrent = await loadPlaylists();
    if (!loadedCurrent || !isForegroundCurrent(request)) return data.playlist || null;
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
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    let data;
    try {
      data = await api.updatePlaylist(playlist.id, {
        name: cleanName,
        description: String(description || "").trim()
      });
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return null;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return data.playlist || null;
    music().activePlaylist = data.playlist || music().activePlaylist;
    const loadedCurrent = await loadPlaylists();
    if (!loadedCurrent || !isForegroundCurrent(request)) return data.playlist || null;
    await loadMusic({ replaceRoute: true, keepCurrent: true });
    return data.playlist || null;
  }

  async function addTrackToPlaylistTarget(playlistId) {
    const trackId = music().playlistDialogTrackId;
    const playlist = (music().playlists || []).find((item) => item.id === playlistId);
    if (!trackId || !playlist?.id) return;
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    closePlaylistDialog();
    music().status = `正在加入「${playlist.name}」`;
    try {
      await api.addTrackToPlaylist(playlist.id, { trackId });
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return;
    music().status = `已加入「${playlist.name}」`;
    const loadedCurrent = await loadPlaylists();
    if (!loadedCurrent || !isForegroundCurrent(request)) return;
    if (music().mode === "playlist" && music().activePlaylistId === playlist.id) {
      await loadMusic({ replaceRoute: true, keepCurrent: true });
    } else {
      view.refreshLibrarySidebars();
    }
  }

  async function removeTrackFromActivePlaylist(trackId) {
    const playlistId = music().activePlaylistId;
    if (!playlistId) return;
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    try {
      await api.removeTrackFromPlaylist(playlistId, trackId);
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return;
    music().status = "已移出歌单";
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function deleteActivePlaylist() {
    const playlist = music().activePlaylist;
    if (!playlist?.id) return;
    if (!window.confirm(`删除歌单「${playlist.name}」？歌曲文件不会被删除。`)) return;
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    try {
      await api.deletePlaylist(playlist.id);
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return;
    }
    invalidatePlaylistCache();
    if (!isForegroundCurrent(request)) return;
    music().mode = "library";
    music().activePlaylistId = "";
    music().activePlaylist = null;
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function clearHistory() {
    if (!window.confirm("清空最近播放记录？播放进度和收藏会保留。")) return;
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
    try {
      await api.clearHistory();
    } catch (error) {
      if (isForegroundCurrent(request)) throw error;
      return;
    }
    if (!isForegroundCurrent(request)) return;
    await loadMusic({ replaceRoute: true, keepCurrent: true });
  }

  async function startMusicRescan() {
    ensureMusicState(state);
    const request = { navigation: navigationGeneration, foreground: foregroundGeneration };
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
      if (!isForegroundCurrent(request)) return;
      music().status = "音乐库刷新已启动，后台作业完成后会自动更新。";
      router.openAdminScript("music-library-rescan");
    } catch (error) {
      if (isForegroundCurrent(request)) music().status = error?.message || "音乐库刷新启动失败";
    } finally {
      music().rescanning = false;
      if (isForegroundCurrent(request)) view.refresh();
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
    const account = captureWebAccount();
    if (progressClockRequest?.trackId === trackId && progressClockRequest.session === playReportSession
        && progressClockRequest.webAccountOwner === account.owner && progressClockRequest.webAccountRevision === account.revision) return;
    cancelProgressClock();
    const request = { trackId, session: playReportSession, controller: new AbortController(),
      webAccountOwner: account.owner, webAccountRevision: account.revision };
    progressClockRequest = request;
    try {
      const data = await api.claimProgressSession(trackId, progressSession?.id, request.controller.signal);
      if (progressClockRequest !== request || request.controller.signal.aborted || progressHidden
          || request.session !== playReportSession || music().current?.id !== trackId) return;
      checkProgressAccount(request);
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
    getListReadFailure,
    retryListRead,
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
    getFavoriteFailure,
    getRatingFailure,
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
