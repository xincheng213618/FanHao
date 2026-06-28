export function createToolsPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatBytes,
    formatDateTime,
    formatNumber,
    resetProgressiveCoverLoading,
    state,
    toastInline,
    txtToolMaxFileBytes,
    writeStoredFlag
  } = deps;

  function inputBytes() {
    if (state.txtTool.fileBase64) return state.txtTool.fileSize || 0;
    return new Blob([state.txtTool.text || ""]).size;
  }

  function renderStats() {
    const bytes = inputBytes();
    const result = state.txtTool.result;
    const stats = [
      ["小工具", 1],
      ["输入", bytes ? formatBytes(bytes) : "待上传"],
      ["输出", result?.size ? formatBytes(result.size) : "-"],
      ["保留", "10 分钟"]
    ];

    els.statsRow.innerHTML = "";
    for (const [label, value] of stats) {
      const stat = document.createElement("div");
      stat.className = "stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(strong, span);
      els.statsRow.append(stat);
    }
  }

  function renderView() {
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    els.workGrid.innerHTML = "";

    const hub = document.createElement("section");
    hub.className = "tool-hub";

    const rail = document.createElement("aside");
    rail.className = "tool-rail";
    const railTitle = document.createElement("div");
    railTitle.className = "tool-rail-title";
    railTitle.textContent = "小工具";
    const railItem = document.createElement("button");
    railItem.type = "button";
    railItem.className = "tool-rail-item active";
    railItem.innerHTML = "<strong>TXT 格式化</strong><span>小说 / 长文本</span>";
    rail.append(railTitle, railItem);

    const panel = document.createElement("article");
    panel.className = "txt-tool-panel";

    const head = document.createElement("header");
    head.className = "txt-tool-head";
    const copy = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "文本工具";
    const title = document.createElement("h3");
    title.textContent = "TXT 文档格式化";
    const subtitle = document.createElement("p");
    subtitle.textContent = "拖拽 TXT 文件或粘贴文本，处理完成后下载 UTF-8 格式化文件。";
    copy.append(eyebrow, title, subtitle);
    const badge = document.createElement("span");
    badge.className = "txt-tool-badge";
    badge.textContent = state.txtTool.processing ? "处理中" : state.txtTool.result ? "已生成" : "就绪";
    head.append(copy, badge);

    const body = document.createElement("div");
    body.className = "txt-tool-body";
    body.append(createDropZone(), createEditor(), createOptions(), createActions(), createStatus());

    panel.append(head, body, renderResult());
    hub.append(rail, panel);
    els.workGrid.append(hub);
  }

  function createDropZone() {
    const dropZone = document.createElement("label");
    dropZone.className = "txt-drop-zone";
    dropZone.tabIndex = 0;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,text/plain";
    fileInput.hidden = true;

    const dropTitle = document.createElement("strong");
    dropTitle.textContent = state.txtTool.fileName || "拖拽 TXT 到这里";
    const dropMeta = document.createElement("span");
    dropMeta.textContent = state.txtTool.fileName ? `${formatBytes(state.txtTool.fileSize)} · 原始字节上传` : "也可以点击选择文件";
    const dropButton = document.createElement("span");
    dropButton.className = "txt-drop-button";
    dropButton.textContent = "选择 TXT";
    dropZone.append(fileInput, dropTitle, dropMeta, dropButton);

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
    });
    for (const eventName of ["dragenter", "dragover"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.add("drag-over");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.remove("drag-over");
      });
    }
    dropZone.addEventListener("drop", (event) => {
      const file = [...(event.dataTransfer?.files || [])].find((item) => item.name.toLowerCase().endsWith(".txt"));
      if (file) handleFile(file);
      else setStatus("只支持 .txt 文件");
    });
    dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
      }
    });

    return dropZone;
  }

  function createEditor() {
    const editorWrap = document.createElement("label");
    editorWrap.className = "txt-tool-editor";
    const editorLabel = document.createElement("span");
    editorLabel.textContent = "粘贴文本";
    const textarea = document.createElement("textarea");
    textarea.placeholder = "也可以直接粘贴 TXT 内容";
    textarea.spellcheck = false;
    textarea.value = state.txtTool.text || "";
    textarea.addEventListener("input", () => {
      state.txtTool.text = textarea.value;
      state.txtTool.result = null;
      if (state.txtTool.fileBase64 && textarea.value.trim()) {
        state.txtTool.fileBase64 = "";
        state.txtTool.fileName = "";
        state.txtTool.fileSize = 0;
        renderStats();
        renderView();
        return;
      }
      renderStats();
    });
    editorWrap.append(editorLabel, textarea);
    return editorWrap;
  }

  function createOptions() {
    const options = document.createElement("div");
    options.className = "txt-tool-options";
    options.append(
      createCheckbox("indent", "首行缩进", state.txtTool.indent),
      createCheckbox("cleanJunk", "清理分页噪声", state.txtTool.cleanJunk)
    );
    return options;
  }

  function createActions() {
    const actions = document.createElement("div");
    actions.className = "txt-tool-actions";
    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "folder-button";
    runButton.textContent = state.txtTool.processing ? "正在格式化" : "格式化";
    runButton.disabled = state.txtTool.processing;
    runButton.addEventListener("click", runFormatter);
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "folder-button subtle";
    clearButton.textContent = "清空";
    clearButton.addEventListener("click", clear);
    actions.append(runButton, clearButton);
    return actions;
  }

  function createStatus() {
    const status = document.createElement("p");
    status.className = "txt-tool-status";
    status.textContent = state.txtTool.status || "";
    return status;
  }

  function createCheckbox(key, text, checked) {
    const label = document.createElement("label");
    label.className = "txt-tool-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", () => {
      state.txtTool[key] = input.checked;
      writeStoredFlag(`fanhao.txtTool.${key}`, input.checked);
    });
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    return label;
  }

  function renderResult() {
    const result = state.txtTool.result;
    const section = document.createElement("section");
    section.className = "txt-tool-result";
    if (!result) {
      const empty = document.createElement("div");
      empty.className = "txt-tool-empty";
      empty.textContent = "结果会显示在这里";
      section.append(empty);
      return section;
    }

    const head = document.createElement("div");
    head.className = "txt-tool-result-head";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = result.fileName || "格式化结果.txt";
    const meta = document.createElement("span");
    meta.textContent = `${formatBytes(result.size)} · 有效至 ${formatDateTime(result.expiresAt)}`;
    info.append(title, meta);

    const buttons = document.createElement("div");
    buttons.className = "txt-tool-result-actions";
    const download = document.createElement("a");
    download.className = "folder-button";
    download.href = result.downloadUrl;
    download.download = result.fileName || "格式化结果.txt";
    download.textContent = "下载文件";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "folder-button subtle";
    copy.textContent = "复制文本";
    copy.addEventListener("click", () => copyResult(copy));
    buttons.append(download, copy);
    head.append(info, buttons);

    const stats = document.createElement("div");
    stats.className = "txt-tool-result-stats";
    const pairs = [
      ["章节", result.stats?.chapters],
      ["段落", result.stats?.paragraphs],
      ["合并折行", result.stats?.joined_blocks],
      ["清理噪声", result.stats?.removed_noise_lines]
    ];
    for (const [label, value] of pairs) {
      const item = document.createElement("span");
      item.textContent = `${label} ${formatNumber(value || 0)}`;
      stats.append(item);
    }

    const preview = document.createElement("textarea");
    preview.className = "txt-tool-preview";
    preview.readOnly = true;
    preview.spellcheck = false;
    preview.value = result.previewText || "";

    section.append(head, stats, preview);
    return section;
  }

  function setStatus(message) {
    state.txtTool.status = message || "";
    const status = els.workGrid.querySelector(".txt-tool-status");
    if (status) status.textContent = state.txtTool.status;
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

  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setStatus("只支持 .txt 文件");
      return;
    }
    if (file.size > txtToolMaxFileBytes) {
      setStatus(`TXT 文件不能超过 ${Math.round(txtToolMaxFileBytes / 1024 / 1024)} MB`);
      return;
    }
    setStatus("正在读取文件");
    try {
      state.txtTool.fileBase64 = await fileToBase64(file);
      state.txtTool.fileName = file.name;
      state.txtTool.fileSize = file.size;
      state.txtTool.text = "";
      state.txtTool.result = null;
      state.txtTool.status = "文件已读取";
    } catch (error) {
      state.txtTool.status = error.message || "读取文件失败";
    }
    renderStats();
    renderView();
  }

  async function runFormatter() {
    if (state.txtTool.processing) return;
    const pastedText = state.txtTool.text || "";
    const hasText = Boolean(pastedText.trim());
    const hasFile = Boolean(state.txtTool.fileBase64);
    if (!hasText && !hasFile) {
      setStatus("请先拖拽 TXT 文件或粘贴文本");
      return;
    }

    state.txtTool.processing = true;
    state.txtTool.status = "正在格式化";
    state.txtTool.result = null;
    renderStats();
    renderView();
    try {
      const body = {
        fileName: hasText ? "粘贴文本.txt" : state.txtTool.fileName,
        options: {
          indent: state.txtTool.indent,
          cleanJunk: state.txtTool.cleanJunk
        }
      };
      if (hasText) body.text = pastedText;
      else body.contentBase64 = state.txtTool.fileBase64;

      const result = await api("/api/tools/txt-format", { method: "POST", body });
      state.txtTool.result = result;
      state.txtTool.status = `已生成，${Math.round((result.expiresInSeconds || 600) / 60)} 分钟内可下载`;
    } catch (error) {
      state.txtTool.status = error.message || "格式化失败";
    } finally {
      state.txtTool.processing = false;
      renderStats();
      renderView();
    }
  }

  function clear() {
    state.txtTool.fileName = "";
    state.txtTool.fileSize = 0;
    state.txtTool.fileBase64 = "";
    state.txtTool.text = "";
    state.txtTool.result = null;
    state.txtTool.status = "";
    renderStats();
    renderView();
  }

  async function copyResult(button) {
    const result = state.txtTool.result;
    if (!result?.downloadUrl) return;
    const restoreText = button.textContent;
    button.disabled = true;
    button.textContent = "正在复制";
    try {
      const response = await fetch(result.downloadUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("下载文件已失效");
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      toastInline(button, "已复制", restoreText);
    } catch (error) {
      toastInline(button, error.message || "复制失败", restoreText);
    } finally {
      button.disabled = false;
    }
  }

  return {
    renderStats,
    renderView
  };
}
