const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const STYLE_ID = "fanhao-subtitle-controls-style";

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .subtitle-controls-host { position:absolute; z-index:10; top:66px; right:14px; max-width:calc(100% - 28px); color:#edf4f0; font:13px/1.5 system-ui,sans-serif; text-align:left; }
    .subtitle-controls { max-width:100%; }
    .subtitle-controls > summary { width:fit-content; margin-left:auto; padding:7px 12px; border:1px solid #ffffff50; border-radius:8px; background:#102019e8; color:#fff; cursor:pointer; }
    .subtitle-panel { width:min(350px,calc(100vw - 48px)); max-width:100%; max-height:calc(100dvh - 170px); overflow:auto; margin-top:6px; padding:12px; border:1px solid #ffffff40; border-radius:10px; background:#13241ff5; box-shadow:0 8px 30px #0006; }
    .subtitle-panel label { display:grid; min-width:0; gap:5px; margin-bottom:10px; color:#edf4f0; font-size:12px; }
    .subtitle-panel select,.subtitle-panel input,.subtitle-panel button,.subtitle-panel a { font:inherit; }
    .subtitle-panel select,.subtitle-panel input { width:100%; min-width:0; min-height:36px; padding:6px 8px; border:1px solid #ffffff45; border-radius:6px; color:#edf4f0; background:#18382b; }
    .subtitle-panel option { background:#18382b; color:#edf4f0; }
    .subtitle-panel button,.subtitle-panel a { display:inline-flex; align-items:center; min-height:34px; padding:5px 9px; border:1px solid #ffffff45; border-radius:6px; color:#edf4f0; background:#1a3c2f; text-decoration:none; cursor:pointer; }
    .subtitle-panel button:disabled { opacity:.55; cursor:default; }
    .subtitle-actions,.subtitle-search-row { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:10px; }
    .subtitle-search-row input { flex:1 1 130px; width:0; }
    .subtitle-status,.subtitle-source-note { margin:8px 0; color:#c0d3c8; font-size:12px; overflow-wrap:anywhere; }
    .subtitle-status.error { color:#ffcaab; }
    .subtitle-online-results { display:grid; gap:8px; }
    .subtitle-result { display:grid; gap:6px; padding-top:9px; border-top:1px solid #ffffff28; }
    .subtitle-result strong { overflow-wrap:anywhere; font-size:12px; }
    .subtitle-result-files { display:grid; gap:5px; }
    .subtitle-result-files button { text-align:left; overflow-wrap:anywhere; }
    .subtitle-panel [hidden],.subtitle-controls-host[hidden] { display:none!important; }
    .subtitle-controls :focus-visible { outline:2px solid #7ee2b7; outline-offset:2px; }
    .fanhao-subtitle-cues { position:absolute; z-index:5; left:7%; right:7%; bottom:70px; text-align:center; pointer-events:none; white-space:pre-line; color:white; font:500 clamp(16px,2vw,26px)/1.45 system-ui,sans-serif; text-shadow:0 2px 3px #000,1px 0 2px #000,-1px 0 2px #000; }
    .fanhao-subtitle-cues span { background:#000a; border-radius:3px; padding:2px 6px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
    .fanhao-subtitles-managed .plyr__captions { display:none!important; }
    @media(max-width:640px) { .subtitle-controls-host { top:60px; right:10px; max-width:calc(100% - 20px); } .subtitle-panel { width:min(330px,calc(100vw - 40px)); padding:10px; } .subtitle-panel button,.subtitle-panel select { min-height:40px; } }
  `;
  document.head.append(style);
}

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function chineseTrack(track) {
  return /^zh(?:[-_]|$)|^(?:chi|zho)$/i.test(String(track.language || "")) || /中文|简体|繁体|中字|簡體|繁體/.test(String(track.label || ""));
}

function sameOriginUrl(value) {
  try { const url = new URL(value, location.origin); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url : null; }
  catch { return null; }
}

export function createSubtitleControls({ api, container = null }) {
  installStyles();
  const root = node("details", "subtitle-controls");
  const summary = node("summary", "", "字幕");
  const panel = node("div", "subtitle-panel");
  panel.setAttribute("aria-label", "字幕设置");
  const label = node("label", "", "字幕轨道");
  const select = node("select");
  select.setAttribute("aria-label", "字幕轨道");
  label.append(select);
  const actions = node("div", "subtitle-actions");
  const reload = node("button", "", "重新读取"); reload.type = "button";
  const download = node("a", "", "下载原字幕"); download.download = ""; download.hidden = true;
  const cancel = node("button", "", "取消请求"); cancel.type = "button"; cancel.hidden = true;
  const retry = node("button", "", "重试"); retry.type = "button"; retry.hidden = true;
  actions.append(reload, download, cancel, retry);
  const uploadLabel = node("label", "", "加载本地字幕（SRT / ASS / VTT，最大 2 MiB）");
  const upload = node("input"); upload.type = "file"; upload.accept = ".srt,.ass,.ssa,.vtt"; upload.setAttribute("aria-label", "加载本地字幕");
  uploadLabel.append(upload);
  const form = node("form");
  const searchLabel = node("label", "", "在线字幕 · SubtitleCat");
  const searchRow = node("div", "subtitle-search-row");
  const query = node("input"); query.type = "search"; query.placeholder = "输入番号"; query.setAttribute("aria-label", "字幕搜索番号");
  const search = node("button", "", "搜索字幕"); search.type = "submit";
  searchRow.append(query, search); searchLabel.append(searchRow); form.append(searchLabel);
  const status = node("p", "subtitle-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const note = node("p", "subtitle-source-note", "在线字幕需手动选择下载。同番号也可能因版本、剪辑而对不上时间轴，请试播确认；下载保存到视频同目录。");
  const results = node("div", "subtitle-online-results");
  panel.append(label, actions, uploadLabel, form, status, results, note); root.append(summary, panel);
  const preferences = new Map();
  let host = null, video = null, context = null, contextVersion = 0, tracks = [], selected = "", active = null, retryAction = null, ownedTrack = null, overlay = null, destroyed = false, queryEdited = false;
  const events = new AbortController();
  const options = { signal: events.signal };

  function mount(next) {
    host = next;
    if (!host) return;
    host.classList.add("subtitle-controls-host");
    host.hidden = !context;
    host.append(root);
  }
  function message(text, error = false) { status.textContent = text; status.classList.toggle("error", error); }
  function abort() { active?.abort(); active = null; cancel.hidden = true; }
  function endpoint(suffix = "") { return `/api/works/${encodeURIComponent(context.workId)}/subtitles${suffix}`; }
  function parameters(extra = {}) { return new URLSearchParams({ videoId: context.videoId, ...extra }); }
  async function run(task, retryTask) {
    abort();
    const controller = new AbortController(); active = controller;
    const version = contextVersion;
    cancel.hidden = false; retry.hidden = true; retryAction = null;
    try {
      await task(controller.signal, () => !destroyed && contextVersion === version && active === controller);
    } catch (error) {
      if (!controller.signal.aborted && contextVersion === version && !destroyed) {
        message(error.message || "字幕请求失败", true); retryAction = retryTask; retry.hidden = !retryTask;
      }
    } finally { if (active === controller) { active = null; cancel.hidden = true; } }
  }
  function selectedTrack() { return tracks.find((track) => String(track.id) === selected); }
  function renderSelect() {
    select.replaceChildren(new Option("关闭字幕", ""));
    for (const track of tracks) select.append(new Option(`${track.label || track.id}${track.format ? ` · ${String(track.format).toUpperCase()}` : ""}`, String(track.id)));
    select.value = selected;
    summary.textContent = selectedTrack() ? `字幕 · ${selectedTrack().language || "开"}` : "字幕";
    const href = selectedTrack()?.downloadUrl && sameOriginUrl(selectedTrack().downloadUrl);
    download.hidden = !href;
    if (href) download.href = href.href; else download.removeAttribute("href");
  }
  function detachMedia() {
    ownedTrack?.remove(); ownedTrack = null;
    overlay?.remove(); overlay = null;
    video = null;
  }
  function applyTrack() {
    retry.hidden = true;
    ownedTrack?.remove(); ownedTrack = null;
    overlay?.replaceChildren();
    if (!video || !context) return;
    const track = selectedTrack();
    if (!track) return;
    const url = sameOriginUrl(track.url);
    if (!url) { message("字幕地址无效，请重新读取。", true); return; }
    url.searchParams.set("offsetSeconds", String(-context.offsetSeconds));
    const media = video;
    const trackElement = document.createElement("track");
    trackElement.kind = "subtitles"; trackElement.label = track.label || "字幕"; trackElement.srclang = track.language || "und";
    trackElement.dataset.subtitleId = String(track.id); trackElement.src = url.href;
    ownedTrack = trackElement;
    if (!overlay) { overlay = node("div", "fanhao-subtitle-cues"); overlay.setAttribute("aria-hidden", "true"); media.parentElement?.append(overlay); }
    media.closest(".plyr")?.classList.add("fanhao-subtitles-managed");
    const paint = () => {
      if (ownedTrack !== trackElement || video !== media || !overlay) return;
      const text = [...(trackElement.track.activeCues || [])].map((cue) => cue.getCueAsHTML?.().textContent ?? cue.text ?? "").join("\n");
      overlay.replaceChildren();
      if (text) overlay.append(node("span", "", text));
    };
    trackElement.addEventListener("load", () => {
      if (ownedTrack !== trackElement || video !== media) return;
      trackElement.track.mode = "hidden"; paint();
      message(`已加载：${track.label || track.id}`);
    });
    trackElement.addEventListener("error", () => {
      if (ownedTrack !== trackElement) return;
      message("字幕加载失败，可重试或重新读取。", true);
      retryAction = applyTrack; retry.hidden = false;
    });
    trackElement.track.addEventListener("cuechange", paint);
    media.append(trackElement);
    trackElement.track.mode = "hidden";
  }
  function acceptTracks(payload, prefer = null) {
    tracks = (payload.tracks || (payload.track ? [...tracks.filter((item) => item.id !== payload.track.id), payload.track] : []))
      .filter((track) => track?.id && sameOriginUrl(track.url));
    const key = context.key;
    if (prefer && tracks.some((track) => String(track.id) === String(prefer))) {
      selected = String(prefer); preferences.set(key, selected);
    } else if (preferences.has(key)) {
      selected = tracks.some((track) => String(track.id) === preferences.get(key)) ? preferences.get(key) : "";
    } else {
      selected = String(tracks.find((track) => track.autoSelect === true && chineseTrack(track))?.id || "");
    }
    renderSelect(); applyTrack();
  }
  function refresh() {
    if (!context) return;
    message("正在读取字幕…");
    return run(async (signal, current) => {
      const data = await api(`${endpoint()}?${parameters()}`, { signal });
      if (!current()) return;
      if (!queryEdited && typeof data.query === "string") query.value = data.query.trim();
      acceptTracks(data);
      message(tracks.length ? `${tracks.length} 条字幕${selected ? "，已选择中文或上次选轨" : "，当前关闭"}` : "没有匹配字幕。可加载本地文件，或按番号搜索。");
    }, refresh);
  }
  function downloadFile(result, file) {
    message("正在下载字幕…");
    return run(async (signal, current) => {
      const data = await api(endpoint("/download"), { method: "POST", signal, body: { videoId: context.videoId, resultId: result.id, fileId: file.id } });
      if (!current()) return;
      acceptTracks(data, data.track?.id);
      message(`字幕已保存并使用：${data.track?.label || file.name || file.language || "字幕"}`);
    }, () => downloadFile(result, file));
  }
  function loadFiles(result, target) {
    message("正在读取字幕语言…");
    return run(async (signal, current) => {
      const data = await api(`${endpoint(`/search/${encodeURIComponent(result.id)}/files`)}?${parameters()}`, { signal });
      if (!current()) return;
      target.replaceChildren();
      for (const file of data.files || []) {
        const button = node("button", "", `下载并使用 · ${file.label || file.language || "未知语言"} · ${file.name || "字幕文件"}`); button.type = "button";
        button.addEventListener("click", () => downloadFile(result, file)); target.append(button);
      }
      message(data.files?.length ? "请选择语言和版本。" : "该结果没有可下载的字幕文件。");
    }, () => loadFiles(result, target));
  }
  function searchOnline() {
    if (!context) return;
    const value = query.value.trim();
    if (!value) { message("请输入要搜索的番号。", true); query.focus(); return; }
    results.replaceChildren(); message("正在搜索 SubtitleCat…");
    return run(async (signal, current) => {
      const data = await api(`${endpoint("/search")}?${parameters({ query: value })}`, { signal });
      if (!current()) return;
      for (const result of data.results || []) {
        const entry = node("div", "subtitle-result");
        const title = node("strong", "", result.title || "字幕搜索结果");
        const files = node("div", "subtitle-result-files");
        const choose = node("button", "", "查看语言与文件"); choose.type = "button";
        choose.addEventListener("click", () => loadFiles(result, files)); entry.append(title, choose, files); results.append(entry);
      }
      message(data.results?.length ? `${data.results.length} 个结果，请核对标题和分段。` : "没有搜索结果。可调整番号后重试，或加载本地字幕。");
    }, searchOnline);
  }
  async function uploadFile(file) {
    if (!context || !file) return;
    if (!/\.(?:srt|ass|ssa|vtt)$/i.test(file.name) || file.size > MAX_UPLOAD_BYTES || !file.size) { message("请选择不超过 2 MiB 的 SRT、ASS、SSA 或 VTT 字幕文件。", true); return; }
    message("正在加载本地字幕…");
    return run(async (signal, current) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!current()) return;
      let binary = "";
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      const data = await api(endpoint("/upload"), { method: "POST", signal, body: { videoId: context.videoId, name: file.name, contentBase64: btoa(binary) } });
      if (!current()) return;
      acceptTracks(data, data.track?.id); message("本地字幕已保存并使用。");
    }, () => uploadFile(file));
  }
  function setMedia(nextVideo, offsetSeconds = 0) {
    detachMedia(); video = nextVideo;
    if (context) context.offsetSeconds = Math.max(0, Number(offsetSeconds) || 0);
    applyTrack();
  }
  function setContext(next = {}) {
    const key = next.workId && next.videoId ? `${next.workId}\u0000${next.videoId}` : "";
    if (!key) { reset(); return; }
    if (context?.key !== key) {
      abort(); contextVersion++; tracks = []; selected = ""; results.replaceChildren(); retry.hidden = true;
      context = { workId: String(next.workId), videoId: String(next.videoId), key, offsetSeconds: 0 };
      queryEdited = false;
      query.value = ""; renderSelect();
      if (host) host.hidden = false;
      refresh();
    }
    setMedia(next.video || null, next.offsetSeconds);
  }
  function reset() {
    abort(); contextVersion++; context = null; tracks = []; selected = ""; retryAction = null; retry.hidden = true;
    detachMedia(); results.replaceChildren(); renderSelect();
    if (host) host.hidden = true;
  }
  root.addEventListener("click", (event) => event.stopPropagation(), options);
  root.addEventListener("keydown", (event) => { event.stopPropagation(); if (event.key === "Escape") { root.open = false; summary.focus(); } }, options);
  select.addEventListener("change", () => { if (!context) return; selected = select.value; preferences.set(context.key, selected); renderSelect(); applyTrack(); if (!selected) message("字幕已关闭。"); }, options);
  reload.addEventListener("click", refresh, options);
  retry.addEventListener("click", () => retryAction?.(), options);
  cancel.addEventListener("click", () => { abort(); message("请求已取消。"); }, options);
  form.addEventListener("submit", (event) => { event.preventDefault(); searchOnline(); }, options);
  query.addEventListener("input", () => { queryEdited = true; }, options);
  upload.addEventListener("change", () => { const file = upload.files?.[0]; upload.value = ""; uploadFile(file); }, options);
  mount(container); renderSelect();
  return { mount, setContext, setMedia, detachMedia, refresh, reset, destroy() { if (destroyed) return; reset(); destroyed = true; events.abort(); root.remove(); preferences.clear(); } };
}
