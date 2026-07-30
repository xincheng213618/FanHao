import { postJson } from "../../js/api.js?v=20260702-novel-local-manage-74";
import { formatBytes, formatNumber } from "../../js/format.js";
import { absoluteUrl } from "../../js/image.js";

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
    els.viewKicker.textContent = "个人中心";
    els.viewTitle.textContent = "我的";
    renderMeta();
    renderBody();
  }

  function renderMeta() {
    els.viewMeta.textContent = "";
  }

  function renderBody() {
    const page = document.createElement("section");
    page.className = "tools-dashboard";
    page.append(
      createToolSection("小游戏", "离线可用", createGameLauncher()),
      createTextWorkspace()
    );
    els.viewContent.replaceChildren(page);
  }

  function createToolSection(titleText, metaText, content) {
    const section = document.createElement("section");
    section.className = "tools-section";
    const head = createSectionHead(titleText, metaText);
    section.append(head, content);
    return section;
  }

  function createSectionHead(titleText, metaText) {
    const head = document.createElement("div");
    head.className = "tools-section-head";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const meta = document.createElement("span");
    meta.textContent = metaText;
    head.append(title, meta);
    return head;
  }

  function createGameLauncher() {
    const wrap = document.createElement("section");
    wrap.className = "tool-launch-grid";
    wrap.append(
      createLaunchCard({
        badge: "2048",
        title: "2048 AI",
        detail: "手玩、AI 建议或自动运行",
        onClick: () => {
          window.location.assign("./games/2048/index.html");
        }
      }),
      createLaunchCard({
        badge: "解",
        title: "华容道",
        detail: "经典滑块与 AI 自动解",
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
    button.setAttribute("aria-label", `打开${item.title}`);
    button.addEventListener("click", item.onClick);

    const badge = document.createElement("span");
    badge.className = "tool-launch-badge";
    badge.textContent = item.badge;

    const body = document.createElement("span");
    body.className = "tool-launch-body";

    const title = document.createElement("strong");
    title.textContent = item.title;

    const detail = document.createElement("small");
    detail.textContent = item.detail;

    const action = document.createElement("span");
    action.className = "tool-launch-action";
    action.textContent = "打开";

    body.append(title, detail);
    button.append(badge, body, action);
    return button;
  }

  function createTextWorkspace() {
    const section = document.createElement("section");
    section.className = "tools-section txt-native-workspace";
    const bytes = inputBytes();
    const summary = state.result?.size
      ? `已生成 ${formatBytes(state.result.size)}`
      : bytes
        ? `已输入 ${formatBytes(bytes)}`
        : "粘贴长文本后直接整理";
    section.append(
      createSectionHead("文本整理", summary),
      createTextEditor(),
      createOptions(),
      createActions(),
      createStatus()
    );
    const result = createResult();
    if (result) section.append(result);
    return section;
  }

  function createTextEditor() {
    const label = document.createElement("label");
    label.className = "txt-native-editor";

    const span = document.createElement("span");
    span.textContent = "文本内容";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "在这里粘贴需要整理的文本";
    textarea.spellcheck = false;
    textarea.value = state.text;
    textarea.addEventListener("input", () => {
      state.text = textarea.value;
      const hadResult = Boolean(state.result);
      state.result = null;
      setStatus("");
      renderMeta();
      if (hadResult) renderBody();
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
    status.hidden = !state.status;
    return status;
  }

  function createResult() {
    const result = state.result;
    if (!result) return null;
    const section = document.createElement("section");
    section.className = "txt-native-result";

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

  async function runFormatter() {
    if (state.processing) return;
    const text = state.text || "";
    const hasText = Boolean(text.trim());
    if (!hasText) {
      setStatus("请先粘贴需要整理的文本", true);
      return;
    }

    state.processing = true;
    state.result = null;
    setStatus("正在格式化", true);
    try {
      const body = {
        fileName: "粘贴文本.txt",
        options: {
          indent: state.indent,
          cleanJunk: state.cleanJunk
        },
        text
      };

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
    if (node) {
      node.className = `txt-native-status${state.status && /失败|不能|只支持|为空|请先/.test(state.status) ? " error" : ""}`;
      node.textContent = state.status;
      node.hidden = !state.status;
    }
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







