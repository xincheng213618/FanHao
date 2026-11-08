const prefix = "/api/fanhao/file-workflows/intake/";
const videoExtension = /\.(?:mp4|mkv|avi|mov|wmv|flv|m4v|ts|m2ts|webm|mpg|mpeg)$/i;
const $ = (id) => document.getElementById(id);
const queue = new Map();
const actionLabels = { replace: "替换馆藏视频", keep: "两份都保留", new: "新番号入库", discard: "丢弃源视频", discardBoth: "两份都删除", mark: "馆藏标记重命名" };
const actionLabel = (job) => job.action === "discard" && job.package ? "丢弃整个文件夹" : actionLabels[job.action];
const isDiscard = (action) => action === "discard" || action === "discardBoth";
const markFields = [["markLtx", "ltx", "ltx"], ["markU", "u", "uncensored"], ["markC", "c", "subtitled"]];
const stateLabels = { prepared: "待确认", queued: "排队中", working: "迁移中", committed: "已入库 · 待收尾", interrupted: "执行中断", completed: "已完成", blocked: "待处理" };
const phaseLabels = { prepare: "准备", copy: "传输文件", verify: "校验", publish: "写入馆藏", cleanup: "清理并刷新馆藏", delete: "删除" };
const failedStates = new Set(["committed", "interrupted", "blocked"]);
let selected = "", comparison = null, oldId = null, generation = 0, busyOwner = -1, confirmation = null;
let discardReasons = {}, discardPage = 1, discardStatsRequest = 0;
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

async function api(route, body) {
  const response = await fetch(prefix + route, body === undefined ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  const tray = trayJobs();
  $("bench").dataset.view = queue.size || tray.length ? "work" : "drop";
  $("tasksPanel").hidden = !tray.length;
  $("doneCount").textContent = doneCount ? `本次完成 ${doneCount}` : "";
}

function renderQueue() {
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
    if (item.package) pick.append(node("small", `下载包 · ${item.package.videos.length} 份正片 · ${item.package.ads.length} 个广告`));
    if (item.error) pick.append(node("small", item.error, "error"));
    const remove = button("×", () => item.package ? discardPackage(item) : removeItem(item.path), "queue-drop");
    remove.title = item.package ? "移除并丢弃整个文件夹" : "从待核对移除（不动文件）";
    remove.setAttribute("aria-label", item.package ? `移除下载包 ${item.code}` : `从待核对移除 ${item.name}`);
    row.append(pick, remove);
    $("queue").append(row);
  }
  updateView();
}

function clearSelection(text) {
  generation += 1;
  selected = ""; comparison = null; oldId = null;
  $("compareBody").hidden = true; $("compareEmpty").hidden = false;
  $("compareEmpty").textContent = text;
}

// Removes a row and moves the review on, so a submitted video never blocks the next one.
function removeItem(file) {
  const wasSelected = selected === file;
  const next = wasSelected ? nextItem() : null;
  queue.delete(file);
  if (wasSelected) {
    if (next) void selectItem(next);
    else clearSelection("待办都已提交。可以继续把视频拖进窗口。");
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
    const lines = [[meta.actors?.join("、"), meta.date, meta.maker, meta.series, meta.rating ? `评分 ${meta.rating}` : ""].filter(Boolean).join(" · "), meta.tags?.join(" · ")];
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
const resolution = (file) => (file?.probe?.width ? `${file.probe.width}×${file.probe.height}` : "待确认");
const duration = (file) => (file?.probe?.duration ? timeLabel(file.probe.duration) : "未知");
const codecs = (file) => [file?.probe?.videoCodec, file?.probe?.audioCodec].filter(Boolean).map((value) => value.toUpperCase()).join(" / ") || "未知";

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
  if (file.available !== false) {
    const tools = node("div", undefined, "col-tools");
    tools.append(button("打开视频", () => openFile(file, false)), button("打开文件夹", () => openFile(file, true)));
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
  const usable = old?.available ? old : null;
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
  add("码率", valueCell(sourceBitrate ? `${sourceBitrate.toFixed(1)} Mbps` : "未知", bitrateTone,
    bitrateTone ? `${sourceBitrate > oldBitrate ? "+" : ""}${Math.round((sourceBitrate / oldBitrate - 1) * 100)}%` : ""),
  usable ? valueCell(oldBitrate ? `${oldBitrate.toFixed(1)} Mbps` : "未知") : unavailable());
  const sizeTone = tone(source.size, usable?.size);
  add("大小", valueCell(sizeLabel(source.size), sizeTone, sizeTone ? `${source.size > usable.size ? "+" : "−"}${sizeLabel(Math.abs(source.size - usable.size))}` : ""),
    usable ? valueCell(sizeLabel(usable.size)) : textCell(old ? sizeLabel(old.size) : ""));
  const gap = source.probe?.duration && usable?.probe?.duration ? Math.abs(source.probe.duration - usable.probe.duration) : 0;
  add("时长", valueCell(duration(source), gap >= 60 ? "warn" : "", gap >= 60 ? `相差 ${timeLabel(gap)}` : ""), usable ? valueCell(duration(usable), gap >= 60 ? "warn" : "") : unavailable());
  add("编码", valueCell(codecs(source)), usable ? valueCell(codecs(usable)) : unavailable());
  add("标记", chipsCell(source), old ? chipsCell(old) : textCell(""));
  add("路径", textCell(source.path, "path"), textCell(old?.path || "", "path"));
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
  $("openBoth").hidden = !usable || source.available === false;
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
    control.disabled = !file.available;
    control.checked = oldId === file.id;
    control.addEventListener("change", () => { oldId = file.id; $("tagA").checked = Boolean(file.a); renderTable(); updateActions(); });
    label.append(control, file.available ? `${resolution(file)} · ${sizeLabel(file.size)}${file.a ? " · [A]" : ""}` : "文件不可读");
    host.append(label);
  }
  if (moreFiles) host.append(node("span", "只显示前 40 份匹配视频。", "queue-empty"));
}

function updateActions() {
  const old = comparison?.files.find((file) => file.id === oldId);
  const newWork = comparison && !comparison.files.length;
  const edited = $("code").value.trim() !== (comparison?.code || "");
  const canMove = !isBusy() && !edited && Boolean(comparison?.source.probe);
  $("replace").hidden = $("keep").hidden = !comparison?.files.length;
  $("addNew").hidden = $("newWork").hidden = $("noExisting").hidden = !newWork;
  $("replace").disabled = !canMove || !old?.available;
  if ($("markSelected")) $("markSelected").disabled = isBusy() || edited;
  $("keep").disabled = !canMove || !old?.available;
  const recommendKeep = Boolean(old?.protected4k);
  $("keep").classList.toggle("primary", recommendKeep);
  $("replace").classList.toggle("primary", !recommendKeep);
  $("addNew").disabled = !canMove || !comparison?.code || (comparison.actors.length > 0 && $("actorTarget").value === "");
  $("fetchMeta").disabled = isBusy() || !comparison?.code || edited;
  $("discard").disabled = isBusy() || !comparison;
  $("discard").textContent = comparison?.package ? "丢弃整个文件夹" : "丢弃源视频";
  $("discardBoth").hidden = !old?.available;
  $("discardBoth").disabled = isBusy() || edited;
  $("qualityTag").hidden = !comparison?.source.flags?.quality4k;
  $("qualityTag").textContent = "实测 4K · 普通视频入库自动加 -4K";
  const hint = edited ? "番号已编辑，请先重新匹配。"
    : comparison && !comparison.source.probe ? "源视频探测失败，请先打开视频核对。"
      : recommendKeep ? "馆藏是 4K 或更高分辨率，推荐两份都保留。"
        : old?.available && !old.probe ? "馆藏参数暂未读取，核对后仍可替换。" : "";
  $("actionHint").textContent = hint;
  $("actionHint").hidden = !hint;
}

async function selectItem(item, code) {
  const owner = ++generation;
  selected = item.path; comparison = null; oldId = null;
  renderQueue();
  $("compareBody").hidden = true; $("compareEmpty").hidden = false;
  $("compareEmpty").textContent = "正在查找馆藏并读取视频参数…";
  try {
    const result = await api("compare", { path: item.path, code, packageFolder: item.package?.folder });
    if (owner !== generation) return;
    comparison = result;
    item.code = result.code;
    item.package = result.package;
    oldId = result.files.find((file) => file.available)?.id || null;
    $("code").value = result.code;
    $("tagLtx").checked = true;
    $("tagU").checked = Boolean(result.source.flags.uncensored);
    $("tagC").checked = Boolean(result.source.flags.subtitled);
    $("tagA").checked = Boolean(result.files.find((file) => file.id === oldId)?.a);
    $("compareBody").hidden = false; $("compareEmpty").hidden = true;
    renderVersions(); renderTable(); renderMetadata(); renderQueue(); updateActions();
  } catch (error) {
    if (owner === generation) $("compareEmpty").textContent = error.message;
  }
}

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
    const data = await api("scan", input);
    const live = new Set(jobs.filter((job) => job.active).map((job) => job.source));
    const items = data.items.filter((item) => !live.has(item.path));
    let refresh = null;
    for (const item of items) {
      if (queue.has(item.path) && !item.package) continue;
      if (item.package && selected === item.path && !queue.get(item.path)?.package) refresh = item;
      queue.set(item.path, item);
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
  if ($("history").open) $("history").close();
  $("confirmTitle").textContent = actionLabel(job);
  $("confirmText").textContent = job.action === "discardBoth"
    ? `这会永久删除${job.package ? "整个下载包" : "待迁移视频"}和所选馆藏文件夹。馆藏文件夹里有 ${job.libraryRemoval.videos} 份视频，共 ${job.libraryRemoval.files} 个文件。`
    : job.action === "discard" ? (job.package ? "这会永久删除整个下载包及其所有内容。" : "这会永久删除这个源视频。")
    : job.action === "mark" ? "确认后立即重命名所选馆藏及同名外挂字幕，并同步馆藏索引。"
      : job.package ? `移动 ${job.package.videos.length} 份正片和配套字幕。入库后清理已核对的下载包文件，新增或变动的文件会留在原目录。${job.replaces4k ? "所选旧馆藏为 4K 或更高分辨率，也会被移除。" : job.old ? "所选旧馆藏也会被移除。" : ""}`
      : job.replaces4k ? "所选馆藏为 4K 或更高分辨率。新视频校验并写入馆藏后，会移除这份馆藏和源文件。"
      : job.action === "replace" ? "新视频校验并写入馆藏后，会移除所选旧视频和源文件。"
        : "校验并写入馆藏后，会移除源文件。";
  if (job.oldQualityUnknown) {
    $("confirmText").textContent = `旧馆藏参数未能读取。请核对所选文件后确认替换。${$("confirmText").textContent}`;
  }
  $("confirmPaths").replaceChildren();
  const paths = job.action === "discardBoth" ? [
    [job.package ? "将删除的下载包" : "将删除的源视频", job.package?.folder || job.source],
    ["将删除的馆藏文件夹", job.libraryRemoval.folder]
  ] : job.action === "mark" ? [["当前馆藏", job.source], ["新文件名", job.target]]
    : [[job.package ? "将删除的源文件夹" : "源文件", job.package?.folder || job.source], ["替换的旧视频", job.old], ["入库位置", job.target]];
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
  (isDiscard(job.action) || job.replaces4k || job.oldQualityUnknown ? $("confirmBack") : $("confirmRun")).focus();
}

async function loadMetadata(owner) {
  const code = comparison.code;
  message("正在使用 115Chrome 查询 JavDB 资料…");
  const data = await api("metadata", { path: selected, code });
  if (owner !== generation || $("code").value.trim() !== code) return false;
  Object.assign(comparison, data);
  renderMetadata();
  return true;
}

async function prepareAction(action, tags) {
  if (!comparison || isBusy()) return;
  const owner = generation;
  busyOwner = owner; updateActions();
  try {
    if (action === "new") {
      if (!comparison.actors.length && !await loadMetadata(owner)) return;
      if (!comparison.actors.length) throw new Error("资料已找到，但没有可用的归档目录");
      if ($("actorTarget").value === "") {
        message("资料已找到，请选择人物和归档目录。");
        $("actorTarget").focus();
        return;
      }
    }
    const actor = comparison.actors[Number($("actorTarget").value)];
    const old = comparison.files.find((file) => file.id === oldId);
    const job = await api("prepare", { action, path: selected, code: action === "discard" ? undefined : comparison.code,
      packageFolder: comparison.package?.folder, packageFingerprint: comparison.package?.fingerprint,
      packageMediaFingerprint: comparison.package?.mediaFingerprint, supportsPackageConfirmation: true,
      sourceSignature: comparison.source.signature, oldId, oldSignature: old?.signature, actorFolder: actor?.folder, actorName: actor?.name,
      tags: tags || { ltx: $("tagLtx").checked, u: $("tagU").checked, c: $("tagC").checked, a: $("tagA").checked } });
    if (owner === generation) askConfirmation(job, true);
    else await cancelJob(job, false);
  } catch (error) { if (owner === generation) message(error.message, true); }
  finally { if (busyOwner === owner) busyOwner = -1; updateActions(); }
}

async function discardPackage(item) {
  if (isBusy()) return;
  if (selected !== item.path || !comparison?.package) await selectItem(item);
  if (selected === item.path && comparison?.package) await prepareAction("discard");
}

async function submitJob(job, discardDecision) {
  known.set(job.id, { ...job, active: true });
  try {
    await api(`jobs/${job.id}/run`, { discardDecision });
    if (queue.has(job.source)) removeItem(job.source);
    message(`${job.code || "视频"}${isDiscard(job.action) ? " 已提交删除。" : job.action === "mark" ? " 正在重命名馆藏。" : " 已提交到执行队列。"}`);
  } catch (error) { known.delete(job.id); message(error.message, true); }
  await refreshJobs();
}

async function cancelJob(job, requeue = true) {
  try {
    const result = await api(`jobs/${job.id}/cancel`, {});
    known.delete(job.id);
    if (result.cancelled && requeue && job.action !== "mark" && !queue.has(job.source)) {
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
  const owner = generation;
  if (previous?.code !== job.code || $("code").value.trim() !== job.code) return;
  try {
    const result = await api("compare", { path: selected, code: previous.code, packageFolder: previous.package?.folder });
    if (owner !== generation || comparison !== previous || $("code").value.trim() !== job.code) return;
    comparison = result;
    if (!result.files.some((file) => file.id === oldId && file.available)) oldId = result.files.find((file) => file.available)?.id || null;
    renderVersions(); renderTable(); updateActions();
  } catch { /* The incoming video can be removed while this job is running. */ }
}

function announce(job) {
  if (job.state === "completed") {
    doneCount += 1;
    const retained = job.result?.sourceFolderRemaining;
    message(`${actionLabel(job)}完成${job.target ? ` · ${job.target}` : ""}。${retained ? ` 下载包仍有保留文件：${retained}` : ""}`);
    if (job.action === "mark") void refreshMarkedComparison(job);
    if (job.action === "discard" && $("history").open && !$("discardStats").hidden) void refreshDiscardStats(discardPage);
  } else if (job.state !== "prepared") message(job.error || "任务已中断，可在执行队列中重试。", true);
}

async function refreshJobs() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  let live = false;
  try {
    ({ jobs } = await api("jobs"));
    for (const job of jobs) if (known.get(job.id)?.active && !job.active) announce(job);
    known = new Map(jobs.map((job) => [job.id, job]));
    renderTasks(); updateView();
    if ($("history").open) renderHistory();
    live = jobs.some((job) => job.active);
  } catch (error) {
    live = [...known.values()].some((job) => job.active);
    message(error.message, true);
  } finally {
    polling = false;
    if (live) pollTimer = setTimeout(refreshJobs, 1000);
  }
}

for (const form of document.querySelectorAll(".path-form")) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = form.querySelector("input");
    void addToQueue({ path: input.value.trim().replace(/^"|"$/g, "") });
    input.value = "";
  });
}
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
$("actorTarget").addEventListener("change", updateActions);
$("openBoth").addEventListener("click", async () => {
  const old = comparison?.files.find((file) => file.id === oldId);
  if (!comparison || !old?.available) return;
  await openFile(comparison.source, false);
  await openFile(old, false);
});
$("fetchMeta").addEventListener("click", async () => {
  if (!comparison) return;
  const owner = generation;
  busyOwner = owner; updateActions();
  try {
    if (await loadMetadata(owner)) message("资料已找到，请确认人物和目录。");
  } catch (error) { if (owner === generation) message(error.message, true); }
  finally { if (busyOwner === owner) busyOwner = -1; updateActions(); }
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
renderQueue();
try {
  const config = await api("config");
  discardReasons = config.discardReasons || {};
  for (const [key, label] of [["", "全部原因"], ...Object.entries(discardReasons), ["unrecorded", "未记录原因"]]) {
    const option = node("option", label);
    option.value = key;
    option.dataset.label = label;
    $("discardFilter").append(option);
  }
  await refreshJobs();
} catch (error) { message(error.message, true); }
