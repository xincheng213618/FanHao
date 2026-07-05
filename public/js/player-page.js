import { createApiClient, addQueryParam } from "./api.js?v=20260701-gallery-merge-01";

const api = createApiClient();
const params = new URLSearchParams(window.location.search);
const workId = params.get("workId") || "";
const requestedVideoId = params.get("videoId") || "";

const els = {
  title: document.querySelector("#playerTitle"),
  notice: document.querySelector("#playerNotice"),
  video: document.querySelector("#playerVideo"),
  files: document.querySelector("#playerFiles"),
  meta: document.querySelector("#playerMeta"),
  back: document.querySelector("#backButton"),
  markerA: document.querySelector("#markerAButton"),
  correctActor: document.querySelector("#correctActorButton"),
  moveToPerson: document.querySelector("#moveToPersonButton"),
  openFile: document.querySelector("#openFileButton"),
  deleteLocal: document.querySelector("#deleteLocalButton"),
  javdb: document.querySelector("#javdbLink")
};

let currentWork = null;
let currentVideo = null;
let progressTimer = null;
let lastProgressReport = 0;

els.back?.addEventListener("click", () => {
  if (window.opener && !window.opener.closed) {
    window.close();
    return;
  }
  window.location.href = "/";
});

els.openFile?.addEventListener("click", () => {
  openCurrentLocalFolder();
});

els.markerA?.addEventListener("click", () => {
  toggleLocalMarker("A");
});

els.deleteLocal?.addEventListener("click", () => {
  deleteCurrentLocalFiles();
});

els.correctActor?.addEventListener("click", () => {
  correctCurrentActorFromFolder();
});

els.moveToPerson?.addEventListener("click", () => {
  moveCurrentWorkToPerson();
});

window.addEventListener("beforeunload", () => {
  reportProgress();
});

load();

async function load() {
  if (!workId) {
    showNotice("缺少 workId");
    return;
  }
  try {
    const data = await api(`/api/works/${encodeURIComponent(workId)}`);
    currentWork = data.work;
    document.title = `${currentWork.title} - FanHao`;
    els.title.textContent = currentWork.title;
    renderFiles(currentWork);
    renderMeta(currentWork);
    updateMarkerButton();
    updateDeleteLocalButton();
    updateCorrectActorButton();
    updateMoveToPersonButton();
    const video = selectInitialVideo(currentWork);
    if (!video) {
      showNotice("这个作品没有可播放的视频");
      return;
    }
    await playVideo(video);
  } catch (error) {
    showNotice(error.message || "读取作品失败");
  }
}

function selectInitialVideo(work) {
  const videos = work.videos || [];
  return (
    videos.find((video) => video.id === requestedVideoId) ||
    videos.find((video) => video.id === work.progress?.videoId) ||
    videos.find((video) => video.playable) ||
    videos[0] ||
    null
  );
}

function renderFiles(work) {
  els.files.innerHTML = "";
  for (const video of work.videos || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `player-file-button${video.id === currentVideo?.id ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = video.name || video.title || "视频";
    button.querySelector("span").textContent = `${formatLibraryPath(video.relativePath)}${video.progress?.percent ? ` · ${Math.floor(video.progress.percent)}%` : ""}`;
    button.addEventListener("click", () => playVideo(video));
    els.files.append(button);
  }
}

async function playVideo(video) {
  reportProgress();
  stopProgressTimer();
  currentVideo = video;
  renderFiles(currentWork);
  updateOpenFileButton();
  updateDeleteLocalButton();
  showNotice("正在准备播放");
  els.video.hidden = true;
  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();

  try {
    const playInfo = await api(`/api/playinfo/${encodeURIComponent(video.id)}`);
    const savedProgress = video.progress || (currentWork.progress?.videoId === video.id ? currentWork.progress : null);
    const resumePosition = savedProgress?.position > 5 ? Number(savedProgress.position) : 0;
    let streamUrl = playInfo.streamUrl;
    if (playInfo.mode !== "direct" && resumePosition > 0) {
      streamUrl = addQueryParam(streamUrl, "t", Math.floor(resumePosition));
    }
    els.video.src = streamUrl;
    els.video.hidden = false;
    els.notice.hidden = true;
    if (playInfo.mode === "direct" && resumePosition > 0) {
      els.video.addEventListener(
        "loadedmetadata",
        () => {
          if (Number.isFinite(resumePosition) && resumePosition < els.video.duration) {
            els.video.currentTime = resumePosition;
          }
        },
        { once: true }
      );
    }
    startProgressTimer();
  } catch (error) {
    showNotice(error.message || "播放失败");
  }
}

function renderMeta(work) {
  const info = work.infoSummary || {};
  els.meta.innerHTML = "";
  appendMeta("番号", info.code || "");
  appendMeta("标题", info.title || work.title || "");
  appendMeta("日期", info.releaseDate || "");
  appendMeta("时长", info.durationMinutes ? `${info.durationMinutes} 分钟` : "");
  appendMeta("评分", info.rating ? `${info.rating} 分${info.ratingCount ? `，${info.ratingCount} 人评价` : ""}` : "");
  const actors = actorItems(work);
  if (actors.length) {
    appendEntityRow("演员", actors);
  } else {
    appendMeta("演员", work.personDisplayName || "");
  }
  const makers = makerItems(work);
  if (makers.length) appendEntityRow("片商", makers);
  const series = seriesItems(work);
  if (series.length) appendEntityRow("系列", series);
  const tags = tagItems(work);
  if (tags.length) appendEntityRow("标签", tags);
  const url = info.javdbUrl || work.javdbUrl || "";
  if (url) {
    els.javdb.href = url;
    els.javdb.hidden = false;
  }
}

function appendMeta(label, value) {
  const text = String(value || "").trim();
  if (!text) return;
  const row = document.createElement("div");
  row.className = "player-meta-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("span");
  val.textContent = text;
  row.append(key, val);
  els.meta.append(row);
}

function appendEntityRow(label, items) {
  const row = document.createElement("div");
  row.className = "player-entity-row";
  const key = document.createElement("span");
  key.textContent = label;
  const chips = document.createElement("div");
  chips.className = "player-entity-chips";

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-entity-chip";
    button.textContent = item.name;
    button.title = item.personId ? `返回人物：${item.name}` : item.url ? `打开：${item.url}` : `返回搜索：${item.name}`;
    button.addEventListener("click", () => {
      if (item.personId) {
        navigateLibrary(`/?personId=${encodeURIComponent(item.personId)}`);
      } else if (item.url) {
        window.open(item.url, "_blank", "noreferrer");
      } else {
        navigateLibrary(`/?q=${encodeURIComponent(item.name)}`);
      }
    });
    chips.append(button);
  }

  row.append(key, chips);
  els.meta.append(row);
}

function actorItems(work) {
  const info = work.infoSummary || {};
  const linkMap = entityLinkMap(info.actorLinks || work.infoMetadata?.actorLinks || []);
  const actors = uniqueTextList(info.actors || []);
  if (actors.length) {
    return actors.map((name) => ({ name, personId: matchingPersonId(name, work), url: linkMap.get(entityKey(name)) || "" }));
  }
  const fallback = work.personDisplayName || work.personName || "";
  return fallback ? [{ name: fallback, personId: work.personId || "" }] : [];
}

function tagItems(work) {
  const info = work.infoSummary || {};
  const linkMap = entityLinkMap(info.tagLinks || work.infoMetadata?.tagLinks || []);
  const tags = Array.isArray(info.tags) && info.tags.length ? info.tags : work.infoMetadata?.tags || [];
  return uniqueTextList(tags).map((name) => ({ name, url: linkMap.get(entityKey(name)) || "" }));
}

function makerItems(work) {
  const info = work.infoSummary || {};
  return uniqueEntityItems([
    { name: info.maker, url: cleanRemoteUrl(info.makerUrl || work.infoMetadata?.makerUrl) },
    { name: info.label, url: cleanRemoteUrl(info.labelUrl || work.infoMetadata?.labelUrl) }
  ]);
}

function seriesItems(work) {
  const info = work.infoSummary || {};
  return uniqueEntityItems([{ name: info.series, url: cleanRemoteUrl(info.seriesUrl || work.infoMetadata?.seriesUrl) }]);
}

function matchingPersonId(name, work) {
  return sameText(name, work.personDisplayName) || sameText(name, work.personName) ? work.personId || "" : "";
}

function uniqueTextList(values) {
  const seen = new Set();
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
  }
  return list;
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function uniqueEntityItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const key = entityKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...item, name });
  }
  return output;
}

function entityLinkMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name || item?.label || item?.text || "").trim();
    const url = cleanRemoteUrl(item?.url || item?.href || "");
    if (name && url) map.set(entityKey(name), url);
  }
  return map;
}

function entityKey(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanRemoteUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function navigateLibrary(url) {
  if (window.opener && !window.opener.closed) {
    window.opener.location.href = url;
    window.opener.focus?.();
    window.close();
    return;
  }
  window.location.href = url;
}

async function toggleLocalMarker(marker) {
  if (!els.markerA || !currentWork?.id) return;
  const key = String(marker || "").toUpperCase();
  const nextEnabled = !(currentWork.localMarkers || []).includes(key);
  const originalText = els.markerA.textContent;
  els.markerA.disabled = true;
  els.markerA.textContent = nextEnabled ? "标记中" : "移除中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/local-marker`, {
      method: "POST",
      body: { marker: key, enabled: nextEnabled }
    });
    if (data.work) {
      currentWork = data.work;
      document.title = `${currentWork.title} - FanHao`;
      els.title.textContent = currentWork.title;
      currentVideo = (currentWork.videos || []).find((video) => video.id === currentVideo?.id) || currentVideo;
      renderFiles(currentWork);
      renderMeta(currentWork);
    }
    updateMarkerButton();
    updateDeleteLocalButton();
    updateCorrectActorButton();
  } catch (error) {
    els.markerA.textContent = "标记失败";
    els.markerA.title = error.message || "标记失败";
    window.setTimeout(updateMarkerButton, 2000);
  } finally {
    els.markerA.disabled = false;
    if (els.markerA.textContent === originalText) updateMarkerButton();
  }
}

function updateMarkerButton() {
  if (!els.markerA) return;
  const active = (currentWork?.localMarkers || []).includes("A");
  els.markerA.hidden = !currentWork || Boolean(currentWork.missingLocal);
  els.markerA.classList.toggle("active", active);
  els.markerA.textContent = active ? "A 已标记" : "标记 A";
  els.markerA.title = active ? "移除 A 标记" : "添加 A 标记";
}

async function openCurrentLocalFolder() {
  if (!els.openFile || !currentVideo?.id || !isLocalFileOpenAvailable()) return;
  const originalText = els.openFile.textContent;
  els.openFile.disabled = true;
  els.openFile.textContent = "打开中";
  try {
    await api("/api/open-folder", { method: "POST", body: { videoId: currentVideo.id } });
    els.openFile.textContent = "已打开";
    window.setTimeout(() => {
      els.openFile.textContent = originalText;
      els.openFile.disabled = false;
    }, 1200);
  } catch (error) {
    els.openFile.textContent = "打开失败";
    els.openFile.title = error.message || "打开失败";
    window.setTimeout(() => {
      els.openFile.textContent = originalText;
      els.openFile.disabled = false;
      updateOpenFileButton();
    }, 2000);
  }
}

function updateOpenFileButton() {
  if (!els.openFile) return;
  const available = isLocalFileOpenAvailable() && Boolean(currentVideo?.id);
  els.openFile.hidden = !available;
  els.openFile.disabled = !available;
  els.openFile.textContent = "打开文件夹";
  els.openFile.title = available ? formatLibraryPath(currentVideo.relativePath) : "";
}

function updateDeleteLocalButton() {
  if (!els.deleteLocal) return;
  const available = isTrustedNetworkFeatureAvailable() && currentWork && !currentWork.missingLocal;
  els.deleteLocal.hidden = !available;
  els.deleteLocal.disabled = !available;
  els.deleteLocal.textContent = "删除本地文件";
  els.deleteLocal.title = available ? "删除这个作品的本地文件夹，并保留资料库记录" : "";
}

function updateCorrectActorButton() {
  if (!els.correctActor) return;
  const available = isTrustedNetworkFeatureAvailable() && currentWork && !currentWork.missingLocal;
  els.correctActor.hidden = !available;
  els.correctActor.disabled = !available;
  els.correctActor.textContent = "订正演员";
  els.correctActor.title = available ? "按本地文件夹名订正这个作品的演员关联" : "";
}

function updateMoveToPersonButton() {
  if (!els.moveToPerson) return;
  const available = isTrustedNetworkFeatureAvailable() && currentWork && !currentWork.missingLocal;
  els.moveToPerson.hidden = !available;
  els.moveToPerson.disabled = !available;
  els.moveToPerson.textContent = "迁移演员";
  els.moveToPerson.title = available ? "移动作品文件夹，并把作品分配给指定人物" : "";
}

function parsePersonIdInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) return text;
  try {
    const url = new URL(text, window.location.origin);
    const queryId = url.searchParams.get("personId") || url.searchParams.get("person");
    if (queryId && /^\d+$/.test(queryId)) return queryId;
  } catch {}
  const match = /(?:personId|person)=([0-9]+)/i.exec(text);
  return match ? match[1] : "";
}

function safeFolderName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
}

async function libraryRootsForMove() {
  const data = await api("/api/library/roots");
  const roots = Array.isArray(data.availableRoots) && data.availableRoots.length ? data.availableRoots : data.roots || [];
  return {
    roots,
    defaultRoot: data.defaultRoot || roots[0] || ""
  };
}

function closeMoveDialog(overlay, result, resolve) {
  overlay.remove();
  resolve(result || null);
}

async function openMovePersonDialog() {
  const { roots, defaultRoot } = await libraryRootsForMove();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "player-move-backdrop";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("section");
    dialog.className = "player-move-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "迁移演员");

    const head = document.createElement("header");
    head.className = "player-move-head";
    const title = document.createElement("h2");
    title.textContent = "迁移演员";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    head.append(title, close);

    const body = document.createElement("div");
    body.className = "player-move-body";

    const tabs = document.createElement("div");
    tabs.className = "player-move-tabs";
    const existingTab = document.createElement("button");
    existingTab.type = "button";
    existingTab.textContent = "已有人物";
    const createTab = document.createElement("button");
    createTab.type = "button";
    createTab.textContent = "新建人物";
    tabs.append(existingTab, createTab);

    const existingPane = document.createElement("div");
    existingPane.className = "player-move-pane";
    const existingInput = document.createElement("input");
    existingInput.type = "text";
    existingInput.placeholder = "1199 或 http://127.0.0.1:29998/?personId=1199";
    existingPane.append(createMoveField("人物 ID / 链接", existingInput));

    const createPane = document.createElement("div");
    createPane.className = "player-move-pane";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "若葉結希";
    const javdbInput = document.createElement("input");
    javdbInput.type = "url";
    javdbInput.placeholder = "https://javdb.com/actors/...";
    const rootSelect = document.createElement("select");
    for (const root of roots) {
      const option = document.createElement("option");
      option.value = root;
      option.textContent = formatLibraryPath(root);
      rootSelect.append(option);
    }
    rootSelect.value = defaultRoot;
    const folderInput = document.createElement("input");
    folderInput.type = "text";
    folderInput.placeholder = "若葉結希";
    let folderTouched = false;
    nameInput.addEventListener("input", () => {
      if (!folderTouched) folderInput.value = safeFolderName(nameInput.value);
    });
    folderInput.addEventListener("input", () => {
      folderTouched = true;
    });
    createPane.append(
      createMoveField("演员名", nameInput),
      createMoveField("JavDB actor", javdbInput),
      createMoveField("保存硬盘", rootSelect),
      createMoveField("文件夹名", folderInput)
    );

    const status = document.createElement("div");
    status.className = "player-move-status";

    const foot = document.createElement("footer");
    foot.className = "player-move-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "primary";
    submit.textContent = "迁移";
    foot.append(status, cancel, submit);

    let mode = "existing";
    const renderMode = () => {
      existingTab.classList.toggle("active", mode === "existing");
      createTab.classList.toggle("active", mode === "create");
      existingPane.hidden = mode !== "existing";
      createPane.hidden = mode !== "create";
      status.textContent = "";
      window.setTimeout(() => (mode === "existing" ? existingInput : nameInput).focus(), 0);
    };
    existingTab.addEventListener("click", () => {
      mode = "existing";
      renderMode();
    });
    createTab.addEventListener("click", () => {
      mode = "create";
      renderMode();
    });

    close.addEventListener("click", () => closeMoveDialog(overlay, null, resolve));
    cancel.addEventListener("click", () => closeMoveDialog(overlay, null, resolve));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeMoveDialog(overlay, null, resolve);
    });
    document.addEventListener("keydown", function onKey(event) {
      if (!overlay.isConnected) {
        document.removeEventListener("keydown", onKey);
        return;
      }
      if (event.key === "Escape") closeMoveDialog(overlay, null, resolve);
    });

    submit.addEventListener("click", async () => {
      status.textContent = "";
      if (mode === "existing") {
        const personId = parsePersonIdInput(existingInput.value);
        if (!personId) {
          status.textContent = "人物 ID 无效";
          return;
        }
        submit.disabled = true;
        try {
          const data = await api(`/api/people/${encodeURIComponent(personId)}?limit=1`);
          closeMoveDialog(overlay, { mode, personId, person: data.person || null }, resolve);
        } catch (error) {
          status.textContent = error.message || "读取目标人物失败";
          submit.disabled = false;
        }
        return;
      }

      const name = nameInput.value.trim();
      const folderName = safeFolderName(folderInput.value || name);
      if (!name) {
        status.textContent = "请填写演员名";
        return;
      }
      if (!rootSelect.value) {
        status.textContent = "请选择保存硬盘";
        return;
      }
      if (!folderName) {
        status.textContent = "文件夹名无效";
        return;
      }
      closeMoveDialog(
        overlay,
        {
          mode,
          createPerson: {
            name,
            displayName: name,
            javdbUrl: javdbInput.value.trim(),
            rootPath: rootSelect.value,
            folderName
          },
          person: {
            name,
            relativePath: `${rootSelect.value.replace(/[\\/]+$/, "")}/${folderName}`
          }
        },
        resolve
      );
    });

    body.append(tabs, existingPane, createPane);
    dialog.append(head, body, foot);
    overlay.append(dialog);
    document.body.append(overlay);
    renderMode();
  });
}

function createMoveField(labelText, control) {
  const label = document.createElement("label");
  label.className = "player-move-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

async function moveCurrentWorkToPerson() {
  if (!els.moveToPerson || !currentWork?.id || currentWork.missingLocal || !isTrustedNetworkFeatureAvailable()) return;
  let target = null;
  try {
    target = await openMovePersonDialog();
  } catch (error) {
    showNotice(error.message || "打开迁移窗口失败");
    return;
  }
  if (!target) {
    return;
  }

  const pathText = formatLibraryPath(currentWork.relativePath || "");
  const targetPerson = target.person || null;
  const targetPath = formatLibraryPath(targetPerson?.relativePath || targetPerson?.sourcePaths?.[0] || "");
  const message = [
    "迁移这个作品到目标人物？",
    pathText,
    "",
    `目标人物：${targetPerson?.name || target.personId || target.createPerson?.name || ""}`,
    targetPath ? `目标文件夹：${targetPath}` : "",
    "",
    "会移动作品文件夹，并把这个作品分配给目标人物。"
  ].filter((line) => line !== "").join("\n");
  if (!window.confirm(message)) return;

  const originalText = els.moveToPerson.textContent;
  els.moveToPerson.disabled = true;
  els.moveToPerson.textContent = "释放播放";
  stopCurrentPlayback();
  await delay(1800);
  els.moveToPerson.textContent = "迁移中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/move-to-person`, {
      method: "POST",
      body: target.mode === "create" ? { createPerson: target.createPerson } : { personId: target.personId }
    });
    if (data.work) {
      currentWork = data.work;
      currentVideo = (currentWork.videos || []).find((video) => video.id === currentVideo?.id) || selectInitialVideo(currentWork);
      document.title = `${currentWork.title} - FanHao`;
      els.title.textContent = currentWork.title;
      renderFiles(currentWork);
      renderMeta(currentWork);
      updateMarkerButton();
      updateDeleteLocalButton();
      updateCorrectActorButton();
      updateMoveToPersonButton();
      updateOpenFileButton();
    }
    showNotice(`已迁移到：${data.person?.name || targetPerson?.name || target.personId || target.createPerson?.name}`);
  } catch (error) {
    els.moveToPerson.textContent = "迁移失败";
    els.moveToPerson.title = error.message || "迁移失败";
    showNotice(error.message || "迁移作品失败");
    window.setTimeout(() => {
      els.moveToPerson.textContent = originalText;
      els.moveToPerson.disabled = false;
      updateMoveToPersonButton();
    }, 2200);
  }
}

async function correctCurrentActorFromFolder() {
  if (!els.correctActor || !currentWork?.id || currentWork.missingLocal || !isTrustedNetworkFeatureAvailable()) return;
  const pathText = formatLibraryPath(currentWork.relativePath || "");
  const message = [
    "按本地文件夹订正演员？",
    pathText,
    "",
    "会把这个作品的演员关联替换成文件夹中的人物名，作品文件不会移动。"
  ].filter((line) => line !== "").join("\n");
  if (!window.confirm(message)) return;

  const originalText = els.correctActor.textContent;
  els.correctActor.disabled = true;
  els.correctActor.textContent = "订正中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/correct-actor-from-folder`, { method: "POST" });
    if (data.work) {
      currentWork = data.work;
      currentVideo = (currentWork.videos || []).find((video) => video.id === currentVideo?.id) || currentVideo;
      document.title = `${currentWork.title} - FanHao`;
      els.title.textContent = currentWork.title;
      renderFiles(currentWork);
      renderMeta(currentWork);
      updateMarkerButton();
      updateDeleteLocalButton();
      updateCorrectActorButton();
      updateMoveToPersonButton();
    }
    showNotice(`演员已订正为：${data.actorName || data.person?.name || "文件夹人物"}`);
    window.setTimeout(() => {
      if (currentVideo) {
        els.notice.hidden = true;
        els.video.hidden = false;
      }
    }, 1800);
  } catch (error) {
    els.correctActor.textContent = "订正失败";
    els.correctActor.title = error.message || "订正失败";
    showNotice(error.message || "订正演员失败");
    window.setTimeout(() => {
      els.correctActor.textContent = originalText;
      els.correctActor.disabled = false;
      updateCorrectActorButton();
    }, 2200);
  }
}

async function deleteCurrentLocalFiles() {
  if (!els.deleteLocal || !currentWork?.id || currentWork.missingLocal || !isTrustedNetworkFeatureAvailable()) return;
  const title = currentWork.title || currentWork.directoryName || currentWork.id;
  const pathText = formatLibraryPath(currentWork.relativePath || "");
  const message = [
    `确认删除这个作品的本地文件夹？`,
    title,
    pathText,
    "",
    "数据库资料会保留，删除后会显示为未下载。"
  ].filter((line) => line !== "").join("\n");
  if (!window.confirm(message)) return;

  stopCurrentPlayback();
  await delay(700);
  const originalText = els.deleteLocal.textContent;
  els.deleteLocal.disabled = true;
  els.deleteLocal.textContent = "删除中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/local-files/delete`, { method: "POST" });
    currentWork = data.work || { ...currentWork, missingLocal: true, videos: [], images: [], infos: [] };
    currentVideo = null;
    document.title = `${currentWork.title || title} - FanHao`;
    els.title.textContent = currentWork.title || title;
    renderFiles(currentWork);
    renderMeta(currentWork);
    updateMarkerButton();
    updateOpenFileButton();
    updateDeleteLocalButton();
    const removedEmpty = Array.isArray(data.emptyRemovedPaths) && data.emptyRemovedPaths.length
      ? `，已清理 ${data.emptyRemovedPaths.length} 个空文件夹`
      : "";
    showNotice(`本地文件已删除${removedEmpty}，这个作品现在是未下载状态`);
  } catch (error) {
    els.deleteLocal.textContent = "删除失败";
    els.deleteLocal.title = error.message || "删除失败";
    showNotice(error.message || "删除本地文件失败");
    window.setTimeout(() => {
      els.deleteLocal.textContent = originalText;
      els.deleteLocal.disabled = false;
      updateDeleteLocalButton();
    }, 2200);
  }
}

function stopCurrentPlayback() {
  stopProgressTimer();
  currentVideo = null;
  try {
    els.video.pause();
    els.video.srcObject = null;
    els.video.removeAttribute("src");
    els.video.querySelectorAll("source").forEach((source) => source.remove());
    els.video.load();
  } catch {
    // Nothing to do if the browser already released the media element.
  }
  els.video.hidden = true;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isLocalFileOpenAvailable() {
  return ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
}

function isTrustedNetworkFeatureAvailable() {
  const host = window.location.hostname;
  return isLocalFileOpenAvailable() || isPrivateLanHost(host);
}

function isPrivateLanHost(host) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(host || "").trim());
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
  els.video.hidden = true;
}

function startProgressTimer() {
  progressTimer = window.setInterval(reportProgress, 5000);
}

function stopProgressTimer() {
  if (!progressTimer) return;
  window.clearInterval(progressTimer);
  progressTimer = null;
}

function reportProgress() {
  if (!currentVideo || !els.video || !Number.isFinite(els.video.duration) || els.video.duration <= 0) return;
  const now = Date.now();
  if (now - lastProgressReport < 1000) return;
  lastProgressReport = now;
  api(`/api/progress/${encodeURIComponent(currentVideo.id)}`, {
    method: "POST",
    body: {
      workId: currentWork?.id || "",
      position: els.video.currentTime || 0,
      duration: els.video.duration || 0
    }
  }).catch(() => {});
}

function formatLibraryPath(value) {
  return String(value || "").replaceAll("\\", "/");
}
