const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const PREVIEW_LIMIT = 64 * 1024;

export function createTxtFormatTool({ api, state, writeStoredFlag = () => {}, txtToolMaxFileBytes = DEFAULT_MAX_BYTES } = {}) {
  const maxBytes = Number(txtToolMaxFileBytes) > 0 ? Number(txtToolMaxFileBytes) : DEFAULT_MAX_BYTES;
  const element = document.createElement("details");
  element.className = "txt-format-tool";
  element.innerHTML = `<summary>TXT 文本整理<span>合并断行 · 章节分段 · UTF-8 下载</span></summary>
    <div class="txt-format-workspace">
      <p>将所选 TXT 发送到当前资料库服务，整理后下载为 UTF-8 文件。需要本机管理员权限，不会加入小说书库。</p>
      <form>
        <label class="txt-format-file">选择 TXT 文件<input type="file" accept=".txt,text/plain" aria-describedby="txtFormatLimit"></label>
        <p id="txtFormatLimit"></p>
        <fieldset><legend>整理选项</legend>
          <label><input type="checkbox" name="indent">段落首行缩进两格</label>
          <label><input type="checkbox" name="cleanJunk">清理常见分页和章节导航文字</label>
        </fieldset>
        <button type="submit" class="txt-format-submit" disabled>整理并生成下载</button>
      </form>
      <p class="txt-format-status" role="status" aria-live="polite" aria-atomic="true"></p>
      <section class="txt-format-result" aria-label="整理结果" hidden></section>
    </div>`;
  const form = element.querySelector("form");
  const picker = element.querySelector('input[type="file"]');
  const submit = element.querySelector('button[type="submit"]');
  const indent = element.querySelector('[name="indent"]');
  const cleanJunk = element.querySelector('[name="cleanJunk"]');
  const status = element.querySelector(".txt-format-status");
  const result = element.querySelector(".txt-format-result");
  const listeners = new AbortController();
  const listen = { signal: listeners.signal };
  let file = null, operation = null, expiryTimer = null, suspended = false, disposed = false;
  indent.checked = state?.txtTool?.indent !== false;
  cleanJunk.checked = state?.txtTool?.cleanJunk !== false;
  element.querySelector("#txtFormatLimit").textContent = `支持 UTF-8、GB18030、GBK、Big5；单个文件不超过 ${Math.round(maxBytes / 1024 / 1024)} MB。原文件保持不变。`;

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

  function updateBusy() {
    form.setAttribute("aria-busy", String(Boolean(operation)));
    submit.disabled = Boolean(validationError(file));
    submit.setAttribute("aria-disabled", String(Boolean(operation)));
    submit.textContent = operation ? "正在整理…" : "整理并生成下载";
  }

  function invalidate() {
    const old = operation;
    operation = null;
    old?.controller.abort();
    if (old?.reader?.readyState === FileReader.LOADING) old.reader.abort();
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
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

  function renderResult(receipt) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(receipt?.id || ""))
      || receipt.downloadUrl !== `/api/tools/txt-format/download/${receipt.id}`
      || !Number.isFinite(Date.parse(receipt.expiresAt))) throw new Error("下载回执无效，请重新整理");
    const heading = document.createElement("h4");
    heading.textContent = String(receipt.fileName || "整理后的 TXT").slice(0, 240);
    const stats = document.createElement("p");
    const detail = receipt.stats || {};
    const count = value => new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value) || 0));
    stats.textContent = `输入编码：${String(detail.used_encoding || "自动识别").slice(0, 32)} · ${count(detail.chapters)} 章 · ${count(detail.paragraphs)} 段 · 清理 ${count(detail.removed_noise_lines)} 处`;
    const download = document.createElement("a");
    download.className = "txt-format-download";
    download.href = receipt.downloadUrl;
    download.download = String(receipt.fileName || "formatted.txt");
    download.textContent = "下载整理后的 TXT";
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

  picker.addEventListener("change", () => {
    file = picker.files?.[0] || null;
    invalidate();
    const error = validationError(file);
    message(error || `已选择 ${file.name}，点击整理后生成下载。`, Boolean(error));
  }, listen);
  for (const control of [indent, cleanJunk]) control.addEventListener("change", () => {
    invalidate();
    if (state?.txtTool) state.txtTool[control.name] = control.checked;
    try { writeStoredFlag(`fanhao.txtTool.${control.name}`, control.checked); } catch { /* Preferences are optional. */ }
    message(validationError(file) || "选项已更新，点击整理后生成下载。");
  }, listen);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (operation || disposed || suspended || !element.isConnected) return;
    const error = validationError(file);
    if (error) { message(error, true); picker.focus(); return; }
    invalidate();
    const owner = { controller: new AbortController(), reader: null };
    const source = file;
    operation = owner;
    updateBusy();
    message("正在读取并整理文件，请稍候…");
    try {
      let contentBase64 = await readFile(owner, source);
      if (!isCurrent(owner)) return;
      // Keep only the File between attempts. The encoded book exists only for
      // this request; preview/download use the server's bounded receipt.
      const pending = api("/api/tools/txt-format", { method: "POST", signal: owner.controller.signal,
        body: { fileName: source.name, contentBase64, options: { indent: indent.checked, cleanJunk: cleanJunk.checked } } });
      contentBase64 = null;
      const receipt = await pending;
      if (!isCurrent(owner)) return;
      renderResult(receipt);
      message("整理完成，可预览并下载。原文件未修改。");
    } catch (error) {
      if (!isCurrent(owner)) return;
      message(error.message || "整理失败，请重试", true);
    } finally {
      if (operation === owner) { operation = null; updateBusy(); }
    }
  }, listen);
  window.addEventListener("pagehide", () => {
    suspended = true;
    const pending = Boolean(operation);
    const hadResult = !result.hidden;
    invalidate();
    if (pending) message("本次等待已结束，返回后可重新提交。");
    else if (hadResult) message("临时结果已清除，返回后可重新整理。");
  }, listen);
  window.addEventListener("pageshow", () => { suspended = false; }, listen);

  return { element, destroy() { disposed = true; invalidate(); file = null; listeners.abort(); } };
}
