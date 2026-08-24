import { loadModuleCatalog, renderWebModuleNavigation } from "/js/module-navigation.js";

const els = {
  breadcrumb: document.querySelector("#breadcrumb"),
  cacheTime: document.querySelector("#cacheTime"),
  contextMenu: document.querySelector("#contextMenu"),
  diskContent: document.querySelector("#diskContent"),
  driveGrid: document.querySelector("#driveGrid"),
  entryCount: document.querySelector("#entryCount"),
  entryList: document.querySelector("#entryList"),
  entryTitle: document.querySelector("#entryTitle"),
  folderDirectories: document.querySelector("#folderDirectories"),
  folderFiles: document.querySelector("#folderFiles"),
  folderSize: document.querySelector("#folderSize"),
  listViewTab: document.querySelector("#listViewTab"),
  mapViewTab: document.querySelector("#mapViewTab"),
  openCurrentButton: document.querySelector("#openCurrentButton"),
  pathSearch: document.querySelector("#pathSearch"),
  previewClose: document.querySelector("#previewClose"),
  previewDialog: document.querySelector("#previewDialog"),
  previewOpen: document.querySelector("#previewOpen"),
  previewPath: document.querySelector("#previewPath"),
  previewReveal: document.querySelector("#previewReveal"),
  previewStage: document.querySelector("#previewStage"),
  previewTitle: document.querySelector("#previewTitle"),
  productNav: document.querySelector("#productNav"),
  refreshButton: document.querySelector("#refreshButton"),
  scanStatus: document.querySelector("#scanStatus"),
  treemap: document.querySelector("#treemap"),
  upButton: document.querySelector("#upButton")
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".ts", ".m2ts", ".iso"]);
const DIRECT_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const MIN_TREEMAP_TILE_AREA = 72;
const formatter = new Intl.NumberFormat("zh-CN");

const state = {
  cacheScanId: "",
  contentView: "map",
  drives: [],
  linkedElements: new Map(),
  pollTimer: null,
  resizeTimer: null,
  searchTimer: null,
  selectedDriveId: "",
  selectedNode: null,
  tree: null
};

await Promise.allSettled([loadNavigation(), loadSummary()]);
installEvents();

async function loadNavigation() {
  const modules = await loadModuleCatalog(() => fetchJson("/api/modules"));
  const links = renderWebModuleNavigation(els.productNav, modules);
  for (const link of links) {
    const active = link.dataset.moduleId === "disk-usage" || new URL(link.href, window.location.href).pathname === "/disk-usage";
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function loadSummary(options = {}) {
  try {
    const payload = await fetchJson(`/api/disk-usage/summary?t=${Date.now()}`);
    state.drives = Array.isArray(payload.drives) ? payload.drives : [];
    renderDriveCards();
    if (!state.selectedDriveId && state.drives.length) {
      const first = state.drives.find((drive) => drive.cache) || state.drives.find((drive) => drive.capacity?.available) || state.drives[0];
      state.selectedDriveId = first.id;
      renderDriveCards();
      await loadTree(first.root);
    } else if (state.selectedDriveId) {
      const selected = selectedDrive();
      renderScanStatus(selected);
      if (options.reloadChangedCache && selected?.cache?.scanId && selected.cache.scanId !== state.cacheScanId) {
        await loadTree(state.tree?.path || selected.root, { fallbackToRoot: true });
      }
    }
    syncPolling();
  } catch (error) {
    showStatus(error.message, true);
  }
}

function renderDriveCards() {
  const fragment = document.createDocumentFragment();
  for (const drive of state.drives) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drive-card";
    button.classList.toggle("is-active", drive.id === state.selectedDriveId);
    button.classList.toggle("is-offline", !drive.capacity?.available);
    button.classList.toggle("is-scanning", ["scanning", "publishing"].includes(drive.task?.state));
    const capacity = drive.capacity || {};
    const usedPercent = capacity.total ? Math.min(100, Math.max(0, capacity.used / capacity.total * 100)) : 0;
    const cacheLabel = drive.task?.state === "scanning"
      ? `扫描 ${formatter.format(drive.task.progress?.nodes || 0)} 项`
      : drive.cacheNeedsRefresh
        ? "需刷新"
      : drive.cache
        ? "已有缓存"
        : "无缓存";
    const linkedLabel = (drive.monitoredLinks || []).map((value) => String(value).split(/[\\/]+/).filter(Boolean).at(-1)).filter(Boolean).join(" · ");
    const driveLabels = (drive.labels || []).join(" · ") || "监控磁盘";
    button.innerHTML = `
      <span class="drive-card__top">
        <strong class="drive-card__name">${escapeHtml(drive.name)}</strong>
        <span class="drive-card__cache">${escapeHtml(cacheLabel)}</span>
      </span>
      <span class="drive-card__labels">${escapeHtml(linkedLabel ? `${driveLabels} · 含 ${linkedLabel}` : driveLabels)}</span>
      <span class="capacity-track"><span style="width:${usedPercent.toFixed(2)}%"></span></span>
      <span class="drive-card__meta">
        <span>${capacity.available ? `${formatBytes(capacity.used)} 已用` : "当前不可访问"}</span>
        <span>${capacity.available ? `${formatBytes(capacity.free)} 可用` : "--"}</span>
      </span>`;
    button.addEventListener("click", () => selectDrive(drive.id));
    fragment.append(button);
  }
  els.driveGrid.replaceChildren(fragment);
}

async function selectDrive(driveId) {
  if (driveId === state.selectedDriveId && state.tree) return;
  state.selectedDriveId = driveId;
  state.tree = null;
  state.cacheScanId = "";
  els.pathSearch.value = "";
  renderDriveCards();
  const drive = selectedDrive();
  await loadTree(drive?.root || "");
}

async function loadTree(targetPath, options = {}) {
  const drive = selectedDrive();
  if (!drive) return;
  hideContextMenu();
  els.treemap.setAttribute("aria-busy", "true");
  try {
    if (!drive.cache) {
      state.tree = { cache: null, children: [], drive, node: null, path: drive.root };
    } else {
      const params = new URLSearchParams({ drive: drive.id, path: targetPath || drive.root, limit: "1400", depth: "7", t: String(Date.now()) });
      try {
        state.tree = await fetchJson(`/api/disk-usage/tree?${params}`);
      } catch (error) {
        if (!options.fallbackToRoot || targetPath === drive.root) throw error;
        params.set("path", drive.root);
        state.tree = await fetchJson(`/api/disk-usage/tree?${params}`);
      }
    }
    state.cacheScanId = state.tree.cache?.scanId || "";
    renderCurrentView();
  } catch (error) {
    state.tree = { cache: drive.cache, children: [], drive, node: null, path: targetPath || drive.root };
    renderCurrentView();
    showStatus(error.message, true);
  } finally {
    els.treemap.removeAttribute("aria-busy");
  }
}

function renderCurrentView() {
  state.linkedElements = new Map();
  renderBreadcrumb();
  renderFolderSummary();
  renderTreemap();
  renderEntries(state.tree?.children || [], "当前目录");
  renderScanStatus(selectedDrive());
}

function renderBreadcrumb() {
  const drive = selectedDrive();
  const currentPath = state.tree?.path || drive?.root || "";
  const parts = currentPath.slice((drive?.root || "").length).split(/[\\/]+/).filter(Boolean);
  const parentPath = state.tree?.node?.parentPath || "";
  els.upButton.disabled = !parentPath;
  els.upButton.title = parentPath ? `返回 ${parentPath}` : "已经在磁盘根目录";
  const fragment = document.createDocumentFragment();
  let accumulated = drive?.root || "";
  appendBreadcrumbButton(fragment, drive?.name || "磁盘", accumulated);
  for (const part of parts) {
    const separator = document.createElement("span");
    separator.className = "path-separator";
    separator.textContent = "›";
    fragment.append(separator);
    accumulated = `${accumulated.replace(/[\\/]+$/u, "")}\\${part}`;
    appendBreadcrumbButton(fragment, part, accumulated);
  }
  els.breadcrumb.replaceChildren(fragment);
}

function appendBreadcrumbButton(fragment, label, targetPath) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = targetPath;
  button.addEventListener("click", () => loadTree(targetPath));
  fragment.append(button);
}

function renderFolderSummary() {
  const node = state.tree?.node;
  els.folderSize.textContent = node ? formatBytes(node.size) : "--";
  els.folderFiles.textContent = node ? formatter.format(node.fileCount || 0) : "--";
  els.folderDirectories.textContent = node ? formatter.format(node.directoryCount || 0) : "--";
  els.cacheTime.textContent = state.tree?.cache?.completedAt ? formatDateTime(state.tree.cache.completedAt) : "尚未扫描";
}

function renderTreemap() {
  els.treemap.replaceChildren();
  if (state.contentView !== "map") return;
  const children = (state.tree?.children || []).filter((item) => Number(item.size) > 0);
  if (!state.tree?.cache) {
    renderTreemapEmpty("尚无磁盘缓存", "选择上方磁盘后点击“手动刷新缓存”。扫描在后台运行，完成前页面仍可正常使用。");
    return;
  }
  if (!children.length) {
    renderTreemapEmpty("当前文件夹没有可绘制内容", "空文件夹和 0 字节文件仍会保留在右侧目录列表中。");
    return;
  }

  const bounds = els.treemap.getBoundingClientRect();
  if (bounds.width < 10 || bounds.height < 10) {
    requestAnimationFrame(renderTreemap);
    return;
  }
  const mapBounds = { x: 4, y: 4, width: bounds.width - 8, height: bounds.height - 8 };
  const layouts = binaryTreemap(prepareTreemapItems(children, mapBounds, state.tree?.node), mapBounds);
  const fragment = document.createDocumentFragment();
  for (const layout of layouts) {
    if (layout.width < 2 || layout.height < 2) continue;
    const item = layout.item;
    fragment.append(shouldRenderGroup(item, layout) ? createTreemapGroup(item, layout, { depth: 1 }) : createTreemapNode(item, layout));
  }
  els.treemap.append(fragment);
}

function createTreemapGroup(item, layout, options = {}) {
  const depth = Number(options.depth || 1);
  const headerHeight = Math.max(15, Math.min(23, Math.round(layout.height * .2)));
  const group = document.createElement("section");
  group.className = `treemap-group is-depth-${Math.min(depth, 4)}`;
  group.style.cssText = rectangleStyle(layout);
  group.style.setProperty("--group-header-height", `${headerHeight}px`);
  group.title = `${item.path}\n${formatBytes(item.size)} · ${formatter.format(item.fileCount || 0)} 个文件`;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "treemap-group-header";
  header.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${formatBytes(item.size)}</span>`;
  installNodeEvents(header, item);
  group.append(header);

  const body = document.createElement("div");
  body.className = "treemap-group-body";
  const innerWidth = Math.max(0, layout.width - 2);
  const innerHeight = Math.max(0, layout.height - headerHeight - 2);
  const innerBounds = { x: 1, y: 1, width: innerWidth, height: innerHeight };
  const innerItems = prepareTreemapItems(item.treemapChildren, innerBounds, item);
  const innerLayouts = binaryTreemap(innerItems, innerBounds);
  for (const childLayout of innerLayouts) {
    if (childLayout.width < 2 || childLayout.height < 2) continue;
    body.append(shouldRenderGroup(childLayout.item, childLayout)
      ? createTreemapGroup(childLayout.item, childLayout, { depth: depth + 1 })
      : createTreemapNode(childLayout.item, childLayout, { secondary: true }));
  }
  group.append(body);
  return group;
}

function shouldRenderGroup(item, layout) {
  return !item.aggregate
    && Array.isArray(item.treemapChildren)
    && item.treemapChildren.length > 0
    && layout.width >= 42
    && layout.height >= 42;
}

function createTreemapNode(item, layout, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = [
    "treemap-node",
    item.isDirectory ? "is-directory" : "",
    options.secondary ? "is-secondary" : "",
    item.aggregate ? "is-aggregate" : ""
  ].filter(Boolean).join(" ");
  button.style.cssText = `${rectangleStyle(layout)}background:${nodeColor(item, options)};`;
  button.title = `${item.path}\n${formatBytes(item.size)}${item.isDirectory ? ` · ${formatter.format(item.fileCount || 0)} 个文件` : ""}`;
  if (layout.width >= 62 && layout.height >= 28) {
    const label = document.createElement("span");
    label.className = "treemap-label";
    label.textContent = item.name;
    button.append(label);
  }
  if (layout.width >= 74 && layout.height >= 50) {
    const size = document.createElement("span");
    size.className = "treemap-size";
    size.textContent = formatBytes(item.size);
    button.append(size);
  }
  installNodeEvents(button, item);
  return button;
}

function rectangleStyle(rectangle) {
  return `left:${rectangle.x}px;top:${rectangle.y}px;width:${rectangle.width}px;height:${rectangle.height}px;`;
}

function renderTreemapEmpty(title, detail) {
  const empty = document.createElement("div");
  empty.className = "treemap-empty";
  empty.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
  els.treemap.append(empty);
}

function renderEntries(items, title) {
  els.entryTitle.textContent = title;
  els.entryCount.textContent = `${formatter.format(items.length)} 项`;
  els.listViewTab.textContent = title === "搜索结果" ? `搜索结果 ${formatter.format(items.length)}` : "目录列表";
  els.entryList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "entry-empty";
    empty.textContent = title === "搜索结果" ? "没有找到匹配的缓存记录。" : "当前目录没有项目。";
    els.entryList.append(empty);
    return;
  }
  const maxSize = Math.max(1, ...items.map((item) => Number(item.size || 0)));
  const fragment = document.createDocumentFragment();
  for (const [index, item] of items.slice(0, 600).entries()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "entry-row";
    row.setAttribute("aria-label", `第 ${index + 1} 位，${item.name}，${formatBytes(item.size)}`);
    const countLabel = item.isDirectory ? `${formatter.format(item.fileCount || 0)} 文件 · ${formatter.format(item.directoryCount || 0)} 文件夹` : (item.extension || "文件").slice(1).toUpperCase() || "文件";
    row.innerHTML = `
      <span class="entry-bar" style="width:${Math.max(1, Number(item.size || 0) / maxSize * 100).toFixed(2)}%"></span>
      <span class="entry-rank" aria-hidden="true">${index + 1}</span>
      <span class="entry-main"><span class="entry-name">${escapeHtml(item.name)}</span><span class="entry-meta">${escapeHtml(countLabel)}</span></span>
      <span class="entry-size">${formatBytes(item.size)}</span>`;
    row.title = item.path;
    installNodeEvents(row, item);
    fragment.append(row);
  }
  els.entryList.append(fragment);
}

function installNodeEvents(element, item) {
  if (item.aggregate) return;
  registerLinkedElement(element, item);
  element.addEventListener("click", () => activateNode(item));
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, item);
  });
}

function registerLinkedElement(element, item) {
  if (item.aggregate || !item.path) return;
  const key = item.path.toLocaleLowerCase("zh-CN");
  const linked = state.linkedElements.get(key) || [];
  linked.push(element);
  state.linkedElements.set(key, linked);
  const highlight = (active) => linked.forEach((candidate) => candidate.isConnected && candidate.classList.toggle("is-linked", active));
  element.addEventListener("pointerenter", () => highlight(true));
  element.addEventListener("pointerleave", () => highlight(false));
  element.addEventListener("focus", () => highlight(true));
  element.addEventListener("blur", () => highlight(false));
}

function activateNode(item) {
  if (item.isDirectory) {
    els.pathSearch.value = "";
    loadTree(item.path);
    return;
  }
  if (previewKind(item) === "video") openVideoPlayer(item);
  else if (previewKind(item)) openPreview(item);
  else openSystemPath(item, "open");
}

function showContextMenu(x, y, item) {
  state.selectedNode = item;
  const actions = [];
  if (item.isDirectory) actions.push(["进入此文件夹", () => loadTree(item.path)]);
  else if (previewKind(item) === "video") actions.push(["使用番号播放器", () => openVideoPlayer(item)]);
  else if (previewKind(item)) actions.push(["预览", () => openPreview(item)]);
  actions.push([item.isDirectory ? "打开文件夹" : "使用系统打开", () => openSystemPath(item, "open")]);
  actions.push(["在资源管理器中定位", () => openSystemPath(item, "reveal")]);
  actions.push(["复制完整路径", () => copyPath(item.path)]);

  els.contextMenu.replaceChildren();
  actions.forEach(([label, action], index) => {
    if (index === actions.length - 1) els.contextMenu.append(document.createElement("hr"));
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = label;
    button.addEventListener("click", () => {
      hideContextMenu();
      action();
    });
    els.contextMenu.append(button);
  });
  els.contextMenu.hidden = false;
  const width = els.contextMenu.offsetWidth;
  const height = els.contextMenu.offsetHeight;
  els.contextMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x))}px`;
  els.contextMenu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, y))}px`;
}

function hideContextMenu() {
  els.contextMenu.hidden = true;
}

async function copyPath(targetPath) {
  try {
    await navigator.clipboard.writeText(targetPath);
    showStatus(`已复制：${targetPath}`);
  } catch {
    showStatus("浏览器未允许复制路径", true);
  }
}

function openPreview(item) {
  state.selectedNode = item;
  els.previewTitle.textContent = item.name;
  els.previewPath.textContent = item.path;
  els.previewStage.replaceChildren();
  const kind = previewKind(item);
  const params = new URLSearchParams({ drive: state.selectedDriveId, path: item.path });
  if (kind === "video" && !DIRECT_VIDEO_EXTENSIONS.has(item.extension)) params.set("mode", "transcode");
  const source = `/api/disk-usage/media?${params}`;
  let media;
  if (kind === "image") {
    media = document.createElement("img");
    media.alt = item.name;
  } else if (kind === "audio") {
    media = document.createElement("audio");
    media.controls = true;
    media.autoplay = true;
  } else {
    media = document.createElement("video");
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
  }
  media.src = source;
  els.previewStage.append(media);
  els.previewDialog.showModal();
}

function openVideoPlayer(item) {
  const params = new URLSearchParams({
    drive: state.selectedDriveId,
    path: item.path,
    redirect: "1"
  });
  window.open(`/api/disk-usage/playback-target?${params}`, "_blank", "noopener");
}

function closePreview() {
  const media = els.previewStage.querySelector("video, audio, img");
  if (media) {
    media.pause?.();
    media.removeAttribute("src");
    media.load?.();
  }
  els.previewStage.replaceChildren();
  if (els.previewDialog.open) els.previewDialog.close();
}

async function openSystemPath(item, action) {
  try {
    await fetchJson("/api/disk-usage/open", {
      method: "POST",
      body: JSON.stringify({ action, driveId: state.selectedDriveId, path: item.path }),
      headers: { "Content-Type": "application/json" }
    });
    showStatus(action === "reveal" ? `已定位：${item.name}` : `已打开：${item.name}`);
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function refreshSelectedDrive() {
  const drive = selectedDrive();
  if (!drive || !drive.capacity?.available) return;
  const confirmed = window.confirm(`重新扫描 ${drive.name} 的完整目录并更新缓存？\n\n扫描会在后台运行，旧缓存会保留到新缓存完整生成。`);
  if (!confirmed) return;
  try {
    const payload = await fetchJson("/api/disk-usage/refresh", {
      method: "POST",
      body: JSON.stringify({ driveId: drive.id }),
      headers: { "Content-Type": "application/json" }
    });
    drive.task = payload.task;
    renderDriveCards();
    renderScanStatus(drive);
    syncPolling();
  } catch (error) {
    showStatus(error.message, true);
  }
}

function renderScanStatus(drive) {
  const task = drive?.task;
  els.refreshButton.disabled = !drive?.capacity?.available || ["scanning", "publishing"].includes(task?.state);
  if (!task) {
    els.scanStatus.textContent = drive?.cacheNeedsRefresh
      ? `当前缓存还未包含 ${(drive.monitoredLinks || []).join("、")}，请手动刷新 ${drive.name} 缓存。`
      : drive?.cache
        ? "正在读取已保存缓存；不会自动检查磁盘变化。"
        : "该磁盘尚无缓存，点击“手动刷新缓存”开始第一次扫描。";
    els.scanStatus.classList.remove("is-error");
    return;
  }
  if (["scanning", "publishing"].includes(task.state)) {
    const progress = task.progress || {};
    els.scanStatus.textContent = task.state === "publishing"
      ? "扫描完成，正在发布新缓存……"
      : `后台扫描中：${formatter.format(progress.files || 0)} 个文件，${formatter.format(progress.directories || 0)} 个文件夹，累计 ${formatBytes(progress.bytes || 0)} · ${progress.currentPath || drive.root}`;
    els.scanStatus.classList.remove("is-error");
  } else if (task.state === "failed") {
    els.scanStatus.textContent = `上次刷新失败：${task.error || "未知错误"}。旧缓存未受影响。`;
    els.scanStatus.classList.add("is-error");
  } else {
    els.scanStatus.textContent = "缓存刷新完成。页面继续使用已保存结果，不会自动重新扫描。";
    els.scanStatus.classList.remove("is-error");
  }
}

function syncPolling() {
  const hasActive = state.drives.some((drive) => ["scanning", "publishing"].includes(drive.task?.state));
  if (hasActive && !state.pollTimer) {
    state.pollTimer = window.setInterval(() => loadSummary({ reloadChangedCache: true }), 1500);
  } else if (!hasActive && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function installEvents() {
  els.upButton.addEventListener("click", navigateUp);
  els.refreshButton.addEventListener("click", refreshSelectedDrive);
  els.mapViewTab.addEventListener("click", () => setContentView("map"));
  els.listViewTab.addEventListener("click", () => setContentView("list"));
  els.openCurrentButton.addEventListener("click", () => {
    const node = state.tree?.node || { isDirectory: true, name: selectedDrive()?.name || "磁盘", path: state.tree?.path || selectedDrive()?.root };
    if (node.path) openSystemPath(node, "open");
  });
  els.pathSearch.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    const query = els.pathSearch.value.trim();
    if (!query) {
      renderEntries(state.tree?.children || [], "当前目录");
      return;
    }
    setContentView("list");
    state.searchTimer = setTimeout(() => searchCache(query), 280);
  });
  els.previewClose.addEventListener("click", closePreview);
  els.previewDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePreview();
  });
  els.previewOpen.addEventListener("click", () => state.selectedNode && openSystemPath(state.selectedNode, "open"));
  els.previewReveal.addEventListener("click", () => state.selectedNode && openSystemPath(state.selectedNode, "reveal"));
  document.addEventListener("pointerdown", (event) => {
    if (!els.contextMenu.hidden && !els.contextMenu.contains(event.target)) hideContextMenu();
  });
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(renderTreemap, 120);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Backspace" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    if (!state.tree?.node?.parentPath || els.previewDialog.open) return;
    event.preventDefault();
    navigateUp();
  });
}

function setContentView(view) {
  const next = view === "list" ? "list" : "map";
  state.contentView = next;
  const showMap = next === "map";
  els.mapViewTab.classList.toggle("active", showMap);
  els.mapViewTab.setAttribute("aria-selected", String(showMap));
  els.listViewTab.classList.toggle("active", !showMap);
  els.listViewTab.setAttribute("aria-selected", String(!showMap));
  document.querySelector("#treemapPanel").hidden = !showMap;
  document.querySelector("#entryPanel").hidden = showMap;
  if (showMap) requestAnimationFrame(renderTreemap);
}

function navigateUp() {
  const parentPath = state.tree?.node?.parentPath || "";
  if (!parentPath) return;
  els.pathSearch.value = "";
  loadTree(parentPath);
}

async function searchCache(query) {
  const drive = selectedDrive();
  if (!drive?.cache || query !== els.pathSearch.value.trim()) return;
  try {
    const params = new URLSearchParams({ drive: drive.id, q: query, limit: "120", t: String(Date.now()) });
    const payload = await fetchJson(`/api/disk-usage/search?${params}`);
    if (query !== els.pathSearch.value.trim()) return;
    renderEntries(payload.items || [], "搜索结果");
  } catch (error) {
    showStatus(error.message, true);
  }
}

function binaryTreemap(items, bounds) {
  const positive = items.filter((item) => Number(item.size) > 0);
  const regular = positive.filter((item) => !item.aggregate).sort((a, b) => b.size - a.size);
  const aggregate = positive.filter((item) => item.aggregate).sort((a, b) => b.size - a.size);
  const result = [];
  layoutBinary([...regular, ...aggregate], bounds, result);
  return result;
}

function prepareTreemapItems(items, bounds, parentItem) {
  const positive = (items || []).filter((item) => Number(item.size) > 0);
  if (positive.length <= 1) return positive;
  const regular = positive.filter((item) => !item.aggregate).sort((a, b) => b.size - a.size);
  const existingAggregate = positive.filter((item) => item.aggregate);
  const total = positive.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const area = Math.max(1, bounds.width * bounds.height);
  const maximumVisible = Math.max(1, Math.floor(area / MIN_TREEMAP_TILE_AREA));
  const visible = [];
  const collapsed = [];

  for (const item of regular) {
    const projectedArea = Number(item.size || 0) / total * area;
    if ((!visible.length || projectedArea >= MIN_TREEMAP_TILE_AREA) && visible.length < maximumVisible) visible.push(item);
    else collapsed.push(item);
  }

  const aggregateItems = [...existingAggregate, ...collapsed];
  const aggregateSize = aggregateItems.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (!aggregateSize) return visible;
  const aggregateCount = aggregateItems.reduce((sum, item) => sum + Number(item.aggregateCount || 1), 0);
  return [...visible, {
    aggregate: true,
    aggregateCount,
    depth: Number(parentItem?.depth || 0) + 1,
    directoryCount: 0,
    errorCount: 0,
    extension: "",
    fileCount: aggregateCount,
    isDirectory: true,
    modifiedMs: 0,
    name: `其他 ${formatter.format(aggregateCount)} 项`,
    parentPath: parentItem?.path || "",
    path: parentItem?.path || "",
    size: aggregateSize
  }];
}

function layoutBinary(items, bounds, result) {
  if (!items.length || bounds.width < 1 || bounds.height < 1) return;
  if (items.length === 1) {
    result.push({ item: items[0], ...bounds });
    return;
  }

  const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.size || 0)), 0);
  if (!total) return;
  const target = total / 2;
  let running = 0;
  let splitIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < items.length; index += 1) {
    running += Number(items[index - 1].size || 0);
    const distance = Math.abs(target - running);
    if (distance <= bestDistance) {
      bestDistance = distance;
      splitIndex = index;
    } else {
      break;
    }
  }

  const first = items.slice(0, splitIndex);
  const second = items.slice(splitIndex);
  const firstSize = first.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const ratio = Math.min(.9999, Math.max(.0001, firstSize / total));
  if (bounds.width >= bounds.height) {
    const firstWidth = bounds.width * ratio;
    layoutBinary(first, { x: bounds.x, y: bounds.y, width: firstWidth, height: bounds.height }, result);
    layoutBinary(second, { x: bounds.x + firstWidth, y: bounds.y, width: bounds.width - firstWidth, height: bounds.height }, result);
  } else {
    const firstHeight = bounds.height * ratio;
    layoutBinary(first, { x: bounds.x, y: bounds.y, width: bounds.width, height: firstHeight }, result);
    layoutBinary(second, { x: bounds.x, y: bounds.y + firstHeight, width: bounds.width, height: bounds.height - firstHeight }, result);
  }
}

function selectedDrive() {
  return state.drives.find((drive) => drive.id === state.selectedDriveId) || null;
}

function previewKind(item) {
  const extension = String(item.extension || "").toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return "";
}

function nodeColor(item, options = {}) {
  if (item.aggregate) return "#46554f";
  if (item.isDirectory) return options.secondary ? "#a95722" : "#286a55";
  const kind = previewKind(item);
  if (kind === "video") return "#bf6427";
  if (kind === "audio") return "#6752a3";
  if (kind === "image") return "#2b7695";
  if ([".zip", ".rar", ".7z", ".cbz"].includes(item.extension)) return "#8b7025";
  return "#59645f";
}

function showStatus(message, isError = false) {
  els.scanStatus.textContent = message;
  els.scanStatus.classList.toggle("is-error", isError);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function formatBytes(bytes) {
  let value = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}
