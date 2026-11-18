import { formatNumber } from "../../js/format.js";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-78764ed05056";

const PAGE_SIZE = 30;

export function openMusicQueueSearch({ trigger, isCurrent, readQueue, isCurrentTrack, resolveRow, locate }) {
  const sheet = openMobileActionSheet({ title: "搜索播放队列", trigger });
  sheet.panel.classList.add("music-mobile-queue-search-sheet");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "输入歌名、歌手或专辑";
  search.setAttribute("aria-label", "搜索队列歌曲");
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  const results = document.createElement("div");
  results.className = "music-mobile-queue-search-results";
  const list = document.createElement("ul");
  const more = button("显示更多歌曲", "music-mobile-queue-search-more");
  more.hidden = true;
  results.append(list, more);
  sheet.panel.append(search, status, results);

  const current = () => sheet.overlay.isConnected && isCurrent();
  const normalize = text => String(text || "").normalize("NFKC").toLocaleLowerCase();
  let composing = false;
  let limit = PAGE_SIZE;

  function choose(track, play) {
    const row = resolveRow(track);
    if (!row) {
      render("队列已更新，请重新选择");
      search.focus({ preventScroll: true });
      return;
    }
    sheet.close(false);
    if (play) row.click();
    else locate(row);
  }

  function render(message = "") {
    const tracks = readQueue();
    const terms = normalize(search.value).trim().split(/\s+/u).filter(Boolean);
    const matches = [];
    if (terms.length) tracks.forEach((track, index) => {
      const text = normalize([track.title, track.fileName, track.artist, track.album].filter(Boolean).join(" "));
      if (terms.every(term => text.includes(term))) matches.push({ track, index });
    });
    status.textContent = message || (!terms.length ? `可搜索队列中的 ${formatNumber(tracks.length)} 首歌曲`
      : matches.length ? `匹配 ${formatNumber(matches.length)} 首` : "没有匹配的歌曲");
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    let nextFocus;
    const fragment = document.createDocumentFragment();
    for (const { track, index } of matches.slice(0, limit)) {
      const title = track.title || track.fileName || "未知歌曲";
      const position = `第 ${formatNumber(index + 1)} 首`;
      const item = document.createElement("li");
      const target = button("", "music-mobile-queue-search-locate");
      target.dataset.trackId = String(track.id);
      target.setAttribute("aria-label", `定位「${title}」，${position}`);
      const name = document.createElement("strong");
      name.textContent = title;
      const meta = document.createElement("small");
      meta.textContent = [position, track.artist, track.album].filter(Boolean).join(" · ");
      target.append(name, meta);
      target.addEventListener("click", () => { if (current() && target.isConnected) choose(track, false); });
      const playing = isCurrentTrack(track);
      const play = button(playing ? "当前" : "播放", "music-mobile-queue-search-play");
      play.dataset.trackId = String(track.id);
      play.disabled = playing;
      play.setAttribute("aria-label", `${play.disabled ? "当前歌曲" : "播放"}「${title}」`);
      play.addEventListener("click", () => { if (current() && play.isConnected && !isCurrentTrack(track)) choose(track, true); });
      item.append(target, play);
      fragment.append(item);
      if (focused?.dataset.trackId === target.dataset.trackId) {
        nextFocus = !play.disabled && focused.className === play.className ? play : target;
      }
    }
    list.replaceChildren(fragment);
    more.hidden = matches.length <= limit;
    if (focused) (nextFocus || search).focus({ preventScroll: true });
  }

  const apply = () => {
    if (!current() || composing) return;
    limit = PAGE_SIZE;
    results.scrollTop = 0;
    render();
  };
  search.addEventListener("input", apply);
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; apply(); });
  more.addEventListener("click", () => {
    if (!current()) return;
    const focused = document.activeElement === more;
    const firstNew = limit;
    limit += PAGE_SIZE;
    render();
    if (focused) (list.children[firstNew]?.firstElementChild || search).focus();
  });
  sheet.panel.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const last = more.hidden ? [...list.querySelectorAll("button:not(:disabled)")].at(-1) || search : more;
    if (document.activeElement !== (event.shiftKey ? sheet.closeButton : last)) return;
    event.preventDefault();
    (event.shiftKey ? last : sheet.closeButton).focus();
  });
  render();
  search.focus({ preventScroll: true });
  return { close: sheet.close, isCurrent: current, refresh: () => { if (current() && !composing) render(); } };
}

function button(label, className) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.className = className;
  return control;
}
