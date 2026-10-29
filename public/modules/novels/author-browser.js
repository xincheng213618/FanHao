const NOVEL_AUTHOR_PAGE_SIZE = 48;

export function createNovelAuthorBrowser({ api, isCurrent, selectAuthor, onClose }) {
  let dialog = null, controller = null, lifetime = null, requestId = 0;
  let applied = null, failed = null, busy = false, composing = false;
  let retryButton = null, intentRevision = 0, focusOwner = null;
  let opener, scroll, overflow, input, sort, results, status, previous, next;
  const current = () => Boolean(dialog?.isConnected && dialog.open && isCurrent());
  const close = () => {
    if (!dialog) return;
    const element = dialog; dialog = null;
    requestId++; controller?.abort(); lifetime.abort();
    if (element.open) element.close();
    element.remove(); document.body.style.overflow = overflow;
    if (isCurrent()) {
      window.scrollTo({ top: scroll, behavior: "auto" });
      if (document.hasFocus()) (opener.isConnected ? opener : document.querySelector(".novel-browse-authors"))?.focus({ preventScroll: true });
    }
    onClose();
  };
  const load = async spec => {
    if (!current()) return;
    const id = ++requestId;
    focusOwner = document.activeElement;
    const focused = focusOwner, intent = intentRevision;
    controller?.abort(); controller = new AbortController();
    busy = true; failed = null;
    status.textContent = "正在读取作者…";
    previous.setAttribute("aria-disabled", "true"); next.setAttribute("aria-disabled", "true");
    if (retryButton?.isConnected) { retryButton.setAttribute("aria-disabled", "true"); retryButton.textContent = "正在读取…"; }
    else results.textContent = "";
    const params = new URLSearchParams({ q: spec.query, sort: spec.sort, limit: String(NOVEL_AUTHOR_PAGE_SIZE), offset: String(spec.offset) });
    try {
      const data = await api(`/api/novels/authors?${params}`, { signal: controller.signal });
      if (!current() || id !== requestId) return;
      if (!Array.isArray(data.authors) || data.authors.length > NOVEL_AUTHOR_PAGE_SIZE || !Number.isFinite(Number(data.total))) throw new Error("作者列表数据不完整，请重试。");
      const total = Math.max(0, Number(data.total)), offset = Math.max(0, Number(data.offset ?? spec.offset));
      if (!data.authors.length && total > 0 && offset >= total && offset > 0 && !spec.clamped) {
        const last = Math.floor((total - 1) / NOVEL_AUTHOR_PAGE_SIZE) * NOVEL_AUTHOR_PAGE_SIZE;
        const history = [...spec.history.filter(value => value < last), last];
        return load({ ...spec, offset: last, history, index: history.length - 1, clamped: true });
      }
      applied = { ...spec, clamped: false, offset: total ? offset : 0, history: total ? spec.history : [0], index: total ? spec.index : 0,
        nextOffset: offset + data.authors.length, hasNext: data.authors.length > 0 && offset + data.authors.length < total };
      results.textContent = "";
      status.textContent = `${spec.query ? `“${spec.query}” · ` : "全库 · "}${!total ? "没有匹配的作者" : !data.authors.length ? `此页暂无作者（共 ${total} 位），可返回上一页或重新搜索。` : `显示 ${offset + 1}–${offset + data.authors.length} / ${total} 位作者`}`;
      for (const author of data.authors) {
        if (!String(author.name || "").trim()) continue;
        const row = document.createElement("li"), button = document.createElement("button");
        button.type = "button"; button.className = "novel-author-result";
        const name = document.createElement("strong"), count = document.createElement("span");
        name.textContent = author.name; count.textContent = `${Number(author.bookCount || 0).toLocaleString()} 本 · ${Number(author.chapterCount || 0).toLocaleString()} 章`;
        button.append(name, count);
        button.addEventListener("click", () => { if (!button.isConnected || !current() || busy) return; close(); selectAuthor(author.name); });
        row.append(button); results.append(row);
      }
    } catch (error) {
      if (!current() || id !== requestId) return;
      failed = spec;
      status.textContent = error.message || "作者列表读取失败";
      if (!retryButton) {
        retryButton = document.createElement("button"); retryButton.type = "button"; retryButton.className = "novel-secondary-button";
        retryButton.addEventListener("click", () => { if (retryButton.isConnected && current() && !busy && failed) void load(failed); });
      }
      retryButton.textContent = "重试作者列表"; retryButton.removeAttribute("aria-disabled");
      if (!retryButton.isConnected) { const row = document.createElement("li"); row.append(retryButton); results.append(row); }
    } finally {
      if (current() && id === requestId) {
        busy = false;
        previous.disabled = Boolean(failed) || !applied || applied.index === 0;
        next.disabled = Boolean(failed) || !applied?.hasNext;
        previous.setAttribute("aria-disabled", String(previous.disabled)); next.setAttribute("aria-disabled", String(next.disabled));
        if (intent === intentRevision && [previous, next, retryButton].includes(focused) && document.activeElement === document.body && document.hasFocus()) {
          status.tabIndex = -1; status.focus({ preventScroll: true });
        }
      }
    }
  };
  return {
    close,
    open(button) {
      opener = button; scroll = window.scrollY; overflow = document.body.style.overflow;
      lifetime = new AbortController(); dialog = document.createElement("dialog"); dialog.className = "novel-author-dialog"; dialog.setAttribute("aria-label", "浏览作者");
      const noteIntent = event => {
        const activation = event.type === "keydown" && !event.ctrlKey && !event.metaKey && !event.altKey && ["Enter", " ", "Spacebar"].includes(event.key);
        if (event.target === focusOwner && (activation || event.type === "pointerdown" || event.type === "focusin")) return;
        if (event.type !== "focusin" || event.target !== document.body) intentRevision++;
      };
      for (const type of ["keydown", "pointerdown", "wheel", "touchmove", "focusin"]) document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: lifetime.signal });
      const head = document.createElement("header"), heading = document.createElement("h2"), dismiss = document.createElement("button");
      heading.textContent = "浏览全库作者"; dismiss.type = "button"; dismiss.textContent = "关闭"; dismiss.setAttribute("aria-label", "关闭作者浏览"); dismiss.addEventListener("click", close);
      head.append(heading, dismiss);
      const form = document.createElement("form"); form.className = "novel-author-search";
      input = document.createElement("input"); input.type = "search"; input.placeholder = "输入作者名"; input.setAttribute("aria-label", "搜索作者"); input.autocomplete = "off";
      input.addEventListener("compositionstart", () => { composing = true; }); input.addEventListener("compositionend", () => { composing = false; });
      const search = document.createElement("button"); search.type = "submit"; search.textContent = "搜索作者";
      sort = document.createElement("select"); sort.setAttribute("aria-label", "作者排序");
      for (const [value, label] of [["books", "作品最多"], ["name", "作者名"], ["updated", "最近更新"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; sort.append(option); }
      const searchFirstPage = () => { if (current() && !composing) void load({ query: input.value.trim(), sort: sort.value, offset: 0, history: [0], index: 0 }); };
      form.addEventListener("submit", event => { event.preventDefault(); searchFirstPage(); }); sort.addEventListener("change", searchFirstPage);
      form.append(input, search, sort);
      status = document.createElement("p"); status.className = "novel-author-status"; status.setAttribute("role", "status");
      results = document.createElement("ul"); results.className = "novel-author-results";
      const pager = document.createElement("nav"); pager.setAttribute("aria-label", "作者分页");
      previous = document.createElement("button"); previous.type = "button"; previous.textContent = "上一页"; previous.setAttribute("aria-label", "上一页作者");
      next = document.createElement("button"); next.type = "button"; next.textContent = "下一页"; next.setAttribute("aria-label", "下一页作者");
      previous.addEventListener("click", () => { if (current() && !busy && applied?.index > 0) void load({ ...applied, offset: applied.history[applied.index - 1], index: applied.index - 1 }); });
      next.addEventListener("click", () => { if (current() && !busy && applied?.hasNext) { const history = [...applied.history.slice(0, applied.index + 1), applied.nextOffset]; void load({ ...applied, offset: applied.nextOffset, history, index: history.length - 1 }); } });
      pager.append(previous, next); dialog.append(head, form, status, results, pager); document.body.append(dialog);
      dialog.addEventListener("cancel", event => { if (composing) event.preventDefault(); });
      dialog.addEventListener("close", close, { signal: lifetime.signal }); window.addEventListener("pagehide", close, { once: true, signal: lifetime.signal });
      document.body.style.overflow = "hidden"; dialog.showModal(); input.focus(); searchFirstPage();
    }
  };
}
