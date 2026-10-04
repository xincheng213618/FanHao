export function createMusicCatalogueRefresh(deps) {
  const {
    state, els, isActive, renderShell, renderMusicUiPreservingSearch,
    renderLibraryHeader, renderQuickAccess, renderRecentListening,
    renderPlaylists, renderSmartPlaylists, renderAutoCollectionHero,
    renderPlaylistHero, collectionView, renderPlaylistSheet,
    renderPlaylistActionsSheet, musicTitle, musicMeta, updatePlaybackUi
  } = deps;

  function refreshMusicCatalogueUi(kind) {
    if (!isActive() || !els.viewContent || !["smart", "playlists"].includes(kind)) return false;
    if (state.searchOpen || state.query) {
      renderMusicUiPreservingSearch();
      return true;
    }
    const shell = els.viewContent.querySelector(".music-mobile-shell");
    if (!shell) {
      renderShell();
      return true;
    }
    const viewWindow = els.viewContent.ownerDocument?.defaultView;
    const scrollX = viewWindow?.scrollX || 0;
    const scrollY = viewWindow?.scrollY || 0;
    let missingConsumer = false;

    function replaceRegion(selector, render, scrollerSelector) {
      const previous = shell.querySelector(selector);
      if (!previous || typeof render !== "function") {
        missingConsumer = true;
        return;
      }
      const previousScroller = scrollerSelector ? previous.querySelector(scrollerSelector) : previous;
      const left = previousScroller?.scrollLeft || 0;
      const top = previousScroller?.scrollTop || 0;
      const next = render();
      previous.replaceWith(next);
      const nextScroller = scrollerSelector ? next.querySelector(scrollerSelector) : next;
      if (nextScroller) {
        nextScroller.scrollLeft = left;
        nextScroller.scrollTop = top;
      }
    }

    function refreshSheetList(sheetSelector, listSelector, render) {
      const sheet = shell.querySelector(sheetSelector);
      if (!sheet) return;
      const previous = sheet.querySelector(listSelector);
      const next = render().querySelector(listSelector);
      if (!previous || !next) {
        missingConsumer = true;
        return;
      }
      const left = previous.scrollLeft;
      const top = previous.scrollTop;
      // Keep the dialog, dismiss-swipe header and scroll container mounted.
      previous.replaceChildren(...next.childNodes);
      previous.scrollLeft = left;
      previous.scrollTop = top;
    }

    const home = Boolean(shell.querySelector(":scope > .music-mobile-playlists, :scope > .music-mobile-smart"));
    if (home) {
      if (kind === "smart") {
        replaceRegion(":scope > .music-mobile-library-head", renderLibraryHeader);
        replaceRegion(":scope > .music-mobile-quick-access", renderQuickAccess);
        replaceRegion(":scope > .music-mobile-recent", renderRecentListening, ".music-mobile-recent-rail");
        replaceRegion(":scope > .music-mobile-smart", renderSmartPlaylists, ".music-mobile-smart-scroll");
      } else {
        replaceRegion(":scope > .music-mobile-playlists", renderPlaylists, ".music-mobile-playlist-scroll");
      }
    }
    if (kind === "smart") {
      if (shell.querySelector(":scope > .music-mobile-collection-browser")) {
        replaceRegion(":scope > .music-mobile-collection-browser > .music-mobile-collection-languages", collectionView.renderLanguages);
      }
      if (state.smartId && state.data?.smartPlaylist?.id !== state.smartId
        && shell.querySelector(":scope > .music-mobile-auto-hero")) {
        replaceRegion(":scope > .music-mobile-auto-hero", renderAutoCollectionHero);
      }
    } else {
      if (state.playlistId && state.data?.playlist?.id !== state.playlistId
        && shell.querySelector(":scope > .music-mobile-playlist-hero")) {
        replaceRegion(":scope > .music-mobile-playlist-hero", renderPlaylistHero);
      }
      refreshSheetList(".music-mobile-playlist-sheet", ".music-mobile-queue-list", renderPlaylistSheet);
      refreshSheetList(".music-mobile-playlist-actions-sheet", ".music-mobile-playlist-action-list", renderPlaylistActionsSheet);
    }

    const knownView = home || shell.querySelector(":scope > .music-mobile-list, :scope > .music-mobile-collection-browser, :scope > .music-mobile-playlist-hero, :scope > .music-mobile-auto-hero, :scope > .music-mobile-focused-library-head");
    if (missingConsumer || !knownView) {
      renderShell();
    } else {
      const title = musicTitle();
      const meta = state.status || musicMeta(state.data);
      if (els.viewTitle && els.viewTitle.textContent !== title) els.viewTitle.textContent = title;
      if (els.viewMeta && els.viewMeta.textContent !== meta) els.viewMeta.textContent = meta;
      updatePlaybackUi();
    }
    if (viewWindow && (viewWindow.scrollX !== scrollX || viewWindow.scrollY !== scrollY)) {
      viewWindow.scrollTo(scrollX, scrollY);
    }
    return true;
  }

  return { refreshMusicCatalogueUi };
}
