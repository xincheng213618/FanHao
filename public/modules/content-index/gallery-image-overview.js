const PAGE_SIZE = 18;

export function createGalleryImageOverview({ signal, images, currentIndex, catalogState, loadCatalog, chooseImage, canOpen, visibilityChanged, formatNumber }) {
  const button = control("图片总览");
  button.classList.add("compact", "gallery-image-overview-trigger");
  button.setAttribute("aria-controls", "galleryImageOverview");
  button.setAttribute("aria-expanded", "false");

  const panel = node("section", "gallery-image-overview");
  panel.id = "galleryImageOverview";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "galleryImageOverviewTitle");
  const heading = node("h2", "", "图片总览");
  heading.id = "galleryImageOverviewTitle";
  const closeButton = control("关闭总览");
  const header = node("header", "gallery-image-overview-header");
  header.append(heading, closeButton);

  const form = node("form", "gallery-image-overview-search");
  const input = node("input");
  input.type = "search";
  input.placeholder = "文件名或归档路径";
  input.setAttribute("aria-label", "按文件名查找图片");
  input.autocomplete = "off";
  const submit = control("查找");
  submit.type = "submit";
  const clear = control("清除");
  clear.hidden = true;
  form.append(input, submit, clear);

  const feedback = node("div", "gallery-image-overview-feedback");
  feedback.hidden = true;
  const status = node("span");
  status.setAttribute("role", "status");
  const retry = control("重试目录");
  retry.hidden = true;
  feedback.append(status, retry);
  const grid = node("div", "gallery-image-overview-grid");
  const footer = node("footer", "gallery-image-overview-pagination");
  const previous = control("上一页总览");
  const next = control("下一页总览");
  const count = node("span");
  footer.append(previous, count, next);
  panel.append(header, form, feedback, grid, footer);

  let query = "";
  let page = 0;
  let composing = false;
  let previousImages = null;
  let previousQuery = "";
  let matches = null;
  let displayed = [];
  const events = { signal };
  const isOpen = () => !panel.hidden;

  function refresh() {
    if (!isOpen() || signal.aborted) return;
    const list = images();
    if (list !== previousImages || query !== previousQuery) {
      matches = query ? [] : null;
      if (matches) for (const [index, image] of list.entries()) {
        if (normalized(`${image.name || ""}\n${image.archivePath || ""}`).includes(query)) matches.push({ index, image });
      }
      previousImages = list;
      previousQuery = query;
    }
    const catalog = catalogState();
    const incomplete = list.length < catalog.total;
    const totalMatches = matches?.length ?? list.length;
    const readStatus = catalog.failed ? "完整目录读取失败" : catalog.loading ? "正在读取完整目录" : "";
    status.textContent = [
      incomplete && [readStatus, `已加载 ${formatNumber(list.length)} / ${formatNumber(catalog.total)} 张。`].filter(Boolean).join("，"),
      query && `${incomplete ? "已加载范围内" : ""}匹配 ${formatNumber(totalMatches)} 张。`
    ].filter(Boolean).join(" ");
    feedback.hidden = !status.textContent;
    if (document.activeElement === retry && !catalog.failed) input.focus({ preventScroll: true });
    retry.hidden = !incomplete || !catalog.failed;

    const pageCount = Math.max(1, Math.ceil(totalMatches / PAGE_SIZE));
    page = Math.min(page, pageCount - 1);
    const offset = page * PAGE_SIZE;
    const entries = matches ? matches.slice(offset, offset + PAGE_SIZE)
      : list.slice(offset, offset + PAGE_SIZE).map((image, index) => ({ index: offset + index, image }));
    const changed = entries.length !== displayed.length || entries.some(({ index, image }, position) => {
      const previous = displayed[position];
      return !previous || index !== previous.index || image.url !== previous.image.url || image.previewUrl !== previous.image.previewUrl
        || image.name !== previous.image.name || image.archivePath !== previous.image.archivePath;
    });
    const focusedTile = grid.contains(document.activeElement) ? document.activeElement.dataset.index : "";
    if (changed) {
      grid.replaceChildren(...entries.map(renderTile));
      displayed = entries;
      if (focusedTile) (grid.querySelector(`[data-index="${focusedTile}"]`) || input).focus({ preventScroll: true });
    }
    for (const tile of grid.children) {
      tile.setAttribute("aria-current", String(Number(tile.dataset.index) === currentIndex()));
    }
    if ((document.activeElement === previous && page === 0) || (document.activeElement === next && page === pageCount - 1)) {
      (grid.firstElementChild || input).focus({ preventScroll: true });
    }
    previous.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
    footer.hidden = !totalMatches;
    count.textContent = totalMatches
      ? `${formatNumber(offset + 1)}–${formatNumber(offset + entries.length)} / ${formatNumber(totalMatches)} 张` : "";
    clear.hidden = !query && !input.value;
  }

  function renderTile({ index, image }) {
    const tile = node("button", "gallery-image-overview-tile");
    tile.type = "button";
    tile.dataset.index = String(index);
    const number = formatNumber(index + 1);
    const name = image.name || "";
    tile.setAttribute("aria-label", [`打开第 ${number} 张`, name].filter(Boolean).join(" · "));
    tile.title = image.archivePath || name;
    const preview = node("img");
    preview.alt = "";
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.fetchPriority = "low";
    preview.src = image.previewUrl || image.url;
    const caption = node("span");
    caption.append(node("strong", "", number), node("span", "", name));
    tile.append(preview, caption);
    return tile;
  }

  function changePage(direction) {
    page = Math.max(0, page + direction);
    grid.scrollTop = 0;
    refresh();
  }

  function setQuery(value) {
    query = normalized(value);
    page = query ? 0 : Math.floor(currentIndex() / PAGE_SIZE);
    grid.scrollTop = 0;
    refresh();
    if (!query) showCurrentTile();
  }

  function showCurrentTile() {
    grid.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function open() {
    if (signal.aborted || !button.isConnected || !canOpen()) return;
    if (!query) page = Math.floor(currentIndex() / PAGE_SIZE);
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    visibilityChanged(true);
    refresh();
    showCurrentTile();
    const catalog = catalogState();
    if (!catalog.failed && images().length < catalog.total) void loadCatalog();
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    visibilityChanged(false);
    grid.replaceChildren();
    displayed = [];
    composing = false;
    button.focus({ preventScroll: true });
  }

  button.addEventListener("click", open, events);
  closeButton.addEventListener("click", close, events);
  previous.addEventListener("click", () => changePage(-1), events);
  next.addEventListener("click", () => changePage(1), events);
  retry.addEventListener("click", loadCatalog, events);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!composing) setQuery(input.value);
  }, events);
  input.addEventListener("input", () => {
    clear.hidden = !query && !input.value;
    if (!input.value && !composing && query) setQuery("");
  }, events);
  input.addEventListener("compositionstart", () => { composing = true; }, events);
  input.addEventListener("compositionend", () => { composing = false; }, events);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  }, events);
  clear.addEventListener("click", () => {
    input.value = "";
    input.focus({ preventScroll: true });
    setQuery("");
  }, events);
  grid.addEventListener("click", (event) => {
    const tile = event.target.closest(".gallery-image-overview-tile");
    if (!tile || !isOpen() || !grid.contains(tile)) return;
    close();
    chooseImage(Number(tile.dataset.index));
  }, events);

  return { button, panel, isOpen, close, refresh, focus: () => closeButton.focus({ preventScroll: true }) };
}

function normalized(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replaceAll("\\", "/").trim();
}

function control(label) {
  const button = node("button", "gallery-image-pager-button", label);
  button.type = "button";
  return button;
}

function node(tag, className = "", value = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
}
