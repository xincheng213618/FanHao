import { createEpisodePicker } from "./player-episode-picker.js";

const EPISODE_PAGE_SIZE = 240;
const EPISODE_TIMEOUT_MS = 12000;

function episodeScope(item, mediaId, returnTo) {
  const kind = item?.mediaKind;
  const seriesKey = String(item?.seriesKey || item?.tvSeries?.seriesKey || "").trim();
  if (!["tv", "anime"].includes(kind) || !seriesKey || String(item?.id || "") !== mediaId) return null;
  const params = new URLSearchParams({ seriesKey });
  if (kind === "anime") params.set("kind", "anime");
  const seriesRoute = `${kind === "anime" ? "/media" : "/tv"}?${params}`;
  let back = seriesRoute;
  if (returnTo?.startsWith("/")) {
    try {
      const url = new URL(returnTo, window.location.href);
      if (url.origin === window.location.origin) back = `${url.pathname}${url.search}${url.hash}`;
    } catch { /* Use the series route for an invalid return link. */ }
  }
  return { id: mediaId, kind, seriesKey, category: item.category || item.tvSeries?.category || "", back };
}

async function readEpisodePage(api, scope, offset, limit, signal, query = "") {
  const params = new URLSearchParams({ mode: scope.kind === "anime" ? "media" : "tv", sort: "title", seriesKey: scope.seriesKey,
    offset: String(offset), limit: String(limit) });
  if (scope.kind === "anime") params.set("kind", "anime");
  if (scope.category && scope.category !== "all") params.set("category", scope.category);
  if (query) params.set("q", query);
  const data = await api(`/api/image-library/items?${params}`, { signal, cache: "no-store" });
  const { items, total } = data || {};
  if (!Array.isArray(items) || !Number.isSafeInteger(total) || total < 0 || data.offset !== offset
    || data.seriesKey !== scope.seriesKey || items.length > limit || items.length > Math.max(0, total - offset)
    || (data.query || "") !== query
    || (!items.length && offset < total)
    || items.some(item => !item?.id || item.seriesKey !== scope.seriesKey || item.mediaKind !== scope.kind)) {
    throw new Error("剧集目录响应无效，请重试。");
  }
  return { items, total, snapshot: JSON.stringify([total, data.listRevision || "", data.scannedAt || ""]) };
}

async function findEpisodeNeighbors(api, scope, hint, signal) {
  if (Number.isSafeInteger(hint) && hint > 0) {
    const offset = Math.max(0, hint - 2);
    const page = await readEpisodePage(api, scope, offset, 3, signal);
    const index = hint - 1 - offset;
    if (page.items[index]?.id === scope.id && (hint === page.total || page.items[index + 1])
      && new Set(page.items.map(item => item.id)).size === page.items.length) {
      return { previous: page.items[index - 1], next: page.items[index + 1], position: hint, total: page.total };
    }
  }
  let offset = 0, snapshot = null, previous = null;
  const seen = new Set();
  const read = async (limit) => {
    const page = await readEpisodePage(api, scope, offset, limit, signal);
    if ((snapshot !== null && page.snapshot !== snapshot) || page.items.some(item => {
      if (seen.has(item.id)) return true;
      seen.add(item.id);
      return false;
    })) throw new Error("剧集目录已变化，请重试。");
    snapshot = page.snapshot;
    return page;
  };
  while (!signal.aborted) {
    const page = await read(EPISODE_PAGE_SIZE);
    const index = page.items.findIndex(item => item.id === scope.id);
    const nextOffset = offset + page.items.length;
    if (index >= 0) {
      const position = offset + index + 1;
      let next = page.items[index + 1];
      if (!next && position < page.total) {
        offset = nextOffset;
        next = (await read(1)).items[0];
      }
      return { previous: index === 0 ? previous : page.items[index - 1], next, position, total: page.total };
    }
    if (nextOffset >= page.total) break;
    previous = page.items.at(-1);
    offset = nextOffset;
  }
  throw new Error("当前视频不在剧集目录中。");
}

export function createPlayerEpisodeNavigation({ api, container, dialog, navigate }) {
  const previous = container?.querySelector("[data-episode-step='previous']");
  const next = container?.querySelector("[data-episode-step='next']");
  const status = container?.querySelector("[data-episode-status]");
  const retry = container?.querySelector("[data-episode-retry]");
  let scope = null, hint = 0, request = null, neighbors = null;
  const picker = createEpisodePicker({
    dialog,
    trigger: container?.querySelector("[data-episode-picker-trigger]"),
    current: () => scope && { id: scope.id, position: neighbors?.position },
    readPage: (offset, limit, signal, query) => readEpisodePage(api, scope, offset, limit, signal, query),
    select: followItem
  });

  function showNeighbors(value) {
    neighbors = value;
    for (const [button, item, label] of [[previous, value?.previous, "上一集"], [next, value?.next, "下一集"]]) {
      button.disabled = !item;
      button.title = item?.title ? `${label} · ${item.title}` : label;
    }
  }

  async function refresh() {
    if (!scope || request || !container?.isConnected) return;
    const active = { controller: new AbortController(), timeout: 0 };
    request = active;
    const refocus = document.activeElement === retry;
    retry.hidden = true;
    showNeighbors(null);
    status.textContent = "正在读取集数…";
    container.setAttribute("aria-busy", "true");
    const showError = (message) => {
      status.textContent = message;
      retry.hidden = false;
      if (refocus && document.activeElement === document.body) retry.focus({ preventScroll: true });
    };
    active.timeout = window.setTimeout(() => {
      if (request !== active) return;
      request = null;
      active.controller.abort();
      container.removeAttribute("aria-busy");
      showError("剧集目录读取超时，请重试。");
    }, EPISODE_TIMEOUT_MS);
    try {
      const result = await findEpisodeNeighbors(api, scope, hint, active.controller.signal);
      if (request !== active) return;
      hint = result.position;
      status.textContent = `第 ${result.position} / ${result.total} 集`;
      showNeighbors(result);
      if (refocus && document.activeElement === document.body) {
        (result.next ? next : result.previous ? previous : status).focus({ preventScroll: true });
      }
    } catch (error) {
      if (request !== active || error?.code === "ACCOUNT_CHANGED") return;
      showError(error.message || "剧集目录读取失败，请重试。");
    } finally {
      window.clearTimeout(active.timeout);
      if (request === active) {
        request = null;
        container.removeAttribute("aria-busy");
      }
    }
  }

  function follow(key, offset) {
    const item = neighbors?.[key];
    if (item) followItem(item, neighbors.position + offset);
  }

  function followItem(item, position) {
    if (!item || !scope || !container?.isConnected) return;
    const params = new URLSearchParams({ mediaId: String(item.id), returnTo: scope.back });
    if (position > 0) params.set("episodePosition", String(position));
    showNeighbors(null);
    navigate(`/player.html?${params}`);
  }

  previous?.addEventListener("click", () => follow("previous", -1));
  next?.addEventListener("click", () => follow("next", 1));
  retry?.addEventListener("click", refresh);

  function suspend() {
    picker.close();
    const active = request;
    request = null;
    if (active) {
      window.clearTimeout(active.timeout);
      active.controller.abort();
    }
    neighbors = null;
  }

  return {
    open(item, { mediaId, returnTo, position }) {
      suspend();
      scope = episodeScope(item, mediaId, returnTo);
      if (container) container.hidden = !scope;
      hint = Number(position);
      if (scope) void refresh();
      return scope?.back || "";
    },
    suspend,
    refresh
  };
}
