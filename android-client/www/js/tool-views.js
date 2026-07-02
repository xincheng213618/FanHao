import { postJson } from "./api.js?v=20260702-novel-local-manage-74";
import { formatBytes, formatNumber } from "./format.js";
import { absoluteUrl } from "./image.js";

const TXT_TOOL_MAX_FILE_BYTES = 24 * 1024 * 1024;
const TXT_TOOL_INDENT_KEY = "fanhao.android.txtTool.indent";
const TXT_TOOL_CLEAN_KEY = "fanhao.android.txtTool.cleanJunk";

export function createToolViews(context) {
  const {
    els,
    getActiveUrl,
    setActiveBottom
  } = context;

  const state = {
    text: "",
    fileName: "",
    fileSize: 0,
    fileBase64: "",
    indent: readStoredFlag(TXT_TOOL_INDENT_KEY, true),
    cleanJunk: readStoredFlag(TXT_TOOL_CLEAN_KEY, true),
    processing: false,
    status: "",
    result: null
  };
  let activeGuard = () => true;

  function renderTxtTool(isActive = () => true) {
    activeGuard = isActive;
    setActiveBottom("tools");
    els.viewKicker.textContent = "小工具";
    els.viewTitle.textContent = "工具箱";
    renderMeta();
    renderBody();
  }

  function renderMeta() {
    const bytes = inputBytes();
    const parts = [
      "开源小游戏 2 个",
      bytes ? `输入 ${formatBytes(bytes)}` : "等待输入",
      state.result?.size ? `输出 ${formatBytes(state.result.size)}` : "",
      state.result ? "保留 10 分钟" : ""
    ].filter(Boolean);
    els.viewMeta.textContent = parts.join(" · ");
  }

  function renderBody() {
    els.viewContent.innerHTML = "";
    const panel = document.createElement("section");
    panel.className = "txt-native-tool";
    panel.append(createGameLauncher(), createMetrics(), createInputPanel(), createOptions(), createActions(), createStatus(), createResult());
    els.viewContent.append(panel);
  }

  function createGameLauncher() {
    const wrap = document.createElement("section");
    wrap.className = "tool-launch-grid";
    wrap.append(
      createLaunchCard({
        title: "2048 AI Engine",
        meta: "game-difficulty · GPL-3.0",
        detail: "带 WASM AI，可手玩、一步建议或自动运行。",
        action: "开始",
        onClick: () => {
          window.location.assign("./games/2048/index.html");
        }
      }),
      createLaunchCard({
        title: "华容道",
        meta: "jeantimex · source",
        detail: "经典滑块关卡，带 AI 自动解，离线点按游玩。",
        action: "开始",
        onClick: () => {
          window.location.assign("./games/huarongdao/index.html#/game");
        }
      })
    );
    return wrap;
  }

  function createLaunchCard(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-launch-card";
    button.addEventListener("click", item.onClick);

    const body = document.createElement("span");
    body.className = "tool-launch-body";

    const title = document.createElement("strong");
    title.textContent = item.title;

    const meta = document.createElement("span");
    meta.textContent = item.meta;

    const detail = document.createElement("small");
    detail.textContent = item.detail;

    const action = document.createElement("span");
    action.className = "tool-launch-action";
    action.textContent = item.action;

    body.append(title, meta, detail);
    button.append(body, action);
    return button;
  }

  function createMetrics() {
    const metrics = document.createElement("div");
    metrics.className = "txt-native-metrics";
    const input = inputBytes();
    const output = Number(state.result?.size || 0);
    metrics.append(
      createMetric("输入", input ? formatBytes(input) : "待处理"),
      createMetric("输出", output ? formatBytes(output) : "-"),
      createMetric("章节", state.result ? formatNumber(state.result.stats?.chapters || 0) : "-")
    );
    return metrics;
  }

  function createMetric(label, value) {
    const node = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = value || "-";
    const span = document.createElement("span");
    span.textContent = label;
    node.append(strong, span);
    return node;
  }

  function createInputPanel() {
    const wrap = document.createElement("div");
    wrap.className = "txt-native-inputs";
    wrap.append(createFilePicker(), createTextEditor());
    return wrap;
  }

  function createFilePicker() {
    const label = document.createElement("label");
    label.className = "txt-native-file";

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) handleFile(file);
    });

    const title = document.createElement("strong");
    title.textContent = state.fileName || "选择 TXT";

    const meta = document.createElement("span");
    meta.textContent = state.fileName ? `${formatBytes(state.fileSize)} · 原始文件` : "小说 / 长文本";

    const action = document.createElement("span");
    action.className = "txt-native-file-action";
    action.textContent = "选文件";

    label.append(input, title, meta, action);
    return label;
  }

  function createTextEditor() {
    const label = document.createElement("label");
    label.className = "txt-native-editor";

    const span = document.createElement("span");
    span.textContent = "粘贴文本";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "粘贴 TXT 内容";
    textarea.spellcheck = false;
    textarea.value = state.text;
    textarea.addEventListener("input", () => {
      state.text = textarea.value;
      const hadResult = Boolean(state.result);
      state.result = null;
      if (state.fileBase64 && state.text.trim()) {
        state.fileBase64 = "";
        state.fileName = "";
        state.fileSize = 0;
        state.status = "";
        renderMeta();
        renderBody();
        return;
      }
      setStatus("");
      renderMeta();
      if (hadResult) refreshResultPanel();
    });

    label.append(span, textarea);
    return label;
  }

  function createOptions() {
    const options = document.createElement("div");
    options.className = "txt-native-options";
    options.append(
      createToggle("indent", "首行缩进", TXT_TOOL_INDENT_KEY),
      createToggle("cleanJunk", "清理分页噪声", TXT_TOOL_CLEAN_KEY)
    );
    return options;
  }

  function createToggle(key, labelText, storageKey) {
    const label = document.createElement("label");
    label.className = "txt-native-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(state[key]);
    input.addEventListener("change", () => {
      state[key] = input.checked;
      localStorage.setItem(storageKey, input.checked ? "1" : "0");
    });
    const span = document.createElement("span");
    span.textContent = labelText;
    label.append(input, span);
    return label;
  }

  function createActions() {
    const actions = document.createElement("div");
    actions.className = "txt-native-actions";

    const run = document.createElement("button");
    run.type = "button";
    run.className = "txt-native-primary";
    run.textContent = state.processing ? "正在格式化" : "格式化";
    run.disabled = state.processing;
    run.addEventListener("click", runFormatter);

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "txt-native-secondary";
    clear.textContent = "清空";
    clear.disabled = state.processing;
    clear.addEventListener("click", clearInput);

    actions.append(run, clear);
    return actions;
  }

  function createStatus() {
    const status = document.createElement("p");
    status.className = `txt-native-status${state.status && /失败|不能|只支持|为空|请先/.test(state.status) ? " error" : ""}`;
    status.textContent = state.status || "";
    return status;
  }

  function createResult() {
    const result = state.result;
    const section = document.createElement("section");
    section.className = "txt-native-result";

    if (!result) {
      const empty = document.createElement("div");
      empty.className = "txt-native-empty";
      empty.textContent = "格式化结果会显示在这里";
      section.append(empty);
      return section;
    }

    const head = document.createElement("div");
    head.className = "txt-native-result-head";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = result.fileName || "格式化结果.txt";
    const meta = document.createElement("span");
    meta.textContent = result.expiresAt ? `有效至 ${new Date(result.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "可下载";
    info.append(title, meta);

    const buttons = document.createElement("div");
    buttons.className = "txt-native-result-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyResult(copy));
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载";
    download.addEventListener("click", openDownload);
    buttons.append(copy, download);
    head.append(info, buttons);

    const stats = document.createElement("div");
    stats.className = "txt-native-stats";
    for (const [label, value] of resultStats(result)) {
      const item = document.createElement("span");
      item.textContent = `${label} ${formatNumber(value || 0)}`;
      stats.append(item);
    }

    const preview = document.createElement("textarea");
    preview.className = "txt-native-preview";
    preview.readOnly = true;
    preview.spellcheck = false;
    preview.value = result.previewText || "";

    section.append(head, stats, preview);
    return section;
  }

  function resultStats(result) {
    return [
      ["段落", result.stats?.paragraphs],
      ["合并折行", result.stats?.joined_blocks],
      ["清理噪声", result.stats?.removed_noise_lines]
    ];
  }

  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setStatus("只支持 .txt 文件", true);
      return;
    }
    if (file.size > TXT_TOOL_MAX_FILE_BYTES) {
      setStatus(`TXT 文件不能超过 ${Math.round(TXT_TOOL_MAX_FILE_BYTES / 1024 / 1024)} MB`, true);
      return;
    }
    setStatus("正在读取文件");
    try {
      state.fileBase64 = await fileToBase64(file);
      state.fileName = file.name;
      state.fileSize = file.size;
      state.text = "";
      state.result = null;
      setStatus("文件已读取", true);
    } catch (error) {
      setStatus(error.message || "读取文件失败", true);
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || "");
        resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
      };
      reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  async function runFormatter() {
    if (state.processing) return;
    const text = state.text || "";
    const hasText = Boolean(text.trim());
    const hasFile = Boolean(state.fileBase64);
    if (!hasText && !hasFile) {
      setStatus("请先选择 TXT 文件或粘贴文本", true);
      return;
    }

    state.processing = true;
    state.result = null;
    setStatus("正在格式化", true);
    try {
      const body = {
        fileName: hasText ? "粘贴文本.txt" : state.fileName,
        options: {
          indent: state.indent,
          cleanJunk: state.cleanJunk
        }
      };
      if (hasText) body.text = text;
      else body.contentBase64 = state.fileBase64;

      const result = await postJson(getActiveUrl(), "/api/tools/txt-format", body);
      state.result = result;
      state.status = `已生成，${Math.round((result.expiresInSeconds || 600) / 60)} 分钟内可用`;
    } catch (error) {
      state.status = error.message || "格式化失败";
    } finally {
      state.processing = false;
      if (activeGuard()) {
        renderMeta();
        renderBody();
      }
    }
  }

  function clearInput() {
    state.text = "";
    state.fileName = "";
    state.fileSize = 0;
    state.fileBase64 = "";
    state.result = null;
    state.status = "";
    renderMeta();
    renderBody();
  }

  function setStatus(message, rerender = false) {
    state.status = message || "";
    if (rerender && activeGuard()) {
      renderMeta();
      renderBody();
      return;
    }
    const node = els.viewContent.querySelector(".txt-native-status");
    if (node) node.textContent = state.status;
  }

  async function copyResult(button) {
    const url = downloadUrl();
    if (!url) return;
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = "复制中";
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("结果已失效");
      const text = await response.text();
      await copyText(text);
      button.textContent = "已复制";
    } catch (error) {
      button.textContent = error.message || "复制失败";
    } finally {
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = previous;
      }, 1200);
    }
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the textarea copy path used by older Android WebViews.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function refreshResultPanel() {
    const metrics = els.viewContent.querySelector(".txt-native-metrics");
    if (metrics) metrics.replaceWith(createMetrics());
    const result = els.viewContent.querySelector(".txt-native-result");
    if (result) result.replaceWith(createResult());
  }

  function openDownload() {
    const url = downloadUrl();
    if (!url) return;
    const download = new URL(url);
    if (state.result?.fileName) download.searchParams.set("filename", state.result.fileName);
    window.open(download.toString(), "_blank", "noreferrer");
  }

  function downloadUrl() {
    return state.result?.downloadUrl ? absoluteUrl(getActiveUrl(), state.result.downloadUrl) : "";
  }

  function inputBytes() {
    if (state.fileBase64) return state.fileSize || 0;
    return new Blob([state.text || ""]).size;
  }

  return {
    renderTxtTool
  };
}

function readStoredFlag(key, fallback) {
  const value = localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "1" || value === "true";
}







