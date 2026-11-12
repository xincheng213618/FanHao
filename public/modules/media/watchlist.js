import { captureWebAccount } from "../../platform/accounts/session-context.js";

const STORAGE_PREFIX = "fanhao.media.watchlist.v1:";
const LIMIT = 200;
const PAGE_SIZE = 20;
const KIND_LABELS = new Map([["movie", "电影"], ["tv", "电视剧"], ["anime", "动漫"]]);

export function createMediaWatchlist({ root, isBrowsing, destination }) {
  let cache = null, dialog = null;

  function account() {
    try { const current = captureWebAccount(); return current.owner ? current : null; }
    catch { return null; }
  }

  function owns(expected) {
    const current = account();
    return isBrowsing() && current?.owner === expected.owner && current.revision === expected.revision;
  }

  function read(scope) {
    const key = STORAGE_PREFIX + scope.owner, raw = localStorage.getItem(key);
    if (cache?.key === key && cache.raw === raw) return cache.items;
    const value = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("待看清单无法读取");
    const items = new Map();
    for (const stored of value) {
      const item = normalizeItem(stored);
      if (item && !items.has(item.key)) items.set(item.key, item);
      if (items.size >= LIMIT) break;
    }
    cache = { key, raw, items };
    return items;
  }

  function write(scope, items) {
    const key = STORAGE_PREFIX + scope.owner, raw = JSON.stringify([...items.values()]);
    localStorage.setItem(key, raw);
    cache = { key, raw, items };
    for (const button of root.querySelectorAll("[data-media-watch-key]")) paint(button, items.has(button.dataset.mediaWatchKey));
  }

  function paint(button, saved) {
    button.textContent = saved ? "已加入待看" : "加入待看";
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute("aria-label", `${button.textContent} · ${button.dataset.mediaWatchTitle}`);
  }

  function report(message) {
    const status = root.querySelector(".gallery-watch-status");
    if (status) status.textContent = message;
  }

  function toggleFor(input) {
    const item = normalizeItem(input), scope = account();
    if (!item || !scope) return null;
    const button = control("", "gallery-watch-toggle");
    button.dataset.mediaWatchKey = item.key;
    button.dataset.mediaWatchTitle = item.title;
    try { paint(button, read(scope).has(item.key)); }
    catch { paint(button, false); }
    button.addEventListener("click", () => {
      if (!button.isConnected || !owns(scope)) return;
      try {
        const items = new Map(read(scope));
        if (items.has(item.key)) items.delete(item.key);
        else {
          if (items.size >= LIMIT) { report(`待看清单最多保存 ${LIMIT} 部，请先移除已看作品。`); return; }
          items.set(item.key, item);
        }
        write(scope, items);
        report("");
      } catch { report("待看清单保存失败，请检查浏览器存储。"); }
    });
    return button;
  }

  function wrap(card, item) {
    const button = toggleFor(item);
    if (!button) return card;
    const row = document.createElement("article");
    row.className = "gallery-watch-card";
    row.append(card, button);
    return row;
  }

  function close({ restoreFocus = true } = {}) {
    if (!dialog?.open) return;
    if (!restoreFocus) dialog.dataset.retired = "true";
    dialog.close();
  }

  function trigger() {
    const button = control("待看清单", "text-button gallery-watchlist-trigger");
    const container = document.createElement("div"), status = document.createElement("span");
    container.className = "gallery-watchlist-entry";
    status.className = "gallery-watch-status";
    status.setAttribute("role", "status");
    container.append(button, status);
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", () => {
      if (!button.isConnected || !isBrowsing()) return;
      const scope = account();
      if (!scope) { report("正在确认当前账号，请稍后再试。"); return; }
      if (!dialog?.open || !dialog.isConnected) open(button, scope);
    });
    return container;
  }

  function open(trigger, scope) {
    const panel = document.createElement("dialog");
    panel.className = "gallery-watchlist";
    panel.setAttribute("aria-labelledby", "gallery-watchlist-title");
    panel.innerHTML = `<header><h2 id="gallery-watchlist-title">本机待看清单</h2><button type="button" data-close>关闭</button></header>
      <div class="gallery-watchlist-filters"><input type="search" aria-label="搜索待看片名" placeholder="搜索片名"><select aria-label="待看类型"></select></div>
      <p role="status"></p><ul></ul>
      <nav aria-label="待看分页"><button type="button" data-previous>上一页</button><span></span><button type="button" data-next>下一页</button></nav>`;
    const input = panel.querySelector("input"), select = panel.querySelector("select"), list = panel.querySelector("ul"), status = panel.querySelector("[role=status]");
    const pager = panel.querySelector("nav"), pageNumber = pager.querySelector("span");
    const previous = pager.querySelector("[data-previous]"), next = pager.querySelector("[data-next]");
    for (const [value, label] of [["all", "全部类型"], ...KIND_LABELS]) select.append(new Option(label, value));
    let page = 0, composing = false;
    const current = () => dialog === panel && panel.open && panel.isConnected && owns(scope);

    function refresh() {
      if (!current()) return;
      let items;
      try { items = [...read(scope).values()].reverse(); }
      catch { list.replaceChildren(); pager.hidden = true; status.textContent = "待看清单无法读取，请检查浏览器存储。"; return; }
      const query = normalize(input.value), kind = select.value;
      const matches = items.filter(item => (kind === "all" || item.kind === kind) && (!query || normalize(item.title).includes(query)));
      const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      page = Math.max(0, Math.min(page, pages - 1));
      pager.hidden = pages === 1;
      previous.disabled = page === 0;
      next.disabled = page === pages - 1;
      pageNumber.textContent = `${page + 1} / ${pages}`;
      status.textContent = matches.length ? `${matches.length} 部待看` : items.length ? "没有匹配的作品" : "在影视卡片上选择「加入待看」。";
      list.replaceChildren(...matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row));
    }

    function row(item, index) {
      const entry = document.createElement("li"), link = document.createElement("a"), type = document.createElement("small");
      link.href = destination(item);
      link.textContent = item.title;
      link.addEventListener("click", event => { if (!current() || !link.isConnected) event.preventDefault(); });
      type.textContent = KIND_LABELS.get(item.kind);
      const remove = control("移除");
      remove.setAttribute("aria-label", `移出待看 · ${item.title}`);
      remove.addEventListener("click", () => {
        if (!current() || !entry.isConnected) return;
        try {
          const items = new Map(read(scope));
          items.delete(item.key);
          write(scope, items);
          refresh();
          (list.children[Math.min(index, list.children.length - 1)]?.querySelector("button") || input).focus({ preventScroll: true });
        } catch { status.textContent = "移除失败，请检查浏览器存储。"; }
      });
      entry.append(link, type, remove);
      return entry;
    }

    const filter = () => { if (!composing) { page = 0; refresh(); } };
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; filter(); });
    input.addEventListener("input", filter);
    select.addEventListener("change", filter);
    for (const [button, direction] of [[previous, -1], [next, 1]]) button.addEventListener("click", () => {
      if (!current() || button.disabled) return;
      page += direction;
      refresh();
      if (button.disabled) (direction < 0 ? next : previous).focus({ preventScroll: true });
    });
    panel.querySelector("[data-close]").addEventListener("click", () => close());
    panel.addEventListener("cancel", event => { if (composing) event.preventDefault(); });
    panel.addEventListener("close", () => {
      panel.remove();
      if (dialog === panel) dialog = null;
      const fallback = root.querySelector(".gallery-watchlist-trigger");
      if (!panel.dataset.retired && owns(scope)) (trigger.isConnected ? trigger : fallback)?.focus({ preventScroll: true });
    });
    dialog = panel;
    root.append(panel);
    panel.showModal();
    refresh();
  }

  return { trigger, wrap, toggleFor, close };
}

function control(label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function normalizeItem(value) {
  if (!KIND_LABELS.has(value?.kind)) return null;
  const { kind } = value, title = typeof value.title === "string" ? value.title.trim().slice(0, 512) : "";
  if (kind === "movie") {
    const id = text(value.id, 200);
    return id && title ? { kind, id, title, key: JSON.stringify([kind, id]) } : null;
  }
  const seriesKey = text(value.seriesKey, 1024), seriesName = text(value.seriesName, 512), category = text(value.category, 512);
  return seriesKey && seriesName && title ? { kind, seriesKey, seriesName, category, title, key: JSON.stringify([kind, seriesKey]) } : null;
}

function normalize(value) { return value.normalize("NFKC").trim().toLocaleLowerCase(); }
function text(value, limit) { return typeof value === "string" && value.length <= limit ? value.trim() : ""; }
