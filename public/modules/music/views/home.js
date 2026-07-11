// 发现 / 听歌报告视图簇。
// 真正的视图模块：只读取 music 状态切片、调用稳定的 actions 编排 API、使用 h 渲染原语，
// 不再通过 ctx 桥接捕获组合根闭包里的十几个内部函数。
import { formatDuration, formatClock } from "../format.js";

export function createMusicHome({ music, actions, h, formatNumber, showError }) {
  function renderHero() {
    const summary = music.summary || music.data?.summary || {};
    const totals = summary.totals || {};
    const hero = document.createElement("section");
    hero.className = "music-hero";
    const copy = document.createElement("div");
    copy.className = "music-hero-copy";
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "本地音乐";
    const title = document.createElement("h2");
    title.textContent = "音乐";
    const meta = document.createElement("p");
    const rootText = (summary.roots || []).map((root) => root.path).filter(Boolean)[0] || "D:\\Music";
    meta.textContent = `${formatNumber(totals.tracks || 0)} 首 · ${formatNumber(totals.albums || 0)} 张专辑 · ${formatDuration(totals.durationMs || 0)} · ${rootText}`;
    copy.append(eyebrow, title, meta);

    const actionsEl = document.createElement("div");
    actionsEl.className = "music-hero-actions";
    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "music-primary-button";
    scan.textContent = music.rescanning ? "刷新中" : "刷新音乐库";
    scan.disabled = Boolean(music.rescanning);
    scan.addEventListener("click", () => actions.startMusicRescan().catch(showError));
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-secondary-button";
    play.textContent = music.current ? "继续播放" : "播放全部";
    play.disabled = !(music.current || music.queue.length);
    play.addEventListener("click", () => {
      if (music.current) actions.togglePlayback();
      else if (music.queue[0]?.id) actions.openTrack(music.queue[0].id, { autoplay: true }).catch(showError);
    });
    actionsEl.append(play, scan);
    hero.append(copy, actionsEl);
    return hero;
  }

  function renderHomePanel() {
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-home-panel";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = "发现";
    const headingMeta = document.createElement("small");
    headingMeta.textContent = "从最近播放、常听歌曲、智能歌单、风格、歌手和专辑快速进入";
    headingText.append(headingTitle, headingMeta);
    const headingActions = document.createElement("div");
    headingActions.className = "music-panel-actions";
    const all = document.createElement("button");
    all.type = "button";
    all.className = "music-inline-button";
    all.textContent = "全部歌曲";
    all.addEventListener("click", () => actions.selectMusicMode("library"));
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-inline-button";
    create.textContent = "新建歌单";
    create.addEventListener("click", () => actions.openPlaylistDialog().catch(showError));
    headingActions.append(all, create);
    heading.append(headingText, headingActions);

    const search = document.createElement("form");
    search.className = "music-home-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索歌名、歌手、专辑或歌词";
    searchInput.setAttribute("aria-label", "搜索音乐");
    searchInput.setAttribute("enterkeyhint", "search");
    const searchButton = document.createElement("button");
    searchButton.type = "submit";
    searchButton.textContent = "搜索";
    search.addEventListener("submit", (event) => {
      event.preventDefault();
      music.mode = "library";
      music.query = searchInput.value.trim();
      music.favorite = false;
      music.activePlaylistId = "";
      music.activeSmartPlaylistId = "";
      music.artistId = "all";
      music.albumId = "all";
      music.genre = "all";
      actions.loadMusic({ keepCurrent: true }).catch(showError);
    });
    search.append(searchInput, searchButton);

    const summary = music.summary || music.data?.summary || {};
    const totals = summary.totals || {};
    const topPlayed = summary.topPlayed?.length ? summary.topPlayed : [];
    const cards = document.createElement("div");
    cards.className = "music-home-cards";
    cards.append(
      homeActionCard("全部歌曲", formatNumber(totals.tracks || music.data?.total || 0), "按专辑浏览", () => actions.selectMusicMode("library")),
      homeActionCard("最近播放", formatNumber(summary.recent?.length || 0), "继续听", () => actions.selectMusicMode("history")),
      homeActionCard("常听歌曲", formatNumber(totals.listenedTracks || topPlayed.length || 0), "按播放次数", () => actions.selectMusicMode("smart", { smartId: "topplayed" })),
      homeActionCard("听歌报告", formatNumber(totals.plays || 0), "播放统计", () => actions.selectMusicMode("report")),
      homeActionCard("智能歌单", formatNumber((music.smartPlaylists || []).length), "自动整理", () => actions.selectFirstSmartPlaylist()),
      homeActionCard("我喜欢", "♥", "收藏歌曲", () => actions.selectMusicMode("library", { favorite: true }))
    );

    const sections = document.createElement("div");
    sections.className = "music-home-sections";
    const recent = summary.recent?.length ? summary.recent : (music.queue || []).slice(0, 8);
    sections.append(
      homeSection("最近播放", "继续刚才的顺序", homeTrackList(recent.slice(0, 8), "还没有最近播放")),
      homeSection("常听歌曲", "按播放次数", homeTrackList(topPlayed.slice(0, 8), "还没有播放统计")),
      homeSection("智能歌单", "动态规则", homeSmartPlaylistList()),
      homeSection("歌单", "自建列表", homePlaylistList()),
      homeSection("风格", "按音乐类型进入", homeGenreList()),
      homeSection("歌手", "按歌手进入", homeArtistList()),
      homeSection("专辑", "按专辑进入", homeAlbumList())
    );
    panel.append(heading, search, cards, sections);
    return panel;
  }

  function renderReportPanel() {
    const data = music.data || {};
    const summary = data.summary || music.summary || {};
    const counts = data.counts || summary.totals || {};
    const topTracks = data.topTracks || data.tracks || [];
    const panel = document.createElement("section");
    panel.className = "music-track-panel music-report-panel";
    const heading = document.createElement("div");
    heading.className = "music-panel-heading";
    const headingText = document.createElement("span");
    const headingTitle = document.createElement("strong");
    headingTitle.textContent = "听歌报告";
    const headingMeta = document.createElement("small");
    headingMeta.textContent = `${formatNumber(counts.plays || 0)} 次播放 · ${formatNumber(counts.listenedTracks || 0)} 首听过 · ${formatNumber(counts.favorites || 0)} 首收藏`;
    headingText.append(headingTitle, headingMeta);
    const headingActions = document.createElement("div");
    headingActions.className = "music-panel-actions";
    const playTop = document.createElement("button");
    playTop.type = "button";
    playTop.className = "music-inline-button";
    playTop.textContent = "播放常听";
    playTop.disabled = !topTracks.length;
    playTop.addEventListener("click", () => actions.openTrackFromList(topTracks[0], topTracks, { autoplay: true }).catch(showError));
    const home = document.createElement("button");
    home.type = "button";
    home.className = "music-inline-button";
    home.textContent = "返回发现";
    home.addEventListener("click", () => actions.selectMusicMode("home"));
    headingActions.append(playTop, home);
    heading.append(headingText, headingActions);

    const cards = document.createElement("div");
    cards.className = "music-report-cards";
    cards.append(
      reportStatCard("累计播放", formatNumber(counts.plays || 0), "本地记录"),
      reportStatCard("听过歌曲", formatNumber(counts.listenedTracks || 0), `${formatNumber(counts.tracks || 0)} 首入库`),
      reportStatCard("收藏歌曲", formatNumber(counts.favorites || 0), "喜欢的歌"),
      reportStatCard("库时长", formatDuration(counts.durationMs || 0), `${formatNumber(counts.albums || 0)} 张专辑`)
    );

    const sections = document.createElement("div");
    sections.className = "music-home-sections music-report-sections";
    sections.append(
      homeSection("常听歌曲", "按播放次数", homeTrackList(topTracks.slice(0, 8), "还没有播放统计")),
      homeSection("最近播放", "按最后一次播放", homeTrackList((data.recent || []).slice(0, 8), "还没有最近播放")),
      homeSection("常听歌手", "按累计播放", reportArtistList(data.topArtists || [])),
      homeSection("常听专辑", "按累计播放", reportAlbumList(data.topAlbums || []))
    );

    panel.append(heading, cards, reportActivityChart(data.activityMonths || []), sections);
    return panel;
  }

  function reportStatCard(label, value, hint) {
    const card = document.createElement("div");
    card.className = "music-report-card";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = hint;
    card.append(small, strong, span);
    return card;
  }

  function reportActivityChart(months) {
    const section = document.createElement("section");
    section.className = "music-report-chart";
    const head = document.createElement("div");
    head.className = "music-home-section-head";
    const title = document.createElement("strong");
    title.textContent = "播放活跃";
    const meta = document.createElement("small");
    meta.textContent = "最近月份";
    head.append(title, meta);
    const bars = document.createElement("div");
    bars.className = "music-report-bars";
    if (!months.length) {
      bars.append(homeEmpty("听几首歌后这里会有趋势"));
      section.append(head, bars);
      return section;
    }
    const max = Math.max(1, ...months.map((item) => Number(item.plays || 0)));
    for (const item of months) {
      const bar = document.createElement("div");
      bar.className = "music-report-bar";
      bar.title = `${item.month} · ${formatNumber(item.plays || 0)} 次播放`;
      const fill = document.createElement("span");
      fill.style.height = `${Math.max(8, Math.round((Number(item.plays || 0) / max) * 100))}%`;
      const label = document.createElement("small");
      label.textContent = String(item.month || "").slice(5) || item.month || "--";
      bar.append(fill, label);
      bars.append(bar);
    }
    section.append(head, bars);
    return section;
  }

  function reportArtistList(artists) {
    const list = document.createElement("div");
    list.className = "music-home-pill-list";
    if (!artists.length) {
      list.append(homeEmpty("还没有歌手播放统计"));
      return list;
    }
    for (const artist of artists.slice(0, 12)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-pill";
      button.textContent = `${artist.name || "未知歌手"} · ${formatNumber(artist.plays || 0)} 次`;
      button.addEventListener("click", () => {
        music.mode = "library";
        music.favorite = false;
        music.query = "";
        music.activePlaylistId = "";
        music.activeSmartPlaylistId = "";
        music.artistId = artist.id || "all";
        music.albumId = "all";
        music.genre = "all";
        actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function reportAlbumList(albums) {
    const list = document.createElement("div");
    list.className = "music-home-list";
    if (!albums.length) {
      list.append(homeEmpty("还没有专辑播放统计"));
      return list;
    }
    for (const album of albums.slice(0, 8)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-album";
      button.append(h.renderCover(album, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title || "未知专辑";
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.plays || 0)} 次`;
      text.append(strong, small);
      button.append(text);
      button.addEventListener("click", () => {
        music.mode = "library";
        music.favorite = false;
        music.query = "";
        music.activePlaylistId = "";
        music.activeSmartPlaylistId = "";
        music.artistId = album.artistId || "all";
        music.albumId = album.id || "all";
        music.genre = "all";
        actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function homeActionCard(label, value, hint, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-home-card";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = hint;
    button.append(small, strong, span);
    button.addEventListener("click", action);
    return button;
  }

  function homeSection(titleText, metaText, content) {
    const section = document.createElement("section");
    section.className = "music-home-section";
    const head = document.createElement("div");
    head.className = "music-home-section-head";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("small");
    meta.textContent = metaText;
    head.append(title, meta);
    section.append(head, content);
    return section;
  }

  function homeTrackList(tracks, emptyText) {
    const list = document.createElement("div");
    list.className = "music-home-list";
    if (!tracks.length) {
      list.append(homeEmpty(emptyText));
      return list;
    }
    for (const track of tracks) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-track";
      button.append(h.renderCover(track, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = track.title || "未知歌曲";
      const small = document.createElement("small");
      small.textContent = `${track.artist || "未知歌手"} · ${track.album || "未知专辑"}`;
      text.append(strong, small);
      const time = document.createElement("em");
      time.textContent = formatClock(track.durationMs || 0);
      button.append(text, time);
      button.addEventListener("click", () => actions.openTrackFromList(track, tracks, { autoplay: true }).catch(showError));
      list.append(button);
    }
    return list;
  }

  function homePlaylistList() {
    const list = document.createElement("div");
    list.className = "music-home-list";
    const playlists = (music.playlists || []).slice(0, 8);
    for (const playlist of playlists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-playlist";
      const strong = document.createElement("strong");
      strong.textContent = playlist.name;
      const small = document.createElement("small");
      small.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
      button.append(strong, small);
      button.addEventListener("click", () => actions.selectMusicMode("playlist", { playlistId: playlist.id }));
      list.append(button);
    }
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-home-playlist create";
    create.textContent = "新建歌单";
    create.addEventListener("click", () => actions.openPlaylistDialog().catch(showError));
    list.append(create);
    return list;
  }

  function homeSmartPlaylistList() {
    const list = document.createElement("div");
    list.className = "music-home-list";
    const smartPlaylists = (music.smartPlaylists || []).slice(0, 8);
    if (!smartPlaylists.length) {
      list.append(homeEmpty("暂无智能歌单"));
      return list;
    }
    for (const smart of smartPlaylists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-smart";
      const badge = document.createElement("b");
      badge.textContent = smart.badge || "智能";
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = smart.name || "智能歌单";
      const small = document.createElement("small");
      small.textContent = `${formatNumber(smart.trackCount || 0)} 首 · ${smart.description || "动态更新"}`;
      text.append(strong, small);
      button.append(badge, text);
      button.addEventListener("click", () => actions.selectMusicMode("smart", { smartId: smart.id }));
      list.append(button);
    }
    return list;
  }

  function homeGenreList() {
    const list = document.createElement("div");
    list.className = "music-home-pill-list";
    const genres = (music.genres || []).slice(0, 12);
    if (!genres.length) {
      list.append(homeEmpty("还没有风格信息"));
      return list;
    }
    for (const genre of genres) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-pill";
      button.textContent = `${genre.name} · ${formatNumber(genre.trackCount || 0)}`;
      button.addEventListener("click", () => actions.selectGenre(genre.name));
      list.append(button);
    }
    return list;
  }

  function homeArtistList() {
    const list = document.createElement("div");
    list.className = "music-home-pill-list";
    const artists = (music.artists || []).slice(0, 12);
    if (!artists.length) {
      list.append(homeEmpty("还没有歌手信息"));
      return list;
    }
    for (const artist of artists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-pill";
      button.textContent = `${artist.name} · ${formatNumber(artist.trackCount || 0)}`;
      button.addEventListener("click", () => {
        music.mode = "library";
        music.favorite = false;
        music.activePlaylistId = "";
        music.activeSmartPlaylistId = "";
        music.artistId = artist.id;
        music.albumId = "all";
        music.genre = "all";
        actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function homeAlbumList() {
    const list = document.createElement("div");
    list.className = "music-home-album-grid";
    const albums = (music.albums || []).slice(0, 8);
    if (!albums.length) {
      list.append(homeEmpty("还没有专辑信息"));
      return list;
    }
    for (const album of albums) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-home-album";
      button.append(h.renderCover(album, "tiny"));
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = album.title || "未知专辑";
      const small = document.createElement("small");
      small.textContent = `${album.artistName || "未知歌手"} · ${formatNumber(album.trackCount || 0)} 首`;
      text.append(strong, small);
      button.append(text);
      button.addEventListener("click", () => {
        music.mode = "library";
        music.favorite = false;
        music.activePlaylistId = "";
        music.activeSmartPlaylistId = "";
        music.artistId = album.artistId || "all";
        music.albumId = album.id;
        music.genre = "all";
        actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(showError);
      });
      list.append(button);
    }
    return list;
  }

  function homeEmpty(text) {
    const empty = document.createElement("div");
    empty.className = "music-home-empty";
    empty.textContent = text;
    return empty;
  }

  return { renderHero, renderHomePanel, renderReportPanel };
}
