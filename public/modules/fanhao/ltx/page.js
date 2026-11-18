import { installFilterViews, writeFilterViewUrl } from "./filter-views.js?v=20261113-ltx-filter-views-01";

const $ = (id) => document.getElementById(id);
const scope = { header: "db15c80d", sort: "276abc24", side: "e8550fad", avatar: "190f65b8", main: "ff5b15bf", card: "289703c3" };
const BATCH_SIZE = 20;
const ACTOR_BATCH_SIZE = 40;
const collator = new Intl.Collator("zh-CN", { numeric: true });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai"
});
const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
const displayKey = "fanhao.ltx.display";
const display = { original: true, added: true, detail: true, subtitle: true };
try {
  const saved = JSON.parse(localStorage.getItem(displayKey) || "{}");
  for (const key of Object.keys(display)) if (typeof saved?.[key] === "boolean") display[key] = saved[key];
} catch { /* Keep the display defaults. */ }
const iconPaths = {
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4m-2-12a4 4 0 0 1 0 8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  score: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z",
  date: "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  recent: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  size: "M4 13h16l-2-7H6Zm0 0v5h16v-5m-3 2.5h1",
  code: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  up: "M12 18V6m-4 4 4-4 4 4",
  down: "M12 6v12m-4-4 4 4 4-4"
};
const sortOptions = [
  { id: "score", label: "评分", value: (item) => item.score ?? 0, direction: -1 },
  { id: "date", label: "发行日期", value: (item) => item.date || "", direction: 1 },
  { id: "recent", label: "最近收录", value: (item) => item.addedAt, direction: -1 },
  { id: "size", label: "文件大小", value: (item) => item.maxSize, direction: -1 },
  { id: "code", label: "番号", value: (item) => item.code, direction: 1 }
];
const BATCH_PREVIEW_LIMIT = 50;
const CLIPBOARD_INTERVAL_MS = 2000;
const copiedBatchUrls = new Set();
let batchLoading = false;
let batchReady = false;
let batchRun = null;
const state = {
  items: [], localItems: [], results: [], actors: [], actorItemCount: 0, avatars: {},
  actor: "", status: "all", sort: "score", direction: -1, shown: 0,
  libraryChecked: false, downloadsChecked: false
};
let localCatalogRequest;
let actorView;
let recentPreview;
const actorSentinel = element("div", "sentinel", "", "main");
actorSentinel.setAttribute("aria-hidden", "true");
const actorObserver = new IntersectionObserver((entries) => {
  if (entries.some(({ isIntersecting }) => isIntersecting)) appendActors();
}, { root: $("actors"), rootMargin: "160px 0px" });
const coverImages = createViewportImageLoader({ rootMargin: "200px 0px" });
const avatarImages = createViewportImageLoader();
const visibleMedia = new Map();
const resolutionQueue = new Map();
let mediaCache = new Map();
let activeMedia = new Map();
let mediaRequests = 0;
let resolutionRenderTimer;
const mediaObserver = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    if (isIntersecting) visibleMedia.set(target, target.dataset.code);
    else visibleMedia.delete(target);
  }
  loadVisibleMedia();
});

function element(tag, className = "", text = "", component) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  if (component) node.setAttribute(`data-v-${scope[component]}`, "");
  return node;
}

function button(text, handler, className = "", component) {
  const node = element("button", className, text, component);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

function icon(name, size = 16) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const stroke = document.createElementNS(namespace, "path");
  stroke.setAttribute("d", iconPaths[name]);
  svg.append(stroke);
  return svg;
}

function selectText(node) {
  node.focus({ preventScroll: true });
  window.getSelection()?.selectAllChildren(node);
}

async function copyText(text, status, fallback = null) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = "已复制";
    return true;
  } catch {
    if (fallback) {
      selectText(fallback);
      status.textContent = "已选中文本，可以按 Ctrl+C 复制。";
    } else {
      status.textContent = "剪贴板不可用。";
    }
    return false;
  }
}

function isResourceLink(link) {
  return typeof link?.url === "string" && !/[\r\n]/.test(link.url)
    && (link.type === "magnet" ? /^magnet:\?/i.test(link.url)
      : link.type === "ed2k" && /^ed2k:\/\/\|file\|/i.test(link.url));
}

const normalize = (text) => String(text || "").normalize("NFKC").trim().toLowerCase();
const normalizeCode = (text) => normalize(text).replace(/[-_.\s]+/g, "");
const searchIndex = new WeakMap();
const hasLocal = ({ local }) => Boolean(local.library || local.downloads);
const isPending = (item) => !item.libraryOnly && Boolean(item.pending || item.waiting || item.missing || !item.links.length);
const hasMediaUrl = (url) => typeof url === "string" && /^\/media\/(?:remote-image\?|image\/[^/?#]+$|core-image\/\d+\?)/.test(url);
const coverSources = (item) => [item.coverUrl, ...(item.coverFallbacks || [])].filter(hasMediaUrl);

function prepareItem(item) {
  item.links = item.links.filter(isResourceLink);
  let maxSize = item.libraryOnly ? largestLocalSize(item) : 0;
  for (const { size } of item.links) maxSize = Math.max(maxSize, size || 0);
  item.maxSize = maxSize;
  return item;
}

function matchesSearch(item, query, codeQuery) {
  let search = searchIndex.get(item);
  if (!search) {
    search = {
      code: normalizeCode(item.code),
      text: normalize([item.code, item.title, item.originalTitle, item.maker, ...item.actors, ...(item.genres || [])].join(" "))
    };
    searchIndex.set(item, search);
  }
  return search.text.includes(query) || Boolean(codeQuery && search.code.includes(codeQuery));
}

async function readLibraryJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("读取本机 LTX 馆藏失败，请重读本地状态。");
  return response.json();
}

async function readLocalCatalog() {
  const params = new URLSearchParams({ q: "class:ltx-local", filter: "localOnly", limit: "24", offset: "0" });
  const items = new Map();
  let offset = 0;
  for (;;) {
    params.set("offset", String(offset));
    const { works, total } = await readLibraryJson(`/api/fanhao/search?${params}`);
    const localWorks = await Promise.all(works.map(({ id }) => readLibraryJson(`/api/works/${encodeURIComponent(id)}`)));
    for (const { work } of localWorks) {
      const info = work.infoSummary || {};
      const code = info.code;
      const key = normalizeCode(code);
      if (!key) continue;
      const flags = work.traits?.flags;
      const copies = work.videos.filter(({ name, size }) => /\[LTX 本地\]\.[^.]+$/i.test(name) && size > 0)
        .map(({ id, size }) => ({ videoId: id, source: "library", size, marked: true, ltxLocal: true,
          hasSidecar: work.videos.length === 1 && flags?.hasSidecar,
          hasChineseSidecar: work.videos.length === 1 && flags?.hasChineseSidecar }));
      if (!copies.length) continue;
      const actor = work.personDisplayName || work.personName;
      const existing = items.get(key);
      if (existing) {
        if (actor && !existing.actors.includes(actor)) existing.actors.push(actor);
        for (const copy of copies) if (!existing.local.copies.some(({ videoId }) => videoId === copy.videoId)) existing.local.copies.push(copy);
      } else {
        items.set(key, { code, title: work.title, actors: actor ? [actor] : [], maker: info.maker,
          date: info.releaseDate, score: info.rating, votes: info.ratingCount, addedAt: 0,
          coverUrl: work.coverId ? `/media/image/${encodeURIComponent(work.coverId)}` : "",
          links: [], libraryOnly: true, local: { downloads: 0, copies } });
      }
    }
    offset += works.length;
    if (!works.length || offset >= total) break;
  }
  return [...items.values()].map((item) => {
    const count = item.local.copies.length;
    Object.assign(item.local, { library: count, marked: count, ltxLocal: count });
    return prepareItem(item);
  });
}

function loadLocalCatalog() {
  if (localCatalogRequest) return;
  const request = readLocalCatalog();
  localCatalogRequest = request;
  request.then((items) => {
    if (localCatalogRequest !== request) return;
    state.localItems = items;
    if ($("filter").value === "ltx-local") renderResults();
  }).catch((error) => {
    if (localCatalogRequest !== request) return;
    localCatalogRequest = null;
    if ($("filter").value === "ltx-local") $("feedback").textContent = error.message;
  });
}
function formatSize(size) {
  const gib = size / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(2)} TiB`;
  return gib >= 1 ? `${gib.toFixed(2)} GiB` : `${(size / 1024 ** 2).toFixed(1)} MiB`;
}

function linkLabel(link) {
  return link.type === "magnet" ? "磁力" : `eD2k · ${formatSize(link.size)}`;
}

const hasSubtitledLtx = (item) => item.links.some(({ subtitledLtx }) => subtitledLtx);

function linksForSubtitleFilter(item, filter) {
  return filter === "ltx-c" || (filter === "available" && !item.subtitleUrl)
    ? item.links.filter(({ subtitledLtx }) => subtitledLtx) : item.links;
}

function largestLocalSize(item) {
  return Math.max(0, ...(item.local.copies ?? []).map(({ size }) => size));
}

function findBatchLink(item, mode, localSize, candidates) {
  if (mode === "missing" ? hasLocal(item) : !localSize) return null;
  if (mode === "unmarked" && (item.local.marked || candidates.some(({ sizeMatch }) => sizeMatch))) return null;
  const links = candidates.filter(({ size, sizeMatch }) => !sizeMatch &&
    (mode === "missing" || size > (mode === "larger" ? localSize : 0)));
  return links.reduce((best, next) => !best || (next.size || 0) > (best.size || 0) ? next : best, null);
}

function batchCandidates(mode) {
  const seen = new Set();
  const candidates = [];
  const checked = state.libraryChecked && state.downloadsChecked;
  const subtitle = $("subtitleFilter").value;
  if (mode === "missing" && !checked) return candidates;
  for (const item of state.results) {
    const localSize = largestLocalSize(item);
    const link = findBatchLink(item, mode, localSize, linksForSubtitleFilter(item, subtitle));
    if (!link || copiedBatchUrls.has(link.url) || seen.has(link.url)) continue;
    seen.add(link.url);
    candidates.push({ code: item.code, link, localSize });
  }
  return candidates;
}

function renderBatch() {
  const mode = $("batchMode").value;
  const candidates = batchReady ? batchCandidates(mode) : [];
  const preview = candidates.slice(0, BATCH_PREVIEW_LIMIT);
  $("batchSummary").textContent = batchLoading ? "正在重读本地状态…" :
    !batchReady ? "本地状态读取失败，请关闭后重试。" :
    mode === "missing" && !(state.libraryChecked && state.downloadsChecked) ? "本地检查不完整，暂时无法确认哪些作品没有本地视频。" :
    `当前筛选 ${state.results.length} 部 · 可添加 ${candidates.length} 条${candidates.length > preview.length ? ` · 预览前 ${preview.length} 条` : ""}${state.libraryChecked && state.downloadsChecked ? "" : " · 部分本地目录不可读"}`;
  $("batchList").replaceChildren(...preview.map(({ code, link, localSize }) => {
    const row = element("li");
    row.append(element("strong", "", code), element("span", "",
      `${localSize ? `本地最大 ${formatSize(localSize)}` : "本地无视频"} · 远端 ${linkLabel(link)}${link.subtitledLtx ? " · LTX-C" : ""}`));
    return row;
  }));
  $("batchMode").disabled = !batchReady || Boolean(batchRun);
  const submit = $("submitBatch");
  submit.disabled = Boolean(batchRun) || !candidates.length;
  submit.textContent = candidates.length ? `逐条添加 ${candidates.length} 条` : "逐条添加";
  $("stopBatch").hidden = !batchRun;
  $("stopBatch").disabled = Boolean(batchRun?.stopped);
  return candidates;
}

async function openBatchLinks() {
  if (!batchRun) $("batchStatus").textContent = "";
  $("batchDialog").showModal();
  if (batchLoading || batchRun) { renderBatch(); return; }
  if ($("filter").value === "remote-larger") $("batchMode").value = "larger";
  batchReady = false;
  batchLoading = true;
  renderBatch();
  batchReady = await load({ refresh: true });
  batchLoading = false;
  renderBatch();
}

function stopBatch() {
  if (!batchRun) return;
  batchRun.stopped = true;
  batchRun.resume?.();
  $("stopBatch").disabled = true;
}

async function submitBatch() {
  const candidates = renderBatch();
  if ($("submitBatch").disabled) return;
  const run = { stopped: false, resume: null };
  batchRun = run;
  renderBatch();
  const status = $("batchStatus");
  const total = candidates.length;
  let copied = 0;
  let reason = "";
  for (const { code, link } of candidates) {
    if (run.stopped || !$("batchDialog").open) break;
    if (!document.hasFocus()) {
      reason = "页面失去焦点。回到本页可继续剩余链接。";
      break;
    }
    status.textContent = `正在处理 ${code} · ${copied + 1}/${total}`;
    if (!await copyText(link.url, status)) {
      reason = "浏览器未能写入剪贴板。可继续剩余链接。";
      break;
    }
    copiedBatchUrls.add(link.url);
    copied++;
    status.textContent = `已写入剪贴板 ${copied}/${total} 条`;
    if (copied < total && !run.stopped) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, CLIPBOARD_INTERVAL_MS);
        run.resume = () => { clearTimeout(timer); resolve(); };
      });
      run.resume = null;
    }
  }
  batchRun = null;
  renderBatch();
  status.textContent = `已写入剪贴板 ${copied}/${total} 条。${reason || (copied < total ? "已停止，可继续剩余链接。" : "请在 115 查看接收结果。")}`;
}

function loadImageSources(image, urls, onFailure) {
  let index = 0;
  const next = () => {
    if (index < urls.length) image.src = urls[index++];
    else {
      image.onerror = null;
      image.removeAttribute("src");
      onFailure();
    }
  };
  image.onerror = next;
  next();
}

function createViewportImageLoader(options) {
  const pending = new WeakMap();
  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting || !target.isConnected) continue;
      observer.unobserve(target);
      const sources = pending.get(target);
      pending.delete(target);
      if (sources) loadImageSources(target, sources, () => target.remove());
    }
  }, options);
  return {
    observe(image, sources) {
      pending.set(image, sources);
      observer.observe(image);
    },
    unobserve(image) {
      pending.delete(image);
      observer.unobserve(image);
    },
    disconnect() {
      observer.disconnect();
    }
  };
}

function appendImage(parent, urls, alt, cover = false) {
  const sources = (Array.isArray(urls) ? urls : [urls]).filter(hasMediaUrl);
  if (!sources.length) return;
  const image = element("img", "", "", cover ? "card" : "avatar");
  image.alt = alt;
  image.decoding = "async";
  if (cover) image.classList.add("in");
  parent.append(image);
  (cover ? coverImages : avatarImages).observe(image, sources);
}

function showCover(item) {
  $("coverTitle").textContent = item.code;
  $("coverPreview").alt = `${item.code} 封面`;
  loadImageSources($("coverPreview"), coverSources(item), () => {});
  $("coverDialog").showModal();
}

function setActor(actor) {
  state.actor = actor;
  toggleActors(false);
  updateFilters();
}

function localStateView(item) {
  const row = element("div", "fanhao-local-state");
  const { library, downloads, marked, ltxLocal = 0, folderMarked } = item.local;
  if (!hasLocal(item)) {
    row.append(element("span", "", state.libraryChecked && state.downloadsChecked ? "本地未发现" : "本地状态不完整"));
    return row;
  }
  if (library) row.append(element("span", "fanhao-present", `馆藏 ${library}`));
  if (downloads) row.append(element("span", "fanhao-present", `下载盘 ${downloads}`));
  if (!ltxLocal || marked > ltxLocal) {
    const otherMarked = marked - ltxLocal;
    const status = element("span", otherMarked ? "fanhao-present" : "fanhao-pending",
      otherMarked ? `已标 LTX ${otherMarked}` : folderMarked ? "仅目录标 LTX" : "未标 LTX");
    status.title = otherMarked ? `${otherMarked} 份本地视频的文件名含 LTX 标记`
      : folderMarked ? "视频文件名未标 LTX，目录带 LTX 标记" : "同番号本地视频的文件名未标 LTX";
    row.append(status);
  }
  if (ltxLocal) {
    const badge = element("span", "fanhao-present", `LTX 本地 ${ltxLocal}`);
    badge.title = "本机 Jasna LTX 已完成的输出";
    row.append(badge);
  }
  return row;
}

function renderLocalMedia(row, copies, pending = false) {
  row.replaceChildren(...copies.map(({ source, size, width, height, hasSidecar, hasChineseSidecar }) => {
    const location = source === "library" ? "馆藏" : "下载盘";
    const resolution = width && height ? `${width}×${height}` : pending ? "读取分辨率…" : "分辨率暂不可读";
    const copy = element("div", "", `${location} · ${resolution} · ${formatSize(size)}`);
    if (display.subtitle && (hasSidecar || hasChineseSidecar)) {
      const badge = element("span", "fanhao-local-subtitle", hasChineseSidecar ? "外挂中字" : "外挂字幕");
      badge.title = hasChineseSidecar ? "这份馆藏视频有已入库的独立中文字幕文件" : "这份馆藏视频有已入库的独立字幕文件";
      copy.append(" ", badge);
    }
    return copy;
  }));
  if (!copies.length) row.textContent = "本地文件已无法读取";
}

function localMediaView(item) {
  const row = element("div", "fanhao-local-media");
  const cached = mediaCache.get(item.code);
  const pending = !mediaCache.has(item.code);
  renderLocalMedia(row, cached ?? item.local.copies, pending);
  if (pending) {
    row.dataset.code = item.code;
    mediaObserver.observe(row);
  }
  return row;
}

function readItemMedia(item) {
  const { code } = item;
  const cache = mediaCache;
  const active = activeMedia;
  mediaRequests++;
  const media = item.libraryOnly
    ? Promise.all(item.local.copies.map(async (copy) => {
      const info = await readLibraryJson(`/api/playinfo/${encodeURIComponent(copy.videoId)}`).catch(() => ({}));
      return { ...copy, width: info.width, height: info.height };
    }))
    : readLibraryJson(`/api/fanhao/ltx/local-media?${new URLSearchParams({ code })}`).then(({ copies }) => copies);
  const request = media.catch(() => null).then((copies) => {
    if (copies != null || (cache === mediaCache && resolutionQueue.has(code))) cache.set(code, copies);
    return copies;
  }).finally(() => {
    active.delete(code);
    mediaRequests--;
    if (cache === mediaCache && resolutionQueue.delete(code) && !resolutionRenderTimer) {
      resolutionRenderTimer = setTimeout(() => renderResults(false, true), 250);
    }
    loadVisibleMedia();
  });
  active.set(code, request);
  return request;
}

function loadVisibleMedia() {
  if (recentPreview) return;
  for (const [row, code] of visibleMedia) {
    const active = activeMedia.get(code);
    if (row.isConnected && !mediaCache.has(code) && !active && mediaRequests >= 3) break;
    visibleMedia.delete(row);
    mediaObserver.unobserve(row);
    if (!row.isConnected) continue;
    const item = state.results.find((item) => item.code === code);
    if (!item) continue;
    if (mediaCache.has(code)) {
      renderLocalMedia(row, mediaCache.get(code) ?? item.local.copies);
    } else {
      (active ?? readItemMedia(item)).then((copies) => {
        if (row.isConnected) renderLocalMedia(row, copies ?? item.local.copies);
      });
    }
  }
  for (const [code, item] of resolutionQueue) {
    if (mediaRequests >= 3) break;
    if (!activeMedia.has(code)) readItemMedia(item);
  }
}

function createCover(item) {
  const cover = element("div", "cover", "", "card");
  cover.append(element("span", "ph", "", "card"));
  const sources = coverSources(item);
  if (sources.length) {
    const preview = button("", () => showCover(item), "cover-btn", "card");
    preview.setAttribute("aria-label", `查看 ${item.code} 的完整封面`);
    appendImage(preview, sources, `${item.code} 封面`, true);
    cover.append(preview);
  }
  const code = button(item.code, () => copyText(item.code, $("feedback"), code), "code", "card");
  code.title = `复制番号 ${item.code}`;
  cover.append(code);
  if (isPending(item)) cover.append(element("span", "badge", "待确认", "card"));
  if (Number.isFinite(item.score) && item.score > 0) {
    const score = element("span", "score", `★ ${item.score.toFixed(2)}`, "card");
    score.append(element("small", "", item.votes >= 1000 ? `${(item.votes / 1000).toFixed(1)}k` : String(item.votes || 0), "card"));
    if (item.rawScore) score.title = `原始评分 ${item.rawScore.toFixed(2)} · ${item.votes} 票`;
    cover.append(score);
  }
  return cover;
}

function createActions(item) {
  if (item.libraryOnly) return document.createDocumentFragment();
  const actions = element("div", "actions expanded fanhao-card-actions", "", "card");
  if (!item.links.length) {
    const pending = button("待确认", () => {}, "btn", "card");
    pending.disabled = true;
    actions.append(pending);
    return actions;
  }
  for (const link of item.links) {
    const action = element("a", "btn copy-btn", "", "card");
    action.href = link.url;
    action.target = "_blank";
    action.rel = "noopener noreferrer";
    action.title = link.sizeMatch ? "在新标签页打开，本地已有同体积文件" : "在新标签页打开，由 115 浏览器接管";
    action.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.setData("text/uri-list", link.url);
      event.dataTransfer.setData("text/plain", link.url);
      event.dataTransfer.effectAllowed = "link";
    });
    action.append(element("span", "", `打开 ${linkLabel(link)}`));
    if (display.subtitle && link.subtitledLtx) {
      const badge = element("small", "", "LTX-C", "card");
      badge.title = "资源文件名标有 LTX 和中字";
      action.append(badge);
    }
    actions.append(action);
  }
  return actions;
}

function cardLink(url, label, title, className = "fanhao-card-link") {
  const anchor = element("a", className, label);
  anchor.href = url;
  anchor.title = title;
  anchor.setAttribute("aria-label", title);
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

function cardSources(item) {
  const sources = element("div", "fanhao-card-sources");
  if (display.added && item.addedAt > 0 && Number.isFinite(new Date(item.addedAt).valueOf())) {
    const elapsed = Math.max(0, Date.now() - item.addedAt);
    const [unit, length] = elapsed >= 86_400_000 ? ["day", 86_400_000] : ["hour", 3_600_000];
    const time = element("time", "fanhao-added", elapsed < 3_600_000 ? "刚入库" : relativeFormatter.format(-Math.floor(elapsed / length), unit));
    time.dateTime = new Date(item.addedAt).toISOString();
    time.title = `LTX 入库时间 ${dateFormatter.format(item.addedAt)}`;
    sources.append(time);
  }
  if (display.detail) {
    const lookup = `https://javdb.com/search?${new URLSearchParams({ q: item.code, f: "all" })}`;
    sources.append(cardLink(item.detailUrl || lookup, item.detailUrl ? "详情 ↗" : "查详情 ↗", `查看 ${item.code} 的作品资料`));
  }
  if (display.subtitle && item.subtitleUrl) {
    const subtitle = cardLink(item.subtitleUrl, "字", `下载 ${item.code} 的中文字幕（SubtitleCat）`, "fanhao-subtitle-badge");
    subtitle.download = `${item.code}.srt`;
    sources.append(subtitle);
  } else if (display.subtitle) {
    sources.append(cardLink(`https://www.subtitlecat.com/index.php?${new URLSearchParams({ search: item.code })}`,
      "找字幕 ↗", `在 SubtitleCat 查找 ${item.code} 的字幕`));
  }
  return sources;
}

function cardView(item) {
  const card = element("article", "card", "", "card");
  card.setAttribute(`data-v-${scope.main}`, "");
  const body = element("div", "body", "", "card");
  const title = element("h3", "title", (display.original && item.originalTitle) || item.title || item.code, "card");
  title.title = title.textContent;
  const tags = element("div", "tags", "", "card");
  for (const actor of item.actors) tags.append(button(actor, () => setActor(actor), "tag", "card"));
  const sub = element("div", "sub", "", "card");
  const meta = element("span", "meta", [item.date, item.maker].filter(Boolean).join(" · "), "card");
  meta.title = meta.textContent;
  const library = element("a", "feedback", "查馆藏", "card");
  library.href = `/fanhao?${new URLSearchParams({ q: item.code })}`;
  sub.append(meta, library);
  body.append(title, tags, sub, cardSources(item), localStateView(item));
  if (item.local.copies?.length) body.append(localMediaView(item));
  body.append(createActions(item));
  card.append(createCover(item), body);
  return card;
}

function actorRow(actor, label, count) {
  const row = button("", () => setActor(actor), "actor", "side");
  setActorRowSelected(row, state.actor === actor);
  const marker = element("span", actor ? "avatar" : "all-mark", "", actor ? "avatar" : "side");
  if (actor) {
    marker.setAttribute(`data-v-${scope.side}`, "");
    marker.append(element("span", "", Array.from(actor)[0]));
    appendImage(marker, state.avatars[actor], "");
  } else {
    marker.append(icon("people"));
  }
  row.append(marker, element("span", "name", label, "side"), element("i", "", String(count), "side"));
  return row;
}

function setActorRowSelected(row, selected) {
  row.classList.toggle("on", selected);
  row.setAttribute("aria-pressed", String(selected));
}

function appendActors() {
  const { matching, rows, shown } = actorView;
  const next = matching.slice(shown, shown + ACTOR_BATCH_SIZE);
  const fragment = document.createDocumentFragment();
  for (const [actor, count] of next) {
    const row = actorRow(actor, actor, count);
    rows.set(actor, row);
    fragment.append(row);
  }
  actorSentinel.before(fragment);
  actorView.shown += next.length;
  actorObserver.unobserve(actorSentinel);
  if (actorView.shown < matching.length) actorObserver.observe(actorSentinel);
}

function renderActors() {
  const nav = $("actors");
  const query = normalize($("actorSearch").value);
  const extraActor = !query && state.actor && !state.actors.some(([actor]) => actor === state.actor) ? state.actor : "";
  if (actorView?.facets !== state.actors || actorView.query !== query || actorView.extraActor !== extraActor
    || actorView.itemCount !== state.actorItemCount || actorView.avatars !== state.avatars) {
    const top = actorView ? nav.scrollTop : 0;
    const keepTop = actorView?.query === query;
    const matching = query ? state.actors.filter(([actor]) => normalize(actor).includes(query)) : state.actors;
    avatarImages.disconnect();
    const all = actorRow("", "全部", state.actorItemCount);
    const rows = new Map([["", all]]);
    const fragment = document.createDocumentFragment();
    fragment.append(all);
    if (extraActor) {
      const row = actorRow(extraActor, extraActor, 0);
      rows.set(extraActor, row);
      fragment.append(row);
    }
    fragment.append(actorSentinel);
    nav.replaceChildren(fragment);
    actorView = { facets: state.actors, avatars: state.avatars, itemCount: state.actorItemCount,
      query, extraActor, selected: state.actor, matching, rows, shown: 0 };
    appendActors();
    if (top) nav.scrollTop = keepTop ? top : 0;
    $("actorCount").textContent = `${matching.length} 人`;
  } else if (actorView.selected !== state.actor) {
    const previous = actorView.rows.get(actorView.selected);
    const selected = actorView.rows.get(state.actor);
    if (previous) setActorRowSelected(previous, false);
    if (selected) setActorRowSelected(selected, true);
    actorView.selected = state.actor;
  }
  $("actorChip").hidden = !state.actor;
  $("actorChip").textContent = state.actor ? `${state.actor} ×` : "";
}

function updateActorFacets(items) {
  const counts = new Map();
  for (const { actors } of items) {
    for (const actor of new Set(actors)) counts.set(actor, (counts.get(actor) || 0) + 1);
  }
  state.actorItemCount = items.length;
  if (counts.size !== state.actors.length || state.actors.some(([actor, count]) => counts.get(actor) !== count)) {
    state.actors = [...counts].sort(([left, leftCount], [right, rightCount]) =>
      rightCount - leftCount || collator.compare(left, right));
  }
  renderActors();
}

function renderSort() {
  $("sort").replaceChildren(...sortOptions.map((option) => {
    const selectedSort = state.sort === option.id;
    const node = button("", () => {
      state.direction = selectedSort ? -state.direction : option.direction;
      state.sort = option.id;
      renderSort();
      updateFilters();
    }, selectedSort ? "opt on" : "opt", "sort");
    node.dataset.tip = option.label;
    node.setAttribute("aria-label", option.label);
    node.setAttribute("aria-pressed", String(selectedSort));
    node.append(icon(option.id));
    if (selectedSort) {
      const direction = icon(state.direction > 0 ? "up" : "down", 12);
      direction.classList.add("dir");
      direction.setAttribute(`data-v-${scope.sort}`, "");
      node.append(direction);
    }
    return node;
  }));
}

function renderStatus(total, pending) {
  const labels = [["all", "全部", total], ["confirmed", "已确认", total - pending], ["pending", "待确认", pending]];
  $("status").replaceChildren(...labels.map(([status, label, count]) => {
    const node = button(label, () => { state.status = status; updateFilters(); }, `seg ${status}`, "main");
    node.classList.toggle("on", status === state.status);
    node.setAttribute("aria-pressed", String(status === state.status));
    node.append(element("i", "", String(count), "main"));
    return node;
  }));
}

function appendResults(count = BATCH_SIZE) {
  const next = state.results.slice(state.shown, state.shown + count);
  if (next.length) $("grid").append(...next.map(cardView));
  state.shown += next.length;
  updateResultPagination();
}

function updateResultPagination() {
  const hasMore = state.shown < state.results.length;
  $("loadMore").hidden = !hasMore;
  const sentinel = $("sentinel");
  pagination.unobserve(sentinel);
  if (hasMore) pagination.observe(sentinel);
}

function reconcileResultCards(previousResults, count) {
  const previous = previousResults.slice(0, state.shown);
  if (previous.every((item, index) => item === state.results[index])) {
    appendResults(count - state.shown);
    return;
  }

  const grid = $("grid");
  const next = state.results.slice(0, count);
  const retained = new Set(next);
  const cards = new Map(previous.map((item, index) => [item, grid.children[index]]));
  for (const [item, card] of cards) {
    if (retained.has(item)) continue;
    const image = card.querySelector(".cover img");
    if (image) coverImages.unobserve(image);
    const media = card.querySelector(".fanhao-local-media");
    if (media) {
      visibleMedia.delete(media);
      mediaObserver.unobserve(media);
    }
    card.remove();
  }
  let cursor = grid.firstElementChild;
  for (const item of next) {
    const card = cards.get(item);
    if (card === cursor && card) cursor = card.nextElementSibling;
    else grid.insertBefore(card ?? cardView(item), cursor);
  }
  state.shown = next.length;
  updateResultPagination();
}

function renderLocalVolume(results, filter, splitUnmarked) {
  const volume = $("localVolume");
  volume.hidden = !splitUnmarked && !["marked", "ltx-local", "unmarked"].includes(filter);
  if (volume.hidden) return;
  let count = 0, size = 0;
  for (const { local } of results) {
    for (const copy of local.copies ?? []) {
      if (filter === "marked" && !copy.marked || filter === "ltx-local" && !copy.ltxLocal) continue;
      count++;
      size += copy.size;
    }
  }
  volume.textContent = `本地体积 ${size ? formatSize(size) : "0 B"} · ${count} 份`;
}

function renderResults(resetScroll = false, reuseCards = false) {
  const scrollToTop = resetScroll && window.scrollY > 0;
  if (recentPreview) {
    if ($("reload").disabled) $("feedback").textContent = "正在读取完整目录…";
    if (scrollToTop) window.scrollTo({ top: 0 });
    return;
  }
  clearTimeout(resolutionRenderTimer);
  resolutionRenderTimer = undefined;
  resolutionQueue.clear();
  const query = normalize($("search").value);
  const codeQuery = normalizeCode(query);
  const filter = $("filter").value;
  const splitUnmarked = filter === "unmarked-4k" || filter === "unmarked-non4k";
  const subtitle = $("subtitleFilter").value;
  let items = state.items;
  if (filter === "ltx-local") {
    const keys = new Set(items.filter(({ local }) => local.ltxLocal > 0).map(({ code }) => normalizeCode(code)));
    items = [...items, ...state.localItems.filter(({ code }) => !keys.has(normalizeCode(code)))];
  }
  const matching = items.filter((item) => {
    if (query && !matchesSearch(item, query, codeQuery)) return false;
    if (subtitle === "available" && !item.subtitleUrl && !hasSubtitledLtx(item)) return false;
    if (subtitle === "ltx-c" && !hasSubtitledLtx(item)) return false;
    if (filter === "present") return hasLocal(item);
    if (filter === "marked") return item.local.marked > 0;
    if (filter === "ltx-local") return item.local.ltxLocal > 0;
    if (filter === "unmarked" || splitUnmarked) {
      if (!hasLocal(item) || item.local.marked) return false;
      if (!splitUnmarked) return true;
      if (!mediaCache.has(item.code)) {
        resolutionQueue.set(item.code, item);
        return false;
      }
      const has4k = mediaCache.get(item.code)?.some(({ width, height }) =>
        width > 0 && height > 0 && (Math.max(width, height) >= 3840 || Math.min(width, height) >= 2160)) ?? false;
      return has4k === (filter === "unmarked-4k");
    }
    if (filter === "remote-larger") return Boolean(findBatchLink(item, "larger", largestLocalSize(item), linksForSubtitleFilter(item, subtitle)));
    if (filter === "missing") return !hasLocal(item);
    return true;
  });
  const eligible = state.actor ? matching.filter(({ actors }) => actors.includes(state.actor)) : matching;
  renderStatus(eligible.length, eligible.filter(isPending).length);
  const matchesStatus = (item) => state.status === "all" || (state.status === "pending") === isPending(item);
  updateActorFacets(matching.filter(matchesStatus));
  const results = eligible.filter(matchesStatus);
  const sort = sortOptions.find(({ id }) => id === state.sort);
  results.sort((a, b) => {
    const left = sort.value(a), right = sort.value(b);
    const primary = typeof left === "number" ? left - right : collator.compare(left, right);
    return state.direction * primary || collator.compare(a.code, b.code);
  });
  const previousResults = state.results;
  state.results = results;
  renderLocalVolume(results, filter, splitUnmarked);
  const count = reuseCards ? Math.max(BATCH_SIZE, state.shown) : BATCH_SIZE;
  const resolutionNote = resolutionQueue.size ? ` · 正在读取 ${resolutionQueue.size} 部的分辨率…` : "";
  $("results").textContent = `${results.length} 部 · 本地 ${results.filter(hasLocal).length} · LTX ${results.filter(({ local }) => local.marked).length}${resolutionNote}`;
  $("batchLinks").disabled = !results.some(({ links }) => links.length);
  $("batchCount").textContent = String(results.length);
  $("empty").hidden = results.length !== 0 || resolutionQueue.size !== 0;
  if (reuseCards) {
    reconcileResultCards(previousResults, count);
  } else {
    state.shown = 0;
    mediaObserver.disconnect();
    coverImages.disconnect();
    visibleMedia.clear();
    $("grid").replaceChildren();
    appendResults(count);
  }
  loadVisibleMedia();
  if ($("batchDialog").open && batchReady) renderBatch();
  if (scrollToTop) window.scrollTo({ top: 0 });
}

function toggleActors(open) {
  const menu = $("actor-panel");
  const scrim = $("actorScrim");
  menu.classList.toggle("open", open);
  scrim.hidden = !open;
  scrim.classList.toggle("open", open);
  $("openActors").setAttribute("aria-expanded", String(open));
  if (open) $("actorSearch").focus();
}

function applyCatalogMetadata(payload) {
  state.libraryChecked = payload.libraryChecked;
  state.downloadsChecked = payload.downloadsChecked;
  const avatars = payload.avatars || {};
  const sameAvatars = recentPreview && Object.keys(avatars).length === Object.keys(state.avatars).length
    && Object.entries(avatars).every(([actor, url]) => state.avatars[actor] === url);
  if (!sameAvatars) state.avatars = avatars;
  const date = new Date(payload.fetchedAt);
  const snapshot = $("snapshot");
  snapshot.textContent = Number.isFinite(date.valueOf()) ? `本地快照 · ${dateFormatter.format(date)}` : "本地快照";
  $("reload").title = snapshot.textContent;
}

function showRecentPreview(payload) {
  applyCatalogMetadata(payload);
  const { total, local, marked, pending } = payload.counts;
  state.actors = payload.actors;
  state.actorItemCount = total;
  state.results = payload.items.map(prepareItem);
  recentPreview = { items: new Map(state.results.map((item) => [item.code, item])), display: JSON.stringify(display) };
  renderStatus(total, pending);
  renderActors();
  $("results").textContent = `${total} 部 · 本地 ${local} · LTX ${marked}`;
  $("batchCount").textContent = String(total);
  $("empty").hidden = total !== 0;
  appendResults();
}

async function readCatalogResponse(url) {
  const response = await fetch(url);
  return { ok: response.ok, payload: await response.json() };
}

async function load({ refresh = false, catalogJson, initialUrl = "/api/fanhao/ltx" } = {}) {
  const reload = $("reload");
  const syncButton = $("syncCatalog");
  const feedback = $("feedback");
  if (reload.disabled) return false;
  const sync = catalogJson !== undefined;
  reload.disabled = syncButton.disabled = true;
  syncButton.textContent = sync ? "导入中…" : "更新目录";
  feedback.textContent = sync ? "正在校验并导入目录…" : "";
  let synced = false;
  try {
    if (sync) {
      const result = await fetch("/api/fanhao/ltx/sync", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: catalogJson
      });
      if (!result.ok) {
        const payload = await result.json().catch(() => ({}));
        throw new Error(payload.error || "同步请求失败，请重试。");
      }
      synced = true;
      feedback.textContent = "目录已同步，正在读取本地状态…";
      $("catalogImportJson").value = "";
      $("catalogImport").close();
    }
    let { ok, payload } = await readCatalogResponse(refresh ? "/api/fanhao/ltx?refresh=1" : initialUrl);
    if (ok && payload.preview === "recent") {
      if (getFilterParams().toString() === "sort=recent") showRecentPreview(payload);
      ({ ok, payload } = await readCatalogResponse("/api/fanhao/ltx"));
    }
    if (!ok) throw new Error(payload.error || "读取本地 LTX 目录失败。");
    const reuseCards = Boolean(recentPreview && recentPreview.display === JSON.stringify(display)
      && state.libraryChecked === payload.libraryChecked && state.downloadsChecked === payload.downloadsChecked);
    const previewItems = reuseCards ? recentPreview.items : null;
    applyCatalogMetadata(payload);
    state.items = payload.items.map((item) => {
      const prepared = prepareItem(item);
      const previous = previewItems?.get(item.code);
      return previous && JSON.stringify(previous) === JSON.stringify(prepared) ? previous : prepared;
    });
    const hadPreview = Boolean(recentPreview);
    recentPreview = null;
    if (!hadPreview || refresh || sync) localCatalogRequest = null;
    if ($("filter").value === "ltx-local") loadLocalCatalog();
    mediaCache = new Map();
    activeMedia = new Map();
    renderResults(false, reuseCards && !refresh && !sync);
    const note = !state.libraryChecked || !state.downloadsChecked ? "部分本地目录或索引暂不可读，结果可能不完整。" : "";
    feedback.textContent = synced ? `目录已更新，共 ${state.items.length} 部。${note}` : note;
    return true;
  } catch (error) {
    if (sync && !synced) $("catalogImportStatus").textContent = error.message;
    feedback.textContent = synced ? "目录已同步，页面读取失败，请重读本地状态。"
      : sync ? `更新失败：${error.message}` : error.message;
    if (!state.items.length && !recentPreview) $("snapshot").textContent = "本地快照暂不可用";
    return false;
  } finally {
    syncButton.textContent = "更新目录";
    reload.disabled = syncButton.disabled = false;
  }
}

function getFilterParams() {
  const params = new URLSearchParams();
  const values = {
    q: $("search").value.trim(),
    actor: state.actor,
    status: state.status === "all" ? "" : state.status,
    local: $("filter").value === "all" ? "" : $("filter").value,
    subtitle: $("subtitleFilter").value === "all" ? "" : $("subtitleFilter").value,
    sort: state.sort === "score" ? "" : state.sort
  };
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const defaultDirection = sortOptions.find(({ id }) => id === state.sort).direction;
  if (state.direction !== defaultDirection) params.set("order", state.direction > 0 ? "asc" : "desc");
  return params;
}

function setSelectValue(id, value) {
  const select = $(id);
  select.value = value || "all";
  if (select.selectedIndex < 0) select.value = "all";
}

let filterLocationSearch = location.search;
function navigateFilters(mode) {
  writeFilterViewUrl(getFilterParams(), mode);
  filterLocationSearch = location.search;
}

function applyFilterParams(params, { render = true, navigate = false } = {}) {
  const sort = sortOptions.find(({ id }) => id === params.get("sort")) || sortOptions[0];
  const order = params.get("order");
  const status = params.get("status");
  $("search").value = params.get("q") || "";
  state.actor = params.get("actor") || "";
  state.status = ["confirmed", "pending"].includes(status) ? status : "all";
  state.sort = sort.id;
  state.direction = order === "asc" ? 1 : order === "desc" ? -1 : sort.direction;
  setSelectValue("filter", params.get("local"));
  setSelectValue("subtitleFilter", params.get("subtitle"));
  if (!render) return;
  if (navigate) navigateFilters();
  if ($("filter").value === "ltx-local") loadLocalCatalog();
  renderSort();
  renderResults(true);
}

function updateFilters(mode = "push") {
  navigateFilters(mode);
  renderResults(true);
}

applyFilterParams(new URLSearchParams(location.search), { render: false });
installFilterViews({ getParams: getFilterParams, applyParams: (params) => applyFilterParams(params, { navigate: true }) });
window.addEventListener("popstate", () => {
  if (filterLocationSearch === location.search) return;
  filterLocationSearch = location.search;
  if ($("filterViews").open) $("filterViews").close();
  applyFilterParams(new URLSearchParams(location.search));
});
$("openActors").append(icon("people", 20));
$("openActors").addEventListener("click", () => toggleActors(true));
$("closeActors").addEventListener("click", () => { toggleActors(false); $("openActors").focus(); });
$("actorScrim").addEventListener("click", () => toggleActors(false));
$("actorChip").addEventListener("click", () => setActor(""));
$("actorSearch").addEventListener("input", renderActors);
$("actors").addEventListener("focusin", (event) => {
  if (event.target === actorSentinel.previousElementSibling && actorView.shown < actorView.matching.length) appendActors();
});
$("search").addEventListener("input", (event) => {
  if (!event.isComposing) updateFilters("replace");
});
$("search").addEventListener("compositionend", () => updateFilters("replace"));
$("filter").addEventListener("change", () => {
  if ($("filter").value === "ltx-local") loadLocalCatalog();
  updateFilters();
});
$("subtitleFilter").addEventListener("change", () => updateFilters());
$("displaySettings").addEventListener("click", () => $("displayDialog").showModal());
for (const control of $("displayDialog").querySelectorAll("[data-display]")) {
  const key = control.dataset.display;
  control.checked = display[key];
  control.addEventListener("change", () => {
    display[key] = control.checked;
    try { localStorage.setItem(displayKey, JSON.stringify(display)); } catch { /* Use this session's settings. */ }
    renderResults();
  });
}
$("loadMore").addEventListener("click", () => appendResults());
$("reload").addEventListener("click", () => load({ refresh: true }));
$("syncCatalog").addEventListener("click", () => {
  $("catalogImportStatus").textContent = "";
  $("catalogImport").showModal();
});
const LTX_CATALOG_ORIGIN = "https://ltxlib.dpdns.org";
const MAX_CATALOG_IMPORT_BYTES = 32 * 1024 * 1024;
let catalogPopup;
function closeCatalogPopup() {
  if (!catalogPopup) return;
  clearInterval(catalogPopup.timer);
  catalogPopup.window.close();
  catalogPopup = null;
  $("openCatalogSync").disabled = false;
}

$("openCatalogSync").addEventListener("click", () => {
  const status = $("catalogImportStatus");
  if (!["http://127.0.0.1:29998", "http://localhost:29998"].includes(location.origin)) {
    status.textContent = "请在服务电脑的 29998 端口打开 FanHao 再同步。";
    return;
  }
  if (catalogPopup) return;
  const id = crypto.randomUUID();
  const url = new URL(LTX_CATALOG_ORIGIN);
  url.hash = new URLSearchParams({ fanhaoCatalog: id, fanhaoOrigin: location.origin });
  const popup = window.open(url, "_blank", "popup,width=980,height=720");
  if (!popup) {
    status.textContent = "浏览器拦截了小窗，请允许弹出窗口后重试。";
    return;
  }
  $("openCatalogSync").disabled = true;
  status.textContent = "请在小窗完成官网验证。";
  const openedAt = Date.now();
  catalogPopup = { id, window: popup, timer: setInterval(() => {
    const elapsed = Date.now() - openedAt;
    if (!popup.closed && elapsed < 5 * 60_000) {
      if (!catalogPopup.connected && elapsed > 10_000) {
        status.textContent = "还没连接到官网。请安装或更新同步脚本，再重新打开小窗。";
      } else if (catalogPopup.connected && elapsed > 15_000) {
        status.textContent = "已连接官网小窗，但尚未收到完整目录。如果官网已显示作品列表，当前同步仍无法导入新站目录。本地快照可继续使用。";
      }
      return;
    }
    status.textContent = popup.closed ? "官网小窗已关闭，可以重新打开。" : "没有收到可导入的官网目录，已保留本地快照。";
    closeCatalogPopup();
  }, 500) };
});
$("catalogImport").addEventListener("close", closeCatalogPopup);
window.addEventListener("pagehide", closeCatalogPopup);
window.addEventListener("message", async (event) => {
  const attempt = catalogPopup;
  if (!attempt || event.origin !== LTX_CATALOG_ORIGIN || event.source !== attempt.window
    || event.data?.id !== attempt.id || attempt.importing) return;
  if (event.data.type === "fanhao:ltx:ready") {
    attempt.connected = true;
    $("catalogImportStatus").textContent = "已连接官网小窗，正在等待可导入的完整目录。";
    return;
  }
  if (event.data.type !== "fanhao:ltx:catalog" || typeof event.data.json !== "string") return;
  attempt.importing = true;
  clearInterval(attempt.timer);
  $("catalogImportStatus").textContent = "已收到目录，正在导入…";
  await load({ catalogJson: event.data.json });
  if (catalogPopup === attempt) closeCatalogPopup();
});
async function importManualCatalog(text) {
  if (!text || $("reload").disabled) return;
  closeCatalogPopup();
  $("catalogImportSubmit").disabled = true;
  $("catalogImportStatus").textContent = "正在导入…";
  try { await load({ catalogJson: text }); }
  finally { $("catalogImportSubmit").disabled = false; }
}

$("catalogImportClipboard").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const dialog = $("catalogImport");
  const status = $("catalogImportStatus");
  if ($("reload").disabled) return;
  button.disabled = true;
  try {
    let text;
    try { text = (await navigator.clipboard.readText()).trim(); }
    catch {
      if (!dialog.open) return;
      $("catalogImportManual").open = true;
      $("catalogImportJson").focus();
      status.textContent = "浏览器未允许读取剪贴板，请在文本框中粘贴目录 JSON。";
      return;
    }
    if (!dialog.open) return;
    if (new Blob([text]).size > MAX_CATALOG_IMPORT_BYTES) {
      status.textContent = "剪贴板内容超过 32 MiB。";
      return;
    }
    let catalog;
    try { catalog = JSON.parse(text); } catch { /* Report invalid clipboard input below. */ }
    const items = (catalog?.data ?? catalog)?.items;
    if (!Array.isArray(items) || !items.length || !items.some((item) => Array.isArray(item?.links) && item.links.length)) {
      status.textContent = "剪贴板里没有可导入的目录 JSON。请复制完整目录后重试。";
      return;
    }
    await importManualCatalog(text);
  } finally { button.disabled = false; }
});
$("catalogImportChoose").addEventListener("click", () => $("catalogImportFile").click());
$("catalogImportFile").addEventListener("change", async (event) => {
  const input = event.target;
  const [file] = input.files;
  input.value = "";
  if (!file) return;
  if (file.size > MAX_CATALOG_IMPORT_BYTES) {
    $("catalogImportStatus").textContent = "目录文件超过 32 MiB。";
    return;
  }
  try {
    $("catalogImportJson").value = await file.text();
    $("catalogImportStatus").textContent = `已选 ${file.name}，点「导入目录」继续。`;
  } catch { $("catalogImportStatus").textContent = "读取 JSON 文件失败。"; }
});
$("catalogImportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await importManualCatalog($("catalogImportJson").value.trim());
});
$("batchLinks").addEventListener("click", openBatchLinks);
$("batchMode").addEventListener("change", () => {
  $("batchStatus").textContent = "";
  renderBatch();
});
$("submitBatch").addEventListener("click", submitBatch);
$("stopBatch").addEventListener("click", stopBatch);
$("batchDialog").addEventListener("close", stopBatch);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("actor-panel").classList.contains("open")) toggleActors(false);
  if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey
    || event.target.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  $("search").focus();
});
const smallScreen = matchMedia("(max-width: 760px)");
function sizeMobileHeader() {
  const style = document.documentElement.style;
  if (smallScreen.matches) style.setProperty("--header-h", `${Math.ceil(document.querySelector(".header").getBoundingClientRect().height)}px`);
  else style.removeProperty("--header-h");
}
new ResizeObserver(sizeMobileHeader).observe(document.querySelector(".header"));
smallScreen.addEventListener("change", () => { toggleActors(false); sizeMobileHeader(); });
const pagination = new IntersectionObserver((entries) => {
  if (entries.some(({ isIntersecting }) => isIntersecting) && state.shown < state.results.length) appendResults();
}, { rootMargin: "500px" });
renderSort();
void load({ initialUrl: $("catalogPreload")?.getAttribute("href") });
