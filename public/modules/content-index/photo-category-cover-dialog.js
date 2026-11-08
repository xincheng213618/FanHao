const ENDPOINT = "/api/image-library/photo-category-cover";
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"];
const SOURCE_LABELS = { default: "默认封面", album: "套图封面", upload: "本地上传" };

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, action, type = "button") {
  const node = element("button", "", text);
  node.type = type;
  if (action) node.addEventListener("click", action);
  return node;
}

function coverFrame(url, { lazy = false } = {}) {
  const frame = element("span", "photo-category-cover-image", "无预览");
  frame.setAttribute("aria-hidden", "true");
  if (url) {
    const image = element("img");
    image.alt = "";
    image.decoding = "async";
    if (lazy) image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = url;
    frame.append(image);
  }
  return frame;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("无法读取所选图片。")), { once: true });
    reader.addEventListener("load", () => resolve(String(reader.result).split(",", 2)[1]), { once: true });
    reader.readAsDataURL(file);
  });
}

export function openPhotoCategoryCoverDialog({ api, category, name, onSaved }) {
  const existing = document.querySelector(".photo-category-cover-dialog[open]");
  if (existing) return existing;

  const dialog = element("dialog", "photo-category-cover-dialog");
  const title = element("h2", "", `设置封面 · ${name || "分类"}`);
  title.id = "photoCategoryCoverTitle";
  dialog.setAttribute("aria-labelledby", title.id);
  const header = element("header", "photo-category-cover-header");
  const close = button("关闭", () => dialog.close());
  close.autofocus = true;
  header.append(title, close);

  const content = element("div", "photo-category-cover-content");
  const settingsRow = element("div", "photo-category-cover-settings");
  const preview = element("div", "photo-category-cover-preview");
  const settingsControls = element("fieldset");
  const previewStatus = element("strong", "", "当前封面");
  const previewSource = element("span", "photo-category-cover-muted");
  previewSource.setAttribute("role", "status");
  const fileLabel = element("label", "photo-category-cover-file", "上传本地图片");
  const fileInput = element("input");
  fileInput.type = "file";
  fileInput.accept = UPLOAD_TYPES.join(",");
  const fileHelp = element("small", "photo-category-cover-muted", "支持 JPEG、PNG、WebP，最大 5 MiB");
  fileHelp.id = "photoCategoryCoverFileHelp";
  fileInput.setAttribute("aria-describedby", fileHelp.id);
  fileLabel.append(fileInput);
  const reset = button("恢复默认", () => choose({ source: "default" }));
  settingsControls.append(previewStatus, previewSource, fileLabel, fileHelp, reset);
  settingsRow.append(preview, settingsControls);

  const choicesControls = element("fieldset", "photo-category-cover-choices");
  const choicesTitle = element("legend", "", "从本分类选择套图封面");
  const searchForm = element("form", "photo-category-cover-search");
  const searchInput = element("input");
  searchInput.type = "search";
  searchInput.placeholder = "搜索本分类套图";
  searchInput.setAttribute("aria-label", searchInput.placeholder);
  searchForm.append(searchInput, button("搜索", null, "submit"));
  const choices = element("ul", "photo-category-cover-grid");
  const status = element("p", "photo-category-cover-muted");
  status.setAttribute("role", "status");
  const pages = element("div", "photo-category-cover-pages");
  const previous = button("上一页", () => void loadChoices(query, history.at(-1), history.slice(0, -1)));
  const next = button("下一页", () => void loadChoices(query, nextOffset, [...history, offset]));
  const retry = button("重试读取", () => retryChoices?.());
  pages.append(previous, next, retry);
  choicesControls.append(choicesTitle, searchForm, status, choices, pages);
  content.append(settingsRow, choicesControls);

  const footer = element("footer", "photo-category-cover-footer");
  const error = element("p", "photo-category-cover-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const cancel = button("取消", () => dialog.close());
  const save = button("保存封面", () => void saveChoice());
  save.className = "photo-category-cover-save";
  footer.append(error, cancel, save);
  dialog.append(header, content, footer);

  const endpoint = `${ENDPOINT}?${new URLSearchParams({ category })}`;
  let current = null, draft = null, reader = null, saving = false;
  let previewUrl;
  let query = "", offset = 0, nextOffset = null, history = [], retryChoices = null;

  function showError(message = "") {
    error.textContent = message;
    error.hidden = !message;
  }

  function updateControls() {
    settingsControls.disabled = saving || !current;
    choicesControls.disabled = saving;
    reset.disabled = (draft || current)?.source === "default";
    close.disabled = cancel.disabled = saving;
    save.disabled = saving || !draft;
    save.textContent = saving ? "正在保存…" : "保存封面";
    previous.disabled = Boolean(reader) || !history.length;
    next.disabled = Boolean(reader) || nextOffset === null;
    retry.hidden = !retryChoices;
  }

  function updatePreview() {
    const selection = draft || current;
    const url = selection?.coverUrl || "";
    if (url !== previewUrl) {
      previewUrl = url;
      preview.replaceChildren(coverFrame(url));
    }
    previewStatus.textContent = draft ? "待保存封面" : "当前封面";
    previewSource.textContent = selection?.title || SOURCE_LABELS[selection?.source] || "正在读取…";
    const albumId = selection?.source === "album" ? selection.albumId : "";
    for (const option of choices.querySelectorAll("button")) {
      option.setAttribute("aria-pressed", String(option.dataset.albumId === albumId));
    }
  }

  function clearDraft() {
    if (draft?.source === "upload") URL.revokeObjectURL(draft.coverUrl);
    draft = null;
  }

  function choose(selection) {
    if (!current || saving) return;
    clearDraft();
    if (selection.source !== current.source || selection.source === "upload"
      || selection.source === "album" && selection.albumId !== current.albumId) draft = selection;
    if (selection.source !== "upload") fileInput.value = "";
    showError();
    updatePreview();
    updateControls();
  }

  async function loadChoices(search = "", start = 0, back = []) {
    if (saving) return;
    reader?.abort();
    const request = new AbortController();
    reader = request;
    retryChoices = null;
    status.textContent = "正在读取套图…";
    choices.setAttribute("aria-busy", "true");
    updateControls();
    const params = new URLSearchParams({ offset: start, limit: 16 });
    if (search) params.set("q", search);
    try {
      const data = await api(`${endpoint}&${params}`, { signal: request.signal });
      if (reader !== request || !dialog.open) return;
      current = data.settings;
      query = search;
      offset = start;
      history = back;
      nextOffset = data.nextOffset;
      choices.replaceChildren(...data.choices.map(item => {
        const row = element("li");
        const option = button("", () => choose({ source: "album", albumId: item.id, coverUrl: item.coverUrl, title: item.title }));
        option.dataset.albumId = item.id;
        option.title = item.title;
        option.append(coverFrame(item.coverUrl, { lazy: true }), element("span", "photo-category-cover-choice-title", item.title));
        row.append(option);
        return row;
      }));
      status.textContent = data.choices.length ? `第 ${start + 1}–${start + data.choices.length} 项，共 ${data.total} 项` : "没有符合条件的套图。";
      updatePreview();
    } catch (failure) {
      if (reader !== request || !dialog.open) return;
      status.textContent = failure.message || "读取分类封面失败。";
      retryChoices = () => void loadChoices(search, start, back);
    } finally {
      if (reader === request && dialog.open) {
        reader = null;
        choices.removeAttribute("aria-busy");
        updateControls();
      }
    }
  }

  async function saveChoice() {
    if (!draft || saving) return;
    const { source, albumId, file } = draft;
    saving = true;
    showError();
    updateControls();
    const body = { source };
    let settings;
    try {
      if (source === "album") body.albumId = albumId;
      if (source === "upload") body.data = await readBase64(file);
      ({ settings } = await api(endpoint, { method: "PUT", body }));
    } catch (failure) {
      saving = false;
      showError(failure.message || "保存封面失败。");
      updateControls();
      save.focus();
      return;
    }
    dialog.close("saved");
    onSaved?.(settings);
  }

  searchForm.addEventListener("submit", event => {
    event.preventDefault();
    void loadChoices(searchInput.value.trim());
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!UPLOAD_TYPES.includes(file.type) || file.size === 0 || file.size > MAX_UPLOAD_SIZE) {
      fileInput.value = "";
      showError("请选择不超过 5 MiB 的 JPEG、PNG 或 WebP 图片。");
      return;
    }
    choose({ source: "upload", coverUrl: URL.createObjectURL(file), file, title: file.name });
  });
  dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    reader?.abort();
    clearDraft();
    dialog.remove();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  updatePreview();
  void loadChoices();
  return dialog;
}
