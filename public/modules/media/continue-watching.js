import { routeFromUrl } from "../../js/router.js?v=20261108-photo-issue-sort-01";
import { captureWebAccount } from "../../platform/accounts/session-context.js";

const READ_TIMEOUT_MS = 10000;
const VISIBLE_LIMIT = 6;
const CANDIDATE_LIMIT = 24;
const HIDDEN_LIMIT = 200;
const HIDDEN_PREFIX = "fanhao.media.continue.hidden.v1:";

function currentAccount() {
  try {
    const account = captureWebAccount();
    return { owner: account.owner || "guest", revision: account.revision };
  } catch { return null; }
}

function readHidden(account) {
  try {
    const value = JSON.parse(localStorage.getItem(HIDDEN_PREFIX + account.owner) || "[]");
    return new Map(Array.isArray(value) ? value.slice(-HIDDEN_LIMIT).filter(entry =>
      Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") : []);
  } catch { return new Map(); }
}

function control(label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function mediaContinueKind(gallery) {
  if (!["media", "movie", "tv"].includes(gallery.mode) || gallery.query || gallery.media || gallery.seriesKey
    || [gallery.category, gallery.subCategory, gallery.person].some(value => value && value !== "all")
    || routeFromUrl().galleryMediaId) return "";
  return gallery.mode === "media" ? gallery.mediaKind || "all" : gallery.mode;
}

export function createContinueWatching({ api, playerUrl }) {
  let current = null;

  function cancel(selection) {
    if (!selection?.request) return;
    const request = selection.request;
    selection.request = null;
    window.clearTimeout(request.timer);
    request.controller.abort();
  }

  function ownsShelf(selection) {
    const account = currentAccount();
    return selection === current && selection.section.isConnected && account && selection.account
      && account.owner === selection.account.owner && account.revision === selection.account.revision;
  }

  function changeHidden(selection, item, button) {
    if (!button.isConnected || !ownsShelf(selection)) return;
    const hidden = readHidden(selection.account);
    const restore = selection.showHidden;
    const refocus = document.activeElement === button;
    const entry = button.closest("li");
    const index = [...entry.parentElement.children].indexOf(entry);
    if (!restore || hidden.get(item.id) === item.progressRevision) hidden.delete(item.id);
    if (!restore) hidden.set(item.id, item.progressRevision);
    try {
      const key = HIDDEN_PREFIX + selection.account.owner;
      if (hidden.size) localStorage.setItem(key, JSON.stringify([...hidden].slice(-HIDDEN_LIMIT)));
      else localStorage.removeItem(key);
      selection.message = restore ? `已恢复「${item.title}」` : `已隐藏「${item.title}」`;
    } catch {
      selection.message = "无法保存隐藏设置，请检查浏览器存储";
    }
    show(selection, refocus ? { id: item.id, index } : null);
  }

  function show(selection, refocus = null) {
    const { section, heading, items, failed } = selection;
    const account = ownsShelf(selection) ? selection.account : null;
    const hidden = account ? readHidden(account) : new Map();
    const isHidden = item => item.progressRevision && hidden.get(item.id) === item.progressRevision;
    const hiddenItems = items.filter(isHidden);
    if (!hiddenItems.length) selection.showHidden = false;
    const visibleItems = selection.showHidden ? hiddenItems : items.filter(item => !isHidden(item)).slice(0, VISIBLE_LIMIT);
    const previousList = section.querySelector(".media-continue-list");
    const scrollLeft = previousList?.dataset.hiddenView === String(selection.showHidden) ? previousList.scrollLeft : 0;
    section.hidden = !failed && items.length === 0;
    const header = document.createElement("header");
    header.className = "media-continue-heading";
    header.append(heading);
    let manage;
    if (hiddenItems.length) {
      manage = control(selection.showHidden ? "返回继续观看" : `已隐藏 ${hiddenItems.length} 项`, "text-button media-continue-manage");
      manage.addEventListener("click", () => {
        if (!manage.isConnected || !ownsShelf(selection)) return;
        selection.showHidden = !selection.showHidden;
        selection.message = "";
        show(selection, document.activeElement === manage ? { manage: true } : null);
      });
      header.append(manage);
    }
    section.replaceChildren(header);
    if (failed) {
      const status = document.createElement("p");
      status.className = "media-continue-error";
      status.textContent = "播放进度读取失败";
      const retry = control("重试", "text-button");
      retry.addEventListener("click", () => load(selection, document.activeElement === retry));
      status.append(" ", retry);
      section.append(status);
    } else if (visibleItems.length) {
      const list = document.createElement("ul");
      list.className = "media-continue-list";
      list.dataset.hiddenView = String(selection.showHidden);
      for (const item of visibleItems) {
        const entry = createItem(item, playerUrl(item));
        if (account && typeof item.progressRevision === "string" && item.progressRevision) {
          const label = selection.showHidden ? "恢复" : "隐藏";
          const action = control(label, "media-continue-action");
          action.setAttribute("aria-label", `${label}「${item.title}」`);
          action.addEventListener("click", () => changeHidden(selection, item, action));
          entry.classList.add("media-continue-manageable");
          entry.append(action);
        }
        list.append(entry);
      }
      section.append(list);
      list.scrollLeft = scrollLeft;
    }
    if (selection.message) {
      const status = document.createElement("p");
      status.className = "media-continue-notice";
      status.setAttribute("role", "status");
      status.textContent = selection.message;
      section.append(status);
    }
    if (refocus && document.activeElement === document.body) {
      const links = [...section.querySelectorAll(".media-continue-card")];
      const entry = links.find(link => link.dataset.mediaId === refocus.id) || links[Math.min(refocus.index ?? 0, links.length - 1)];
      (refocus.manage ? manage : entry || manage || section.querySelector("button"))?.focus({ preventScroll: true });
    }
  }

  async function load(selection, refocus = false) {
    if (selection !== current || selection.request) return;
    const request = { controller: new AbortController(), timer: 0 };
    selection.request = request;
    const { section } = selection;
    section.setAttribute("aria-busy", "true");
    const finish = (items, failed, timedOut = false) => {
      if (selection !== current || selection.request !== request) return;
      selection.request = null;
      window.clearTimeout(request.timer);
      if (timedOut) request.controller.abort();
      section.removeAttribute("aria-busy");
      selection.items = items;
      selection.failed = failed;
      selection.account = currentAccount();
      selection.message = "";
      if (section.isConnected) show(selection, refocus ? {} : null);
    };
    request.timer = window.setTimeout(() => finish([], true, true), READ_TIMEOUT_MS);
    try {
      const data = await api(`/api/gallery-media/continue-watching?kind=${encodeURIComponent(selection.kind)}&limit=${CANDIDATE_LIMIT}&includeProgressRevision=1`, {
        signal: request.controller.signal, cache: "no-store"
      });
      const items = Array.isArray(data?.items) ? data.items.slice(0, CANDIDATE_LIMIT)
        .filter(item => typeof item?.id === "string" && item.id && Number.isFinite(item.percent)) : [];
      finish(items, false);
    } catch (error) {
      finish([], ![404, 409].includes(error?.status) && error?.code !== "ACCOUNT_CHANGED");
    }
  }

  window.addEventListener("pagehide", () => {
    if (!current) return;
    cancel(current);
    current.section.hidden = true;
    current.section.replaceChildren(current.heading);
    current.items = [];
    current.showHidden = false;
    current.account = null;
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted && current?.section.isConnected) void load(current);
  });

  return function render(container, gallery) {
    const kind = mediaContinueKind(gallery);
    if (current?.kind !== kind) {
      cancel(current);
      current?.section.remove();
      current = null;
      if (!kind) return;
      const section = document.createElement("section");
      section.className = "media-continue";
      section.hidden = true;
      section.setAttribute("aria-labelledby", "media-continue-title");
      const heading = document.createElement("h2");
      heading.id = "media-continue-title";
      heading.textContent = "继续观看";
      current = { kind, section, heading, request: null, items: [], account: null, failed: false, showHidden: false, message: "" };
      void load(current);
    }
    if (current) {
      for (const link of current.section.querySelectorAll(".media-continue-card")) link.href = playerUrl({ id: link.dataset.mediaId });
      if (current.section.parentElement !== container) container.append(current.section);
    }
  };
}

function createItem(item, href) {
  const entry = document.createElement("li");
  const link = document.createElement("a");
  link.href = href;
  link.className = "media-continue-card";
  link.dataset.mediaId = item.id;
  const cover = document.createElement("span");
  cover.className = "media-continue-cover";
  cover.setAttribute("aria-hidden", "true");
  cover.textContent = "▶";
  if (item.coverUrl) {
    const image = document.createElement("img");
    image.src = item.coverUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    cover.append(image);
  }
  const copy = document.createElement("span");
  copy.className = "media-continue-copy";
  const title = document.createElement("strong");
  title.title = title.textContent = item.title;
  copy.append(title);
  if (item.episodeTitle) {
    const episode = document.createElement("span");
    episode.title = episode.textContent = item.episodeTitle;
    copy.append(episode);
  }
  const progress = document.createElement("small");
  const percent = Math.min(100, Math.max(0, Math.floor(item.percent)));
  progress.textContent = `已看 ${percent}%`;
  copy.append(progress);
  link.append(cover, copy);
  entry.append(link);
  return entry;
}
