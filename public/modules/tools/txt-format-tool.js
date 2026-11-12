const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const PREVIEW_LIMIT = 64 * 1024;
const MAX_BATCH_FILES = 16;

export function createTxtFormatTool({ api, state, writeStoredFlag = () => {}, txtToolMaxFileBytes = DEFAULT_MAX_BYTES } = {}) {
  const maxBytes = Number(txtToolMaxFileBytes) > 0 ? Number(txtToolMaxFileBytes) : DEFAULT_MAX_BYTES;
  const element = document.createElement("details");
  element.className = "txt-format-tool";
  element.innerHTML = `<summary>TXT 文本整理<span>合并断行 · 章节分段 · UTF-8 下载</span></summary>
    <div class="txt-format-workspace">
      <p>将所选 TXT 发送到当前资料库服务，整理后下载为 UTF-8 文件。需要本机管理员权限，不会加入小说书库。</p>
      <form>
        <div class="txt-format-selection">
          <div class="txt-format-selection-actions">
            <div class="txt-format-file"><button type="button" class="txt-format-secondary" aria-describedby="txtFormatLimit">选择 TXT 文件</button><input type="file" accept=".txt,text/plain" multiple hidden></div>
            <button type="button" class="txt-format-secondary txt-format-append" hidden>追加文件</button>
            <input type="file" class="txt-format-append-input" accept=".txt,text/plain" multiple hidden>
            <button type="button" class="txt-format-secondary txt-format-clear" hidden>清空选择</button>
          </div>
          <p>也可拖入 TXT 文件</p>
          <p class="txt-format-selection-summary" hidden></p>
        </div>
        <p id="txtFormatLimit"></p>
        <fieldset><legend>整理选项</legend>
          <label><input type="checkbox" name="indent">段落首行缩进两格</label>
          <label><input type="checkbox" name="cleanJunk">清理常见分页和章节导航文字</label>
        </fieldset>
        <button type="submit" class="txt-format-submit" disabled>整理并生成下载</button>
        <button type="button" class="txt-format-cancel" hidden>停止批量整理</button>
      </form>
      <p class="txt-format-status" role="status" aria-live="polite" aria-atomic="true"></p>
      <section class="txt-format-result" aria-label="整理结果" hidden></section>
    </div>`;
  const form = element.querySelector("form");
  const picker = element.querySelector(".txt-format-file input");
  const choose = element.querySelector(".txt-format-file button");
  const append = element.querySelector(".txt-format-append");
  const appendPicker = element.querySelector(".txt-format-append-input");
  const clear = element.querySelector(".txt-format-clear");
  const dropzone = element.querySelector(".txt-format-selection");
  const selectionSummary = element.querySelector(".txt-format-selection-summary");
  const submit = element.querySelector('button[type="submit"]');
  const cancel = element.querySelector(".txt-format-cancel");
  const indent = element.querySelector('[name="indent"]');
  const cleanJunk = element.querySelector('[name="cleanJunk"]');
  const status = element.querySelector(".txt-format-status");
  const result = element.querySelector(".txt-format-result");
  const listeners = new AbortController();
  const listen = { signal: listeners.signal };
  let entries = [], batch = null, operation = null, expiryTimer = null, suspended = false, disposed = false;
  indent.checked = state?.txtTool?.indent !== false;
  cleanJunk.checked = state?.txtTool?.cleanJunk !== false;
  element.querySelector("#txtFormatLimit").textContent = `支持 UTF-8、GB18030、GBK、Big5。最多选 ${MAX_BATCH_FILES} 份，每份不超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("is-error", error);
  }

  function validationError(value) {
    if (!value) return "请先选择一个 TXT 文件";
    if (!/\.txt$/i.test(value.name)) return "只支持 .txt 文档，请重新选择";
    if (!value.size) return "TXT 文件为空，请重新选择";
    if (value.size > maxBytes) return `TXT 文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB，请重新选择`;
    return "";
  }

  function selectionError() {
    if (entries.length <= 1) return validationError(entries[0]?.file);
    return entries.every(entry => entry.invalid) ? "没有可以整理的 TXT 文件" : "";
  }

  const multiple = () => entries.length > 1;
  const ready = entry => Boolean(entry.receipt && Date.parse(entry.receipt.expiresAt) > Date.now());

  function updateBusy() {
    form.setAttribute("aria-busy", String(Boolean(operation)));
    const complete = multiple() && !entries.some(entry => !entry.invalid && !ready(entry));
    submit.disabled = Boolean(selectionError()) || complete;
    submit.setAttribute("aria-disabled", String(Boolean(operation)));
    cancel.hidden = !operation || !multiple();
    if (batch) for (const row of batch.rows.values()) row.remove.disabled = Boolean(operation);
    submit.textContent = operation ? "正在整理…" : complete ? "已完成整理"
      : multiple() && entries.some(entry => entry.error || entry.receipt) ? "重试未完成" : "整理并生成下载";
  }

  function stopOperation() {
    const old = operation;
    operation = null;
    old?.controller.abort();
    if (old?.reader?.readyState === FileReader.LOADING) old.reader.abort();
  }

  function invalidate() {
    stopOperation();
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
    batch = null;
    for (const entry of entries) Object.assign(entry, { receipt: null, error: "", pending: false });
    result.replaceChildren();
    result.hidden = true;
    updateBusy();
  }

  function isCurrent(owner) {
    return operation === owner && !owner.controller.signal.aborted && !disposed && !suspended && element.isConnected;
  }

  function readFile(owner, source) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      owner.reader = reader;
      const finish = (error, value) => {
        reader.onload = reader.onerror = reader.onabort = null;
        owner.reader = null;
        if (error) reject(error); else resolve(value);
      };
      reader.onload = () => {
        const value = String(reader.result || "");
        const comma = value.indexOf(",");
        finish(comma < 0 ? new Error("文件读取失败，请重新选择或重试") : null, value.slice(comma + 1));
      };
      reader.onerror = () => finish(new Error("文件读取失败，请重新选择或重试"));
      reader.onabort = () => finish(new DOMException("文件读取已取消", "AbortError"));
      reader.readAsDataURL(source);
    });
  }

  function validateReceipt(receipt) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(receipt?.id || ""))
      || receipt.downloadUrl !== `/api/tools/txt-format/download/${receipt.id}`
      || !Number.isFinite(Date.parse(receipt.expiresAt))) throw new Error("下载回执无效，请重新整理");
  }

  function receiptDownload(receipt) {
    const download = document.createElement("a");
    download.className = "txt-format-download";
    download.href = receipt.downloadUrl;
    download.download = String(receipt.fileName || "formatted.txt");
    download.textContent = "下载整理后的 TXT";
    return download;
  }

  function renderResult(receipt) {
    const heading = document.createElement("h4");
    heading.textContent = String(receipt.fileName || "整理后的 TXT").slice(0, 240);
    const stats = document.createElement("p");
    const detail = receipt.stats || {};
    const count = value => new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value) || 0));
    stats.textContent = `输入编码：${String(detail.used_encoding || "自动识别").slice(0, 32)} · ${count(detail.chapters)} 章 · ${count(detail.paragraphs)} 段 · 清理 ${count(detail.removed_noise_lines)} 处`;
    const download = receiptDownload(receipt);
    const expires = document.createElement("p");
    expires.textContent = `临时下载有效至 ${new Date(receipt.expiresAt).toLocaleString("zh-CN", { hour12: false })}，过期后可重新整理。`;
    const previewTitle = document.createElement("h4");
    previewTitle.id = "txtFormatPreviewTitle";
    const preview = String(receipt.previewText || "");
    previewTitle.textContent = receipt.previewTruncated || preview.length > PREVIEW_LIMIT ? "正文预览（部分）" : "正文预览";
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-labelledby", previewTitle.id);
    pre.textContent = preview.slice(0, PREVIEW_LIMIT);
    result.replaceChildren(heading, stats, download, expires, previewTitle, pre);
    result.hidden = false;
    const expire = () => {
      download.removeAttribute("href");
      download.setAttribute("aria-disabled", "true");
      download.textContent = "下载已过期，请重新整理";
      expires.textContent = "临时下载已过期，所选文件和选项仍在，可以再次整理。";
    };
    const delay = Date.parse(receipt.expiresAt) - Date.now();
    if (delay <= 0) expire();
    else expiryTimer = window.setTimeout(expire, Math.min(delay, 2147483647));
  }

  function mountBatch() {
    if (!multiple()) return;
    if (!batch) {
      const summary = document.createElement("p"), archive = document.createElement("a"), list = document.createElement("ol");
      archive.className = "txt-format-download txt-format-archive";
      archive.textContent = "下载已完成结果 ZIP";
      archive.download = "TXT_整理结果.zip";
      list.className = "txt-format-batch";
      batch = { summary, archive, list, rows: new Map() };
      result.replaceChildren(summary, archive, list);
      result.hidden = false;
    }
    for (const [entry, row] of batch.rows) {
      if (entries.includes(entry)) continue;
      row.element.remove();
      batch.rows.delete(entry);
    }
    for (const entry of entries) {
      if (batch.rows.has(entry)) continue;
      const row = document.createElement("li"), title = document.createElement("strong"), status = document.createElement("span"), output = document.createElement("div");
      title.textContent = entry.file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "txt-format-secondary txt-format-remove";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除 ${entry.file.name}`);
      row.append(title, status, remove, output);
      batch.list.append(row);
      batch.rows.set(entry, { element: row, status, output, remove, receipt: null, download: null });
    }
    updateBatch();
  }

  function updateBatch() {
    if (!batch) return;
    const completed = entries.filter(ready);
    for (const entry of entries) {
      const row = batch.rows.get(entry), available = ready(entry);
      row.status.textContent = entry.invalid || (entry.pending ? "正在整理…" : entry.error || (available ? "已完成" : entry.receipt ? "下载已过期" : "待整理"));
      row.status.classList.toggle("is-error", Boolean(entry.invalid || entry.error));
      if (row.receipt !== entry.receipt) {
        row.receipt = entry.receipt;
        row.output.replaceChildren();
        row.download = null;
        if (entry.receipt) {
          const preview = document.createElement("details"), label = document.createElement("summary"), text = document.createElement("pre");
          label.textContent = entry.receipt.previewTruncated ? "正文预览（部分）" : "正文预览";
          text.textContent = String(entry.receipt.previewText || "").slice(0, PREVIEW_LIMIT);
          text.tabIndex = 0;
          preview.append(label, text);
          row.download = receiptDownload(entry.receipt);
          row.output.append(row.download, preview);
        }
      }
      if (row.download && !available) {
        row.download.removeAttribute("href");
        row.download.setAttribute("aria-disabled", "true");
      }
    }
    const failed = entries.filter(entry => entry.error || entry.invalid).length;
    batch.summary.textContent = `已完成 ${completed.length} / ${entries.length} 份${failed ? ` · ${failed} 份需处理` : ""}`;
    batch.archive.hidden = completed.length < 2;
    if (completed.length < 2) batch.archive.removeAttribute("href");
    else batch.archive.href = `/api/tools/txt-format/batch-download?${new URLSearchParams(completed.map(entry => ["id", entry.receipt.id]))}`;
    window.clearTimeout(expiryTimer);
    if (completed.length) {
      const expires = Math.min(...completed.map(entry => Date.parse(entry.receipt.expiresAt)));
      expiryTimer = window.setTimeout(() => { updateBatch(); updateBusy(); }, Math.min(2147483647, Math.max(0, expires - Date.now())));
    }
  }

  async function formatFile(owner, source) {
    let contentBase64 = await readFile(owner, source);
    if (!isCurrent(owner)) return null;
    const pending = api("/api/tools/txt-format", { method: "POST", signal: owner.controller.signal,
      body: { fileName: source.name, contentBase64, options: { indent: indent.checked, cleanJunk: cleanJunk.checked } } });
    contentBase64 = null;
    const receipt = await pending;
    if (!isCurrent(owner)) return null;
    validateReceipt(receipt);
    return receipt;
  }

  async function formatBatch(owner) {
    mountBatch();
    const pending = entries.filter(entry => !entry.invalid && !ready(entry));
    for (const entry of pending) {
      Object.assign(entry, { error: "", pending: true, receipt: null });
      updateBatch();
      let error;
      try {
        const receipt = await formatFile(owner, entry.file);
        if (!receipt) return;
        entry.receipt = receipt;
      } catch (caught) {
        if (!isCurrent(owner)) return;
        error = caught;
        entry.error = error.message || "整理失败，请重试";
      }
      entry.pending = false;
      updateBatch();
      if (error?.status === 401 || error?.status === 403 || error?.code === "ACCOUNT_CHANGED") break;
    }
    if (!isCurrent(owner)) return;
    message(entries.some(entry => !entry.invalid && !ready(entry)) ? "未完成的文件可以重试。" : "可下载整理结果。原文件未修改。");
  }

  function refreshSelection() {
    choose.textContent = entries.length ? "重新选择" : "选择 TXT 文件";
    clear.hidden = append.hidden = selectionSummary.hidden = !entries.length;
    selectionSummary.textContent = entries.length === 1 ? entries[0].file.name : entries.length ? `已选 ${entries.length} 份文件` : "";
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
    if (multiple()) mountBatch();
    else {
      batch = null;
      if (entries[0]?.receipt) renderResult(entries[0].receipt);
      else { result.replaceChildren(); result.hidden = true; }
    }
    updateBusy();
  }

  function selectFiles(files, { appendFiles = false } = {}) {
    if (disposed || suspended || !element.isConnected) return;
    if (appendFiles && !files.length) return;
    if (files.length + (appendFiles ? entries.length : 0) > MAX_BATCH_FILES) {
      message(appendFiles ? `本次追加后将超过 ${MAX_BATCH_FILES} 份，请先移除不需要的文件。` : `每次最多选择 ${MAX_BATCH_FILES} 个 TXT 文件`, true);
      return;
    }
    const added = files.map(file => ({ file, invalid: validationError(file) }));
    if (appendFiles) entries = [...entries, ...added];
    else {
      entries = added;
      invalidate();
    }
    refreshSelection();
    const error = selectionError();
    const selected = appendFiles
      ? operation ? `已追加 ${files.length} 份。当前整理结束后可处理新增文件。` : `已追加 ${files.length} 份。`
      : entries.length ? `已选择 ${entries.length} 份文件。` : "已清空选择。";
    message(entries.length ? error || selected : selected, Boolean(entries.length && error));
  }

  function takeFiles(input) {
    const files = Array.prototype.slice.call(input.files || [], 0, MAX_BATCH_FILES + 1);
    input.value = "";
    return files;
  }

  const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes("Files");
  choose.addEventListener("click", () => picker.click(), listen);
  append.addEventListener("click", () => appendPicker.click(), listen);
  picker.addEventListener("change", () => selectFiles(takeFiles(picker)), listen);
  appendPicker.addEventListener("change", () => selectFiles(takeFiles(appendPicker), { appendFiles: true }), listen);
  clear.addEventListener("click", () => {
    selectFiles([]);
    choose.focus({ preventScroll: true });
  }, listen);
  dropzone.addEventListener("dragover", event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dropzone.classList.add("is-dragging");
  }, listen);
  dropzone.addEventListener("dragleave", event => {
    if (!(event.relatedTarget instanceof Node) || !dropzone.contains(event.relatedTarget)) dropzone.classList.remove("is-dragging");
  }, listen);
  dropzone.addEventListener("drop", event => {
    dropzone.classList.remove("is-dragging");
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const files = Array.prototype.slice.call(event.dataTransfer.files, 0, MAX_BATCH_FILES + 1);
    selectFiles(files, { appendFiles: true });
  }, listen);
  result.addEventListener("click", event => {
    const button = event.target.closest?.(".txt-format-remove");
    if (!button || !batch || operation || !result.contains(button)) return;
    const index = entries.findIndex(entry => batch.rows.get(entry)?.remove === button);
    if (index < 0) return;
    const [removed] = entries.splice(index, 1);
    refreshSelection();
    message(`已移除 ${removed.file.name}。`);
    (batch?.rows.get(entries[Math.min(index, entries.length - 1)])?.remove || append).focus({ preventScroll: true });
  }, listen);
  for (const control of [indent, cleanJunk]) control.addEventListener("change", () => {
    invalidate();
    mountBatch();
    if (state?.txtTool) state.txtTool[control.name] = control.checked;
    try { writeStoredFlag(`fanhao.txtTool.${control.name}`, control.checked); } catch { /* Preferences are optional. */ }
    message(selectionError() || "选项已更新，点击整理后生成下载。");
  }, listen);
  cancel.addEventListener("click", () => {
    if (!operation || !multiple()) return;
    stopOperation();
    for (const entry of entries) entry.pending = false;
    updateBatch();
    updateBusy();
    message("已停止等待，已完成的文件仍可下载。");
    submit.focus({ preventScroll: true });
  }, listen);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (operation || disposed || suspended || !element.isConnected) return;
    const error = selectionError();
    if (error) { message(error, true); choose.focus(); return; }
    if (!multiple()) invalidate();
    else if (submit.disabled) return;
    const owner = { controller: new AbortController(), reader: null };
    const entry = multiple() ? null : entries[0];
    operation = owner;
    updateBusy();
    message("正在读取并整理文件，请稍候…");
    try {
      if (!entry) { await formatBatch(owner); return; }
      entry.pending = true;
      const receipt = await formatFile(owner, entry.file);
      if (!receipt) return;
      entry.pending = false;
      entry.receipt = receipt;
      if (multiple()) {
        updateBatch();
        message("已完成当前文件，可继续整理新增文件。");
      } else {
        renderResult(receipt);
        message("整理完成，可预览并下载。原文件未修改。");
      }
    } catch (error) {
      if (!isCurrent(owner)) return;
      if (entry) {
        entry.pending = false;
        entry.error = error.message || "整理失败，请重试";
        if (multiple()) updateBatch();
      }
      message(error.message || "整理失败，请重试", true);
    } finally {
      if (operation === owner) { operation = null; updateBusy(); }
    }
  }, listen);
  window.addEventListener("pagehide", () => {
    suspended = true;
    const pending = Boolean(operation);
    const hadResult = batch ? entries.some(entry => entry.receipt) : !result.hidden;
    invalidate();
    if (pending) message("本次等待已结束，返回后可重新提交。");
    else if (hadResult) message("临时结果已清除，返回后可重新整理。");
  }, listen);
  window.addEventListener("pageshow", () => {
    if (!suspended) return;
    suspended = false;
    if (element.isConnected) refreshSelection();
  }, listen);

  return { element, destroy() { disposed = true; invalidate(); entries = []; listeners.abort(); } };
}
