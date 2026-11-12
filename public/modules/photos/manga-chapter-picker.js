const CHAPTERS_PER_PAGE = 32;

export function normalizeChapterQuery(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().trim();
}

export function createMangaChapterPicker({ container, trigger, currentChapter, current, chapters, available, select, formatNumber }) {
  const dialog = document.createElement("dialog");
  dialog.className = "manga-reader-chapters";
  dialog.setAttribute("aria-labelledby", "manga-reader-chapters-title");
  dialog.innerHTML = `
    <header><h2 id="manga-reader-chapters-title">选择章节</h2><button type="button" data-close>关闭</button></header>
    <input type="search" aria-label="查找章节" placeholder="章节标题或话数" autocomplete="off">
    <div class="manga-reader-chapter-list"></div>
    <footer aria-label="选章分页">
      <button type="button" data-previous>上一页</button><span role="status"></span><button type="button" data-next>下一页</button>
    </footer>`;
  const input = dialog.querySelector("input");
  const list = dialog.querySelector(".manga-reader-chapter-list");
  const previous = dialog.querySelector("[data-previous]");
  const next = dialog.querySelector("[data-next]");
  const count = dialog.querySelector("[role=status]");
  let source = null, matches = [], query = "", page = 0, composing = false;

  function close({ restoreFocus = true } = {}) {
    if (!dialog.open) return;
    dialog.close();
    if (restoreFocus && current()) trigger.focus({ preventScroll: true });
  }

  function renderRows() {
    const pages = Math.max(1, Math.ceil(matches.length / CHAPTERS_PER_PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    previous.disabled = page === 0;
    next.disabled = page === pages - 1;
    count.textContent = matches.length ? `${formatNumber(matches.length)} 话 · ${page + 1} / ${pages} 页` : "没有匹配的章节";
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.chapterIndex : null;
    const rows = document.createDocumentFragment();
    for (const chapter of matches.slice(page * CHAPTERS_PER_PAGE, (page + 1) * CHAPTERS_PER_PAGE)) {
      const active = Number(chapter.index) === Number(currentChapter);
      const title = chapter.title || `第 ${chapter.index} 话`;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.chapterIndex = String(chapter.index);
      button.disabled = !active && !available(chapter);
      if (active) button.setAttribute("aria-current", "true");
      const index = document.createElement("span"), name = document.createElement("strong"), status = document.createElement("small");
      index.textContent = `第 ${chapter.index} 话`;
      name.textContent = title;
      status.textContent = active ? "当前" : button.disabled ? (chapter.status === "failed" ? "下载失败" : "待下载") : "";
      button.append(index, name, status);
      rows.append(button);
    }
    list.replaceChildren(rows);
    if (focused) {
      const target = [...list.children].find(button => button.dataset.chapterIndex === focused && !button.disabled);
      (target || input).focus({ preventScroll: true });
    }
  }

  function updateMatches({ locate = false } = {}) {
    source = chapters();
    const ordinal = query.match(/^(?:第\s*)?(\d+)(?:\s*(?:[话話回]|章[节節]?))?$/u);
    const exact = ordinal && source.find(chapter => Number(chapter.index) === Number(ordinal[1]));
    matches = exact ? [exact] : query
      ? source.filter(chapter => normalizeChapterQuery(`${chapter.index} ${chapter.title || ""}`).includes(query))
      : source;
    if (locate) {
      const position = !query ? matches.findIndex(chapter => Number(chapter.index) === Number(currentChapter)) : 0;
      page = Math.floor(Math.max(position, 0) / CHAPTERS_PER_PAGE);
    }
    renderRows();
    if (locate) {
      list.scrollTop = 0;
      const selected = list.querySelector('[aria-current="true"]');
      if (selected) {
        const row = selected.getBoundingClientRect();
        list.scrollTop = Math.max(0, row.top - list.getBoundingClientRect().top - (list.clientHeight - row.height) / 2);
      }
    }
  }

  function acceptInput() {
    if (!dialog.open || !current() || composing) return;
    const nextQuery = normalizeChapterQuery(input.value);
    if (nextQuery === query) return;
    query = nextQuery;
    updateMatches({ locate: true });
  }

  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; acceptInput(); });
  input.addEventListener("input", acceptInput);
  input.addEventListener("search", acceptInput);
  input.addEventListener("keydown", event => {
    if (composing || event.isComposing || event.keyCode === 229 || !current()) return;
    if (event.key !== "Enter" && event.key !== "ArrowDown") return;
    event.preventDefault();
    acceptInput();
    list.querySelector("button:not(:disabled)")?.focus();
  });
  for (const [button, direction] of [[previous, -1], [next, 1]]) button.addEventListener("click", () => {
    if (!dialog.open || !current() || button.disabled) return;
    page += direction;
    renderRows();
    list.scrollTop = 0;
    if (button.disabled) (direction < 0 ? next : previous).focus({ preventScroll: true });
  });
  list.addEventListener("click", event => {
    const button = event.target.closest("[data-chapter-index]");
    if (!dialog.open || !current() || !button || button.disabled) return;
    const chapter = chapters().find(item => Number(item.index) === Number(button.dataset.chapterIndex));
    if (!chapter) return;
    if (Number(chapter.index) === Number(currentChapter)) { close(); return; }
    if (!available(chapter)) return;
    close();
    select(chapter, event.detail === 0);
  });
  dialog.querySelector("[data-close]").addEventListener("click", () => close());
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!composing) close(); });
  container.append(dialog);
  return {
    open() {
      if (!current() || dialog.open) return;
      input.value = query = "";
      composing = false;
      dialog.showModal();
      updateMatches({ locate: true });
    },
    refresh() {
      if (dialog.open && current() && source !== chapters()) updateMatches();
    },
    close
  };
}
