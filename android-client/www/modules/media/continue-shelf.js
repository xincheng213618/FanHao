import { loadPreviewImage } from "../../js/image.js?v=assets-06c1d7f13464";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-06c1d7f13464";

const STORAGE_PREFIX = "fanhao.android.media.continueHidden.v1:";
const HIDDEN_LIMIT = 200;
const SHELF_LIMIT = 6;

export function createContinueShelf({ activeUrl, account, items, isCurrent, onPlay }) {
  const key = STORAGE_PREFIX + JSON.stringify([account.origin, account.owner]);
  const section = document.createElement("section");
  section.className = "media-continue-shelf";
  section.setAttribute("aria-labelledby", "mediaContinueTitle");
  const head = document.createElement("header");
  const heading = document.createElement("h2");
  heading.id = "mediaContinueTitle";
  heading.textContent = "继续观看";
  head.append(heading);
  const manage = button("管理记录", "media-continue-manage");
  manage.setAttribute("aria-haspopup", "dialog");
  const list = document.createElement("ul");
  const cards = new Map();
  const empty = document.createElement("p");
  empty.className = "media-continue-empty";
  empty.textContent = "暂无显示的观看记录";
  section.append(head, list, empty);
  if (items.some(hasRevision) || items.length > SHELF_LIMIT) head.append(manage);

  let sheet = null;
  const owns = () => section.isConnected && isCurrent();
  const matchesHidden = (hidden, item) => hasRevision(item) && hidden.get(item.id) === item.progressRevision;
  const dispose = () => { sheet?.close(false); section.remove(); };

  function renderShelf(hidden) {
    const visible = items.filter(item => !matchesHidden(hidden, item)).slice(0, SHELF_LIMIT);
    const previousScroll = list.scrollLeft;
    list.replaceChildren(...visible.map(item => {
      if (cards.has(item)) return cards.get(item);
      const row = document.createElement("li");
      const play = button("", "media-continue-play");
      const cover = document.createElement("span");
      cover.className = "media-continue-cover";
      cover.setAttribute("aria-hidden", "true");
      const fallback = document.createElement("span");
      fallback.textContent = "▶";
      cover.append(fallback);
      const coverUrl = sameOriginCover(activeUrl, item.coverUrl);
      if (coverUrl) void loadPreviewImage(fallback, coverUrl, { cacheBaseUrl: activeUrl });
      play.append(cover, itemText(item));
      play.addEventListener("click", () => { if (owns() && play.isConnected) onPlay(item.id); });
      row.append(play);
      cards.set(item, row);
      return row;
    }));
    empty.hidden = visible.length > 0;
    list.hidden = !visible.length;
    list.scrollLeft = previousScroll;
  }

  manage.addEventListener("click", () => {
    if (!owns()) return;
    const panel = sheet = openMobileActionSheet({ title: "继续观看记录", trigger: manage });
    panel.panel.classList.add("media-continue-panel");
    const views = document.createElement("div");
    views.className = "media-continue-views";
    const active = button("可继续"), hiddenView = button("已隐藏");
    views.append(active, hiddenView);
    const status = document.createElement("p");
    status.className = "media-continue-status";
    status.setAttribute("role", "status");
    const rows = document.createElement("ul");
    panel.panel.append(views, status, rows);
    let showHidden = false;
    const ownsPanel = () => owns() && panel.overlay.isConnected && sheet === panel;

    function render(hidden, message = "", focusIndex = null) {
      const hiddenCount = items.filter(item => matchesHidden(hidden, item)).length;
      const matching = items.filter(item => matchesHidden(hidden, item) === showHidden);
      active.setAttribute("aria-pressed", String(!showHidden));
      hiddenView.setAttribute("aria-pressed", String(showHidden));
      hiddenView.textContent = `已隐藏 ${hiddenCount}`;
      status.textContent = message || (matching.length ? `${matching.length} 条记录` : showHidden ? "没有已隐藏的记录" : "暂无显示的观看记录");
      rows.replaceChildren(...matching.map((item, index) => {
        const row = document.createElement("li");
        const name = showHidden ? document.createElement("div") : button("", "media-continue-open");
        name.append(itemText(item));
        if (!showHidden) name.addEventListener("click", () => {
          if (row.isConnected && ownsPanel() && panel.close(false)) onPlay(item.id);
        });
        row.append(name);
        if (hasRevision(item)) {
          const action = button(showHidden ? "恢复" : "隐藏", "media-continue-change");
          action.setAttribute("aria-label", `${action.textContent}「${item.title}」`);
          action.addEventListener("click", () => {
            if (!row.isConnected || !ownsPanel()) return;
            const updated = readHidden(key);
            if (showHidden && !matchesHidden(updated, item)) { render(updated, "记录已变化", index); return; }
            updated.delete(item.id);
            if (!showHidden) updated.set(item.id, item.progressRevision);
            try {
              if (updated.size) localStorage.setItem(key, JSON.stringify([...updated].slice(-HIDDEN_LIMIT)));
              else localStorage.removeItem(key);
            } catch {
              status.textContent = "无法保存，请检查本机存储";
              return;
            }
            const stored = readHidden(key);
            renderShelf(stored);
            render(stored, `${showHidden ? "已恢复" : "已隐藏"}「${item.title}」`, index);
          });
          row.append(action);
        }
        return row;
      }));
      if (focusIndex !== null) {
        const row = rows.children[Math.min(focusIndex, rows.children.length - 1)];
        (row?.querySelector(".media-continue-change, .media-continue-open") || (showHidden ? hiddenView : active)).focus();
      }
    }

    for (const [control, hidden] of [[active, false], [hiddenView, true]]) control.addEventListener("click", () => {
      if (!ownsPanel() || showHidden === hidden) return;
      showHidden = hidden;
      rows.scrollTop = 0;
      render(readHidden(key));
    });
    panel.panel.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const controls = rows.querySelectorAll("button");
      const last = controls[controls.length - 1] || hiddenView;
      if (document.activeElement !== (event.shiftKey ? panel.closeButton : last)) return;
      event.preventDefault();
      (event.shiftKey ? last : panel.closeButton).focus();
    });
    render(readHidden(key));
  });

  renderShelf(readHidden(key));
  return { section, dispose };
}

function readHidden(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return new Map(Array.isArray(value) ? value.slice(-HIDDEN_LIMIT).filter(entry =>
      Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") : []);
  } catch { return new Map(); }
}

function hasRevision(item) {
  return typeof item.progressRevision === "string" && item.progressRevision.length > 0;
}

function button(label, className = "") {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.className = className;
  return control;
}

function itemText(item) {
  const text = document.createElement("span");
  text.className = "media-continue-copy";
  const title = document.createElement("strong");
  title.textContent = item.title;
  title.title = item.title;
  text.append(title);
  if (item.episodeTitle) {
    const episode = document.createElement("span");
    episode.textContent = item.episodeTitle;
    text.append(episode);
  }
  const progress = document.createElement("small");
  progress.textContent = `已看 ${Math.max(0, Math.min(99, Math.floor(item.percent)))}%`;
  text.append(progress);
  return text;
}

function sameOriginCover(activeUrl, cover) {
  if (!cover) return "";
  try {
    const source = new URL(activeUrl);
    const url = new URL(cover, source);
    return url.origin === source.origin && ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}
