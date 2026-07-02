import { fetchJson } from "./api.js?v=20260702-novel-local-manage-74";
import { formatBytes, formatNumber } from "./format.js";
import { createDetailSectionTitle, revealDetailBlock } from "./detail-ui.js";

export function createInfoPreviewSection(context) {
  const { getActiveUrl } = context;

  function createFileInfoPanel(work) {
    const section = document.createElement("div");
    section.className = "detail-block";
    section.append(createDetailSectionTitle("作品资料", formatNumber(work.infos?.length || 0)));

    const list = document.createElement("div");
    list.className = "file-list compact";
    const preview = document.createElement("div");
    preview.className = "info-preview";
    for (const file of work.infos || []) {
      const row = document.createElement("div");
      row.className = "file-row";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = file.name;
      const meta = document.createElement("span");
      meta.textContent = `${file.ext || ""} · ${formatBytes(file.size)}`;
      info.append(title, meta);

      const view = document.createElement("button");
      view.type = "button";
      view.textContent = "查看";
      view.addEventListener("click", () => renderInfoPreview(preview, file));
      row.append(info, view);
      list.append(row);
    }

    if (!work.infos?.length) {
      const empty = document.createElement("div");
      empty.className = "message-box quiet";
      empty.textContent = "这个作品没有资料。";
      list.append(empty);
    }

    section.append(list);
    section.append(preview);
    return section;
  }

  function createInlineInfoPanel(work) {
    if (hasStructuredInfo(work.infoMetadata)) {
      const section = document.createElement("div");
      section.className = "detail-block inline-info-block";
      section.append(createDetailSectionTitle("作品资料", ""));
      const preview = document.createElement("div");
      preview.className = "info-preview";
      section.append(preview);
      renderStructuredInfo(preview, work.infoMetadata, { showHeader: false });
      return section;
    }

    const file = primaryInfoFile(work);
    if (!file) return null;

    const section = document.createElement("div");
    section.className = "detail-block inline-info-block";
    section.append(createDetailSectionTitle("作品资料", ""));

    const preview = document.createElement("div");
    preview.className = "info-preview";
    section.append(preview);
    renderInfoPreview(preview, file, { reveal: false, showHeader: false });
    return section;
  }

  function primaryInfoFile(work) {
    const files = work.infos || [];
    return files.find((file) => /^info\.(txt|json|nfo)$/i.test(file.name || "")) || files[0] || null;
  }

  async function renderInfoPreview(mount, file, options = {}) {
    const activeUrl = getActiveUrl();
    mount.innerHTML = `<div class="loading-row">正在读取作品资料</div>`;
    if (options.reveal !== false) revealDetailBlock(mount);
    try {
      const data = await fetchJson(activeUrl, `/api/info/${encodeURIComponent(file.id)}`);
      mount.innerHTML = "";
      if (data.displayable === false) {
        const box = document.createElement("div");
        box.className = "message-box quiet";
        box.textContent = "这个作品没有可显示的作品资料。";
        mount.append(box);
        return;
      }

      if (hasStructuredInfo(data.metadata)) {
        renderStructuredInfo(mount, data.metadata, {
          showHeader: options.showHeader !== false,
          headerTitle: data.name || file.name
        });
        return;
      }

      const panel = document.createElement("div");
      panel.className = "info-preview-panel";
      if (options.showHeader !== false) {
        const head = document.createElement("div");
        head.className = "info-preview-head";
        const title = document.createElement("strong");
        title.textContent = data.name || file.name;
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "收起";
        close.addEventListener("click", () => {
          mount.innerHTML = "";
        });
        head.append(title, close);
        panel.append(head);
      }
      const content = document.createElement("pre");
      content.textContent = data.content || "这个作品没有可显示内容。";
      panel.append(content);
      mount.append(panel);
      if (options.reveal !== false) revealDetailBlock(mount);
    } catch (error) {
      mount.innerHTML = "";
      const box = document.createElement("div");
      box.className = "message-box error";
      box.textContent = error.message;
      mount.append(box);
      if (options.reveal !== false) revealDetailBlock(mount);
    }
  }

  function hasStructuredInfo(metadata) {
    return Boolean(metadata && ((metadata.fields || []).length || metadata.rawText));
  }

  function renderStructuredInfo(mount, metadata, options = {}) {
    mount.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "info-preview-panel structured-info-panel";

    if (options.showHeader) {
      const head = document.createElement("div");
      head.className = "info-preview-head";
      const title = document.createElement("strong");
      title.textContent = options.headerTitle || metadata.title || metadata.code || "作品资料";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "收起";
      close.addEventListener("click", () => {
        mount.innerHTML = "";
      });
      head.append(title, close);
      panel.append(head);
    }

    const fields = metadata.fields || [];
    if (fields.length) {
      const grid = document.createElement("dl");
      grid.className = "structured-info-grid";
      for (const field of fields) {
        const label = document.createElement("dt");
        label.textContent = field.label;
        const value = document.createElement("dd");
        value.textContent = field.value;
        grid.append(label, value);
      }
      panel.append(grid);
    } else {
      const content = document.createElement("pre");
      content.textContent = metadata.rawText || "这个作品没有可显示内容。";
      panel.append(content);
    }

    if (metadata.rawTextTruncated) {
      const note = document.createElement("div");
      note.className = "info-preview-note";
      note.textContent = "资料较长，已显示主要字段。";
      panel.append(note);
    }

    mount.append(panel);
  }

  return {
    createFileInfoPanel,
    createInlineInfoPanel
  };
}







