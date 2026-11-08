import { createApiClient } from "../../../js/api.js";
import { createIntake } from "./intake.js";

const api = createApiClient();
const endpoint = "/api/photo-catalog";
const filters = document.querySelector("#catalog-filter");
const results = document.querySelector("#catalog-results");
const more = document.querySelector("#catalog-more");
const status = document.querySelector("#catalog-status");
const counts = document.querySelector("#catalog-counts");
const statsStatus = document.querySelector("#catalog-stats-status");
const statsValues = document.querySelector("#catalog-stats-values");
const statsCategories = document.querySelector("#catalog-stats-categories");
const statsCategoryList = document.querySelector("#catalog-stats-category-list");
const localCollectionKey = new URLSearchParams(location.search).get("localCollection") || "";
const number = new Intl.NumberFormat("zh-CN");
const fields = ["q", "category", "collection", "person", "scope", "sort"];
let controller;
let statsController;
let filterKey;
let nextOffset = null;
let visibleLocal = 0;
let visibleSource = 0;

function filterParams(values) {
  const params = new URLSearchParams();
  for (const field of fields) {
    const value = String(values.get(field) || "").trim();
    if (field === "scope" && !["local", "source"].includes(value)) continue;
    if (field === "sort" && !["release", "size"].includes(value)) continue;
    if (value) params.set(field, value);
  }
  return params;
}

function preserveChoice(select, value, label = value) {
  if (value && !Array.from(select.options).some((option) => option.value === value)) {
    select.add(new Option(label, value));
  }
  select.value = value;
}

function applyLocation() {
  const params = filterParams(new URLSearchParams(location.search));
  const form = filters.elements;
  form.q.value = params.get("q") || "";
  form.scope.value = params.get("scope") || "all";
  form.sort.value = params.get("sort") || "updated";
  for (const field of ["category", "collection", "person"]) {
    preserveChoice(form[field], params.get(field) || "");
  }
  updateStatsCategorySelection();
  if (params.toString() === filterKey) return;
  filterKey = params.toString();
  void loadDirectory();
}

function useFilters(values = new FormData(filters)) {
  const params = filterParams(values);
  const url = new URL(location.href);
  for (const field of fields) {
    if (params.has(field)) url.searchParams.set(field, params.get(field));
    else url.searchParams.delete(field);
  }
  if (url.href !== location.href) history.pushState(null, "", url);
  const retry = params.toString() === filterKey && status.classList.contains("error") && !results.childElementCount;
  applyLocation();
  if (retry) void loadDirectory();
}

function showFacet(field, facets, label) {
  const select = filters.elements[field];
  const active = new URLSearchParams(filterKey).get(field) || "";
  const activeLabel = select.value === active ? select.selectedOptions[0]?.textContent : active;
  select.replaceChildren(new Option(label, ""));
  for (const { key, name, count } of facets || []) {
    if (key) select.add(new Option(count == null ? name : `${name}（${number.format(count)}）`, key));
  }
  preserveChoice(select, active, activeLabel);
}

function itemLink(list, title, href, external = false) {
  const item = document.createElement("li");
  const link = node("a", "", title);
  link.href = href;
  if (external) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  item.append(link);
  list.append(item);
  return item;
}

function appendArchiveLinks(list, archives) {
  for (const archive of archives) {
    if (!archive.id) continue;
    const item = itemLink(list, `阅读 ${archive.title || "本地包"}`, `/photo/set/${encodeURIComponent(archive.id)}`);
    const declared = [
      archive.declaredImageCount != null && `${number.format(archive.declaredImageCount)} 张`,
      archive.declaredVideoCount != null && `${number.format(archive.declaredVideoCount)} 段视频`
    ].filter(Boolean);
    const facts = [
      declared.length && `文件名标注 ${declared.join(" · ")}`,
      archive.personHint && `人物线索 ${archive.personHint}`
    ].filter(Boolean);
    if (facts.length) item.append(node("span", "details archive-facts", facts.join(" · ")));
  }
}

function measuredSize(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${number.format(bytes)} ${units[index]}`;
}

function statCount(value) {
  return Number.isFinite(value) ? number.format(value) : "—";
}

function statSize(bytes) {
  return Number.isFinite(bytes) ? measuredSize(bytes) : "—";
}

function updateStatsCategorySelection() {
  const active = filters.elements.category.value;
  for (const button of statsCategoryList.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.category === active));
  }
}

function statsCategoryItem({ key, name, works, archives, bytes }) {
  const item = node("li");
  const button = node("button", "secondary");
  button.type = "button";
  button.dataset.category = key;
  button.append(node("span", "", name), node("span", "details", [
    `${statCount(works)} 部作品`, `${statCount(archives)} 个归档`, statSize(bytes)
  ].join(" · ")));
  button.addEventListener("click", () => {
    useFilters(new URLSearchParams({ category: key, sort: filters.elements.sort.value }));
  });
  item.append(button);
  return item;
}

async function loadStats() {
  statsController?.abort();
  const request = new AbortController();
  statsController = request;
  try {
    const data = await api(`${endpoint}/stats`, { signal: request.signal });
    if (request.signal.aborted) return;
    if (!Number.isFinite(data.works) || !Number.isFinite(data.archives)) throw new Error("统计数据不完整");
    const values = [
      ["已登记作品", statCount(data.works)],
      ["本地归档", statCount(data.archives)],
      ["本地大小", statSize(data.bytes)],
      ["合集", statCount(data.collections)],
      ["有期号", statCount(data.withIssue)],
      ["有人物", statCount(data.withPeople)],
      ["已实测归档", `${statCount(data.measuredArchives)} / ${statCount(data.archives)}`],
      ["已实测图片", data.measuredArchives > 0 ? `${statCount(data.measuredImages)} 张` : "—"]
    ];
    if (Number.isFinite(data.declaredImageArchives)) {
      values.push(["文件名标注图片", `${statCount(data.declaredImages)} 张（${statCount(data.declaredImageArchives)} 包）`]);
    }
    if (Number.isFinite(data.declaredVideoArchives)) {
      values.push(["文件名标注视频", `${statCount(data.declaredVideos)} 段（${statCount(data.declaredVideoArchives)} 包）`]);
    }
    if (Number.isFinite(data.personHintArchives)) {
      values.push(["人物线索归档", `${statCount(data.personHintArchives)} / ${statCount(data.archives)}`]);
    }
    statsValues.replaceChildren(...values.map(([label, value]) => {
      const metric = node("div");
      metric.append(node("dt", "", label), node("dd", "", value));
      return metric;
    }));
    const categories = (data.categories || []).filter(({ key }) => key);
    statsCategoryList.replaceChildren(...categories.map(statsCategoryItem));
    statsCategories.hidden = !categories.length;
    statsCategories.querySelector("summary").textContent = `查看各分类统计（${number.format(categories.length)}）`;
    updateStatsCategorySelection();
    statsValues.hidden = false;
    statsStatus.hidden = true;
  } catch {
    if (request.signal.aborted) return;
    statsStatus.textContent = statsValues.hidden ? "目录统计暂不可用。" : "目录统计更新失败，仍显示上次结果。";
    statsStatus.hidden = false;
  }
}

function directoryItem(item) {
  const row = document.createElement("li");
  const heading = node("div", "result-heading");
  heading.append(node("h3", "", item.title || item.issueCode || "未命名套图"));
  if (item.issueCode && item.title !== item.issueCode) heading.append(node("span", "issue", item.issueCode));
  const collections = (item.collections || []).map((collection) => {
    const declared = [collection.declaredCountLabel, collection.declaredSizeLabel].filter(Boolean).join(" · ");
    return declared ? `${collection.name}（来源标注 ${declared}）` : collection.name;
  }).filter(Boolean);
  const people = item.people || [];
  const names = (label, matches) => {
    const found = people.filter(matches).map(({ name }) => name).filter(Boolean);
    return found.length ? `${label} ${found.join("、")}` : "";
  };
  const archives = item.archives || [];
  const sources = item.sources || [];
  const categories = [...new Set(archives.map(({ category }) => category || "未分类"))];
  const details = [
    categories.length && `分类 ${categories.join("、")}`,
    collections.length && `合集 ${collections.join("、")}`,
    names("出镜人物", ({ role }) => !role || role === "model"),
    names("归属/创作者", ({ role }) => role === "creator"),
    names("其他人物", ({ role }) => role && role !== "model" && role !== "creator"),
    item.releaseDate && `发行 ${item.releaseDate}`,
    `本地包 ${number.format(archives.length)}`,
    `来源 ${number.format(sources.length)}`,
    item.measuredImageCount != null && `本地实测 ${number.format(item.measuredImageCount)} 张`,
    item.measuredSize != null && `本地大小 ${measuredSize(item.measuredSize)}`
  ].filter(Boolean);
  row.append(heading, node("p", "details", details.join(" · ")));
  const links = node("ul", "link-list");
  appendArchiveLinks(links, archives);
  for (const source of sources) {
    const url = sourceUrl(source.url);
    const declared = [
      source.issueLabel && `期号 ${source.issueLabel}`,
      source.declaredImageCount != null && `${number.format(source.declaredImageCount)} 张`,
      source.declaredVideoCount != null && `${number.format(source.declaredVideoCount)} 段视频`,
      source.declaredSizeLabel
    ].filter(Boolean);
    const title = source.label || source.title || source.provider || url?.hostname || "来源记录";
    const label = declared.length ? `${title}（来源标注 ${declared.join(" · ")}）` : title;
    if (url) itemLink(links, label, url, true);
    else links.append(node("li", "", label));
  }
  if (links.childElementCount) row.append(links);
  return row;
}

function updateCounts(serverCounts) {
  const full = Number.isFinite(serverCounts?.local) && Number.isFinite(serverCounts?.source);
  document.querySelector("#local-count-label").textContent = full ? "有本地包的作品" : "已载入 · 有本地包";
  document.querySelector("#source-count-label").textContent = full ? "有来源的作品" : "已载入 · 有来源";
  document.querySelector("#local-count").textContent = number.format(full ? serverCounts.local : visibleLocal);
  document.querySelector("#source-count").textContent = number.format(full ? serverCounts.source : visibleSource);
  counts.hidden = false;
}

async function loadDirectory(offset = 0) {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const params = new URLSearchParams(filterKey);
  params.set("limit", "40");
  if (offset) params.set("offset", String(offset));
  if (!offset) {
    results.replaceChildren();
    visibleLocal = visibleSource = 0;
    nextOffset = null;
    counts.hidden = true;
    more.hidden = true;
  }
  more.disabled = true;
  results.setAttribute("aria-busy", "true");
  setStatus(status, offset ? "正在加载更多…" : "正在读取目录…");
  try {
    const data = await api(`${endpoint}?${params}`, { signal: request.signal });
    if (request.signal.aborted) return;
    const items = data.items || [];
    if (!offset) {
      showFacet("category", data.facets?.categories, "全部分类");
      showFacet("collection", data.facets?.collections, "全部合集");
      showFacet("person", data.facets?.people, "全部人物");
    }
    results.append(...items.map(directoryItem));
    visibleLocal += items.filter((item) => item.archives?.length).length;
    visibleSource += items.filter((item) => item.sources?.length).length;
    updateCounts(data.counts);
    const loaded = offset + items.length;
    nextOffset = items.length && loaded < data.total ? loaded : null;
    more.hidden = nextOffset === null;
    setStatus(status, loaded ? `已显示 ${number.format(loaded)} / ${number.format(data.total)} 部作品` : "没有符合条件的套图。");
  } catch (error) {
    if (!request.signal.aborted) setStatus(status, `读取目录失败。可以重新搜索或加载更多。 ${error.message}`, true);
  } finally {
    if (!request.signal.aborted) {
      results.removeAttribute("aria-busy");
      more.disabled = false;
    }
  }
}

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = value;
  return element;
}

function setStatus(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
}

function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch {}
  return null;
}

filters.addEventListener("submit", (event) => {
  event.preventDefault();
  useFilters();
});
filters.addEventListener("change", (event) => {
  if (event.target.tagName === "SELECT" || (event.target.name === "q" && !event.target.value)) useFilters();
});
more.addEventListener("click", () => {
  if (nextOffset !== null) void loadDirectory(nextOffset);
});
window.addEventListener("popstate", applyLocation);
if (localCollectionKey) {
  const back = document.querySelector("#catalog-back");
  back.href = `/photo/collection/${encodeURIComponent(localCollectionKey)}`;
  back.textContent = "← 返回图库合集";
}
applyLocation();
void loadStats();
createIntake({ api, endpoint, node, setStatus, sourceUrl, appendArchiveLinks, localCollectionKey, onSaved() {
  void loadDirectory();
  void loadStats();
} });
