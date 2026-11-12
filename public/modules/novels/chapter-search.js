export function createNovelChapterSearch({ page, content, trigger, formatNumber, onLocate, onBookSearch }) {
  const highlightName = "novel-chapter-match";
  let panel = null;
  let clearMatch = null;

  function close({ restoreFocus = false } = {}) {
    if (!panel) return false;
    clearMatch?.();
    clearMatch = null;
    panel.remove();
    panel = null;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-controls");
    if (restoreFocus) trigger.focus({ preventScroll: true });
    return true;
  }

  function toggle(initialQuery = "") {
    if (panel) { close({ restoreFocus: true }); return; }
    if (!page.isConnected) return;
    const search = document.createElement("section");
    search.className = "novel-chapter-search";
    search.id = "novel-chapter-search";
    search.setAttribute("role", "search");
    search.setAttribute("aria-label", "本章正文");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "查找本章正文";
    input.setAttribute("aria-label", "查找本章正文");
    const previous = button("↑", "上一处匹配");
    const next = button("↓", "下一处匹配");
    const dismiss = button("×", "关闭本章查找");
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    search.append(input, previous, next, dismiss, status);
    if (onBookSearch) {
      const wholeBook = button("搜全书", "搜索全书正文");
      wholeBook.className = "novel-search-whole-book";
      wholeBook.addEventListener("click", () => { if (wholeBook.isConnected) onBookSearch(input.value); });
      search.append(wholeBook);
    }
    panel = search;
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", search.id);
    page.append(search);

    let composing = false;
    let query = "";
    let pattern = null;
    let groups = [];
    let total = 0;
    let cursor = -1;
    let groupIndex = 0;
    let matchEnd = 0;
    const current = () => search === panel && search.isConnected;

    function updateControls() {
      previous.disabled = next.disabled = total === 0;
      status.textContent = !query ? "" : !total ? "本章无匹配"
        : cursor < 0 ? `${formatNumber(total)} 处匹配` : `第 ${formatNumber(cursor + 1)} / ${formatNumber(total)} 处`;
    }

    function acceptInput() {
      if (!current() || composing) return;
      const value = input.value.trim();
      if (value === query) return;
      clearMatch?.();
      clearMatch = null;
      query = value;
      groups = [];
      total = 0;
      cursor = -1;
      groupIndex = 0;
      if (query) {
        pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
        for (const paragraph of content.children) {
          const text = paragraph.textContent;
          const first = total;
          while (pattern.exec(text)) total++;
          // Index paragraphs rather than retaining a Range for every match.
          if (total > first) groups.push({ paragraph, text, first, end: total });
        }
      }
      updateControls();
    }

    function locate(delta) {
      if (!current() || composing || !total) return false;
      const target = cursor < 0 ? (delta > 0 ? 0 : total - 1) : (cursor + delta + total) % total;
      let targetGroup = groupIndex;
      while (target < groups[targetGroup].first) targetGroup--;
      while (target >= groups[targetGroup].end) targetGroup++;
      const { paragraph, text, first } = groups[targetGroup];
      const consecutive = cursor >= 0 && target === cursor + 1 && groupIndex === targetGroup;
      pattern.lastIndex = consecutive ? matchEnd : 0;
      let match;
      for (let index = consecutive ? target : first; index <= target; index++) match = pattern.exec(text);
      cursor = target;
      groupIndex = targetGroup;
      matchEnd = pattern.lastIndex;
      clearMatch?.();
      const highlighted = highlightMatch(paragraph, text, match.index, matchEnd, highlightName);
      clearMatch = highlighted.clear;
      const viewport = window.visualViewport;
      const inset = Math.max(search.getBoundingClientRect().bottom + 12,
        (viewport?.height || window.innerHeight) * 0.28 + (viewport?.offsetTop || 0));
      onLocate();
      window.scrollTo({ top: window.scrollY + highlighted.rect().top - inset, behavior: "auto" });
      updateControls();
      return true;
    }

    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; acceptInput(); });
    input.addEventListener("input", event => { if (!event.isComposing) acceptInput(); });
    input.addEventListener("search", acceptInput);
    search.addEventListener("keydown", event => {
      if (!current()) return;
      if (composing || event.isComposing || event.keyCode === 229) {
        event.stopPropagation();
        return;
      }
      if (event.target === input && event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        locate(event.shiftKey ? -1 : 1);
      }
    });
    previous.addEventListener("click", () => locate(-1));
    next.addEventListener("click", () => locate(1));
    dismiss.addEventListener("click", () => { if (current()) close({ restoreFocus: true }); });
    updateControls();
    input.focus({ preventScroll: true });
    if (initialQuery) {
      input.value = initialQuery;
      acceptInput();
      return locate(1);
    }
  }

  return { toggle, close, jumpTo(query) { close(); return toggle(query); } };
}

function button(symbol, label) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = symbol;
  element.setAttribute("aria-label", label);
  element.title = label;
  return element;
}

function highlightMatch(paragraph, text, start, end, name) {
  const highlights = globalThis.CSS?.highlights;
  if (highlights && globalThis.Highlight) {
    const range = document.createRange();
    range.setStart(paragraph.firstChild, start);
    range.setEnd(paragraph.firstChild, end);
    highlights.set(name, new Highlight(range));
    return { rect: () => range.getBoundingClientRect(), clear: () => highlights.delete(name) };
  }

  const mark = document.createElement("mark");
  mark.className = name;
  mark.textContent = text.slice(start, end);
  paragraph.replaceChildren(text.slice(0, start), mark, text.slice(end));
  return { rect: () => mark.getBoundingClientRect(), clear: () => { paragraph.textContent = text; } };
}
