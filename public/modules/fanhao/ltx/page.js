import { installFilterViews, writeFilterViewUrl } from "./filter-views.js?v=20261113-ltx-filter-views-01";

const $ = (id) => document.getElementById(id);
const scope = { header: "db15c80d", sort: "276abc24", side: "e8550fad", avatar: "190f65b8", main: "ff5b15bf", card: "289703c3" };
const BATCH_SIZE = 60;
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
const visibleMedia = new Map();
let mediaCache = new Map();
let mediaRequests = 0;
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
const hasLocal = ({ local }) => Boolean(local.library || local.downloads);
const isPending = (item) => !item.libraryOnly && Boolean(item.pending || item.waiting || item.missing || !item.links.length);
const hasMediaUrl = (url) => typeof url === "string" && /^\/media\/(?:remote-image\?|image\/[^/?#]+$)/.test(url);

function searchableItem(item) {
  const links = item.links.filter(isResourceLink);
  return {
    ...item, links, maxSize: Math.max(0, ...links.map(({ size }) => size || 0), item.libraryOnly ? largestLocalSize(item) : 0),
    searchCode: normalizeCode(item.code),
    searchText: normalize([item.code, item.title, item.originalTitle, item.maker, ...item.actors, ...(item.genres || [])].join(" "))
  };
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
    return searchableItem(item);
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

function appendImage(parent, url, alt, cover = false) {
  if (!hasMediaUrl(url)) return;
  const image = element("img", "", "", cover ? "card" : "avatar");
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  if (cover) image.classList.add("in");
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = url;
  parent.append(image);
}

function showCover(item) {
  $("coverTitle").textContent = item.code;
  $("coverPreview").alt = `${item.code} 封面`;
  $("coverPreview").src = item.coverUrl;
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
  renderLocalMedia(row, cached ?? item.local.copies, !cached);
  if (!cached) {
    row.dataset.code = item.code;
    mediaObserver.observe(row);
  }
  return row;
}

function loadVisibleMedia() {
  for (const [row, code] of visibleMedia) {
    if (mediaRequests >= 3) return;
    visibleMedia.delete(row);
    mediaObserver.unobserve(row);
    if (!row.isConnected) continue;
    const cached = mediaCache.get(code);
    if (cached) {
      renderLocalMedia(row, cached);
      continue;
    }
    const cache = mediaCache;
    mediaRequests++;
    const item = state.results.find((item) => item.code === code);
    const media = item?.libraryOnly
      ? Promise.all(item.local.copies.map(async (copy) => {
        const info = await readLibraryJson(`/api/playinfo/${encodeURIComponent(copy.videoId)}`).catch(() => ({}));
        return { ...copy, width: info.width, height: info.height };
      }))
      : readLibraryJson(`/api/fanhao/ltx/local-media?${new URLSearchParams({ code })}`).then(({ copies }) => copies);
    media
      .then((copies) => {
        cache.set(code, copies);
        if (row.isConnected) renderLocalMedia(row, copies);
      }).catch(() => {
        if (row.isConnected && item) renderLocalMedia(row, item.local.copies);
      }).finally(() => {
        mediaRequests--;
        loadVisibleMedia();
      });
  }
}

function createCover(item) {
  const cover = element("div", "cover", "", "card");
  cover.append(element("span", "ph", "", "card"));
  if (hasMediaUrl(item.coverUrl)) {
    const preview = button("", () => showCover(item), "cover-btn", "card");
    preview.setAttribute("aria-label", `查看 ${item.code} 的完整封面`);
    appendImage(preview, item.coverUrl, `${item.code} 封面`, true);
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
  row.classList.toggle("on", state.actor === actor);
  row.setAttribute("aria-pressed", String(state.actor === actor));
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

function renderActors() {
  const nav = $("actors");
  const top = nav.scrollTop;
  const query = normalize($("actorSearch").value);
  const matching = state.actors.filter(([actor]) => !query || normalize(actor).includes(query));
  const rows = matching.map(([actor, count]) => actorRow(actor, actor, count));
  if (!query && state.actor && !state.actors.some(([actor]) => actor === state.actor)) {
    rows.unshift(actorRow(state.actor, state.actor, 0));
  }
  $("actorCount").textContent = `${matching.length} 人`;
  nav.replaceChildren(
    actorRow("", "全部", state.actorItemCount),
    ...rows
  );
  nav.scrollTop = top;
  $("actorChip").hidden = !state.actor;
  $("actorChip").textContent = state.actor ? `${state.actor} ×` : "";
}

function updateActorFacets(items) {
  const counts = new Map();
  for (const { actors } of items) {
    for (const actor of new Set(actors)) counts.set(actor, (counts.get(actor) || 0) + 1);
  }
  state.actorItemCount = items.length;
  state.actors = [...counts].sort(([left, leftCount], [right, rightCount]) =>
    rightCount - leftCount || collator.compare(left, right));
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

function renderStatus(items) {
  const pending = items.filter(isPending).length;
  const labels = [["all", "全部", items.length], ["confirmed", "已确认", items.length - pending], ["pending", "待确认", pending]];
  $("status").replaceChildren(...labels.map(([status, label, count]) => {
    const node = button(label, () => { state.status = status; updateFilters(); }, `seg ${status}`, "main");
    node.classList.toggle("on", status === state.status);
    node.setAttribute("aria-pressed", String(status === state.status));
    node.append(element("i", "", String(count), "main"));
    return node;
  }));
}

function appendResults() {
  const next = state.results.slice(state.shown, state.shown + BATCH_SIZE);
  $("grid").append(...next.map(cardView));
  state.shown += next.length;
  $("loadMore").hidden = state.shown >= state.results.length;
}

function renderLocalVolume(results, filter) {
  const volume = $("localVolume");
  volume.hidden = !["marked", "ltx-local", "unmarked"].includes(filter);
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

function renderResults(resetScroll = false) {
  const query = normalize($("search").value);
  const codeQuery = normalizeCode(query);
  const filter = $("filter").value;
  const subtitle = $("subtitleFilter").value;
  let items = state.items;
  if (filter === "ltx-local") {
    const keys = new Set(items.filter(({ local }) => local.ltxLocal > 0).map(({ searchCode }) => searchCode));
    items = [...items, ...state.localItems.filter(({ searchCode }) => !keys.has(searchCode))];
  }
  const matching = items.filter((item) => {
    if (query && !item.searchText.includes(query) && (!codeQuery || !item.searchCode.includes(codeQuery))) return false;
    if (subtitle === "available" && !item.subtitleUrl && !hasSubtitledLtx(item)) return false;
    if (subtitle === "ltx-c" && !hasSubtitledLtx(item)) return false;
    if (filter === "present") return hasLocal(item);
    if (filter === "marked") return item.local.marked > 0;
    if (filter === "ltx-local") return item.local.ltxLocal > 0;
    if (filter === "unmarked") return hasLocal(item) && !item.local.marked;
    if (filter === "remote-larger") return Boolean(findBatchLink(item, "larger", largestLocalSize(item), linksForSubtitleFilter(item, subtitle)));
    if (filter === "missing") return !hasLocal(item);
    return true;
  });
  const eligible = state.actor ? matching.filter(({ actors }) => actors.includes(state.actor)) : matching;
  renderStatus(eligible);
  const matchesStatus = (item) => state.status === "all" || (state.status === "pending") === isPending(item);
  updateActorFacets(matching.filter(matchesStatus));
  const results = eligible.filter(matchesStatus);
  const sort = sortOptions.find(({ id }) => id === state.sort);
  results.sort((a, b) => {
    const left = sort.value(a), right = sort.value(b);
    const primary = typeof left === "number" ? left - right : collator.compare(left, right);
    return state.direction * primary || collator.compare(a.code, b.code);
  });
  state.results = results;
  renderLocalVolume(results, filter);
  state.shown = 0;
  $("results").textContent = `${results.length} 部 · 本地 ${results.filter(hasLocal).length} · LTX ${results.filter(({ local }) => local.marked).length}`;
  $("batchLinks").disabled = !results.some(({ links }) => links.length);
  $("batchCount").textContent = String(results.length);
  mediaObserver.disconnect();
  visibleMedia.clear();
  $("grid").replaceChildren();
  $("empty").hidden = results.length !== 0;
  appendResults();
  if (resetScroll) window.scrollTo({ top: 0 });
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

async function load({ refresh = false, sync = false } = {}) {
  const reload = $("reload");
  const syncButton = $("syncCatalog");
  const feedback = $("feedback");
  if (reload.disabled) return false;
  reload.disabled = syncButton.disabled = true;
  syncButton.textContent = sync ? "更新中…" : "更新目录";
  feedback.textContent = sync ? "正在从 Jasna-LTX 同步目录…" : "";
  let synced = false;
  try {
    if (sync) {
      const result = await fetch("/api/fanhao/ltx/sync", { method: "POST" });
      if (!result.ok) {
        const payload = await result.json().catch(() => ({}));
        throw new Error(payload.error || "同步请求失败，请重试。");
      }
      synced = true;
      feedback.textContent = "目录已同步，正在读取本地状态…";
    }
    const response = await fetch(refresh ? "/api/fanhao/ltx?refresh=1" : "/api/fanhao/ltx");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "读取本地 LTX 目录失败。");
    state.libraryChecked = payload.libraryChecked;
    state.downloadsChecked = payload.downloadsChecked;
    state.avatars = payload.avatars || {};
    state.items = payload.items.map(searchableItem);
    localCatalogRequest = null;
    if ($("filter").value === "ltx-local") loadLocalCatalog();
    const date = new Date(payload.fetchedAt);
    $("snapshot").textContent = Number.isFinite(date.valueOf()) ? `本地快照 · ${dateFormatter.format(date)}` : "本地快照";
    reload.title = $("snapshot").textContent;
    mediaCache = new Map();
    renderResults();
    const note = !state.libraryChecked || !state.downloadsChecked ? "部分本地目录或索引暂不可读，结果可能不完整。" : "";
    feedback.textContent = synced ? `目录已更新，共 ${state.items.length} 部。${note}` : note;
    return true;
  } catch (error) {
    feedback.textContent = synced ? "目录已同步，页面读取失败，请重读本地状态。"
      : sync ? `更新失败：${error.message}` : error.message;
    if (!state.items.length) $("snapshot").textContent = "本地快照暂不可用";
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
$("loadMore").addEventListener("click", appendResults);
$("reload").addEventListener("click", () => load({ refresh: true }));
$("syncCatalog").addEventListener("click", () => load({ sync: true }));
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
pagination.observe($("sentinel"));
renderSort();
void load();
