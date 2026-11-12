import { isAccountOwnerCurrent } from "../../js/account-owner.js";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-06c1d7f13464";

const STORAGE_PREFIX = "fanhao.android.media.watchlist.v1:";
const MAX_ITEMS = 200;
const PAGE_SIZE = 20;
const KIND_NAMES = new Map([["movie", "电影"], ["tv", "电视剧"], ["anime", "动漫"]]);

export function createMediaWatchlist({ container, getActiveUrl }) {
  let cache = null;

  function scopeFor(scope) {
    const account = scope?.accountScope;
    if (!account || account.owner === "pending" || !isAccountOwnerCurrent(account)) return null;
    return { ...scope, key: STORAGE_PREFIX + JSON.stringify([account.origin, account.owner]) };
  }

  function current(scope, node) {
    return node.isConnected && scope.activeUrl === getActiveUrl() && isAccountOwnerCurrent(scope.accountScope) && scope.isCurrent();
  }

  function read(scope) {
    const raw = localStorage.getItem(scope.key);
    if (cache?.key === scope.key && cache.raw === raw) return cache.items;
    const value = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("待看清单读取失败");
    const items = new Map();
    for (const saved of value) {
      const item = normalizeItem(saved);
      if (item && !items.has(item.key)) items.set(item.key, item);
      if (items.size >= MAX_ITEMS) break;
    }
    cache = { key: scope.key, raw, items };
    return items;
  }

  function write(scope, items, key) {
    const raw = JSON.stringify([...items.values()]);
    localStorage.setItem(scope.key, raw);
    cache = { key: scope.key, raw, items };
    for (const button of container.querySelectorAll(`[data-media-watch-key="${CSS.escape(key)}"]`)) {
      paint(button, items.has(key));
    }
  }

  function paint(button, saved) {
    button.textContent = saved ? "✓" : "+";
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute("aria-label", `${saved ? "已加入待看" : "加入待看"} · ${button.dataset.mediaWatchTitle}`);
  }

  function report(message) {
    const status = container.querySelector(".media-watch-message");
    if (status) status.textContent = message;
  }

  function createToggle(input, options) {
    const item = normalizeItem(input), scope = scopeFor(options);
    if (!item || !scope) return null;
    const button = createButton("", "media-watch-toggle");
    button.dataset.mediaWatchKey = item.key;
    button.dataset.mediaWatchTitle = item.title;
    try { paint(button, read(scope).has(item.key)); }
    catch { paint(button, false); }
    button.addEventListener("click", () => {
      if (!current(scope, button)) return;
      try {
        const items = new Map(read(scope));
        if (items.has(item.key)) items.delete(item.key);
        else {
          if (items.size >= MAX_ITEMS) { report(`待看清单已满，最多 ${MAX_ITEMS} 部。`); return; }
          items.set(item.key, item);
        }
        write(scope, items, item.key);
        report(items.has(item.key) ? "已加入待看" : "已移出待看");
      } catch { report("待看清单保存失败，请检查手机存储。"); }
    });
    return button;
  }

  function createEntry(options, onOpen) {
    const scope = scopeFor(options);
    if (!scope) return null;
    const entry = document.createElement("div");
    entry.className = "media-watch-entry";
    const button = createButton("待看清单", "media-watch-trigger");
    button.setAttribute("aria-haspopup", "dialog");
    const status = document.createElement("span");
    status.className = "media-watch-message";
    status.setAttribute("role", "status");
    entry.append(button, status);
    button.addEventListener("click", () => {
      if (current(scope, button)) showList(button, scope, onOpen);
    });
    return entry;
  }

  function showList(trigger, scope, onOpen) {
    const sheet = openMobileActionSheet({ trigger, title: "本机待看清单" });
    sheet.panel.classList.add("media-watch-panel");
    const filters = document.createElement("div"), input = document.createElement("input"), kind = document.createElement("select");
    filters.className = "media-watch-filters";
    input.type = "search";
    input.placeholder = "搜索片名";
    input.setAttribute("aria-label", "搜索待看片名");
    kind.setAttribute("aria-label", "待看类型");
    for (const [value, title] of [["all", "全部类型"], ...KIND_NAMES]) kind.append(new Option(title, value));
    filters.append(input, kind);
    const status = document.createElement("p"), list = document.createElement("ul"), paging = document.createElement("footer");
    status.setAttribute("role", "status");
    const previous = createButton("上一页"), next = createButton("下一页"), pageLabel = document.createElement("span");
    paging.append(previous, pageLabel, next);
    sheet.panel.append(filters, status, list, paging);
    let page = 0, query = "", composing = false;
    const owns = () => sheet.panel.isConnected && current(scope, trigger);

    function render() {
      if (!owns()) return;
      let items;
      try { items = [...read(scope).values()].reverse(); }
      catch { status.textContent = "待看清单无法读取，请检查手机存储。"; list.replaceChildren(); paging.hidden = true; return; }
      const matches = items.filter(item => (kind.value === "all" || item.kind === kind.value) && folded(item.title).includes(query));
      const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      page = Math.min(Math.max(0, page), pages - 1);
      paging.hidden = pages === 1;
      previous.disabled = page === 0;
      next.disabled = page === pages - 1;
      pageLabel.textContent = `${page + 1} / ${pages}`;
      status.textContent = matches.length ? `${matches.length} 部待看` : items.length ? "没有匹配的作品。" : "在影视卡片上选择「加入待看」。";
      list.replaceChildren(...matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row));
      list.scrollTop = 0;
    }

    function row(item, index) {
      const node = document.createElement("li"), name = createButton(item.title, "media-watch-open");
      name.setAttribute("aria-label", `打开 · ${item.title}`);
      const type = document.createElement("small");
      type.textContent = KIND_NAMES.get(item.kind);
      const remove = createButton("移除", "media-watch-remove");
      remove.setAttribute("aria-label", `移出待看 · ${item.title}`);
      name.addEventListener("click", () => {
        if (node.isConnected && owns() && sheet.close(false)) onOpen(item);
      });
      remove.addEventListener("click", () => {
        if (!node.isConnected || !owns()) return;
        try {
          const items = new Map(read(scope));
          items.delete(item.key);
          write(scope, items, item.key);
          render();
          (list.children[Math.min(index, list.children.length - 1)]?.querySelector(".media-watch-remove") || input).focus({ preventScroll: true });
        } catch { status.textContent = "移除失败，请检查手机存储。"; }
      });
      node.append(name, type, remove);
      return node;
    }

    const search = () => { if (!composing) { query = folded(input.value); page = 0; render(); } };
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; search(); });
    input.addEventListener("input", search);
    kind.addEventListener("change", () => { page = 0; render(); });
    for (const [control, direction] of [[previous, -1], [next, 1]]) control.addEventListener("click", () => {
      if (!owns() || control.disabled) return;
      page += direction;
      render();
      if (control.disabled) (direction < 0 ? next : previous).focus({ preventScroll: true });
    });
    render();
  }

  return { createEntry, createToggle };
}

function createButton(label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function normalizeItem(value) {
  if (!KIND_NAMES.has(value?.kind)) return null;
  const { kind } = value, title = typeof value.title === "string" ? value.title.trim().slice(0, 512) : "";
  if (kind === "movie") {
    const id = text(value.id, 200);
    return id && title ? { kind, id, title, key: JSON.stringify([kind, id]) } : null;
  }
  const seriesKey = text(value.seriesKey, 1024), category = text(value.category, 512);
  return seriesKey && title ? { kind, seriesKey, category, title, key: JSON.stringify([kind, seriesKey]) } : null;
}

function text(value, limit) { return typeof value === "string" && value.length <= limit ? value.trim() : ""; }
function folded(value) { return value.normalize("NFKC").trim().toLocaleLowerCase(); }
