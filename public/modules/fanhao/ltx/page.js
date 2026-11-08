const $ = (id) => document.getElementById(id);
const scope = { header: "db15c80d", sort: "276abc24", side: "e8550fad", avatar: "190f65b8", main: "ff5b15bf", card: "289703c3" };
const BATCH_SIZE = 60;
const collator = new Intl.Collator("zh-CN", { numeric: true });
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai"
});
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
const selected = new Map();
const directorySetting = "fanhao.ltx.115.directory";
let visibleLinks = [];
let downloadRequest = null;
let feedbackTimer = null;
const state = {
  items: [], results: [], actors: [], avatars: {},
  actor: "", status: "all", sort: "score", direction: -1, shown: 0,
  libraryChecked: false, downloadsChecked: false
};

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
      status.textContent = "剪贴板不可用，可在完整链接中选中文本。";
    }
    return false;
  }
}

function resourceAnchor(link, text, className, component) {
  const anchor = element("a", className, text, component);
  anchor.setAttribute("href", link.url);
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.draggable = true;
  anchor.addEventListener("dragstart", (event) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData("text/uri-list", link.url);
    event.dataTransfer.setData("text/plain", link.url);
    event.dataTransfer.effectAllowed = "link";
  });
  return anchor;
}

function browserHandoff(link, code, text, className, component, status) {
  const anchor = resourceAnchor(link, text, className, component);
  const fragment = new URLSearchParams({ code, link: link.url });
  anchor.href = `/modules/fanhao/ltx/open.html#${fragment}`;
  anchor.title = "复制完整链接，在新标签页交给 115 浏览器";
  anchor.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    // Copy before the native new tab takes focus.
    const field = element("textarea", "sr-only");
    field.value = link.url;
    field.readOnly = true;
    (status.closest("dialog") || document.body).append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { /* Use the clipboard API below. */ }
    field.remove();
    if (copied) status.textContent = "已复制";
    else void copyText(link.url, status);
  });
  return anchor;
}

function isResourceLink(link) {
  return typeof link?.url === "string" && !/[\r\n]/.test(link.url)
    && (link.type === "magnet" ? /^magnet:\?/i.test(link.url)
      : link.type === "ed2k" && /^ed2k:\/\/\|file\|/i.test(link.url));
}

const normalize = (text) => String(text || "").normalize("NFKC").trim().toLowerCase();
const normalizeCode = (text) => normalize(text).replace(/[-_.\s]+/g, "");
const hasLocal = ({ local }) => Boolean(local.library || local.downloads);
const isPending = (item) => Boolean(item.pending || item.waiting || item.missing || !item.links.length);
const hasMediaUrl = (url) => typeof url === "string" && url.startsWith("/media/remote-image?");
const has115Bridge = () => document.documentElement.dataset.fanhaoLtx115 === "1";

function dialogDownloadEntries() {
  if (visibleLinks.length === 1) return visibleLinks;
  return visibleLinks.filter(({ link }) => selected.has(link.url));
}

function updateSelection() {
  $("selectedCount").textContent = String(selected.size);
  $("showSelected").disabled = selected.size === 0;
  $("showSelected").setAttribute("aria-label", `已选链接 ${selected.size}`);
  $("copySelected").disabled = selected.size === 0;
  $("clearSelected").disabled = selected.size === 0;
  for (const checkbox of $("linksList").querySelectorAll("input[data-link]")) {
    checkbox.checked = selected.has(checkbox.dataset.link);
  }
  const ready = has115Bridge();
  const add = $("addTo115");
  add.textContent = !ready ? "设置 115 下载" : visibleLinks.length === 1 ? "添加到 115" : "添加选中到 115";
  add.disabled = ready && (Boolean(downloadRequest) || !dialogDownloadEntries().length);
}

function syncBridgeStatus() {
  const ready = has115Bridge();
  const indicator = $("bridgeStatus");
  indicator.textContent = ready ? "已检测到 115 下载脚本" : "未检测到 FanHao 的 115 下载脚本";
  indicator.classList.toggle("fanhao-bridge-ready", ready);
  $("downloadSettings").classList.toggle("fanhao-bridge-ready", ready);
  updateSelection();
}

function openDownloadSettings() {
  $("settingsStatus").textContent = "";
  syncBridgeStatus();
  if (!$("downloadSettingsDialog").open) $("downloadSettingsDialog").showModal();
}

function showDownloadFeedback(status, message, temporary = false) {
  status.textContent = message;
  if (status !== $("downloadFeedback")) return;
  clearTimeout(feedbackTimer);
  if (temporary) feedbackTimer = setTimeout(() => { status.textContent = ""; }, 8000);
}

function submitTo115(entries, status) {
  if (!has115Bridge()) { openDownloadSettings(); return; }
  if (downloadRequest) { showDownloadFeedback(status, "上一批链接正在提交，请稍候。"); return; }
  const urls = [...new Set(entries.map(({ link }) => link.url))];
  if (!urls.length || urls.length > 50) {
    showDownloadFeedback(status, "请勾选 1 至 50 条链接。", true);
    return;
  }
  const directory = $("downloadDirectory");
  if (!directory.checkValidity()) {
    openDownloadSettings();
    directory.reportValidity();
    return;
  }
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    if (downloadRequest?.id !== id) return;
    downloadRequest = null;
    updateSelection();
    showDownloadFeedback(status, "脚本未返回提交结果。请先在 115 云下载核对任务再重试。", true);
  }, 25000);
  downloadRequest = { id, timer, status };
  updateSelection();
  showDownloadFeedback(status, "正在提交到 115…");
  document.dispatchEvent(new CustomEvent("fanhao:ltx115:add", {
    detail: JSON.stringify({ id, urls, dir: directory.value })
  }));
}

document.addEventListener("fanhao:ltx115:result", (event) => {
  let result;
  try { result = JSON.parse(event.detail); } catch { return; }
  if (!downloadRequest || result?.id !== downloadRequest.id || typeof result.message !== "string") return;
  const { timer, status } = downloadRequest;
  clearTimeout(timer);
  downloadRequest = null;
  updateSelection();
  showDownloadFeedback(status, result.message, true);
});

function linkLabel(link) {
  return link.type === "magnet" ? "磁力" : `ed2k · ${(link.size / 1024 ** 3).toFixed(1)}G`;
}

function linkPanel(link, code, index) {
  const group = element("section", "fanhao-link");
  const header = element("div", "fanhao-link-header");
  const label = element("label");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.dataset.link = link.url;
  checkbox.setAttribute("aria-label", `勾选 ${code} 的链接 ${index + 1}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.set(link.url, { link, code });
    else selected.delete(link.url);
    updateSelection();
  });
  label.append(checkbox, ` ${code} · ${linkLabel(link)}`);
  header.append(label);
  if (link.sizeMatch) header.append(element("span", "fanhao-same-size", "本地同字节 · 待校验"));
  const anchor = resourceAnchor(link, link.url, "fanhao-link-address");
  anchor.title = "在新窗口打开或拖拽完整地址";
  const actions = element("div", "fanhao-link-actions");
  actions.append(
    button("选中文本", () => selectText(anchor), "fanhao-pill"),
    button("复制", () => copyText(link.url, $("dialogStatus"), anchor), "fanhao-pill"),
    browserHandoff(link, code, "在 115 浏览器打开", "fanhao-pill", undefined, $("dialogStatus"))
  );
  group.append(header, anchor, actions);
  return group;
}

function openLinks(entries, title) {
  visibleLinks = entries;
  $("linksTitle").textContent = title;
  $("dialogStatus").textContent = "";
  $("linksList").replaceChildren(...entries.map(({ link, code }, index) => linkPanel(link, code, index)));
  updateSelection();
  if (!$("linksDialog").open) $("linksDialog").showModal();
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
  renderActors();
  renderResults(true);
}

function localStateView(item) {
  const row = element("div", "fanhao-local-state");
  const { library, downloads, marked, folderMarked } = item.local;
  if (!hasLocal(item)) {
    row.append(element("span", "", state.libraryChecked && state.downloadsChecked ? "本地未发现" : "本地状态不完整"));
    return row;
  }
  if (library) row.append(element("span", "fanhao-present", `馆藏 ${library}`));
  if (downloads) row.append(element("span", "fanhao-present", `下载盘 ${downloads}`));
  const status = element("span", marked ? "fanhao-present" : "fanhao-pending", marked ? `已标 LTX ${marked}` : "未标 LTX");
  status.title = marked ? `${marked} 份本地视频的文件名含 LTX 标记`
    : folderMarked ? "视频文件名未标 LTX，目录带 LTX 标记" : "同番号本地视频的文件名未标 LTX";
  if (!marked && folderMarked) status.textContent = "仅目录标 LTX";
  row.append(status);
  return row;
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
  const actions = element("div", "actions expanded fanhao-card-actions", "", "card");
  const [link] = item.links;
  if (!link) {
    const pending = button("待确认", () => {}, "btn", "card");
    pending.disabled = true;
    actions.append(pending);
    return actions;
  }
  const entries = item.links.map((entry) => ({ link: entry, code: item.code }));
  const open = () => openLinks(entries, `${item.code} · 完整下载链接`);
  const primary = resourceAnchor(link, `复制 ${linkLabel(link)}`, "btn copy-btn", "card");
  primary.removeAttribute("target");
  primary.removeAttribute("rel");
  primary.title = "直接打开原始链接";
  primary.setAttribute("aria-label", `直接打开 ${item.code} 的${link.type === "magnet" ? "磁力" : " eD2k"}链接`);
  const more = button("添加到下载", () => {
    if (has115Bridge() && entries.length === 1) submitTo115(entries, $("downloadFeedback"));
    else {
      open();
      $("dialogStatus").textContent = has115Bridge() ? "请勾选需要添加到 115 的链接。" : "尚未连接下载脚本，可点「设置 115 下载」。";
    }
  }, "btn add-btn", "card");
  more.title = "提交到 115 云下载或查看完整链接";
  more.setAttribute("aria-label", `添加 ${item.code} 到下载`);
  actions.append(primary, more);
  return actions;
}

function cardView(item) {
  const card = element("article", "card", "", "card");
  card.setAttribute(`data-v-${scope.main}`, "");
  const body = element("div", "body", "", "card");
  const title = element("h3", "title", item.title || item.code, "card");
  title.title = title.textContent;
  const tags = element("div", "tags", "", "card");
  for (const actor of item.actors) tags.append(button(actor, () => setActor(actor), "tag", "card"));
  const sub = element("div", "sub", "", "card");
  const meta = element("span", "meta", [item.date, item.maker].filter(Boolean).join(" · "), "card");
  meta.title = meta.textContent;
  const library = element("a", "feedback", "查馆藏", "card");
  library.href = `/fanhao?${new URLSearchParams({ q: item.code })}`;
  sub.append(meta, library);
  body.append(title, tags, sub, localStateView(item), createActions(item));
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
  nav.replaceChildren(
    actorRow("", "全部", state.items.length),
    ...state.actors.filter(([actor]) => !query || normalize(actor).includes(query)).map(([actor, count]) => actorRow(actor, actor, count))
  );
  nav.scrollTop = top;
  $("actorChip").hidden = !state.actor;
  $("actorChip").textContent = state.actor ? `${state.actor} ×` : "";
}

function renderSort() {
  $("sort").replaceChildren(...sortOptions.map((option) => {
    const selectedSort = state.sort === option.id;
    const node = button("", () => {
      state.direction = selectedSort ? -state.direction : option.direction;
      state.sort = option.id;
      renderSort();
      renderResults(true);
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
    const node = button(label, () => { state.status = status; renderResults(true); }, `seg ${status}`, "main");
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

function renderResults(resetScroll = false) {
  const query = normalize($("search").value);
  const codeQuery = normalizeCode(query);
  const filter = $("filter").value;
  const eligible = state.items.filter((item) => {
    if (query && !item.searchText.includes(query) && (!codeQuery || !item.searchCode.includes(codeQuery))) return false;
    if (state.actor && !item.actors.includes(state.actor)) return false;
    if (filter === "present") return hasLocal(item);
    if (filter === "marked") return item.local.marked > 0;
    if (filter === "unmarked") return hasLocal(item) && !item.local.marked;
    if (filter === "missing") return !hasLocal(item);
    return true;
  });
  renderStatus(eligible);
  const results = eligible.filter((item) => state.status === "all" || (state.status === "pending") === isPending(item));
  const sort = sortOptions.find(({ id }) => id === state.sort);
  results.sort((a, b) => {
    const left = sort.value(a), right = sort.value(b);
    const primary = typeof left === "number" ? left - right : collator.compare(left, right);
    return state.direction * primary || collator.compare(a.code, b.code);
  });
  state.results = results;
  state.shown = 0;
  $("results").textContent = `${results.length} 部 · 本地 ${results.filter(hasLocal).length} · LTX ${results.filter(({ local }) => local.marked).length}`;
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
  if (reload.disabled) return;
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
    state.items = payload.items.map((item) => {
      const links = item.links.filter(isResourceLink);
      return {
        ...item, links, maxSize: Math.max(0, ...links.map(({ size }) => size || 0)),
        searchCode: normalizeCode(item.code),
        searchText: normalize([item.code, item.title, item.originalTitle, item.maker, ...item.actors, ...(item.genres || [])].join(" "))
      };
    });
    const actors = new Map();
    for (const item of state.items) for (const actor of new Set(item.actors)) actors.set(actor, (actors.get(actor) || 0) + 1);
    state.actors = [...actors].sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || collator.compare(left, right));
    const validLinks = new Set(state.items.flatMap((item) => item.links.map(({ url }) => url)));
    for (const url of selected.keys()) if (!validLinks.has(url)) selected.delete(url);
    const date = new Date(payload.fetchedAt);
    $("snapshot").textContent = Number.isFinite(date.valueOf()) ? `本地快照 · ${dateFormatter.format(date)}` : "本地快照";
    reload.title = $("snapshot").textContent;
    renderActors();
    renderResults();
    updateSelection();
    const note = !state.libraryChecked || !state.downloadsChecked ? "部分本地目录或索引暂不可读，结果可能不完整。" : "";
    feedback.textContent = synced ? `目录已更新，共 ${state.items.length} 部。${note}` : note;
  } catch (error) {
    feedback.textContent = synced ? "目录已同步，页面读取失败，请重读本地状态。"
      : sync ? `更新失败：${error.message}` : error.message;
    if (!state.items.length) $("snapshot").textContent = "本地快照暂不可用";
  } finally {
    syncButton.textContent = "更新目录";
    reload.disabled = syncButton.disabled = false;
  }
}

$("search").value = new URLSearchParams(location.search).get("q") || "";
$("openActors").append(icon("people", 20));
$("openActors").addEventListener("click", () => toggleActors(true));
$("closeActors").addEventListener("click", () => { toggleActors(false); $("openActors").focus(); });
$("actorScrim").addEventListener("click", () => toggleActors(false));
$("actorChip").addEventListener("click", () => setActor(""));
$("actorSearch").addEventListener("input", renderActors);
$("search").addEventListener("input", () => renderResults(true));
$("filter").addEventListener("change", () => renderResults(true));
$("loadMore").addEventListener("click", appendResults);
$("reload").addEventListener("click", () => load({ refresh: true }));
$("syncCatalog").addEventListener("click", () => load({ sync: true }));
$("downloadSettings").addEventListener("click", openDownloadSettings);
$("addTo115").addEventListener("click", () => submitTo115(dialogDownloadEntries(), $("dialogStatus")));
const directory = $("downloadDirectory");
try { directory.value = localStorage.getItem(directorySetting) || ""; } catch { /* Browser storage may be disabled. */ }
directory.addEventListener("input", () => {
  if (!directory.checkValidity()) return;
  try { localStorage.setItem(directorySetting, directory.value); } catch { /* Keep the current value in the form. */ }
});
$("copyDownloadScript").addEventListener("click", async () => {
  const status = $("settingsStatus");
  try {
    const response = await fetch($("installDownloadScript").href);
    if (!response.ok) throw new Error("script unavailable");
    await navigator.clipboard.writeText(await response.text());
    status.textContent = "脚本已复制，可粘贴到 Tampermonkey 新建脚本。";
  } catch {
    status.textContent = "可打开「安装脚本」查看并手动复制代码。";
  }
});
new MutationObserver(syncBridgeStatus).observe(document.documentElement, {
  attributes: true, attributeFilter: ["data-fanhao-ltx115"]
});
syncBridgeStatus();
$("showSelected").addEventListener("click", () => openLinks([...selected.values()], "已选完整链接"));
$("copySelected").addEventListener("click", () => copyText([...selected.keys()].join("\n"), $("dialogStatus")));
$("clearSelected").addEventListener("click", () => {
  selected.clear();
  updateSelection();
  $("dialogStatus").textContent = "已清空勾选";
});
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
