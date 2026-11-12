import { createIntakeLibrarySearch } from "./intake-library-search.js?v=2";
import { intakeDraftJobOwns, intakeDraftPathKey, mergeIntakeQueueDraft, readIntakeQueueDraft, restoreIntakeQueueDraft, saveIntakeQueueDraft } from "./intake-queue-draft.js?v=1";

const prefix = "/api/fanhao/file-workflows/intake/";
const videoExtension = /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|webm|mpg|mpeg)$/i;
const $ = (id) => document.getElementById(id);
const queue = new Map();
const dedicatedSubtitle = new URLSearchParams(location.search).get("mode") === "subtitle";
let queueDraft = dedicatedSubtitle ? { entries: [], selected: "" } : readIntakeQueueDraft();
let draftRestore = null;
let draftFailures = [];
const draftSubmitting = new Map();
const librarySearch = createIntakeLibrarySearch({ section: $("librarySearch"), form: $("librarySearchForm"),
  status: $("librarySearchStatus"), results: $("librarySearchResults"), selectVideo: selectLibrarySubtitleVideo,
  catalog: dedicatedSubtitle ? { tools: $("libraryBrowseTools"), sort: $("librarySort"), cardSize: $("libraryCardSize"),
    excludeChinese: $("excludeChineseSubtitles"), excludeVr: $("excludeLibraryVr"), onlyMarkedA: $("libraryOnlyMarkedA"), showFiles: showLibraryFiles,
    onlyUnreviewed: $("libraryOnlyUnreviewed"), onReviewChanged: renderSubtitleReviewMark,
    more: $("libraryLoadMore"), loadStatus: $("libraryLoadStatus"), retry: $("retryLibraryLoad"),
    resume: $("resumeLibraryBrowse"), restart: $("restartLibraryBrowse"), resumeTools: $("libraryResumeTools"), resumeStatus: $("libraryResumeStatus"),
    people: { input: $("libraryPeopleQuery"), status: $("libraryPeopleStatus"), list: $("libraryPeopleList"), retry: $("retryLibraryPeople") } } : null });
const actionLabels = { replace: "替换馆藏视频", keep: "两份都保留", new: "新番号入库", discard: "丢弃源视频", discardBoth: "两份都删除", discardLibraryVideo: "删除此文件", mark: "馆藏标记重命名" };
const actionLabel = (job) => job.action === "discard" && job.package ? "丢弃整个文件夹" : actionLabels[job.action];
const isDiscard = (action) => action === "discard" || action === "discardBoth" || action === "discardLibraryVideo";
const markFields = [["markLtx", "ltx", "ltx"], ["markU", "u", "uncensored"], ["markC", "c", "subtitled"]];
const stateLabels = { prepared: "待确认", queued: "排队中", working: "迁移中", committed: "已入库 · 待收尾", interrupted: "执行中断", completed: "已完成", blocked: "待处理" };
const phaseLabels = { prepare: "准备", copy: "传输文件", verify: "校验", publish: "写入馆藏", cleanup: "清理并刷新馆藏", delete: "删除" };
const failedStates = new Set(["committed", "interrupted", "blocked"]);
let selected = "", comparison = null, oldId = null, generation = 0, busyOwner = -1, confirmation = null;
let comparisonRequest, sourceDetailsRequest;
let subtitleReview, advancingSubtitleWork = false;
let reviewMode = "wash";
let automaticSubtitleQueue = Promise.resolve();
let discardReasons = {}, discardPage = 1, discardStatsRequest = 0;
let subtitleRemoval = false;
let libraryVideoDeletion = false, libraryFileList;
const pendingLibraryDeletes = new Map();
let jobs = [], known = new Map(), pollTimer = 0, polling = false, doneCount = 0, toastTimer = 0;
const taskRows = new Map(), taskGroups = new Map();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function message(text, error = false) {
  clearTimeout(toastTimer);
  $("notice").textContent = text;
  $("notice").hidden = false;
  $("notice").classList.toggle("error", error);
  if (!error) toastTimer = setTimeout(() => { $("notice").hidden = true; }, 8000);
}

async function api(route, body, signal) {
  const response = await fetch(prefix + route, body === undefined ? { cache: "no-store", signal }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data;
}

function sizeLabel(bytes) {
  const size = Number(bytes);
  if (!(size > 0)) return "大小未知";
  return size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GiB` : `${(size / 1024 ** 2).toFixed(1)} MiB`;
}

function timeLabel(seconds) {
  const total = Math.round(seconds);
  if (total >= 3600) return `${Math.floor(total / 3600)} 小时 ${Math.floor(total % 3600 / 60)} 分`;
  return total >= 60 ? `${Math.floor(total / 60)} 分 ${total % 60} 秒` : `${total} 秒`;
}

function button(text, fn, className) {
  const result = node("button", text, className);
  result.type = "button";
  result.addEventListener("click", fn);
  return result;
}

async function openFile(file, folder) {
  try { await api("open", { path: file.path, folder }); }
  catch (error) { message(error.message, true); }
}

const isBusy = () => busyOwner === generation;
const trayJobs = () => jobs.filter((job) => job.active || failedStates.has(job.state));
const nextItem = () => [...queue.values()].find((item) => !item.error && item.path !== selected);

function updateView() {
  const tray = dedicatedSubtitle ? [] : trayJobs();
  const inWork = Boolean(queue.size || tray.length);
  $("bench").dataset.view = inWork ? "work" : "drop";
  const slot = $(inWork ? "sideModeSlot" : "dropModeSlot");
  if ($("reviewMode").parentElement !== slot) slot.append($("reviewMode"));
  if (dedicatedSubtitle) {
    $("libraryQueue").hidden = !queue.size;
  } else {
    const searchSlot = $(inWork ? "sideLibrarySearchSlot" : "dropLibrarySearchSlot");
    if ($("librarySearch").parentElement !== searchSlot) searchSlot.append($("librarySearch"));
  }
  $("tasksPanel").hidden = !tray.length;
  $("doneCount").textContent = doneCount ? `本次完成 ${doneCount}` : "";
  renderDraftPrompt();
}

function draftJobs() {
  return [...known.values(), ...draftSubmitting.values()];
}

function persistWashDraft() {
  if (dedicatedSubtitle) return;
  saveIntakeQueueDraft(mergeIntakeQueueDraft(queueDraft, queue.values(), selected, draftJobs()));
}

function renderDraftPrompt() {
  if (dedicatedSubtitle) return;
  const panel = $("queueDraft");
  const slot = $($("bench").dataset.view === "work" ? "sideQueueDraftSlot" : "dropQueueDraftSlot");
  if (panel.parentElement !== slot) slot.append(panel);
  panel.hidden = reviewMode !== "wash" || !queueDraft.entries.length;
  if (panel.hidden) return;
  $("queueDraftStatus").textContent = draftRestore
    ? `正在检查 ${queueDraft.entries.length} 项待核对文件…`
    : draftFailures.length ? `还有 ${queueDraft.entries.length} 项未恢复，可重试或清除。`
      : `此标签页有 ${queueDraft.entries.length} 项待核对草稿。`;
  $("restoreQueueDraft").disabled = $("clearQueueDraft").disabled = Boolean(draftRestore);
  $("queueDraftFailures").hidden = !draftFailures.length || Boolean(draftRestore);
  $("queueDraftFailures").querySelector("ul").replaceChildren(...draftFailures.map(({ entry, error }) => {
    const name = entry.path.split(/[\\/]/).at(-1);
    const row = node("li", `${entry.code || name} · ${error}`);
    row.title = entry.path;
    return row;
  }));
}

async function restoreWashDraft() {
  if (dedicatedSubtitle || reviewMode !== "wash" || draftRestore || !queueDraft.entries.length) return;
  const owner = new AbortController();
  const draft = queueDraft;
  draftRestore = owner;
  renderDraftPrompt();
  try {
    const { jobs: activeJobs } = await api("jobs", undefined, owner.signal);
    if (!Array.isArray(activeJobs)) throw new Error("无法确认执行队列，请重试恢复。");
    const outcomes = await restoreIntakeQueueDraft(draft.entries, {
      signal: owner.signal,
      scan: (path) => api("scan", { path }, owner.signal),
      hasJob: (entry) => intakeDraftJobOwns(entry, activeJobs)
    });
    if (draftRestore !== owner || owner.signal.aborted) return;
    const existing = new Map([...queue.values()].map((item) => [intakeDraftPathKey(item.path), item]));
    const currentJobs = [...activeJobs, ...draftJobs()];
    const pending = new Set(queueDraft.entries.map(({ path }) => intakeDraftPathKey(path)));
    draftFailures = [];
    let restored = 0, skipped = 0, first = null, previous = null;
    for (const outcome of outcomes) {
      const { entry, item, error } = outcome;
      const key = intakeDraftPathKey(entry.path);
      if (!pending.has(key)) continue;
      if (outcome.skipped || intakeDraftJobOwns(entry, currentJobs)) { skipped++; continue; }
      if (!item) { draftFailures.push({ entry, error }); continue; }
      const itemKey = intakeDraftPathKey(item.path);
      const value = existing.get(itemKey) || item;
      if (value === item) {
        queue.set(item.path, item);
        existing.set(itemKey, item);
      }
      restored++;
      first ??= value;
      if (key === intakeDraftPathKey(draft.selected)) previous = value;
    }
    queueDraft = { entries: draftFailures.map(({ entry }) => entry), selected: draft.selected };
    renderQueue();
    if (!selected && reviewMode === "wash" && (previous || first)) void selectItem(previous || first);
    message(`已恢复 ${restored} 项${skipped ? `，执行记录中已有 ${skipped} 项` : ""}${draftFailures.length ? `，${draftFailures.length} 项可重试` : ""}。`);
  } catch (error) {
    if (draftRestore === owner && !owner.signal.aborted) message(error.message, true);
  } finally {
    if (draftRestore === owner) {
      draftRestore = null;
      renderDraftPrompt();
    }
  }
}

function renderQueue() {
  if (queueDraft.entries.length && queue.size) {
    const visible = new Set([...queue.values()].filter((item) => !item.library).map((item) => intakeDraftPathKey(item.path)));
    queueDraft = { ...queueDraft, entries: queueDraft.entries.filter(({ path }) => !visible.has(intakeDraftPathKey(path))) };
    draftFailures = draftFailures.filter(({ entry }) => !visible.has(intakeDraftPathKey(entry.path)));
  }
  persistWashDraft();
  $("queueCount").textContent = String(queue.size);
  $("queue").replaceChildren();
  if (!queue.size) $("queue").append(node("p", "没有待核对的视频。", "queue-empty"));
  for (const item of queue.values()) {
    const row = node("div", undefined, "queue-row");
    row.setAttribute("aria-current", String(item.path === selected));
    const pick = button("", () => selectItem(item), "queue-pick");
    pick.disabled = Boolean(item.error);
    pick.title = item.path;
    pick.append(node("strong", item.code || "待确认番号"), node("small", item.name));
    if (item.library) pick.append(node("small", "馆藏视频"));
    if (item.package) pick.append(node("small", `下载包 · ${item.package.videos.length} 份正片 · ${item.package.ads.length} 个广告`));
    if (item.savedSubtitle) pick.append(node("small", "已保存外挂字幕"));
    if (item.subtitleError) pick.append(node("small", `自动字幕失败 · ${item.subtitleError}`, "error"));
    if (item.error) pick.append(node("small", item.error, "error"));
    const discardBundle = reviewMode === "wash" && item.package;
    const remove = button("×", () => discardBundle ? discardPackage(item) : removeItem(item.path), "queue-drop");
    remove.title = discardBundle ? "移除并丢弃整个文件夹" : "从待核对移除（不动文件）";
    remove.setAttribute("aria-label", discardBundle ? `移除下载包 ${item.code}` : `从待核对移除 ${item.name}`);
    row.append(pick, remove);
    $("queue").append(row);
  }
  updateView();
}

function clearSelection(text, keepFileList = false) {
  comparisonRequest?.abort();
  closeSubtitleReview();
  generation += 1;
  selected = ""; comparison = null; oldId = null;
  if (!keepFileList) setSubtitleDrawer("");
  librarySearch.setSelectedWork();
  resetSubtitlePreview();
  $("subtitlePane").hidden = $("compareBody").hidden = true;
  $("compareEmpty").hidden = false;
  $("compareEmpty").textContent = text;
}

// Removes a row and moves the review on, so a submitted video never blocks the next one.
function removeItem(file, keepFileList = false) {
  const wasSelected = selected === file;
  const next = wasSelected && !keepFileList ? nextItem() : null;
  queue.delete(file);
  if (wasSelected) {
    if (next) void selectItem(next);
    else clearSelection("待办都已提交。可以继续把视频拖进窗口。", keepFileList);
  }
  renderQueue();
}

function renderMetadata() {
  const meta = comparison?.metadata || comparison?.works?.[0];
  const host = $("workMetadata");
  host.replaceChildren();
  if (meta) {
    const title = node("strong", meta.title);
    title.title = meta.title || "";
    host.append(title);
    const lines = [[meta.actors?.join("、"), meta.date, meta.maker, meta.series, meta.rating ? `评分 ${meta.rating}` : "", meta.source].filter(Boolean).join(" · "), meta.tags?.join(" · ")];
    for (const line of lines.filter(Boolean)) {
      const row = node("p", line);
      row.title = line;
      host.append(row);
    }
  }
  $("actorTarget").replaceChildren();
  const actors = comparison?.actors || [];
  if (actors.length !== 1) {
    const option = node("option", actors.length ? "请选择人物和归档目录" : "入库时自动查询资料");
    option.value = "";
    $("actorTarget").append(option);
  }
  for (const [index, actor] of actors.entries()) {
    const option = node("option", `${actor.name} · ${actor.folder}`);
    option.value = String(index);
    $("actorTarget").append(option);
  }
}

const bitrate = (file) => (file?.size > 0 && file.probe?.duration > 0 ? file.size * 8 / file.probe.duration / 1e6 : 0);
const pixels = (file) => (file?.probe?.width ? file.probe.width * file.probe.height : 0);
const probePlaceholder = (file, fallback = "未知") => file?.probePending ? "读取中…" : fallback;
const resolution = (file) => (file?.probe?.width ? `${file.probe.width}×${file.probe.height}` : probePlaceholder(file, "待确认"));
const duration = (file) => (file?.probe?.duration ? timeLabel(file.probe.duration) : probePlaceholder(file));
const codecs = (file) => [file?.probe?.videoCodec, file?.probe?.audioCodec].filter(Boolean).map((value) => value.toUpperCase()).join(" / ") || probePlaceholder(file);

function versionLabels(file) {
  const labels = [...(file.labels || [])];
  if (file.a) labels.unshift("[A]");
  if (file.protected4k && !labels.includes("4K")) labels.push("4K+");
  return labels;
}

// Colors only the incoming side: green means the new file wins that row, orange means it loses.
function valueCell(text, tone = "", delta = "") {
  const cell = node("td", undefined, "value");
  const value = node("span", text, tone);
  cell.append(value);
  if (delta) cell.append(node("span", delta, `delta ${tone}`));
  return cell;
}

function tone(source, old, margin = 0.02) {
  if (!(source > 0) || !(old > 0)) return "";
  if (source > old * (1 + margin)) return "up";
  return source < old * (1 - margin) ? "down" : "";
}

function row(label, ...cells) {
  const tr = node("tr");
  const head = node("th", label, "row-label");
  head.scope = "row";
  tr.append(head, ...cells);
  return tr;
}

function textCell(text, className) {
  return node("td", text, className);
}

function chipsCell(file) {
  const cell = node("td");
  const chips = node("div", undefined, "chips");
  for (const label of versionLabels(file)) chips.append(node("span", label, "badge"));
  if (!chips.children.length) cell.textContent = "无";
  else cell.append(chips);
  return cell;
}

function columnHead(title, file, library = false) {
  const head = node("th");
  head.scope = "col";
  head.append(node("span", title, "col-title"));
  if (library ? file.available : file.available !== false) {
    const tools = node("div", undefined, "col-tools");
    tools.append(button("打开视频", () => openFile(file, false)), button("打开文件夹", () => openFile(file, true)));
    if (!library) {
      const subtitles = button("字幕", openSubtitleReview);
      subtitles.id = "manageSourceSubtitles";
      tools.append(subtitles);
    }
    if (library && file.marks) {
      const mark = button("修改馆藏标记", () => openMarkDialog(file));
      mark.id = "markSelected";
      tools.append(mark);
    }
    head.append(tools);
  }
  return head;
}

function renderTable() {
  const source = comparison.source;
  const old = comparison.files.find((file) => file.id === oldId) || comparison.files.find((file) => !file.available);
  const usable = old?.available || old?.probePending ? old : null;
  const table = $("compareTable");
  table.replaceChildren();
  const headRow = node("tr");
  headRow.append(node("th"), columnHead("待迁移", source));
  if (old) headRow.append(columnHead("馆藏", old, true));
  const thead = node("thead");
  thead.append(headRow);
  const body = node("tbody");
  const add = (label, sourceCell, oldCell) => body.append(old ? row(label, sourceCell, oldCell) : row(label, sourceCell));
  const unavailable = () => textCell(old ? "索引存在，文件当前无法读取" : "");

  add("文件", textCell(source.name, "name"), textCell(old?.name || "", "name"));
  add("分辨率", valueCell(resolution(source), tone(pixels(source), pixels(usable), 0)), usable ? valueCell(resolution(usable)) : unavailable());
  const sourceBitrate = bitrate(source), oldBitrate = bitrate(usable);
  const bitrateTone = tone(sourceBitrate, oldBitrate);
  add("码率", valueCell(sourceBitrate ? `${sourceBitrate.toFixed(1)} Mbps` : probePlaceholder(source), bitrateTone,
    bitrateTone ? `${sourceBitrate > oldBitrate ? "+" : ""}${Math.round((sourceBitrate / oldBitrate - 1) * 100)}%` : ""),
  usable ? valueCell(oldBitrate ? `${oldBitrate.toFixed(1)} Mbps` : probePlaceholder(usable)) : unavailable());
  const sizeTone = tone(source.size, usable?.size);
  add("大小", valueCell(sizeLabel(source.size), sizeTone, sizeTone ? `${source.size > usable.size ? "+" : "−"}${sizeLabel(Math.abs(source.size - usable.size))}` : ""),
    usable ? valueCell(sizeLabel(usable.size)) : textCell(old ? sizeLabel(old.size) : ""));
  const gap = source.probe?.duration && usable?.probe?.duration ? Math.abs(source.probe.duration - usable.probe.duration) : 0;
  add("时长", valueCell(duration(source), gap >= 60 ? "warn" : "", gap >= 60 ? `相差 ${timeLabel(gap)}` : ""), usable ? valueCell(duration(usable), gap >= 60 ? "warn" : "") : unavailable());
  add("编码", valueCell(codecs(source)), usable ? valueCell(codecs(usable)) : unavailable());
  add("标记", chipsCell(source), old ? chipsCell(old) : textCell(""));
  add("路径", textCell(source.path, "path"), textCell(old?.path || "", "path"));
  const packageSubtitles = new Set(comparison.package?.subtitles || []);
  const sourceSubtitles = (source.subtitles || []).filter((name) => !packageSubtitles.has(name));
  if (sourceSubtitles.length) {
    const cell = node("td");
    const names = node("ul", undefined, "subtitle-list");
    for (const name of sourceSubtitles) names.append(node("li", name));
    cell.append(names);
    if (subtitleRemoval) {
      const remove = button("移除外挂…", () => openSubtitleReview({ focusRemoval: true }), "danger subtitle-list-action");
      remove.id = "manageSourceSubtitleRemoval";
      cell.append(remove);
    }
    add("源字幕", cell, textCell(""));
  }
  if (comparison.package) {
    const bundle = comparison.package;
    add("下载包", textCell(bundle.folder, "path"), textCell(""));
    if (bundle.videos.length > 1) {
      const cell = node("td");
      for (const part of bundle.videos) cell.append(node("div", part.name, "path"), button("打开分段", () => openFile(part, false), "small"));
      add("正片分段", cell, textCell(""));
    }
    const subtitles = bundle.subtitles || [];
    if (subtitles.length) {
      const cell = node("td");
      cell.append(node("div", `字幕 ${subtitles.length} 个，随正片迁移`), ...subtitles.map((name) => node("div", name, "path")));
      add("包内字幕", cell, textCell(""));
    }
    if (bundle.extras - subtitles.length) {
      const cell = node("td");
      if (bundle.ads.length) cell.append(node("div", `已过滤 ${bundle.ads.length} 个广告`), ...bundle.ads.map((name) => node("div", name, "path")));
      const others = bundle.extras - bundle.ads.length - subtitles.length;
      if (others) cell.append(node("div", `其他配套文件 ${others} 项`, "path"));
      add("随包清理", cell, textCell(""));
    }
  }
  table.append(thead, body);
  $("openBoth").hidden = !old?.available || source.available === false;
}

function renderVersions() {
  const host = $("versions");
  host.replaceChildren();
  const { files, moreFiles } = comparison;
  if (files.length > 1) for (const file of files) {
    const label = node("label");
    label.title = file.path;
    const control = node("input");
    control.type = "radio";
    control.name = "existingVersion";
    control.disabled = file.available === false;
    control.checked = oldId === file.id;
    control.addEventListener("change", () => { oldId = file.id; $("tagA").checked = Boolean(file.a); renderTable(); updateActions(); });
    label.append(control, file.available === false ? "文件不可读" : `${resolution(file)} · ${sizeLabel(file.size)}${file.a ? " · [A]" : ""}`);
    host.append(label);
  }
  if (moreFiles) host.append(node("span", "只显示前 40 份匹配视频。", "queue-empty"));
}

function updateActions() {
  const old = comparison?.files.find((file) => file.id === oldId);
  const newWork = comparison && !comparison.files.length;
  const edited = $("code").value.trim() !== (comparison?.code || "");
  const sourceReady = comparison && !comparison.source.probePending && comparison.source.available !== false;
  const canMove = !isBusy() && !edited && sourceReady && Boolean(comparison.source.probe);
  for (const id of ["manageSourceSubtitles", "manageSourceSubtitleRemoval"]) {
    if ($(id)) $(id).disabled = isBusy() || edited || !sourceReady || !comparison?.code;
  }
  $("replace").hidden = $("keep").hidden = !comparison?.files.length;
  $("addNew").hidden = $("newWork").hidden = $("noExisting").hidden = !newWork;
  $("replace").disabled = !canMove || !old?.available;
  if ($("markSelected")) $("markSelected").disabled = isBusy() || edited || !sourceReady;
  $("keep").disabled = !canMove || !old?.available;
  const recommendKeep = Boolean(old?.protected4k);
  $("keep").classList.toggle("primary", recommendKeep);
  $("replace").classList.toggle("primary", !recommendKeep);
  $("addNew").disabled = !canMove || !comparison?.code || (comparison.actors.length > 0 && $("actorTarget").value === "");
  $("fetchMeta").disabled = $("fetchMetaUrl").disabled = $("metadataUrl").disabled = isBusy() || !comparison?.code || edited;
  $("discard").disabled = isBusy() || !sourceReady;
  $("discard").textContent = comparison?.package ? "丢弃整个文件夹" : "丢弃源视频";
  $("discardBoth").hidden = !old?.available;
  $("discardBoth").disabled = isBusy() || edited || !sourceReady;
  $("qualityTag").hidden = !comparison?.source.flags?.quality4k;
  $("qualityTag").textContent = "实测 4K · 普通视频入库自动加 -4K";
  const hint = edited ? "番号已编辑，请先重新匹配。"
    : comparison?.source.probePending ? "正在读取源视频参数，可以先核对番号和资料。"
      : old?.probePending ? "正在读取馆藏视频参数…"
        : comparison && !comparison.source.probe ? "源视频参数无法读取，请重新匹配或打开视频核对。"
      : recommendKeep ? "馆藏是 4K 或更高分辨率，推荐两份都保留。"
        : old?.available && !old.probe ? "馆藏参数暂未读取，核对后仍可替换。" : "";
  $("actionHint").textContent = hint;
  $("actionHint").hidden = !hint;
}

function subtitleStatus(text, error = false) {
  const status = $("sourceSubtitleStatus");
  status.textContent = text;
  status.classList.toggle("error", error);
}

function closeSubtitleReview() {
  subtitleReview?.controller.abort();
  subtitleReview = null;
  setReviewModeLocked(false);
  if ($("sourceSubtitles").open) $("sourceSubtitles").close();
}

function setReviewModeLocked(locked) {
  for (const control of $("reviewMode").querySelectorAll("button")) control.disabled = locked;
}

function subtitleReviewIsCurrent(review) {
  if (subtitleReview !== review || review.controller.signal.aborted || review.owner !== generation) return false;
  return review.inline ? reviewMode === "subtitle" && selected === review.body.path
    : $("sourceSubtitles").open && comparison?.source.path === review.body.path && $("code").value.trim() === review.body.code;
}

function startSubtitleReview(source, code, inline = false) {
  subtitleReview = {
    owner: generation, controller: new AbortController(), inline, source,
    body: { path: source.path, code, ...(inline ? { subtitleMode: true } : {}) }
  };
  $("sourceSubtitleResults").replaceChildren();
  renderSubtitleAttachments();
  setSubtitleReviewPending(subtitleReview, false);
  subtitleStatus("字幕将保存到源视频旁，可先打开视频核对。");
}

function openSubtitleReview({ focusRemoval = false } = {}) {
  if (!comparison?.code || $("manageSourceSubtitles")?.disabled || $("sourceSubtitles").open) return;
  $("sourceSubtitlesTitle").textContent = `${comparison.code} · 源视频字幕`;
  startSubtitleReview(comparison.source, comparison.code);
  $("sourceSubtitles").showModal();
  const item = queue.get(comparison.source.path);
  if (item) showAutomaticSubtitle(item, subtitleReview);
  if (focusRemoval) $("sourceSubtitleAttachments").querySelector("button")?.focus();
}

function setSubtitleReviewPending(review, pending, saving = false) {
  review.pending = pending;
  review.saving = pending && saving;
  const waiting = pending || Boolean(queue.get(review.body.path)?.automaticSubtitle);
  $("downloadSourceSubtitle").disabled = $("searchSourceSubtitles").disabled = $("importSourceSubtitle").disabled = waiting;
  $("closeSourceSubtitles").disabled = review.saving;
  renderSubtitleReviewMark();
  setReviewModeLocked(review.saving);
  for (const control of $("sourceSubtitleContent").querySelectorAll(".job-list button")) control.disabled = pending;
}

async function withSubtitleReview(status, operation, { saving = false } = {}) {
  const review = subtitleReview;
  if (!review || review.pending || !subtitleReviewIsCurrent(review) || queue.get(review.body.path)?.automaticSubtitle) return;
  setSubtitleReviewPending(review, true, saving);
  subtitleStatus(status);
  try { await operation(review); }
  catch (error) { if (subtitleReviewIsCurrent(review)) subtitleStatus(error.message, true); }
  finally { if (subtitleReviewIsCurrent(review)) setSubtitleReviewPending(review, false); }
}

function subtitleOption(label, control) {
  const row = node("div", undefined, "job-row");
  row.append(node("span", label));
  if (control) row.append(control);
  return row;
}

function renderSubtitleAttachments() {
  const source = subtitleReview?.inline ? subtitleReview.source : comparison?.source;
  const names = source?.subtitles || [];
  const list = $("sourceSubtitleAttachments");
  list.hidden = !names.length;
  list.replaceChildren(...names.map((name) => {
    if (!subtitleRemoval) return subtitleOption(name);
    const remove = button("移除外挂", () => void removeSourceSubtitle(name));
    remove.setAttribute("aria-label", `移除外挂 ${name}`);
    return subtitleOption(name, remove);
  }));
}

function showSubtitleResults(review) {
  const results = review.results;
  $("sourceSubtitleResults").replaceChildren(...results.map((result) =>
    subtitleOption(result.title, button("查看中文字幕", () => void loadSubtitleFiles(result)))));
  subtitleStatus(results.length ? `找到 ${results.length} 个结果，选择版本查看字幕。` : "未找到此番号的字幕，可以继续洗版。");
}

async function searchSubtitles(review) {
  const result = await api("subtitle-search", review.body, review.controller.signal);
  if (!subtitleReviewIsCurrent(review)) return;
  review.results = result.results || [];
  showSubtitleResults(review);
}

async function loadSubtitleFiles(result) {
  await withSubtitleReview("正在读取可下载的字幕…", async (review) => {
    const data = await api("subtitle-files", { ...review.body, resultId: result.id }, review.controller.signal);
    if (!subtitleReviewIsCurrent(review)) return;
    const chinese = (data.files || []).filter((file) => /^zh(?:-|$)/i.test(file.languageCode || file.language || ""));
    $("sourceSubtitleResults").replaceChildren(button("返回搜索结果", () => showSubtitleResults(review)),
      ...chinese.map((file) => subtitleOption(`${file.label || "中文字幕"} · ${file.name}`,
        button(review.inline ? "下载字幕" : "下载并匹配", () => void saveSourceSubtitle("subtitle-download", () => ({ resultId: result.id, fileId: file.id }))))));
    subtitleStatus(chinese.length ? result.title : "此版本暂无可直接下载的中文字幕。");
  });
}

async function refreshSourceSubtitleComparison(review, name, removed = false) {
  if (review.inline) {
    const names = review.source.subtitles;
    review.source.subtitles = removed ? names.filter((item) => item !== name) : [...new Set([...names, name])];
    return true;
  }
  try {
    await sourceDetailsRequest;
    if (!subtitleReviewIsCurrent(review)) return false;
    const data = await api("compare", { ...review.body, phase: "source", packageFolder: comparison.package?.folder },
      review.controller.signal);
    if (!subtitleReviewIsCurrent(review)) return false;
    comparison.source = data.source;
    comparison.package = data.package;
    const item = queue.get(review.body.path);
    if (item) item.package = data.package;
  } catch {
    if (subtitleReviewIsCurrent(review)) {
      const names = comparison.source.subtitles || [];
      comparison.source.subtitles = removed ? names.filter((item) => item !== name) : [...new Set([...names, name])];
      renderTable(); updateActions();
    }
    return false;
  }
  renderTable(); renderQueue(); updateActions();
  return true;
}

async function removeSourceSubtitle(name) {
  await withSubtitleReview("正在备份并移除字幕…", async (review) => {
    const result = await api("subtitle-remove", { ...review.body, name }, review.controller.signal);
    if (!subtitleReviewIsCurrent(review)) return;
    const item = queue.get(review.body.path);
    if (item?.savedSubtitle === name) {
      delete item.savedSubtitle;
      delete item.automaticSubtitleReceipt;
      renderQueue();
    }
    const refreshed = await refreshSourceSubtitleComparison(review, name, true);
    if (!subtitleReviewIsCurrent(review)) return;
    renderSubtitleAttachments();
    subtitleStatus(`已移除 ${name}。备份位置 ${result.backupPath}${refreshed ? "" : "。请重新匹配以更新入库预览。"}`);
    if (review.inline && item?.library) void librarySearch.subtitleChanged(item.previewWorkId, false);
  }, { saving: true });
}

async function saveSourceSubtitle(route, input) {
  const direct = route === "subtitle-download-direct";
  await withSubtitleReview(direct ? "正在读取并校验目录字幕…" : "正在校验并保存字幕…", async (review) => {
    const fields = await input?.();
    if (!subtitleReviewIsCurrent(review)) return;
    const result = await api(route, { ...review.body, ...fields }, review.controller.signal);
    if (!subtitleReviewIsCurrent(review)) return;
    if (direct && result.available === false) {
      setSubtitleReviewPending(review, true);
      subtitleStatus("本地 LTX 目录暂无直链，正在按番号查找字幕…");
      await searchSubtitles(review);
      return;
    }
    const refreshed = await refreshSourceSubtitleComparison(review, result.name);
    if (!subtitleReviewIsCurrent(review)) return;
    const item = queue.get(review.body.path);
    if (item?.subtitleError) {
      delete item.subtitleError;
      renderQueue();
    }
    if (review.inline) {
      $("sourceSubtitleResults").replaceChildren();
      renderSubtitleAttachments();
      subtitleStatus(`已保存到视频旁 · ${result.name}`);
      if (item?.library) void librarySearch.subtitleChanged(item.previewWorkId, true);
      return;
    }
    closeSubtitleReview();
    $("manageSourceSubtitles")?.focus();
    message(refreshed ? `已匹配字幕 · ${result.name}。可打开源视频核对。` : "字幕已保存。请重新匹配，更新入库预览。", !refreshed);
  }, { saving: true });
}

function showAutomaticSubtitle(item, review) {
  if (item.savedSubtitle) {
    if (review.inline) review.source.subtitles = [...new Set([...review.source.subtitles, item.savedSubtitle])];
    renderSubtitleAttachments();
    subtitleStatus(`已自动保存到视频旁 · ${item.savedSubtitle}`);
  } else if (item.automaticSubtitle) subtitleStatus("正在检查 LTX 目录字幕…");
  else if (item.subtitleError) subtitleStatus(`${item.subtitleError}。可以手动查找字幕。`, true);
  else if (item.subtitleReason === "no-direct-link") subtitleStatus("本地目录没有字幕直链，可以手动查找字幕。");
  else if (item.subtitleReason === "different-version") subtitleStatus("当前文件与 LTX 目录版本不一致，可以手动选字幕。");
  else subtitleStatus("字幕将保存到源视频旁，可先打开视频核对。");
  setSubtitleReviewPending(review, false);
}

function showSavedSubtitleInComparison(view, name) {
  if (!name || !view.source.subtitles || view.source.subtitles.includes(name)) return;
  view.source.subtitles.push(name);
  const bundle = view.package;
  if (bundle && !bundle.subtitles.includes(name)) {
    // Keep the reviewed fingerprints. Prepare verifies the addition against the write receipt.
    view.package = { ...bundle, subtitles: [...bundle.subtitles, name], extras: bundle.extras + 1 };
  }
}

async function downloadAutomaticSubtitle(item) {
  try {
    if (queue.get(item.path) !== item) return;
    const result = await api("subtitle-download-direct", { path: item.path, code: item.code, automatic: true, subtitleMode: item.library === true });
    if (result.name) {
      item.savedSubtitle = result.name;
      if (result.signature) item.automaticSubtitleReceipt = { name: result.name, signature: result.signature };
    }
    item.subtitleReason = result.reason;
  } catch (error) {
    item.subtitleError = error.message;
  } finally {
    item.automaticSubtitle = null;
    if (queue.get(item.path) === item) {
      if (item.savedSubtitle && comparison?.source.path === item.path) {
        showSavedSubtitleInComparison(comparison, item.savedSubtitle);
        renderTable(); updateActions();
      }
      const review = subtitleReview;
      if (review?.body.path === item.path && subtitleReviewIsCurrent(review)) showAutomaticSubtitle(item, review);
      if (item.savedSubtitle || item.subtitleError) renderQueue();
    }
  }
}

function scheduleAutomaticSubtitle(item) {
  if (!item.code || item.error) return;
  let request;
  const start = () => request ??= downloadAutomaticSubtitle(item);
  item.automaticSubtitle = start;
  automaticSubtitleQueue = automaticSubtitleQueue.then(start);
}

async function readLocalSubtitle(file) {
  if (!/\.srt$/i.test(file.name) || !file.size || file.size > 2 * 1024 * 1024) throw new Error("请选择 2 MiB 以内的 SRT 字幕。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { name: file.name, contentBase64: btoa(binary) };
}

async function loadComparisonDetails(phase, request, view, item, signal) {
  const initialMetadata = view.metadata;
  const automaticSubtitle = item.automaticSubtitle;
  try {
    const data = await api("compare", { ...request, phase }, signal);
    if (signal.aborted || comparison !== view) return;
    if (phase === "source") {
      view.source = data.source;
      view.package = item.package = data.package;
      if (automaticSubtitle) showSavedSubtitleInComparison(view, item.savedSubtitle);
      if (view.metadata === initialMetadata) {
        Object.assign(view, { metadata: data.metadata, actors: data.actors });
        renderMetadata();
      }
      renderQueue();
    } else {
      const previous = view.files.find((file) => file.id === oldId);
      view.files = data.files;
      view.moreFiles = data.moreFiles;
      if (!view.files.some((file) => file.id === oldId && file.available)) {
        const next = view.files.find((file) => file.available);
        oldId = next?.id || null;
        if ($("tagA").checked === Boolean(previous?.a)) $("tagA").checked = Boolean(next?.a);
      }
    }
  } catch (error) {
    if (signal.aborted || comparison !== view) return;
    if (phase === "source") Object.assign(view.source, { probePending: false, available: false });
    else view.files = view.files.map((file) => ({ ...file, probePending: false, available: false }));
    message(error.message, true);
  }
  if (phase === "library") renderVersions();
  renderTable(); updateActions();
}

async function selectItem(item, code) {
  if (dedicatedSubtitle) $("libraryLocalFiles").open = false;
  librarySearch.setSelectedWork(item.previewWorkId);
  resetSubtitlePreview(item);
  setSubtitleDrawer("subtitle");
  const owner = ++generation;
  comparisonRequest?.abort();
  closeSubtitleReview();
  comparisonRequest = new AbortController();
  const { signal } = comparisonRequest;
  selected = item.path; comparison = null; oldId = null;
  renderSubtitleReviewMark();
  $("metadataUrl").value = "";
  renderQueue();
  $("subtitlePane").hidden = $("compareBody").hidden = true;
  $("compareEmpty").hidden = false;
  const inline = reviewMode === "subtitle";
  $("compareEmpty").textContent = inline ? "正在读取视频旁的字幕…" : "正在按番号查找馆藏…";
  try {
    if (inline) {
      const result = await api("subtitle-source", { path: item.path, code: code ?? item.code, subtitleMode: true }, signal);
      if (owner !== generation || signal.aborted) return;
      item.code = result.code;
      $("subtitleVideoName").textContent = result.source.name;
      $("subtitleVideoPath").textContent = result.source.path;
      $("subtitleCode").value = result.code;
      $("subtitleCodeForm").hidden = Boolean(result.code);
      $("inlineSubtitleSlot").hidden = !result.code;
      if (result.code) {
        startSubtitleReview(result.source, result.code, true);
        showAutomaticSubtitle(item, subtitleReview);
      }
      renderSubtitleReviewMark();
      $("subtitlePane").hidden = false;
      $("compareEmpty").hidden = true;
      renderQueue();
      return;
    }
    if (item.library) {
      $("compareEmpty").textContent = "这是馆藏视频。切到字幕模式继续处理。";
      return;
    }
    const request = { path: item.path, code: code ?? item.code, packageFolder: item.package?.folder };
    const result = await api("compare", { ...request, phase: "index" }, signal);
    if (owner !== generation) return;
    comparison = result;
    result.package = item.package;
    item.code = result.code;
    oldId = result.files[0]?.id || null;
    $("code").value = result.code;
    $("tagLtx").checked = true;
    $("tagU").checked = Boolean(result.source.flags.uncensored);
    $("tagC").checked = Boolean(result.source.flags.subtitled);
    $("tagA").checked = Boolean(result.files.find((file) => file.id === oldId)?.a);
    $("compareBody").hidden = false; $("compareEmpty").hidden = true;
    renderVersions(); renderTable(); renderMetadata(); renderQueue(); updateActions();
    request.code = result.code;
    sourceDetailsRequest = loadComparisonDetails("source", request, result, item, signal);
    await Promise.all([
      sourceDetailsRequest,
      result.files.length ? loadComparisonDetails("library", request, result, item, signal) : null
    ]);
  } catch (error) {
    if (owner !== generation || signal.aborted) return;
    if (inline && code !== undefined) {
      $("subtitlePane").hidden = false;
      $("compareEmpty").hidden = true;
      message(error.message, true);
    } else $("compareEmpty").textContent = error.message;
  }
}

function switchReviewMode(mode) {
  if (mode === reviewMode || subtitleReview?.saving) return;
  closeSubtitleReview();
  reviewMode = mode;
  const inline = mode === "subtitle";
  $("bench").dataset.mode = mode;
  librarySearch.setActive(inline);
  document.title = `${inline ? "字幕" : "视频洗版"}工作台 · FanHao`;
  $("inlineSubtitleSlot").hidden = true;
  $(inline ? "inlineSubtitleSlot" : "dialogSubtitleSlot").append($("sourceSubtitleContent"));
  for (const control of $("reviewMode").querySelectorAll("button")) {
    control.setAttribute("aria-pressed", String(control.dataset.mode === mode));
  }
  const item = queue.get(selected);
  if (item) void selectItem(item);
  else {
    $("compareEmpty").textContent = inline ? "在左侧选择影片，处理字幕并播放确认。" : "选中左侧待办开始对照。";
    renderQueue();
  }
}

async function selectLibrarySubtitleVideo(video, workId, signal) {
  if (subtitleReview?.saving) throw new Error("字幕正在保存，请稍后再选视频。");
  const owner = generation;
  const data = await api("scan", { path: video.sourcePath, subtitleMode: true }, signal);
  if (signal.aborted || reviewMode !== "subtitle" || owner !== generation) return false;
  if (subtitleReview?.saving) throw new Error("字幕正在保存，请稍后再选视频。");
  const [item] = data.items;
  if (item?.error || !item?.library || data.items.length !== 1) throw new Error(item?.error || "此馆藏视频当前不可用，请重新搜索。");
  if (jobs.some((job) => job.active && job.source === item.path)) throw new Error("此视频正在迁移，请稍后再试。");
  if (!queue.has(item.path)) queue.set(item.path, item);
  const queued = queue.get(item.path);
  queued.previewWorkId = workId;
  queued.previewVideoId = video.id;
  await selectItem(queued);
  if (!signal.aborted && selected === item.path && !$("subtitlePane").hidden
    && (!dedicatedSubtitle || $("bench").dataset.subtitleDrawer === "subtitle")) $("subtitleVideoName").focus();
  return true;
}

function setSubtitleDrawer(view) {
  if (!dedicatedSubtitle) return;
  $("bench").dataset.subtitleDrawer = view;
  $("libraryFilePicker").hidden = view !== "files";
  if (view !== "files") libraryFileList = null;
  if (view) $("reviewPane").scrollTop = 0;
  subtitleAdvanceStatus();
}

function showLibraryFiles(work, choices, videos, reload) {
  resetSubtitlePreview();
  const fileList = libraryFileList = { work, reload, deletes: [] };
  $("libraryFilePickerTitle").textContent = work.title || work.directoryName;
  const rows = choices.map((pick, index) => {
    const video = videos[index];
    const row = node("div", undefined, "library-file-choice");
    row.append(pick);
    if (videos.length > 1 && video.id && Number.isSafeInteger(video.size)) {
      const remove = button("删除此文件", () => void prepareLibraryVideoDelete(fileList, video, remove), "danger library-file-delete");
      remove.setAttribute("aria-label", `删除此文件：${video.name}`);
      fileList.deletes.push({ path: video.sourcePath, button: remove, pick });
      row.append(remove);
    }
    return row;
  });
  $("libraryFileChoices").replaceChildren(...(rows.length ? rows : [node("p", "这部作品没有可用的本地视频。", "queue-empty")]));
  setSubtitleDrawer("files");
  librarySearch.setSelectedWork(work.id);
  updateLibraryDeleteButtons();
  $("libraryFilePickerTitle").focus();
}

function updateLibraryDeleteButtons() {
  for (const { path, button: control, pick } of libraryFileList?.deletes || []) {
    control.hidden = !libraryVideoDeletion;
    const deleting = [...pendingLibraryDeletes.values()].some((job) => job.source === path)
      || jobs.some((job) => job.active && job.source === path);
    control.disabled = Boolean(libraryFileList.preparing || deleting);
    pick.disabled = deleting;
  }
  renderSubtitleReviewMark();
}

async function prepareLibraryVideoDelete(fileList, video, control) {
  if (!libraryVideoDeletion || fileList !== libraryFileList || control.disabled || $("confirm").open) return;
  fileList.preparing = true;
  updateLibraryDeleteButtons();
  try {
    const job = await api("prepare", { action: "discardLibraryVideo", workId: String(fileList.work.id),
      videoId: String(video.id), path: video.sourcePath, size: video.size, modifiedAt: video.modifiedAt || "" });
    if (fileList !== libraryFileList || $("confirm").open) await cancelJob(job, false);
    else if (job.missingSource) await submitJob(job);
    else askConfirmation(job, true);
  } catch (error) { message(error.message, true); }
  finally { fileList.preparing = false; updateLibraryDeleteButtons(); }
}

function closeSubtitleDrawer() {
  resetSubtitlePreview();
  setSubtitleDrawer("");
  librarySearch.cancelSelection();
  librarySearch.focusLastWork();
}

function resetSubtitlePreview(item) {
  $("subtitlePreview").replaceChildren();
  $("subtitlePreview").hidden = true;
  $("subtitlePreviewButton").hidden = !(dedicatedSubtitle && item?.previewWorkId && item?.previewVideoId);
  $("subtitlePreviewButton").textContent = "播放确认";
}

function currentSubtitleWorkId() {
  const view = $("bench").dataset.subtitleDrawer;
  const id = view === "files" ? libraryFileList?.work.id : view === "subtitle" ? queue.get(selected)?.previewWorkId : "";
  return String(id || "");
}

function renderSubtitleReviewMark() {
  const workId = queue.get(selected)?.previewWorkId;
  const mark = $("markSubtitleReviewed");
  mark.hidden = !(dedicatedSubtitle && workId);
  mark.disabled = Boolean(subtitleReview?.saving || advancingSubtitleWork);
  const reviewed = librarySearch.isReviewed(workId);
  mark.textContent = reviewed ? "撤销已查无中字" : "标记已查无中字";
  const next = $("nextSubtitleWork");
  next.hidden = !currentSubtitleWorkId();
  next.disabled = mark.disabled || Boolean(libraryFileList?.preparing);
  const markAndNext = $("markAndNextSubtitleWork");
  markAndNext.hidden = mark.hidden || reviewed;
  markAndNext.disabled = next.disabled;
}

function subtitleAdvanceStatus(text = "", error = false) {
  const status = $("subtitleAdvanceStatus");
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle("error", error);
}

async function advanceSubtitleWork(markReviewed) {
  const workId = currentSubtitleWorkId();
  if (!workId || advancingSubtitleWork || subtitleReview?.saving || libraryFileList?.preparing) return;
  const trigger = $(markReviewed ? "markAndNextSubtitleWork" : "nextSubtitleWork");
  const hadFocus = document.activeElement === trigger;
  if (markReviewed) {
    try { librarySearch.setReviewed(workId, true); }
    catch { subtitleAdvanceStatus("浏览器无法保存核查标记，请检查本地存储设置。", true); return; }
  }
  const owner = generation;
  const isCurrent = () => owner === generation && workId === currentSubtitleWorkId() && !subtitleReview?.saving;
  advancingSubtitleWork = true;
  renderSubtitleReviewMark();
  const status = $("subtitleAdvanceStatus");
  const loading = "正在读取下一部作品…";
  subtitleAdvanceStatus(loading);
  try {
    const result = await librarySearch.openNextWork(workId, isCurrent);
    if (!isCurrent()) return;
    if (result === "last") subtitleAdvanceStatus("已到当前筛选结果的最后一部。");
    if (result === "outside") subtitleAdvanceStatus("这部作品不在当前筛选结果中，请从馆藏列表重新选择。");
  } catch (error) {
    if (isCurrent()) subtitleAdvanceStatus(error.message, true);
  } finally {
    if (status.textContent === loading) subtitleAdvanceStatus();
    advancingSubtitleWork = false;
    renderSubtitleReviewMark();
    if (hadFocus && isCurrent() && !status.hidden && document.activeElement === document.body) {
      $("nextSubtitleWork").focus({ preventScroll: true });
    }
  }
}

$("markSubtitleReviewed").addEventListener("click", () => {
  const workId = queue.get(selected)?.previewWorkId;
  if (!dedicatedSubtitle || !workId || subtitleReview?.saving || advancingSubtitleWork) return;
  try {
    librarySearch.setReviewed(workId, !librarySearch.isReviewed(workId));
  } catch {
    message("浏览器无法保存核查标记，请检查本地存储设置。", true);
  }
});
$("nextSubtitleWork").addEventListener("click", () => void advanceSubtitleWork(false));
$("markAndNextSubtitleWork").addEventListener("click", () => void advanceSubtitleWork(true));

$("subtitlePreviewButton").addEventListener("click", () => {
  const item = queue.get(selected);
  if (!item?.previewWorkId || !item.previewVideoId) return;
  const preview = $("subtitlePreview");
  const frame = document.createElement("iframe");
  const params = new URLSearchParams({ workId: item.previewWorkId, videoId: item.previewVideoId, preview: "1", t: "0" });
  frame.src = `/player.html?${params}`;
  frame.title = `播放确认 · ${item.name}`;
  frame.allow = "autoplay";
  frame.allowFullscreen = true;
  preview.replaceChildren(frame);
  preview.hidden = false;
  $("subtitlePreviewButton").textContent = "重新载入播放";
});

function showUnmatched(unmatched) {
  const host = $("unmatched");
  host.replaceChildren(); host.hidden = !unmatched.length;
  if (!unmatched.length) return;
  host.append(button("关闭", () => { host.hidden = true; }));
  for (const item of unmatched) {
    host.append(node("p", `${item.name} · ${item.candidates.length ? "匹配到多份，请点选确切路径" : "未自动定位，请粘贴完整路径"}`));
    for (const path of item.candidates) host.append(button(path, () => addToQueue({ path })));
  }
}

async function addToQueue(input) {
  try {
    message("正在定位本机视频…");
    const data = await api("scan", reviewMode === "subtitle" ? { ...input, subtitleMode: true } : input);
    const live = new Set(jobs.filter((job) => job.active).map((job) => job.source));
    const items = data.items.filter((item) => !live.has(item.path));
    let refresh = null;
    for (const item of items) {
      const previous = queue.get(item.path);
      if (previous && !item.package) continue;
      if (item.package && selected === item.path && !previous?.package) refresh = previous || item;
      if (previous) Object.assign(previous, item);
      else {
        queue.set(item.path, item);
        scheduleAutomaticSubtitle(item);
      }
    }
    renderQueue(); showUnmatched(data.unmatched);
    const ads = items.reduce((total, item) => total + (item.package?.ads.length || 0), data.skippedAds?.length || 0);
    message(`识别 ${items.length} 项${ads ? `，已过滤 ${ads} 个广告` : ""}${data.unmatched.length ? `，${data.unmatched.length} 份待手动定位` : ""}。`);
    if (refresh) void selectItem(refresh);
    else if (!selected) {
      const first = [...queue.values()].find((item) => !item.error);
      if (first) void selectItem(first);
    }
  } catch (error) { message(error.message, true); }
}

const fileDescriptor = (file, relative = "") => ({ name: file.name, size: file.size, modified: file.lastModified, relative });

async function droppedFiles(transfer) {
  const files = [];
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...transfer.files].filter((file) => videoExtension.test(file.name)).map((file) => fileDescriptor(file, file.webkitRelativePath));
  async function walk(entry, directoryDrop) {
    if (entry.isFile && videoExtension.test(entry.name)) {
      if (files.length >= 120) throw new Error("一次最多核对 120 份视频。");
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push(fileDescriptor(file, directoryDrop ? entry.fullPath.replace(/^\//, "") : ""));
    } else if (entry.isDirectory && !/^[.$]/.test(entry.name)) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, true);
      }
    }
  }
  for (const entry of entries) await walk(entry, entry.isDirectory);
  return files;
}

function requestedMarks() {
  return Object.fromEntries(markFields.map(([id, tag]) => [tag, $(id).checked && !$(id).disabled]));
}

function openMarkDialog(file) {
  $("markName").textContent = file.name;
  for (const [id, , flag] of markFields) $(id).checked = $(id).disabled = Boolean(file.marks[flag]);
  $("markPreview").disabled = true;
  $("markLibrary").returnValue = "";
  $("markLibrary").showModal();
}

function askConfirmation(job, fresh = false) {
  confirmation = { job, fresh };
  const oldPaths = job.oldPaths || (job.old ? [job.old] : []);
  if ($("history").open) $("history").close();
  $("confirmTitle").textContent = actionLabel(job);
  $("confirmRun").textContent = job.missingSource ? "移除记录" : job.action === "discardLibraryVideo" ? "永久删除" : "确认提交";
  $("confirmText").textContent = job.action === "discardBoth"
    ? `这会永久删除${job.package ? "整个下载包" : "待迁移视频"}和所选馆藏文件夹。馆藏文件夹里有 ${job.libraryRemoval.videos} 份视频，共 ${job.libraryRemoval.files} 个文件。`
    : job.missingSource ? "这个视频已不在原路径。确认后会移除这条馆藏记录。"
    : job.action === "discardLibraryVideo" ? "这会永久删除下面这一份视频。其他视频和外挂字幕会保留。"
    : job.action === "discard" ? (job.package ? "这会永久删除整个下载包及其所有内容。" : "这会永久删除这个源视频。")
    : job.action === "mark" ? "确认后立即重命名所选馆藏及同名外挂字幕，并同步馆藏索引。"
      : job.package ? `移动 ${job.package.videos.length} 份正片和配套字幕。入库后清理已核对的下载包文件，新增或变动的文件会留在原目录。${job.replaces4k ? "所选旧馆藏为 4K 或更高分辨率，也会被移除。" : job.old ? "所选旧馆藏也会被移除。" : ""}`
      : job.replaces4k ? "所选馆藏为 4K 或更高分辨率。新视频校验并写入馆藏后，会移除这份馆藏和源文件。"
      : job.action === "replace" ? "新视频校验并写入馆藏后，会移除所选旧视频和源文件。"
        : "校验并写入馆藏后，会移除源文件。";
  if (oldPaths.length > 1) {
    const incoming = job.package ? `校验并入库 ${job.package.videos.length} 份正片及配套字幕，随后清理已核对的下载包文件` : "校验并入库新视频，随后移除源文件";
    $("confirmText").textContent = `${incoming}，并一起移除下列 ${oldPaths.length} 段馆藏视频。旧分段的外挂字幕留在原位。${job.replaces4k ? "其中有 4K 或更高分辨率的视频。" : ""}`;
  }
  if (job.oldQualityUnknown) {
    $("confirmText").textContent = `旧馆藏参数未能读取。请核对所选文件后确认替换。${$("confirmText").textContent}`;
  }
  $("confirmPaths").replaceChildren();
  const paths = job.action === "discardBoth" ? [
    [job.package ? "将删除的下载包" : "将删除的源视频", job.package?.folder || job.source],
    ["将删除的馆藏文件夹", job.libraryRemoval.folder]
  ] : job.action === "discardLibraryVideo" ? [[job.missingSource ? "缺失的视频" : "将删除的视频", job.source]]
    : job.action === "mark" ? [["当前馆藏", job.source], ["新文件名", job.target]]
    : [[job.package ? "将删除的源文件夹" : "源文件", job.package?.folder || job.source],
      ...oldPaths.map((path, index) => [oldPaths.length > 1 ? `替换的馆藏分段 ${index + 1}/${oldPaths.length}` : "替换的旧视频", path]),
      ["入库位置", job.target]];
  for (const [label, value] of [...paths,
    ...job.items.slice(1).map((item) => [item.retainedSubtitle ? "沿用馆藏字幕（时间轴原样保留）"
      : job.package?.videos.some((part) => part.path === item.source) ? "分段入库位置" : "配套文件", item.target])]) {
    if (value) $("confirmPaths").append(node("dt", label), node("dd", value));
  }
  $("discardReasonFields").hidden = job.action !== "discard";
  if (job.action === "discard") {
    $("discardChoices").replaceChildren(...Object.entries(discardReasons).map(([key, text]) => {
      const label = node("label"), input = node("input");
      input.type = "checkbox";
      input.value = key;
      input.checked = Boolean(job.discardReasons?.includes(key));
      label.append(input, text);
      return label;
    }));
    $("discardLtx").checked = Boolean(job.discardLtx);
  }
  $("confirm").showModal();
  (isDiscard(job.action) || oldPaths.length > 1 || job.replaces4k || job.oldQualityUnknown ? $("confirmBack") : $("confirmRun")).focus();
}

async function loadMetadata(owner, detailUrl = "") {
  const code = comparison.code;
  message(detailUrl ? "正在使用 115Chrome 读取 JavDB 详情页…" : "正在使用 115Chrome 查询 JavDB 资料…");
  const data = await api("metadata", { path: selected, code, detailUrl: detailUrl || undefined });
  if (owner !== generation || $("code").value.trim() !== code) return false;
  Object.assign(comparison, data);
  renderMetadata();
  return true;
}

async function prepareAction(action, tags) {
  if (!comparison || isBusy() || comparison.source.probePending || comparison.source.available === false) return;
  const owner = generation, item = queue.get(selected);
  busyOwner = owner; updateActions();
  try {
    if (action !== "mark" && item?.automaticSubtitle) {
      $("actionHint").textContent = "正在检查当前视频的自动字幕…";
      $("actionHint").hidden = false;
      await item.automaticSubtitle();
      if (owner !== generation || (action !== "discard" && $("code").value.trim() !== comparison.code)) return;
    }
    if (action === "new") {
      if (!comparison.actors.length && !await loadMetadata(owner, $("metadataUrl").value.trim())) return;
      if (!comparison.actors.length) throw new Error("资料已找到，但没有可用的归档目录");
      if ($("actorTarget").value === "") {
        message("资料已找到，请选择人物和归档目录。");
        $("actorTarget").focus();
        return;
      }
    }
    const actor = comparison.actors[Number($("actorTarget").value)];
    const old = comparison.files.find((file) => file.id === oldId);
    const oldParts = action === "replace" && old?.partIds?.map((id) => {
      const part = comparison.files.find((file) => file.id === id);
      if (!part?.available) throw new Error("馆藏分段未全部读取，请重新匹配后再替换。");
      return { id, signature: part.signature };
    });
    const job = await api("prepare", { action, path: selected, code: action === "discard" ? undefined : comparison.code,
      packageFolder: comparison.package?.folder, packageFingerprint: comparison.package?.fingerprint,
      packageMediaFingerprint: comparison.package?.mediaFingerprint, supportsPackageConfirmation: true,
      automaticSubtitle: item?.automaticSubtitleReceipt,
      sourceSignature: comparison.source.signature, oldId, oldSignature: old?.signature, oldParts: oldParts || undefined,
      actorFolder: actor?.folder, actorName: actor?.name,
      tags: tags || { ltx: $("tagLtx").checked, u: $("tagU").checked, c: $("tagC").checked, a: $("tagA").checked } });
    if (owner === generation) askConfirmation(job, true);
    else await cancelJob(job, false);
  } catch (error) { if (owner === generation) message(error.message, true); }
  finally { if (busyOwner === owner) busyOwner = -1; updateActions(); }
}

async function discardPackage(item) {
  if (isBusy()) return;
  if (selected !== item.path || !comparison?.package) await selectItem(item);
  else if (comparison.source.probePending) await sourceDetailsRequest;
  if (selected === item.path && comparison?.package) await prepareAction("discard");
}

async function submitJob(job, discardDecision) {
  known.set(job.id, { ...job, active: true });
  const singleVideo = job.action === "discardLibraryVideo";
  const trackDraft = !dedicatedSubtitle && !singleVideo && job.action !== "mark";
  if (trackDraft) {
    draftSubmitting.set(job.id, { ...job, active: true });
    persistWashDraft();
  }
  if (singleVideo) {
    pendingLibraryDeletes.set(job.id, job);
    updateLibraryDeleteButtons();
  }
  try {
    await api(`jobs/${job.id}/run`, { discardDecision });
    if (!singleVideo && queue.has(job.source)) removeItem(job.source);
    message(job.missingSource ? "正在移除缺失视频的馆藏记录…" :
      `${job.code || "视频"}${isDiscard(job.action) ? " 已提交删除。" : job.action === "mark" ? " 正在重命名馆藏。" : " 已提交到执行队列。"}`);
  } catch (error) {
    known.delete(job.id);
    pendingLibraryDeletes.delete(job.id);
    message(error.message, true);
  } finally {
    if (trackDraft) {
      draftSubmitting.delete(job.id);
      persistWashDraft();
    }
  }
  await refreshJobs();
}

async function cancelJob(job, requeue = true) {
  try {
    const result = await api(`jobs/${job.id}/cancel`, {});
    known.delete(job.id);
    if (result.cancelled && requeue && job.action !== "mark" && job.action !== "discardLibraryVideo" && !queue.has(job.source)) {
      queue.set(job.source, { path: job.source, name: job.source.split(/[\\/]/).pop(), code: job.code, package: job.package });
      renderQueue();
      if (!selected) void selectItem(queue.get(job.source));
    }
  } catch (error) { message(error.message, true); }
  await refreshJobs();
}

function taskDetail(job) {
  if (job.state === "queued") return `第 ${job.position} 位`;
  if (!job.active) return job.error || "可重试，或放弃后重新核对。";
  const progress = job.progress;
  if (!progress) return "执行中…";
  const parts = [phaseLabels[progress.phase] || "执行中"];
  // Cross-disk moves copy first, then re-read the copy to compare checksums.
  if (progress.phase === "copy") parts[0] = "第 1 步 / 共 2 步 · 传输文件", parts.push(`${sizeLabel(progress.copied)} / ${sizeLabel(progress.total)}`);
  if (progress.phase === "verify") parts[0] = "第 2 步 / 共 2 步 · 校验副本", parts.push(`${sizeLabel(progress.verified)} / ${sizeLabel(progress.total)}`);
  if (progress.rate > 0 && ["copy", "verify"].includes(progress.phase)) parts.push(`${(progress.rate / 1024 ** 2).toFixed(0)} MiB/s`);
  if (progress.eta) parts.push(`全部约剩 ${timeLabel(progress.eta)}`);
  return parts.join(" · ");
}

function stepPercent(progress) {
  if (!progress) return null;
  if (progress.total && progress.phase === "copy") return progress.copied / progress.total * 100;
  if (progress.total && progress.phase === "verify") return progress.verified / progress.total * 100;
  return progress.percent;
}

function taskActions(job) {
  if (job.state === "queued") return [button("取消", () => cancelJob(job))];
  if (job.active) return [];
  if (job.state === "committed") return [button("重试收尾", () => submitJob(job))];
  return [button("重试", () => submitJob(job)), button("放弃并重新核对", () => cancelJob(job))];
}

function arrangeChildren(host, children) {
  let cursor = host.firstElementChild;
  for (const child of children) {
    if (child !== cursor) host.insertBefore(child, cursor);
    cursor = child.nextElementSibling;
  }
}

// Rows are updated in place so a poll can't swallow a click on a task's button.
function renderTasks() {
  const tray = trayJobs().sort((a, b) => (a.targetVolume || "").localeCompare(b.targetVolume || "")
    || Number(Boolean(b.progress)) - Number(Boolean(a.progress))
    || Number(b.active) - Number(a.active) || (a.position || 0) - (b.position || 0));
  for (const [id, parts] of taskRows) if (!tray.some((job) => job.id === id)) { parts.element.remove(); taskRows.delete(id); }
  const grouped = new Map();
  for (const job of tray) {
    let parts = taskRows.get(job.id);
    if (!parts) {
      parts = { element: node("div", undefined, "task"), label: node("span"), percent: node("b"), bar: node("progress"), detail: node("small"), actions: node("div", undefined, "task-actions"), key: null };
      const title = node("div", undefined, "task-title");
      title.append(parts.label, parts.percent);
      parts.bar.max = 100;
      parts.element.append(title, parts.bar, parts.detail, parts.actions);
      taskRows.set(job.id, parts);
    }
    const running = job.active && job.state !== "queued";
    const percent = stepPercent(job.progress);
    parts.element.classList.toggle("failed", !job.active);
    parts.label.textContent = `${job.code || "未标番号"} · ${actionLabel(job)}`;
    parts.percent.textContent = running ? (Number.isFinite(percent) ? `${Math.floor(percent)}%` : "") : stateLabels[job.state];
    parts.bar.hidden = !running;
    if (Number.isFinite(percent)) parts.bar.value = percent;
    else parts.bar.removeAttribute("value");
    parts.detail.textContent = taskDetail(job);
    const key = `${job.state}:${job.active}`;
    if (key !== parts.key) { parts.key = key; parts.actions.replaceChildren(...taskActions(job)); }
    const label = job.action === "mark" || isDiscard(job.action) ? "即时操作" : job.targetVolume || "馆藏任务";
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(parts.element);
  }
  for (const [label, group] of taskGroups) if (!grouped.has(label)) { group.element.remove(); taskGroups.delete(label); }
  const groups = [];
  for (const [label, children] of grouped) {
    let group = taskGroups.get(label);
    if (!group) {
      group = { element: node("section", undefined, "task-volume"), body: node("div", undefined, "task-volume-rows") };
      group.element.append(node("h4", label), group.body);
      taskGroups.set(label, group);
    }
    arrangeChildren(group.body, children);
    groups.push(group.element);
  }
  arrangeChildren($("tasks"), groups);
}

function renderHistory() {
  const host = $("jobs");
  host.replaceChildren();
  if (!jobs.length) host.append(node("p", "还没有迁移记录。", "queue-empty"));
  for (const job of jobs) {
    const line = node("div", undefined, "job-row");
    const title = node("span");
    title.append(node("strong", `${job.code || "未标番号"} · ${actionLabel(job)} · ${stateLabels[job.state]}`), node("small", job.target || job.libraryRemoval?.folder || job.package?.folder || job.source));
    if (job.error) title.append(node("small", job.error));
    const actions = node("div", undefined, "job-actions");
    if (job.state === "prepared" && !job.active) actions.append(button("查看确认", () => askConfirmation(job)), button("放弃", () => cancelJob(job, false)));
    if (job.state === "completed" && job.target) actions.append(button("打开目录", () => openFile({ path: job.target }, true)));
    line.append(title, actions);
    host.append(line);
  }
}

async function refreshDiscardStats(page = 1) {
  const request = ++discardStatsRequest;
  const reason = $("discardFilter").value;
  const query = new URLSearchParams({ reason, ltx: $("onlyLtx").checked ? "1" : "0", page: String(page) });
  $("discardSummary").textContent = "正在读取丢弃记录…";
  $("discardRecords").replaceChildren();
  $("discardPagination").hidden = true;
  try {
    const data = await api(`discard-stats?${query}`);
    if (request !== discardStatsRequest) return;
    discardPage = data.page;
    for (const option of $("discardFilter").options) {
      const count = option.value === "unrecorded" ? data.unrecorded : data.counts[option.value];
      option.textContent = option.dataset.label + (count === undefined ? "" : `（${count}）`);
    }
    $("discardSummary").textContent = `共丢弃 ${data.total} 条 · LTX ${data.ltxCount} 条 · 匹配 ${data.matched} 条。原因可多选。`;
    const host = $("discardRecords");
    if (!data.records.length) host.append(node("p", "没有匹配的丢弃记录。", "queue-empty"));
    for (const record of data.records) {
      const line = node("div", undefined, "job-row");
      const title = node("span");
      const labels = record.reasons.map((key) => discardReasons[key]).filter(Boolean);
      const edition = record.ltx ? (record.inferred ? " · LTX（文件名）" : " · LTX") : "";
      title.append(node("strong", `${record.code || "未标番号"}${edition} · ${labels.join("、") || "未记录原因"}`),
        node("small", record.folder || record.source), node("small", new Date(record.completedAt).toLocaleString("zh-CN")));
      line.append(title);
      host.append(line);
    }
    $("discardPage").textContent = `${data.page} / ${data.pages}`;
    $("discardPagination").hidden = data.pages <= 1;
    $("discardPrev").disabled = data.page <= 1;
    $("discardNext").disabled = data.page >= data.pages;
  } catch (error) {
    if (request === discardStatsRequest) $("discardSummary").textContent = error.message;
  }
}

function showDiscardStats(show) {
  $("discardStats").hidden = !show;
  $("jobs").hidden = show;
  $("discardStatsToggle").textContent = show ? "返回迁移记录" : "丢弃统计";
  $("discardStatsToggle").setAttribute("aria-expanded", String(show));
  if (show) void refreshDiscardStats();
  else discardStatsRequest += 1;
}

async function refreshMarkedComparison(job) {
  const previous = comparison;
  const previousSource = previous?.source;
  const owner = generation;
  if (previous?.code !== job.code || $("code").value.trim() !== job.code) return;
  try {
    const result = await api("compare", { path: selected, code: previous.code, packageFolder: previous.package?.folder });
    if (owner !== generation || comparison !== previous || $("code").value.trim() !== job.code) return;
    if (previous.source !== previousSource) {
      result.source = previous.source;
      result.package = previous.package;
    }
    comparison = result;
    if (!result.files.some((file) => file.id === oldId && file.available)) oldId = result.files.find((file) => file.available)?.id || null;
    renderVersions(); renderTable(); updateActions();
  } catch { /* The incoming video can be removed while this job is running. */ }
}

function announce(job) {
  if (job.state === "completed") {
    doneCount += 1;
    const retained = job.result?.sourceFolderRemaining;
    message(job.result?.missingSource ? "原文件已不存在，已移除馆藏记录。" :
      `${actionLabel(job)}完成${job.target ? ` · ${job.target}` : ""}。${retained ? ` 下载包仍有保留文件：${retained}` : ""}`);
    if (job.action === "mark") void refreshMarkedComparison(job);
    if (job.action === "discardLibraryVideo") {
      const files = String(libraryFileList?.work.id) === job.workId ? libraryFileList : null;
      if (queue.has(job.source)) removeItem(job.source, Boolean(files));
      files?.reload();
    }
    if (job.action === "discard" && $("history").open && !$("discardStats").hidden) void refreshDiscardStats(discardPage);
  } else if (job.state !== "prepared") {
    const retry = job.action === "discardLibraryVideo" && dedicatedSubtitle ? " 可在视频洗版的迁移记录里重试。" : "";
    message((job.error || "任务已中断。") + retry, true);
  }
}

async function refreshJobs() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  let live = false;
  try {
    ({ jobs } = await api("jobs"));
    for (const job of jobs) {
      if (job.active) continue;
      if (job.state !== "prepared" && pendingLibraryDeletes.delete(job.id)) announce(job);
      else if (!dedicatedSubtitle && known.get(job.id)?.active) announce(job);
    }
    known = new Map(jobs.map((job) => [job.id, job]));
    renderTasks(); updateView();
    if ($("history").open) renderHistory();
    live = jobs.some((job) => job.active);
  } catch (error) {
    live = [...known.values()].some((job) => job.active);
    message(error.message, true);
  } finally {
    polling = false;
    updateLibraryDeleteButtons();
    if (live || pendingLibraryDeletes.size) pollTimer = setTimeout(refreshJobs, 1000);
  }
}

for (const form of document.querySelectorAll(".path-form:not(#librarySearchForm)")) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = form.querySelector("input");
    void addToQueue({ path: input.value.trim().replace(/^"|"$/g, "") });
    input.value = "";
  });
}
$("restoreQueueDraft").addEventListener("click", () => void restoreWashDraft());
$("clearQueueDraft").addEventListener("click", () => {
  if (draftRestore || dedicatedSubtitle) return;
  queueDraft = { entries: [], selected: "" };
  draftFailures = [];
  persistWashDraft();
  renderDraftPrompt();
});
window.addEventListener("pagehide", () => draftRestore?.abort());
for (const [triggers, picker] of [[["pickFiles", "addFiles"], "filePicker"], [["pickFolder", "addFolder"], "folderPicker"]]) {
  for (const trigger of triggers) $(trigger).addEventListener("click", () => $(picker).click());
  $(picker).addEventListener("change", (event) => {
    const files = [...event.target.files].filter((file) => videoExtension.test(file.name)).map((file) => fileDescriptor(file, file.webkitRelativePath));
    event.target.value = "";
    if (files.length) void addToQueue({ files });
    else message("没有选到支持的视频文件。", true);
  });
}
for (const type of ["dragenter", "dragover"]) {
  document.addEventListener(type, (event) => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    $("dropArea").classList.add("is-dragging");
  });
}
document.addEventListener("dragleave", (event) => { if (!event.relatedTarget) $("dropArea").classList.remove("is-dragging"); });
document.addEventListener("drop", async (event) => {
  event.preventDefault(); $("dropArea").classList.remove("is-dragging");
  try {
    const files = await droppedFiles(event.dataTransfer);
    if (!files.length) throw new Error("没有拖入支持的视频文件。");
    await addToQueue({ files });
  } catch (error) { message(error.message, true); }
});
$("codeForm").addEventListener("submit", (event) => { event.preventDefault(); if (selected) void selectItem(queue.get(selected), $("code").value.trim()); });
$("code").addEventListener("input", updateActions);
$("reviewMode").addEventListener("click", (event) => {
  const control = event.target.closest("button[data-mode]");
  if (control) switchReviewMode(control.dataset.mode);
});
$("subtitleCodeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selected) void selectItem(queue.get(selected), $("subtitleCode").value.trim());
});
$("subtitleOpenVideo").addEventListener("click", () => { if (selected) void openFile({ path: selected }, false); });
$("subtitleOpenFolder").addEventListener("click", () => { if (selected) void openFile({ path: selected }, true); });
$("actorTarget").addEventListener("change", updateActions);
$("downloadSourceSubtitle").addEventListener("click", () => void saveSourceSubtitle("subtitle-download-direct"));
$("searchSourceSubtitles").addEventListener("click", () => void withSubtitleReview("正在按番号查找字幕…", searchSubtitles));
$("importSourceSubtitle").addEventListener("click", () => $("sourceSubtitlePicker").click());
$("sourceSubtitlePicker").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) void saveSourceSubtitle("subtitle-import", () => readLocalSubtitle(file));
});
$("sourceSubtitles").addEventListener("cancel", (event) => { if (subtitleReview?.saving) event.preventDefault(); });
$("sourceSubtitles").addEventListener("close", () => { if (!subtitleReview?.inline && !$("sourceSubtitles").open) closeSubtitleReview(); });
$("openBoth").addEventListener("click", async () => {
  const old = comparison?.files.find((file) => file.id === oldId);
  if (!comparison || !old?.available) return;
  await openFile(comparison.source, false);
  await openFile(old, false);
});
async function fetchMetadataForSelection(detailUrl) {
  if (!comparison || isBusy() || $("code").value.trim() !== comparison.code) return;
  const owner = generation;
  busyOwner = owner; updateActions();
  try {
    if (await loadMetadata(owner, detailUrl)) message("资料已找到，请确认人物和目录。");
  } catch (error) { if (owner === generation) message(error.message, true); }
  finally { if (busyOwner === owner) busyOwner = -1; updateActions(); }
}
$("fetchMeta").addEventListener("click", () => fetchMetadataForSelection());
$("metadataUrlForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const detailUrl = $("metadataUrl").value.trim();
  if (detailUrl) void fetchMetadataForSelection(detailUrl);
});
for (const id of ["replace", "keep", "addNew", "discard", "discardBoth"]) {
  $(id).addEventListener("click", () => prepareAction(id === "addNew" ? "new" : id));
}
$("markLibrary").addEventListener("change", () => { $("markPreview").disabled = !Object.values(requestedMarks()).some(Boolean); });
$("markLibrary").addEventListener("close", () => {
  if ($("markLibrary").returnValue === "preview") void prepareAction("mark", requestedMarks());
});
$("confirm").addEventListener("close", () => {
  const current = confirmation;
  confirmation = null;
  if (current && $("confirm").returnValue === "run") {
    const decision = current.job.action === "discard" ? {
      reasons: [...$("discardChoices").querySelectorAll("input:checked")].map((input) => input.value),
      ltx: $("discardLtx").checked
    } : undefined;
    void submitJob(current.job, decision);
  }
  else if (current?.fresh) void cancelJob(current.job, false);
  $("confirm").returnValue = "";
});
for (const trigger of document.querySelectorAll(".open-history")) {
  trigger.addEventListener("click", async () => {
    await refreshJobs();
    renderHistory();
    showDiscardStats(false);
    $("history").showModal();
  });
}
$("discardStatsToggle").addEventListener("click", () => showDiscardStats($("discardStats").hidden));
$("discardFilter").addEventListener("change", () => void refreshDiscardStats());
$("onlyLtx").addEventListener("change", () => void refreshDiscardStats());
$("discardPrev").addEventListener("click", () => void refreshDiscardStats(discardPage - 1));
$("discardNext").addEventListener("click", () => void refreshDiscardStats(discardPage + 1));
if (dedicatedSubtitle) {
  const bench = $("bench");
  bench.dataset.dedicatedSubtitle = "";
  document.body.classList.add("subtitle-workbench");
  $("reviewPane").setAttribute("role", "dialog");
  $("reviewPane").setAttribute("aria-label", "字幕处理与播放确认");
  $("subtitleDrawerBar").hidden = false;
  $("closeSubtitleDrawer").addEventListener("click", closeSubtitleDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && bench.dataset.subtitleDrawer && !document.querySelector("dialog[open]")) closeSubtitleDrawer();
  });
  $("libraryCardStyles").media = "all";
  bench.prepend($("librarySearch"));
  $("librarySearch").querySelector("header").prepend(node("h1", "字幕工作台", "subtitle-workbench-title"));
  $("librarySearchActions").hidden = $("libraryBrowseTools").hidden = false;
  $("libraryPeople").hidden = false;
  $("libraryPeoplePanel").open = !matchMedia("(max-width: 720px)").matches;
  $("libraryLocalFiles").append($("dropArea").querySelector(".drop-controls"));
  $("libraryQueueTitle").append(" ", $("queueCount"));
  $("libraryQueue").append($("queue"));
  switchReviewMode("subtitle");
  librarySearch.browse();
}
renderQueue();
try {
  const config = await api("config");
  discardReasons = config.discardReasons || {};
  subtitleRemoval = config.subtitleRemoval === true;
  libraryVideoDeletion = config.libraryVideoDeletion === true;
  updateLibraryDeleteButtons();
  for (const [key, label] of [["", "全部原因"], ...Object.entries(discardReasons), ["unrecorded", "未记录原因"]]) {
    const option = node("option", label);
    option.value = key;
    option.dataset.label = label;
    $("discardFilter").append(option);
  }
  await refreshJobs();
} catch (error) { message(error.message, true); }
