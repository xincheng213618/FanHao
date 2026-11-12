export function openChapterSearch({ screen, content, trigger, isCurrent, formatNumber, revealMatch, onClose, onSearchBook, focusInput = true }) {
  const highlightName = "novel-reader-search-match";
  const panel = document.createElement("section");
  panel.className = "novel-reader-chapter-search";
  panel.id = "novelReaderChapterSearch";
  panel.setAttribute("role", "search");
  panel.setAttribute("aria-label", "本章正文");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "查找本章正文";
  input.setAttribute("aria-label", "查找本章正文");
  input.enterKeyHint = "search";
  input.autocomplete = "off";
  input.maxLength = 160;
  const previous = searchButton("↑", "上一处匹配");
  const next = searchButton("↓", "下一处匹配");
  const dismiss = searchButton("×", "关闭本章查找");
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  panel.append(input, previous, next, dismiss, status);
  if (onSearchBook) {
    const wholeBook = searchButton("搜全书", "搜索全书正文");
    wholeBook.className = "novel-reader-search-whole-book";
    wholeBook.addEventListener("click", () => { if (active() && !composing) onSearchBook(input.value, wholeBook); });
    panel.append(wholeBook);
  }
  screen.append(panel);
  screen.classList.add("search-open");
  trigger.setAttribute("aria-expanded", "true");
  trigger.setAttribute("aria-controls", panel.id);

  let query = "";
  let composing = false;
  let pattern = null;
  let groups = [];
  let total = 0;
  let cursor = -1;
  let currentGroup = 0;
  let matchEnd = 0;
  let clearMatch = null;
  const active = () => panel.isConnected && isCurrent();

  function updateControls() {
    previous.disabled = next.disabled = total === 0;
    status.textContent = !query ? "" : !total ? "本章无匹配"
      : cursor < 0 ? `${formatNumber(total)} 处匹配`
        : `第 ${formatNumber(cursor + 1)} / ${formatNumber(total)} 处`;
  }

  function readQuery() {
    if (!active() || composing) return;
    const value = input.value.trim();
    if (value === query) return;
    clearMatch?.();
    clearMatch = null;
    query = value;
    groups = [];
    total = 0;
    cursor = -1;
    currentGroup = 0;
    if (query) {
      pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const paragraph of content.children) {
        const text = paragraph.textContent;
        const first = total;
        while (pattern.exec(text)) total++;
        // Keep one entry per paragraph even when a short query matches many times.
        if (total > first) groups.push({ paragraph, text, first, end: total });
      }
    }
    updateControls();
  }

  function locate(direction) {
    if (!active() || composing || !total) return;
    const target = cursor < 0 ? (direction > 0 ? 0 : total - 1) : (cursor + direction + total) % total;
    let group = currentGroup;
    while (target < groups[group].first) group--;
    while (target >= groups[group].end) group++;
    const { paragraph, text, first } = groups[group];
    const consecutive = cursor >= 0 && target === cursor + 1 && currentGroup === group;
    pattern.lastIndex = consecutive ? matchEnd : 0;
    let match;
    for (let index = consecutive ? target : first; index <= target; index++) match = pattern.exec(text);
    cursor = target;
    currentGroup = group;
    matchEnd = pattern.lastIndex;
    clearMatch?.();
    const highlight = highlightMatch(paragraph, text, match.index, matchEnd, highlightName);
    clearMatch = highlight.clear;
    revealMatch(highlight.rect(), panel);
    updateControls();
  }

  function close({ restoreFocus = false } = {}) {
    clearMatch?.();
    panel.remove();
    screen.classList.remove("search-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-controls");
    if (restoreFocus) trigger.focus({ preventScroll: true });
    onClose();
  }

  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; readQuery(); });
  input.addEventListener("input", event => { if (!event.isComposing) readQuery(); });
  input.addEventListener("search", readQuery);
  panel.addEventListener("keydown", event => {
    if (!active() || composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.target === input && event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      locate(event.shiftKey ? -1 : 1);
    }
  });
  previous.addEventListener("click", () => locate(-1));
  next.addEventListener("click", () => locate(1));
  dismiss.addEventListener("click", () => { if (active()) close({ restoreFocus: true }); });
  updateControls();
  (focusInput ? input : dismiss).focus({ preventScroll: true });
  return { close, locateFirst(value) {
    input.value = value;
    readQuery();
    locate(1);
    return total > 0;
  } };
}

function searchButton(symbol, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = symbol;
  button.setAttribute("aria-label", label);
  return button;
}

function highlightMatch(paragraph, text, start, end, name) {
  const highlights = globalThis.CSS?.highlights;
  if (highlights && globalThis.Highlight) {
    const range = document.createRange();
    range.setStart(paragraph.firstChild, start);
    range.setEnd(paragraph.firstChild, end);
    highlights.set(name, new Highlight(range));
    return { rect: () => range.getClientRects()[0] || range.getBoundingClientRect(), clear: () => highlights.delete(name) };
  }
  const mark = document.createElement("mark");
  mark.className = name;
  mark.textContent = text.slice(start, end);
  paragraph.replaceChildren(text.slice(0, start), mark, text.slice(end));
  return { rect: () => mark.getClientRects()[0] || mark.getBoundingClientRect(), clear: () => { paragraph.textContent = text; } };
}
