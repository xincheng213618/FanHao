import { createApiClient } from "../../../js/api.js";
import { downloadDuplicateReviews, snapshotDuplicateReviews } from "./review-export.js?v=20261113-duplicates-review-export-01";

const api = createApiClient();
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 20;
const INDEX_BATCH_SIZE = 50;
const INDEX_CACHE_MS = 30_000;
const FILE_BATCH_SIZE = 6;
const WHOLE_GROUP_LIMIT = 64;
const POLL_MS = 1000;
const REFERENCES_KEY = "fanhao.duplicates.references.v1";
const REVIEWS_KEY = "fanhao.duplicates.reviews.v1";
const GROUP_REVIEWS_KEY = "fanhao.duplicates.group-reviews.v1";
const JOBS_KEY = "fanhao.duplicates.jobs.v1";
const terminal = new Set(["complete", "cancelled", "failed"]);
const fileStates = { pending: "等待校验", hashing: "正在读取完整文件", hashed: "已计算完整 SHA256", size_distinct: "大小不同，无需完整哈希", unavailable: "文件不可用", changed: "校验时文件已变化", same_file: "同一物理文件的路径引用" };
const initialParams = new URLSearchParams(location.search);
const groupCodes = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const groupOrders = new Map([
  ["total", (a, b) => (Number(b.totalBytes) || 0) - (Number(a.totalBytes) || 0)],
  ["extra", (a, b) => (Number(b.potentialExtraBytes) || 0) - (Number(a.potentialExtraBytes) || 0)],
  ["files", (a, b) => b.files.length - a.files.length],
  ["code", (a, b) => groupCodes.compare(a.code || "", b.code || "")]
]);
const reviewFilters = new Set(["all", "open", "unmarked", "kept", "ignored"]);
let groupSort = groupOrders.has(initialParams.get("sort")) ? initialParams.get("sort") : "total";
let reviewFilter = reviewFilters.has(initialParams.get("status")) ? initialParams.get("status") : "all";
let query = initialParams.get("q") || "", offset = 0, total = 0, hasMore = false, loading = false, view = 0, active = true, listRequest = null;
let reviewCursor = initialParams.has("review") ? { groupId: initialParams.get("review"), index: 0 } : null;
let orderedGroups = [];
let catalog = null;
let exportSnapshot = null;
const groups = new Map(), elements = new Map(), comparisons = new Map(), fileLimits = new Map(), jobs = new Map(), busy = new Set(), errors = new Map(), pollErrors = new Map(), previews = new Map(), pollTimers = new Map(), pollRequests = new Map();
const jobCatalogSignatures = new Map();
const legacyReferences = readStored(localStorage, REFERENCES_KEY);
const reviews = readStored(localStorage, REVIEWS_KEY), notes = new Map();
const groupReviews = readStored(localStorage, GROUP_REVIEWS_KEY), folderMenus = new Set();
const savedJobs = readStored(sessionStorage, JOBS_KEY);

function readStored(storage, key) { try { const value = JSON.parse(storage.getItem(key) || "{}"); return value && !Array.isArray(value) && typeof value === "object" ? value : {}; } catch { return {}; } }
function saveStored(storage, key, value) { try { storage.setItem(key, JSON.stringify(value)); } catch { /* Reference choices can still be used in memory. */ } }
function node(tag, text = "", className = "") { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
function button(text, action, key, disabled = false) { const element = node("button", text); element.type = "button"; element.disabled = disabled; if (key) element.dataset.focusKey = key; element.addEventListener("click", action); return element; }
function count(value) { return Math.max(0, Number(value) || 0).toLocaleString("zh-CN"); }
function bytes(value) { let size = Math.max(0, Number(value) || 0), unit = 0; const names = ["B", "KiB", "MiB", "GiB", "TiB"]; while (size >= 1024 && unit < names.length - 1) { size /= 1024; unit++; } return `${size.toLocaleString("zh-CN", { maximumFractionDigits: unit ? 2 : 0 })} ${names[unit]}`; }
function duration(value) { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds <= 0) return "待读取"; const whole = Math.floor(seconds); return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`; }
function modified(value) { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : "时间未知"; }
function key(type, groupId, fileId = "") { return `${type}\u0000${groupId}\u0000${fileId}`; }
function selected(groupId) { if (!comparisons.has(groupId)) comparisons.set(groupId, new Set()); return comparisons.get(groupId); }
function fingerprint(file) { return JSON.stringify([file.path, Number(file.size), file.modifiedAt || ""]); }
function reviewKey(groupId, fileId) { return JSON.stringify([groupId, String(fileId)]); }
function review(groupId, file) { const value = reviews[reviewKey(groupId, file.id)]; return value?.fingerprint === fingerprint(file) ? value.status : ""; }
function groupFingerprint(group) { return JSON.stringify(group.files.map(fingerprint).sort()); }
function isGroupIgnored(group) { const value = groupReviews[group.id]; return value?.ignored === true && value.fingerprint === groupFingerprint(group); }
function matchesReviewFilter(group, ignored = isGroupIgnored(group)) {
  if (reviewFilter === "all") return true;
  if (reviewFilter === "ignored") return ignored;
  if (reviewFilter === "open") return !ignored;
  if (reviewFilter === "unmarked" && ignored) return false;
  const kept = group.files.some(file => review(group.id, file) === "keep");
  return reviewFilter === "kept" ? kept : !kept;
}

function renderAfterDecision(id) {
  const activeControl = elements.get(id)?.contains(document.activeElement) ? document.activeElement : null;
  const wasReviewing = reviewCursor && groups.has(id);
  const oldPosition = activeControl ? [...elements.keys()].indexOf(id) : 0;
  renderPage();
  if (reviewCursor && wasReviewing) { revealReviewGroup(); return; }
  if (!activeControl) return;
  const replacement = [...(elements.get(id)?.querySelectorAll("[data-focus-key]") || [])]
    .find(control => control.dataset.focusKey === activeControl.dataset.focusKey && !control.disabled);
  const next = $("groups").children[Math.min(oldPosition, elements.size - 1)];
  const heading = (elements.get(id) || next)?.querySelector("h2");
  if (!replacement && heading) heading.tabIndex = -1;
  (replacement || heading || $("reviewFilter")).focus({ preventScroll: Boolean(replacement) });
}

function nextPendingReviewGroup() {
  if (!reviewCursor) return null;
  const { index } = reviewCursor;
  return orderedGroups.slice(index + 1).find(item => !isGroupIgnored(item))
    || orderedGroups.slice(0, index).findLast(item => !isGroupIgnored(item));
}
function ignoreGroup(group) {
  const ignored = !isGroupIgnored(group);
  const next = ignored && reviewCursor?.groupId === group.id ? nextPendingReviewGroup() : null;
  groupReviews[group.id] = { ignored, fingerprint: groupFingerprint(group) };
  try { localStorage.setItem(GROUP_REVIEWS_KEY, JSON.stringify(groupReviews)); notes.set(group.id, ignored ? "已忽略本组，可在「已忽略」中恢复。" : "已恢复本组比对。"); }
  catch { notes.set(group.id, "浏览器未能保存选择，本次页面内仍然有效。"); }
  if (next) reviewCursor.groupId = next.id;
  renderAfterDecision(group.id);
  $("status").textContent = notes.get(group.id);
}
function groupFolders(group) {
  const folders = new Map();
  for (const file of group.files) {
    const value = String(file.path || ""), index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    if (index < 0) continue;
    const directory = value.slice(0, index + (index === 0 || index === 2 && /^[a-z]:/i.test(value) ? 1 : 0));
    const windows = /^[a-z]:|^\\\\/i.test(directory);
    let identity = directory.replaceAll("\\", "/").replace(/\/+$/g, "");
    if (windows) identity = identity.replace(/\/+/g, "/").toLowerCase();
    if (!folders.has(identity)) folders.set(identity, { path: directory, identity, count: 0 });
    folders.get(identity).count++;
  }
  return [...folders.values()];
}
function reviewFile(group, file, status) {
  const id = reviewKey(group.id, file.id);
  reviews[id] = { status: review(group.id, file) === status ? "" : status, fingerprint: fingerprint(file) };
  if (status === "ignore") selected(group.id).delete(String(file.id));
  try { localStorage.setItem(REVIEWS_KEY, JSON.stringify(reviews)); notes.set(group.id, "选择已保存在本浏览器；可以随时取消或恢复。"); }
  catch { notes.set(group.id, "浏览器未能保存选择，本次页面内仍然有效。"); }
  if (matchesReviewFilter(group)) renderGroup(group.id);
  else {
    renderAfterDecision(group.id);
    if (notes.has(group.id)) $("status").textContent = notes.get(group.id);
  }
}
function participating(groupId) { const group = groups.get(groupId); return !group || isGroupIgnored(group) ? [] : group.files.filter(file => review(groupId, file) !== "ignore"); }
function isRunning(job) { return Boolean(job?.id && !terminal.has(job.status)); }
function chip(text, type = "") { return node("span", text, `chip${type ? ` ${type}` : ""}`); }
function operationBody(groupId) {
  const chosen = selected(groupId), files = participating(groupId);
  const fileIds = files.filter((file) => chosen.has(String(file.id))).map((file) => String(file.id));
  return { groupId, ...(fileIds.length === 2 ? { fileIds } : files.length !== groups.get(groupId)?.files.length ? { fileIds: files.map(file => String(file.id)) } : {}) };
}
function requiresSelection(groupId) { return participating(groupId).length > WHOLE_GROUP_LIMIT && selected(groupId).size !== 2; }
function cannotCompare(groupId) { return participating(groupId).length < 2 || requiresSelection(groupId); }

function verifiedMatches(group, job) {
  if (job?.status !== "complete") return [];
  const states = new Map((job.files || []).map((file) => [String(file.id), file]));
  const ids = new Set(group.files.map((file) => String(file.id)));
  return (job.matches || []).filter((match) => {
    const members = [...new Set((match.fileIds || []).map(String))];
    if (members.length < 2 || members.some((id) => !ids.has(id))) return false;
    const hashes = members.map((id) => states.get(id));
    return hashes.every((file) => file?.status === "hashed" && /^[a-f0-9]{64}$/i.test(file.sha256 || ""))
      && new Set(hashes.map((file) => file.sha256.toLowerCase())).size === 1;
  });
}

function exportEvidence(group) {
  const job = jobs.get(group.id), accepted = jobCatalogSignatures.get(group.id);
  if (!job || accepted?.jobId !== job.id || accepted.signature !== groupFingerprint(group)) return null;
  const available = new Set(group.files.filter((file) => !file.availabilityError
    && (!file.availabilityStatus || file.availabilityStatus === "available")).map((file) => String(file.id)));
  const matches = new Map();
  for (const [index, match] of verifiedMatches(group, job).entries()) {
    if (match.fileIds.every((id) => available.has(String(id)))) {
      for (const id of match.fileIds) matches.set(String(id), index + 1);
    }
  }
  return { matches, finishedAt: job.finishedAt || "" };
}

function openReviewExport() {
  if (loading || !total || catalog?.query !== query || !$("retry").hidden) return;
  exportSnapshot = snapshotDuplicateReviews(orderedGroups, {
    isIgnored: isGroupIgnored, getMark: review, getEvidence: exportEvidence
  });
  const { groupCount, rows } = exportSnapshot;
  $("reviewExportSummary").textContent = groupCount
    ? `当前筛选的所有页包含 ${count(groupCount)} 个已标记组、${count(rows.length)} 份文件。`
    : "当前筛选没有已标记的组。可以先标记保留或忽略，再导出清单。";
  $("reviewExportPaths").checked = false;
  $("reviewExportPaths").disabled = $("downloadReviewExport").disabled = !rows.length;
  $("reviewExport").showModal();
}

function renderSummary(summary = {}) {
  const values = [["索引视频文件", count(summary.indexedFiles), "已排除 VR 作品"], ["疑似重复组", count(summary.candidateGroups), "同番号、同分卷候选"], ["候选文件", count(summary.candidateFiles), "版本与内容仍需比较"], ["潜在额外体积", bytes(summary.potentialExtraBytes), "并非确认可回收空间"]];
  $("summary").replaceChildren(...values.map(([label, value, detail]) => { const card = node("article", "", "stat"); card.append(node("span", label), node("strong", value), node("small", detail)); return card; }));
  $("summary").hidden = false;
}

function fileCard(group, file, matched) {
  const id = String(file.id), comparison = selected(group.id), comparing = comparison.has(id), status = review(group.id, file), reference = status === "keep", ignored = status === "ignore";
  const card = node("article", "", `file-card${comparing ? " comparing" : ""}${reference ? " reference" : ""}${ignored ? " ignored" : ""}`);
  card.dataset.fileId = id;
  const identity = node("div", "", "file-identity"), icon = node("span", "▤", "file-icon"); icon.setAttribute("aria-hidden", "true"); identity.append(icon, node("h3", file.name || "未命名文件"));
  const badges = node("div", "", "file-badges");
  if (file.isLargest) badges.append(chip("体积最大"));
  if (file.isLongest) badges.append(chip("时长最长"));
  if (file.codeSource === "metadata") badges.append(chip("番号来自作品资料"));
  if (reference) badges.append(chip("已标记保留", "kept"));
  if (ignored) badges.append(chip("已忽略比对"));
  if (file.availabilityError) badges.append(chip("文件状态待确认", "warning"));
  for (const label of file.editionLabels || []) badges.append(chip(String(label)));
  const match = matched.findIndex((item) => item.fileIds.map(String).includes(id));
  if (match >= 0) badges.append(chip(`本次校验内容一致 · ${match + 1}`, "verified"));
  const path = node("code", file.path || "路径未提供", "file-path");
  const facts = node("dl", "", "file-facts");
  for (const [label, value, wide] of [["文件体积", bytes(file.size)], ["时长", duration(file.duration)], ["清晰度", file.resolutionLabel || "待读取"], ["分卷", group.partLabel || "未标分卷"], ["修改时间", modified(file.modifiedAt), true]]) { const cell = node("div", "", wide ? "wide" : ""); cell.append(node("dt", label), node("dd", value)); facts.append(cell); }
  card.append(identity); if (badges.childElementCount) card.append(badges); card.append(path, facts);
  if (file.availabilityError) card.append(node("p", file.availabilityError, "file-hash-state"));
  const jobState = jobs.get(group.id)?.files?.find((item) => String(item.id) === id);
  if (jobState) {
    const state = node("div", "", "file-hash-state"); state.append(node("span", fileStates[jobState.status] || "状态待确认"));
    if (jobState.status === "same_file" && jobState.sameAs) state.append(node("p", `对应文件 ${jobState.sameAs}，不计为可回收副本。`));
    if (jobState.error) state.append(node("p", String(jobState.error)));
    if (/^[a-f0-9]{64}$/i.test(jobState.sha256 || "")) { const detail = node("details"); detail.append(node("summary", "查看 SHA256"), node("code", jobState.sha256)); state.append(detail); }
    card.append(state);
  }
  const controls = node("div", "", "file-controls");
  const compare = button(comparing ? "取消重点对比" : "加入重点对比", () => { if (comparison.has(id)) comparison.delete(id); else if (comparison.size < 2) comparison.add(id); renderGroup(group.id); }, key("compare", group.id, id), ignored || !comparing && comparison.size >= 2);
  compare.setAttribute("aria-pressed", String(comparing));
  const chooseReference = button(reference ? "取消保留" : "保留", () => reviewFile(group, file, "keep"), key("reference", group.id, id)); chooseReference.setAttribute("aria-pressed", String(reference));
  const preparing = busy.has(key("preview", group.id, id));
  controls.append(chooseReference, compare, button(preparing ? "准备预览…" : "播放预览", () => previewFile(group, file), key("preview", group.id, id), preparing));
  if (ignored) controls.append(button("恢复旧版文件标记", () => reviewFile(group, file, "ignore"), key("ignore", group.id, id)));
  const resolved = previews.get(key("preview", group.id, id));
  if (resolved) { const link = node("a", "点击打开已准备的预览", "preview-link"); link.href = resolved; link.target = "_blank"; link.rel = "noopener noreferrer"; controls.append(link); }
  card.append(controls); return card;
}

function hashPanel(group, job, matches) {
  const panel = node("section", "", "hash-panel"); panel.setAttribute("aria-label", "文件内容校验");
  const heading = node("div", "", "hash-heading");
  let label = job.cancelRequested && isRunning(job) ? "正在取消，等待当前读取块结束…" : ({ running: "正在读取文件并计算 SHA256", complete: "本次校验已完成", cancelled: "校验已取消", failed: "校验失败" }[job.status] || "校验状态待确认");
  if (matches.length) label += ` · ${matches.length} 组内容一致`;
  heading.append(node("strong", label));
  if (isRunning(job)) heading.append(button(job.cancelRequested ? "取消中…" : busy.has(key("cancel", group.id)) ? "提交取消…" : "取消校验", () => cancelJob(group.id), key("cancel", group.id), Boolean(job.cancelRequested || busy.has(key("cancel", group.id)))));
  const progress = node("progress"); const whole = Math.max(0, Number(job.totalBytes) || 0), read = Math.max(0, Number(job.progressBytes) || 0); progress.max = Math.max(whole, 1); progress.value = Math.min(whole || 1, read); progress.setAttribute("aria-label", "文件内容校验进度");
  const scope = (job.files || []).length;
  let detail = `本次范围 ${scope} / ${group.files.length} 份${scope < group.files.length ? "，其余文件未纳入本次校验" : ""}。 `;
  detail += whole ? `${bytes(Math.min(read, whole))} / ${bytes(whole)} · ${Math.min(100, Math.round(read / whole * 100))}%` : "当前没有需要完整哈希的读取字节。";
  if (job.status === "complete" && !matches.length) detail += " 未确认内容一致；请查看各文件状态。";
  if (job.status === "cancelled") detail += " 未完成的文件仍待校验。";
  if (job.error) detail += ` ${job.error}`;
  panel.append(heading, progress, node("p", detail, "hash-detail"));
  const pollError = pollErrors.get(group.id);
  if (pollError) { const warning = node("div", "", "group-error"); warning.append(node("span", `进度读取失败：${pollError}`), button("重试读取进度", () => pollJob(group.id, job.id, view), key("poll-retry", group.id))); panel.append(warning); }
  return panel;
}

function renderGroup(id) {
  const group = groups.get(id); if (!group) return;
  const previous = elements.get(id), focused = previous?.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  const job = jobs.get(id), matches = verifiedMatches(group, job), comparison = selected(id);
  const valid = new Set(group.files.map((file) => String(file.id))); for (const chosen of comparison) if (!valid.has(chosen)) comparison.delete(chosen);
  const ignored = isGroupIgnored(group), folders = groupFolders(group), opening = folders.some(folder => busy.has(key("folder", id, folder.identity)));
  const needsPair = requiresSelection(id), tooFew = participating(id).length < 2;
  const article = node("article", "", `duplicate-group${ignored ? " group-ignored" : ""}`); article.dataset.groupId = id;
  const header = node("header", "", "group-header"), heading = node("div", "", "group-heading"), code = node("div", "", "group-code-row");
  const groupTitle = node("h2", group.code || "未识别番号");
  if (reviewCursor) { groupTitle.tabIndex = -1; groupTitle.dataset.focusKey = key("heading", id); }
  code.append(groupTitle, chip(group.partLabel || "未标分卷"), chip(ignored ? "已忽略本组" : matches.length ? "本次校验内容一致" : "疑似重复", ignored ? "" : matches.length ? "verified" : "warning"));
  heading.append(code, node("p", group.title || "比较文件版本与媒体参数", "group-title"));
  const actions = node("div", "", "group-actions");
  const folderButton = button(opening ? "正在打开…" : "打开文件夹", () => {
    if (folders.length === 1) openFolder(group, folders[0]);
    else { if (folderMenus.has(id)) folderMenus.delete(id); else folderMenus.add(id); renderGroup(id); }
  }, key("folders", id), opening || !folders.length);
  if (folders.length > 1) { folderButton.setAttribute("aria-expanded", String(folderMenus.has(id))); folderButton.title = `本组分布在 ${folders.length} 个文件夹`; }
  const ignoreLabel = ignored ? "恢复本组比对" : nextPendingReviewGroup() ? "忽略并继续" : "忽略本组";
  actions.append(folderButton, button(ignoreLabel, () => ignoreGroup(group), key("ignore-group", id)));
  actions.append(button(busy.has(key("recheck", id)) ? "正在检查…" : "检查文件是否还在", () => recheckGroup(id), key("recheck", id), busy.has(key("recheck", id))), button(busy.has(key("probe", id)) ? "正在读取…" : "读取媒体参数", () => probeGroup(id), key("probe", id), busy.has(key("probe", id)) || needsPair || tooFew), button(busy.has(key("check", id)) ? "启动校验…" : job && !isRunning(job) ? "重新校验文件内容" : "校验文件内容", () => startJob(id), key("check", id), busy.has(key("check", id)) || isRunning(job) || needsPair || tooFew));
  header.append(heading, actions);
  const context = node("div", "", "group-context"); context.append(node("span", `${count(group.files.length)} 份文件 · 合计 ${bytes(group.totalBytes)}`), node("span", `潜在额外体积 ${bytes(group.potentialExtraBytes)}，尚未确认可回收`), node("span", group.evidence === "same_code_part" ? "候选依据：同番号、同分卷" : "候选依据待确认"));
  const compareBar = node("div", "", "compare-actions"); compareBar.append(node("span", `重点对比 ${comparison.size} / 2`), node("span", tooFew ? "参与比对的文件不足两份；可恢复已忽略文件" : comparison.size === 2 ? "已选两份，媒体参数与内容校验仅处理所选文件" : needsPair ? "此组超过 64 份，请先选择两份再读取参数或校验" : "未选两份时处理本组未忽略文件", needsPair ? "compare-message" : ""));
  if (comparison.size) compareBar.append(button("清除对比", () => { comparison.clear(); renderGroup(id); }, key("clear-compare", id)));
  const ordered = [...group.files.filter((file) => comparison.has(String(file.id))), ...group.files.filter((file) => !comparison.has(String(file.id)))];
  const visibleLimit = Math.max(FILE_BATCH_SIZE, fileLimits.get(id) || FILE_BATCH_SIZE), visible = ordered.slice(0, visibleLimit);
  const files = node("div", "", "file-comparison"); files.setAttribute("role", "group"); files.setAttribute("aria-label", `${group.code || "候选"}文件并排比较，可横向滚动`); for (const file of visible) files.append(fileCard(group, file, matches));
  article.append(header, context);
  if (folderMenus.has(id) && folders.length > 1) {
    const picker = node("section", "", "folder-picker"); picker.setAttribute("aria-label", "本组文件夹");
    picker.append(node("p", `本组分布在 ${folders.length} 个文件夹，选择要打开的目录：`));
    for (const folder of folders) {
      const row = node("div", "", "folder-choice"), pending = busy.has(key("folder", id, folder.identity));
      row.append(node("code", folder.path), node("span", `${folder.count} 份文件`), button(pending ? "正在打开…" : "打开此文件夹", () => openFolder(group, folder), key("folder-choice", id, folder.identity), pending)); picker.append(row);
    }
    article.append(picker);
  }
  if (!ignored) article.append(compareBar, files);
  if (!ignored && visible.length < group.files.length) {
    const more = node("div", "", "expand-files");
    more.append(node("span", `已显示 ${visible.length} / ${group.files.length} 份`), button(`展开其余 ${group.files.length - visible.length} 份`, () => { fileLimits.set(id, visibleLimit + FILE_BATCH_SIZE); renderGroup(id); }, key("more-files", id)), node("span", "每次显示 6 份；所选文件按原顺序置前"));
    article.append(more);
  }
  if (job) article.append(hashPanel(group, job, matches));
  if (notes.has(id)) { const message = node("p", notes.get(id), "group-note"); message.setAttribute("role", "status"); article.append(message); }
  if (errors.has(id)) article.append(node("p", errors.get(id), "group-error"));
  if (previous?.isConnected) previous.replaceWith(article); else $("groups").append(article);
  elements.set(id, article);
  if (focused) [...article.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focused && !element.disabled)?.focus({ preventScroll: true });
}

async function action(groupId, actionKey, task) {
  if (busy.has(actionKey)) return;
  busy.add(actionKey); errors.delete(groupId); notes.delete(groupId); renderGroup(groupId);
  try { await task(); }
  catch (error) { errors.set(groupId, error.message || "操作失败，请重试。"); }
  finally { busy.delete(actionKey); if (active) renderGroup(groupId); }
}

function previewFile(group, file) {
  const actionKey = key("preview", group.id, String(file.id)); if (busy.has(actionKey)) return;
  const popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
  return action(group.id, actionKey, async () => {
    try {
      const result = await api("/api/fanhao/duplicates/resolve", { method: "POST", body: { groupId: group.id, fileId: String(file.id) } });
      const url = new URL(result.url, location.origin);
      if (url.origin !== location.origin || url.pathname !== "/player.html") throw new Error("预览地址无效，请重新读取索引后重试。");
      previews.set(actionKey, url.href);
      if (popup && !popup.closed) popup.location.replace(url.href);
    } catch (error) { popup?.close(); throw error; }
  });
}
function openFolder(group, folder) {
  return action(group.id, key("folder", group.id, folder.identity), async () => {
    await api("/api/open-folder", { method: "POST", body: { sourcePath: folder.path } });
    notes.set(group.id, "已请求在运行 FanHao 的电脑上打开所在文件夹。手动删除后，点“检查文件是否还在”。");
  });
}
function recheckGroup(id) { return action(id, key("recheck", id), async () => {
  const result = await api("/api/fanhao/duplicates/recheck", { method: "POST", body: { groupId: id } });
  if (String(result.group?.id) !== id) throw new Error("文件检查结果无效，请重试。");
  const removed = result.missingFileIds?.length || 0, unknown = result.warnings?.length || 0;
  notes.set(id, `检查完成：${removed ? `已移除 ${removed} 份确认不存在的文件。` : "未发现已删除的文件。"}${result.cleanup ? `已清理 ${result.cleanup.removedFileIds.length} 条失效文件索引、${result.cleanup.removedLocalWorkIds.length} 条目录索引。` : ""}${unknown ? `有 ${unknown} 项无法确认，请检查磁盘或索引状态。` : ""}${result.group.files.length < 2 ? "本组已不足两份，不再属于重复候选；重新读取索引后将移出列表。" : ""}`);
  const visible = groups.has(id);
  updateGroup(result.group);
  if (active && visible && !groups.has(id)) $("status").textContent = notes.get(id);
}); }
function probeGroup(id) { if (cannotCompare(id)) return; return action(id, key("probe", id), async () => { const result = await api("/api/fanhao/duplicates/probe", { method: "POST", body: operationBody(id) }); if (!result.group || String(result.group.id) !== id) throw new Error("媒体参数结果无效，请重试。"); updateGroup(result.group); }); }
function acceptJob(groupId, job, signature) {
  if (!job?.id) throw new Error("未取得校验任务，请重试。");
  const previous = jobs.get(groupId);
  if (previous?.id === job.id) {
    if (terminal.has(previous.status) && isRunning(job)) return;
    if (previous.cancelRequested && isRunning(job)) job = { ...job, cancelRequested: true };
  }
  jobs.set(groupId, job); savedJobs[groupId] = String(job.id); saveStored(sessionStorage, JOBS_KEY, savedJobs); pollErrors.delete(groupId);
  const group = groups.get(groupId) || catalog?.groups.find((item) => item.id === groupId);
  if (job.status === "complete" && group && signature === groupFingerprint(group)) jobCatalogSignatures.set(groupId, { jobId: job.id, signature });
  else jobCatalogSignatures.delete(groupId);
  if (active && groups.has(groupId)) { renderGroup(groupId); if (isRunning(job)) schedulePoll(groupId, job.id, view); }
}
function startJob(id) { if (isRunning(jobs.get(id)) || cannotCompare(id)) return; return action(id, key("check", id), async () => { const signature = groupFingerprint(groups.get(id)); const result = await api("/api/fanhao/duplicates/check", { method: "POST", body: operationBody(id) }); acceptJob(id, result.job, signature); }); }
function cancelJob(id) { const job = jobs.get(id); if (!isRunning(job) || job.cancelRequested) return; return action(id, key("cancel", id), async () => { const signature = groupFingerprint(groups.get(id)); const result = await api(`/api/fanhao/duplicates/checks/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }); acceptJob(id, result.job, signature); }); }
function schedulePoll(groupId, jobId, version) { clearTimeout(pollTimers.get(groupId)); if (active && version === view && groups.has(groupId)) pollTimers.set(groupId, setTimeout(() => pollJob(groupId, jobId, version), POLL_MS)); }
async function pollJob(groupId, jobId, version) {
  if (!active || view !== version || !groups.has(groupId)) return;
  clearTimeout(pollTimers.get(groupId)); pollRequests.get(groupId)?.abort();
  const request = new AbortController(); pollRequests.set(groupId, request);
  const signature = groupFingerprint(groups.get(groupId));
  try {
    const result = await api(`/api/fanhao/duplicates/checks/${encodeURIComponent(jobId)}`, { signal: request.signal });
    if (request.signal.aborted || view !== version || !active) return;
    acceptJob(groupId, result.job, signature);
  } catch (error) {
    if (request.signal.aborted || view !== version || !active) return;
    pollErrors.set(groupId, error.message || "请重试"); renderGroup(groupId);
    if (error.status === 404) { delete savedJobs[groupId]; saveStored(sessionStorage, JOBS_KEY, savedJobs); jobs.delete(groupId); jobCatalogSignatures.delete(groupId); errors.set(groupId, "校验任务已失效，可以重新发起校验。"); renderGroup(groupId); }
  } finally { if (pollRequests.get(groupId) === request) pollRequests.delete(groupId); }
}
function stopPolling() { for (const timer of pollTimers.values()) clearTimeout(timer); pollTimers.clear(); for (const request of pollRequests.values()) request.abort(); pollRequests.clear(); }

function updateGroup(group) {
  if (groups.has(group.id)) groups.set(group.id, group);
  const index = catalog?.groups.findIndex(item => item.id === group.id) ?? -1;
  if (index < 0) return;
  const previous = catalog.groups[index];
  catalog.groups[index] = group;
  if (!active || loading || !$("retry").hidden || catalog.query !== query) return;
  const shown = matchesReviewFilter(group), wasShown = matchesReviewFilter(previous);
  if (shown !== wasShown || shown && (isGroupIgnored(group) !== isGroupIgnored(previous) || groupOrders.get(groupSort)(group, previous) !== 0)) {
    renderAfterDecision(group.id);
  }
}
async function readCatalog(request, force) {
  const search = query;
  if (!force && catalog?.query === search && Date.now() - catalog.at < INDEX_CACHE_MS) return catalog;
  const readPage = start => api(`/api/fanhao/duplicates?${new URLSearchParams({ q: search, offset: String(start), limit: String(INDEX_BATCH_SIZE), ...(force && start === 0 ? { refresh: "1" } : {}) })}`, { signal: request.signal });
  const first = await readPage(0), pages = [first];
  const count = Math.max(0, Number(first.total) || 0);
  // Load only indexed metadata, in bounded batches, so browser-local review
  // choices can be sorted across the entire result before UI pagination.
  for (let start = INDEX_BATCH_SIZE; start < count; start += INDEX_BATCH_SIZE * 4) {
    const offsets = Array.from({ length: 4 }, (_, index) => start + index * INDEX_BATCH_SIZE).filter(value => value < count);
    pages.push(...await Promise.all(offsets.map(readPage)));
  }
  const unique = new Map();
  for (const page of pages) for (const group of page.groups || []) {
    const id = String(group.id); if (!unique.has(id)) unique.set(id, { ...group, id, files: group.files || [] });
  }
  return { query: search, at: Date.now(), summary: first.summary, groups: [...unique.values()] };
}
function renderPage() {
  if (!catalog) return;
  stopPolling(); groups.clear(); elements.clear(); $("groups").replaceChildren();
  const compare = groupOrders.get(groupSort);
  orderedGroups = catalog.groups.map(group => ({ group, ignored: isGroupIgnored(group) }))
    .filter(({ group, ignored }) => matchesReviewFilter(group, ignored))
    .sort((a, b) => Number(a.ignored) - Number(b.ignored) || compare(a.group, b.group))
    .map(({ group }) => group);
  total = orderedGroups.length;
  if (!total) reviewCursor = null;
  if (reviewCursor) {
    const savedIndex = orderedGroups.findIndex(group => group.id === reviewCursor.groupId);
    reviewCursor.index = savedIndex < 0 ? Math.min(reviewCursor.index, Math.max(0, total - 1)) : savedIndex;
    const group = orderedGroups[reviewCursor.index];
    reviewCursor.groupId = group?.id || "";
    offset = Math.floor(reviewCursor.index / PAGE_SIZE) * PAGE_SIZE;
  }
  syncBrowseAddress();
  offset = Math.min(offset, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE);
  hasMore = offset + PAGE_SIZE < total;
  const visible = reviewCursor ? orderedGroups.slice(reviewCursor.index, reviewCursor.index + 1)
    : orderedGroups.slice(offset, offset + PAGE_SIZE);
  for (const group of visible) {
    const id = group.id; groups.set(id, group);
    renderGroup(id);
  }
  $("status").textContent = groups.size ? "" : catalog.groups.length ? "没有符合当前标记筛选的候选组。" : query ? "没有匹配的候选组，试试其他番号或文件名。" : "当前索引没有同番号、同分卷的候选文件组。";
  $("status").classList.remove("error");
  $("status").classList.toggle("empty", !groups.size);
  $("resultCount").textContent = `共 ${count(total)} 组${reviewFilter !== "all" ? ` · 搜索匹配 ${count(catalog.groups.length)} 组` : ""}${groups.size && !reviewCursor ? ` · 当前 ${count(offset + 1)}–${count(offset + groups.size)} 组` : ""}`;
  updatePaging();
  for (const id of groups.keys()) { const job = jobs.get(id); if (isRunning(job)) schedulePoll(id, job.id, view); else if (!job && typeof savedJobs[id] === "string") pollJob(id, savedJobs[id], view); }
}
function syncBrowseAddress() {
  const url = new URL(location.href);
  if (reviewCursor) url.searchParams.set("review", reviewCursor.groupId);
  else url.searchParams.delete("review");
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  if (reviewFilter !== "all") url.searchParams.set("status", reviewFilter);
  else url.searchParams.delete("status");
  if (groupSort !== "total") url.searchParams.set("sort", groupSort);
  else url.searchParams.delete("sort");
  if (url.href !== location.href) history.replaceState(history.state, "", url);
}
function revealReviewGroup() {
  $("results").scrollIntoView({ block: "start", behavior: "instant" });
  $("groups").querySelector("h2")?.focus({ preventScroll: true });
}
function toggleReview() {
  if (loading || !reviewCursor && !total) return;
  if (reviewCursor) {
    const groupId = reviewCursor.groupId;
    reviewCursor = null;
    syncBrowseAddress();
    if (catalog?.query === query && total) renderPage();
    else updatePaging();
    const heading = elements.get(groupId)?.querySelector("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    } else $("reviewToggle").focus();
    return;
  }
  reviewCursor = { groupId: orderedGroups[offset].id, index: offset };
  renderPage();
  revealReviewGroup();
}
function stepReview(step) {
  if (!reviewCursor || loading) return false;
  const next = orderedGroups[reviewCursor.index + step];
  if (!next) return false;
  reviewCursor.groupId = next.id;
  renderPage();
  revealReviewGroup();
  return true;
}
function setSearch(value) {
  query = value;
  offset = 0;
  if (reviewCursor) reviewCursor = { groupId: "", index: 0 };
  syncBrowseAddress();
  load();
}
function migrateLegacyKeeps(groups) {
  let changed = false;
  for (const group of groups) {
    const oldId = legacyReferences[group.id];
    if (typeof oldId !== "string") continue;
    const id = reviewKey(group.id, oldId);
    if (reviews[id]) continue;
    const file = group.files.find(item => String(item.id) === oldId);
    if (!file) continue;
    reviews[id] = { status: "keep", fingerprint: fingerprint(file) };
    changed = true;
  }
  if (changed) saveStored(localStorage, REVIEWS_KEY, reviews);
}
async function load({ force = false } = {}) {
  if ($("reviewExport").open) $("reviewExport").close();
  listRequest?.abort(); stopPolling(); const version = ++view, request = new AbortController(); listRequest = request; loading = true;
  groups.clear(); elements.clear(); $("groups").replaceChildren(); $("summary").hidden = true; $("retry").hidden = true;
  $("status").className = "notice"; $("status").textContent = "正在读取索引中的候选文件组…"; $("resultCount").textContent = "正在读取候选…";
  updatePaging(); $("refresh").disabled = true; $("search").disabled = true;
  try {
    const result = await readCatalog(request, force);
    if (request.signal.aborted || version !== view || !active) return;
    catalog = result; migrateLegacyKeeps(result.groups); renderSummary(result.summary); renderPage();
  } catch (error) {
    if (request.signal.aborted || version !== view || !active) return;
    total = 0; hasMore = false; $("status").textContent = error.message || "候选读取失败，请重试。"; $("status").classList.add("error"); $("retry").hidden = false; $("resultCount").textContent = "候选读取失败";
  } finally { if (version === view) { loading = false; $("refresh").disabled = false; $("search").disabled = false; updatePaging(); } }
}
function updatePaging() {
  $("reviewFilter").disabled = loading;
  $("groupSort").disabled = loading;
  $("listPaging").hidden = Boolean(reviewCursor);
  $("previous").disabled = loading || offset === 0;
  $("next").disabled = loading || !hasMore;
  $("pageLabel").textContent = total ? `第 ${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页` : "";
  $("reviewToggle").disabled = loading || !reviewCursor && !total;
  $("openReviewExport").disabled = loading || !total || !$("retry").hidden;
  $("reviewToggle").setAttribute("aria-pressed", String(Boolean(reviewCursor)));
  $("reviewNavigation").hidden = !reviewCursor || !total || loading;
  $("reviewPrevious").disabled = loading || !reviewCursor || reviewCursor.index <= 0;
  $("reviewNext").disabled = loading || !reviewCursor || reviewCursor.index + 1 >= total;
  $("reviewPosition").textContent = reviewCursor && total ? `第 ${count(reviewCursor.index + 1)} / ${count(total)} 组` : "";
}
$("query").value = query;
$("reviewFilter").value = reviewFilter;
$("groupSort").value = groupSort;
for (const [id, apply] of [["reviewFilter", value => { reviewFilter = value; }], ["groupSort", value => { groupSort = value; }]]) {
  $(id).addEventListener("change", () => {
    if (loading) return;
    apply($(id).value);
    offset = 0;
    if (catalog?.query === query && $("retry").hidden) renderPage();
    else syncBrowseAddress();
  });
}
$("searchForm").addEventListener("submit", (event) => { event.preventDefault(); setSearch($("query").value.trim()); });
$("clear").addEventListener("click", () => { $("query").value = ""; setSearch(""); });
$("reviewToggle").addEventListener("click", toggleReview);
$("reviewExit").addEventListener("click", toggleReview);
$("reviewPrevious").addEventListener("click", () => stepReview(-1));
$("reviewNext").addEventListener("click", () => stepReview(1));
$("openReviewExport").addEventListener("click", openReviewExport);
$("reviewExport").addEventListener("close", () => { if (!$("reviewExport").open) exportSnapshot = null; });
$("downloadReviewExport").addEventListener("click", () => {
  if (!$("reviewExport").open || !exportSnapshot?.rows.length) return;
  downloadDuplicateReviews(exportSnapshot.rows, $("reviewExportPaths").checked);
  $("reviewExport").close();
});
document.addEventListener("keydown", (event) => {
  if (!reviewCursor || $("reviewExport").open || event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || event.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const step = event.key === "j" ? 1 : event.key === "k" ? -1 : 0;
  if (step && stepReview(step)) event.preventDefault();
});
$("refresh").addEventListener("click", () => load({ force: true })); $("retry").addEventListener("click", () => load({ force: true }));
$("cleanup").addEventListener("click", async () => {
  if ($("cleanup").disabled || loading) return;
  $("cleanup").disabled = true; $("cleanup").textContent = "正在检查并清理…";
  try {
    const result = await api("/api/fanhao/duplicates/cleanup", { method: "POST", body: { q: query } });
    await load({ force: true });
    $("status").textContent = `已清理 ${count(result.removedFileIds.length)} 条失效文件索引、${count(result.removedLocalWorkIds.length)} 条目录索引。作品资料、收藏和观看记录保留。${result.uncertainFiles ? ` ${count(result.uncertainFiles)} 份文件状态无法确认，已保留。` : ""}${result.warnings?.length ? ` ${result.warnings.map(warning => warning.error).join(" ")}` : ""}`;
  } catch (error) { $("status").textContent = error.message || "索引清理失败，请重试。"; $("status").classList.add("error"); }
  finally { $("cleanup").disabled = false; $("cleanup").textContent = "清理失效索引"; }
});
$("previous").addEventListener("click", () => { if (loading || offset <= 0) return; offset = Math.max(0, offset - PAGE_SIZE); renderPage(); });
$("next").addEventListener("click", () => { if (loading || !hasMore) return; offset += PAGE_SIZE; renderPage(); });
window.addEventListener("pagehide", () => { active = false; listRequest?.abort(); stopPolling(); if ($("reviewExport").open) $("reviewExport").close(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) { active = true; load(); } });
load({ force: true });
