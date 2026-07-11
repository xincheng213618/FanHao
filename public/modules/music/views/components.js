// 共享 DOM 渲染原语（叶子组件）。
// 通过工厂注入 music（状态切片）、actions（编排层）、formatNumber（宿主格式化）
// 与 DOM 注册回调（把渲染出的元素登记到组合根的索引表）。
// 视图层（含 home.js）只调用这里导出的原语 + actions，不反向捕获组合根闭包。

import { qualityLabel, ratingLabel, formatClock } from "../format.js";

export function createComponents(deps) {
  const { music, actions, formatNumber, registerMusicTrackElement, registerCurrentTrackIndicator, registerPlaybackButton } = deps;

  function filterButton(id, label, count, active, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-filter-button${active ? " active" : ""}`;
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = count === "" || count === null || count === undefined ? "" : formatNumber(count || 0);
    button.append(strong, span);
    button.addEventListener("click", () => action());
    return button;
  }

  function sidebarSection(label, content, { open = false, meta = "" } = {}) {
    const section = document.createElement("details");
    section.className = "music-sidebar-section";
    section.open = Boolean(open);
    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    title.textContent = label;
    const count = document.createElement("span");
    count.textContent = meta;
    summary.append(title, count);
    const body = document.createElement("div");
    body.className = "music-sidebar-section-content";
    body.append(content);
    section.append(summary, body);
    return section;
  }

  function sidebarBrowseButton(label, meta, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-sidebar-more";
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = meta;
    button.append(strong, span);
    button.addEventListener("click", () => action());
    return button;
  }

  function renderCover(item, size = "") {
    const cover = document.createElement("span");
    cover.className = `music-cover ${size}`.trim();
    if (item.coverUrl) {
      const img = document.createElement("img");
      img.src = item.coverUrl;
      img.alt = item.album || item.title || "专辑封面";
      img.loading = size === "large" ? "eager" : "lazy";
      img.decoding = "async";
      cover.append(img);
    } else {
      const text = document.createElement("strong");
      text.textContent = initialsLocal(item.album || item.title || item.artist || "音乐");
      cover.append(text);
    }
    return cover;
  }

  function initialsLocal(value) {
    const text = String(value || "音乐").trim();
    return text.slice(0, Math.min(2, text.length)).toUpperCase();
  }

  function controlButton(label, action, disabled = false, kind = "", ariaLabel = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-control-button${kind ? ` ${kind}` : ""}`;
    button.textContent = label;
    button.disabled = disabled;
    if (ariaLabel) {
      button.setAttribute("aria-label", ariaLabel);
      button.title = ariaLabel;
    }
    button.addEventListener("click", action);
    return button;
  }

  function iconControlButton(iconName, action, disabled = false, kind = "", ariaLabel = "") {
    const button = controlButton("", action, disabled, `icon${kind ? ` ${kind}` : ""}`, ariaLabel);
    button.dataset.iconControl = "true";
    setControlButtonIcon(button, iconName);
    return button;
  }

  function setControlButtonIcon(button, iconName) {
    if (!button) return;
    const normalizedIcon = String(iconName || "").trim();
    if (button.dataset.musicControlIcon === normalizedIcon && button.firstElementChild) return;
    button.dataset.musicControlIcon = normalizedIcon;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("music-control-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("viewBox", "0 0 18 18");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/vendor/plyr/plyr.svg#plyr-${normalizedIcon}`);
    svg.append(use);
    button.replaceChildren(svg);
  }

  function emptyRow(message) {
    const empty = document.createElement("div");
    empty.className = "music-empty-row";
    empty.textContent = message;
    return empty;
  }

  function trackHeader() {
    const row = document.createElement("div");
    row.className = "music-track-row head";
    for (const label of ["", "歌曲", "歌手", "专辑", "音质", "时长", ""]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      row.append(cell);
    }
    return row;
  }

  function trackRow(track, index) {
    const row = document.createElement("div");
    row.className = `music-track-row${music.current?.id === track.id ? " active" : ""}`;
    registerMusicTrackElement(row, track.id);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `播放 ${track.title}${Number(track.duplicateCount || 0) > 1 ? `，已合并 ${track.duplicateCount} 个版本` : ""}`);
    const number = document.createElement("span");
    const numberLabel = String(index + 1).padStart(2, "0");
    number.textContent = music.current?.id === track.id && music.playing ? "Ⅱ" : numberLabel;
    registerCurrentTrackIndicator(number, track.id, numberLabel, "Ⅱ");
    const title = document.createElement("span");
    title.className = "music-track-title";
    const strong = document.createElement("strong");
    strong.textContent = track.title;
    const small = document.createElement("small");
    small.textContent = trackSecondaryText(track);
    title.append(strong, small);
    const artist = document.createElement("span");
    artist.textContent = track.artist || "未知歌手";
    const album = document.createElement("span");
    album.textContent = track.album || "未知专辑";
    const quality = document.createElement("span");
    quality.textContent = qualityLabel(track);
    const duration = document.createElement("span");
    duration.textContent = formatClock(track.durationMs || 0);
    const actionsEl = document.createElement("span");
    actionsEl.className = "music-track-actions";
    actionsEl.append(
      trackActionButton("下首", `下一首播放 ${track.title}`, () => actions.queueTrackNext(track)),
      trackActionButton("入队", `加入队列 ${track.title}`, () => actions.appendTrackToQueue(track)),
      trackActionButton("下载", `下载 ${track.title}`, () => actions.downloadTrack(track))
    );
    row.append(number, title, artist, album, quality, duration, actionsEl);
    row.addEventListener("click", () => actions.openTrackFromList(track, music.data?.tracks || [], { autoplay: true }).catch(() => {}));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      actions.openTrackFromList(track, music.data?.tracks || [], { autoplay: true }).catch(() => {});
    });
    return row;
  }

  function trackSecondaryText(track) {
    return [
      ratingLabel(track.rating),
      track.hasLyrics ? "歌词" : track.fileName || "",
      Number(track.duplicateCount || 0) > 1 ? `${formatNumber(track.duplicateCount)} 个版本` : ""
    ].filter(Boolean).join(" · ");
  }

  function trackActionButton(label, ariaLabel, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-track-action";
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action();
    });
    return button;
  }

  function renderRatingControl(track, variant = "") {
    const rating = Math.max(0, Math.min(5, Number(track?.rating || 0)));
    const wrap = document.createElement("div");
    wrap.className = `music-rating${variant ? ` ${variant}` : ""}`;
    wrap.setAttribute("aria-label", track ? `评分：${rating || "未评分"}` : "评分");
    for (let value = 1; value <= 5; value += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = value <= rating ? "★" : "☆";
      button.disabled = !track;
      button.className = value <= rating ? "active" : "";
      const nextRating = value === rating ? 0 : value;
      button.setAttribute("aria-label", nextRating ? `设为 ${value} 星` : "清除评分");
      button.title = nextRating ? `设为 ${value} 星` : "清除评分";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        actions.setTrackRating(track.id, nextRating).catch(() => {});
      });
      wrap.append(button);
    }
    return wrap;
  }

  function renderAlphaIndex(currentLetter) {
    const bar = document.createElement("div");
    bar.className = "music-alpha-index";
    const items = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(["0-9", "待", "#"]);
    for (const item of items) {
      const value = item === "0-9" ? "0" : item;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "music-alpha-index-item" + (currentLetter === value ? " active" : "");
      button.textContent = item;
      button.addEventListener("click", () => {
        music.letter = music.letter === value ? "" : value;
        actions.loadMusic({ replaceRoute: true, keepCurrent: true }).catch(() => {});
      });
      bar.append(button);
    }
    return bar;
  }

  function queueRow(track, index) {
    const row = document.createElement("div");
    row.className = `music-queue-row${music.current?.id === track.id ? " active" : ""}`;
    registerMusicTrackElement(row, track.id);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "music-queue-play";
    play.textContent = `${track.title} - ${track.artist || "未知歌手"}`;
    play.addEventListener("click", () => actions.openTrack(track.id, { autoplay: true }).catch(() => {}));
    const actionsEl = document.createElement("span");
    actionsEl.className = "music-queue-actions";
    actionsEl.append(
      queueActionButton("↑", "上移", () => actions.moveQueueTrack(track.id, -1), index <= 0),
      queueActionButton("↓", "下移", () => actions.moveQueueTrack(track.id, 1), index >= (music.queue || []).length - 1),
      queueActionButton("×", "移出队列", () => actions.removeTrackFromQueue(track.id), music.current?.id === track.id)
    );
    row.append(play, actionsEl);
    return row;
  }

  function queueActionButton(label, ariaLabel, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-queue-action";
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    button.addEventListener("click", action);
    return button;
  }

  function emptyQueueRow(message) {
    const row = document.createElement("div");
    row.className = "music-queue-empty";
    row.textContent = message;
    return row;
  }

  function stageActionButton(label, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-stage-action";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }

  function stageTrackRow(track, index) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `music-stage-track${music.current?.id === track.id ? " active" : ""}`;
    registerMusicTrackElement(row, track.id);
    const number = document.createElement("span");
    const numberLabel = String(index + 1);
    number.textContent = music.current?.id === track.id && music.playing ? "▮▮" : numberLabel;
    registerCurrentTrackIndicator(number, track.id, numberLabel, "▮▮");
    const title = document.createElement("strong");
    title.textContent = track.title || "未知歌曲";
    const artist = document.createElement("small");
    artist.textContent = track.artist || "未知歌手";
    const duration = document.createElement("em");
    duration.textContent = formatClock(track.durationMs || 0);
    row.append(number, title, artist, duration);
    row.addEventListener("click", () => actions.openTrack(track.id, { autoplay: true }).catch(() => {}));
    return row;
  }

  return {
    filterButton,
    sidebarSection,
    sidebarBrowseButton,
    renderCover,
    controlButton,
    iconControlButton,
    setControlButtonIcon,
    emptyRow,
    trackHeader,
    trackRow,
    trackSecondaryText,
    trackActionButton,
    renderRatingControl,
    renderAlphaIndex,
    queueRow,
    queueActionButton,
    emptyQueueRow,
    stageActionButton,
    stageTrackRow
  };
}
