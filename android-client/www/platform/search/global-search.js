import { fetchJson } from "../../js/api.js?v=20260702-novel-local-manage-74";
import { readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatBytes, formatNumber } from "../../js/format.js";
import { absoluteUrl, loadPreviewImage } from "../../js/image.js";

const CHANNELS = [
  { key: "photoCollections", label: "套图合集", mode: "photo", unit: "合集", params: { photoView: "collections" } },
  { key: "photo", label: "套图", mode: "photo", unit: "图包" },
  { key: "manga", label: "套图 · 韩漫", mode: "manga", unit: "部" },
  { key: "media", label: "影视", mode: "media", unit: "作品" }
];

export function createGlobalSearch({ els, getActiveUrl, showView, openInLibrary }) {
  async function fetchBundle(worksPath, query, signal = undefined) {
    const activeUrl = getActiveUrl();
    const [worksData, channels] = await Promise.all([
      fetchJson(activeUrl, worksPath, { timeoutMs: 12000, signal }),
      fetchChannels(query, signal)
    ]);
    return { ...worksData, channels };
  }

  async function fetchChannels(query, signal = undefined) {
    const activeUrl = getActiveUrl();
    const results = await Promise.allSettled(CHANNELS.map(async (channel) => {
      const path = channelPath(channel, query);
      const cached = await readCachedJson(activeUrl, path).catch(() => null);
      try {
        const data = await fetchJson(activeUrl, path, { timeoutMs: 12000, signal });
        writeCachedJson(activeUrl, path, data).catch(() => {});
        return { ...channel, ...data, fromCache: false };
      } catch (error) {
        if (cached?.payload) return { ...channel, ...cached.payload, fromCache: true };
        return { ...channel, error: error.message || "读取失败", items: [], total: 0, count: 0 };
      }
    }));
    return results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((result) => result.error || Number(result.total || 0) > 0 || (result.items || []).length > 0);
  }

  function renderChannels(channels, query) {
    const visibleChannels = (channels || []).filter((channel) => channel.error || (channel.items || []).length);
    if (!visibleChannels.length) return;

    const wrap = document.createElement("section");
    wrap.className = "global-search-panel";
    const head = document.createElement("div");
    head.className = "global-search-head";
    const title = document.createElement("strong");
    title.textContent = "频道内容";
    const meta = document.createElement("span");
    const total = channels.reduce((sum, channel) => sum + Number(channel.total || 0), 0);
    meta.textContent = `${formatNumber(total)} 个匹配`;
    head.append(title, meta);
    wrap.append(head);

    for (const channel of visibleChannels) wrap.append(createChannelSection(channel, query));
    els.viewContent.append(wrap);
  }

  function createChannelSection(channel, query) {
    const section = document.createElement("div");
    section.className = "global-search-section";
    const head = document.createElement("div");
    head.className = "global-search-section-head";
    const title = document.createElement("strong");
    title.textContent = channel.label;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = channel.fromCache ? "缓存" : `${formatNumber(channel.total || 0)} ${channel.unit || "项"}`;
    open.addEventListener("click", () => openChannel(channel, query));
    head.append(title, open);
    section.append(head);

    if (channel.error) {
      const error = document.createElement("div");
      error.className = "global-search-error";
      error.textContent = channel.error;
      section.append(error);
      return section;
    }

    const row = document.createElement("div");
    row.className = "global-search-row";
    for (const item of (channel.items || []).slice(0, 8)) row.append(createChannelCard(channel, item));
    section.append(row);
    return section;
  }

  function createChannelCard(channel, item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `global-result-card ${channel.mode}`;
    card.addEventListener("click", () => openChannelItem(channel, item));
    const thumb = document.createElement("div");
    thumb.className = "global-result-thumb";
    thumb.textContent = fallbackText(item.title || channel.label);
    const cover = item.coverUrl ? absoluteUrl(getActiveUrl(), item.coverUrl) : "";
    if (cover) loadPreviewImage(thumb, cover, { cacheBaseUrl: getActiveUrl() });
    const title = document.createElement("strong");
    title.textContent = item.title || item.collectionTitle || channel.label;
    const meta = document.createElement("span");
    meta.textContent = itemMeta(channel, item);
    card.append(thumb, title, meta);
    return card;
  }

  function openChannel(channel, query) {
    const params = { mode: channel.mode, query };
    if (channel.params?.photoView) params.photoView = channel.params.photoView;
    showView("channel", params, { push: true });
  }

  function openChannelItem(channel, item) {
    if (item.type === "photoCollection") {
      showView("channel", { mode: "photo", collection: item.collectionId || item.id }, { push: true });
    } else if (channel.mode === "photo" && item.id) {
      showView("photoDetail", { id: item.id }, { push: true });
    } else if (channel.mode === "manga" && item.id) {
      showView("mangaDetail", { id: item.id }, { push: true });
    } else if (channel.mode === "media" && item.type === "tvSeries") {
      showView("channel", { mode: "media", seriesKey: item.seriesKey || item.id, category: item.category || "", sort: "title" }, { push: true });
    } else if (["western", "media", "movie", "tv"].includes(channel.mode) && item.id) {
      const mode = item.type === "movie" ? "movie" : item.type === "tv" ? "tv" : channel.mode;
      showView("mediaDetail", { id: item.id, mode }, { push: true });
    } else if (item.routePath) {
      openInLibrary(item.routePath);
    }
  }

  return { fetchBundle, fetchChannels, renderChannels };
}

function channelPath(channel, query) {
  const params = new URLSearchParams({ mode: channel.mode, q: query, limit: "8", offset: "0" });
  for (const [key, value] of Object.entries(channel.params || {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  }
  return `/api/image-library/items?${params}`;
}

function itemMeta(channel, item) {
  if (item.type === "photoCollection") {
    return [hasNumber(item.albumCount) ? `${formatNumber(item.albumCount)} 期` : "", formatBytes(item.size)].filter(Boolean).join(" · ");
  }
  if (channel.mode === "photo") return [item.category, item.personName, formatBytes(item.size)].filter(Boolean).join(" · ");
  if (channel.mode === "manga") {
    return [hasNumber(item.chapterCount) ? `${formatNumber(item.chapterCount)} 话` : "", hasNumber(item.imageCount) ? `${formatNumber(item.imageCount)} 张` : ""].filter(Boolean).join(" · ");
  }
  if (channel.mode === "media" && item.type === "tvSeries") {
    return ["电视剧", item.category, hasNumber(item.chapterCount) ? `${formatNumber(item.chapterCount)} 集` : "", item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : ""].filter(Boolean).join(" · ");
  }
  if (channel.mode === "media" && item.type === "movie") {
    return ["电影", item.category, item.year, item.rating ? `豆瓣 ${Number(item.rating).toFixed(1)}` : ""].filter(Boolean).join(" · ");
  }
  return [item.category, item.seriesName || item.personName, formatBytes(item.size)].filter(Boolean).join(" · ");
}

function hasNumber(value) {
  return value !== undefined && value !== null && value !== "";
}

function fallbackText(value) {
  return String(value || "?").trim().slice(0, 2) || "?";
}
