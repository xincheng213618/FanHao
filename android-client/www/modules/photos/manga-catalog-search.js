import { formatNumber } from "../../js/format.js";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-78764ed05056";

const PAGE_SIZE = 40;

export function openMangaCatalogSearch({ trigger, isCurrent, readChapters, canOpen, openChapter }) {
  const sheet = openMobileActionSheet({ title: "搜索漫画章节", trigger });
  sheet.panel.classList.add("manga-catalog-search");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "输入话数或章节标题";
  input.setAttribute("aria-label", "搜索话数或章节标题");
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  const results = document.createElement("div");
  results.className = "manga-catalog-search-results";
  const list = document.createElement("ul");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "manga-catalog-search-more";
  more.textContent = "显示更多章节";
  more.hidden = true;
  results.append(list, more);
  sheet.panel.append(input, status, results);

  const current = () => sheet.overlay.isConnected && isCurrent();
  const normalize = value => String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
  let composing = false;
  let limit = PAGE_SIZE;

  function refresh() {
    if (!current()) { sheet.close(false); return; }
    if (composing) return;
    const query = normalize(input.value);
    const number = /^(?:第\s*)?(\d+)(?:\s*[话話章节集])?$/u.exec(query);
    const chapters = readChapters();
    const matches = query ? chapters.filter(chapter => number ? Number(chapter.index) === Number(number[1])
      : normalize(chapter.title).includes(query)) : [];
    status.textContent = !query ? `可搜索全部 ${formatNumber(chapters.length)} 话`
      : matches.length ? `匹配 ${formatNumber(matches.length)} 话` : "没有匹配的章节";
    const previousFocus = document.activeElement?.dataset?.chapterIndex;
    let focus = null;
    const fragment = document.createDocumentFragment();
    for (const chapter of matches.slice(0, limit)) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = !canOpen(chapter);
      button.dataset.chapterIndex = String(chapter.index);
      const title = document.createElement("strong");
      title.textContent = chapter.title || `第 ${formatNumber(chapter.index)} 话`;
      const description = document.createElement("small");
      description.textContent = `第 ${formatNumber(chapter.index)} 话 · ${button.disabled ? "等待下载" : "可阅读"}`;
      button.append(title, description);
      button.addEventListener("click", () => {
        if (!current() || !button.isConnected || button.disabled) return;
        const latest = readChapters().find(item => item.index === chapter.index);
        if (!latest || latest.id !== chapter.id || latest.title !== chapter.title || !canOpen(latest)) {
          refresh();
          status.textContent = "章节目录已更新，请重新选择";
          input.focus({ preventScroll: true });
          return;
        }
        sheet.close(false);
        openChapter(latest);
      });
      row.append(button);
      fragment.append(row);
      if (previousFocus === button.dataset.chapterIndex && !button.disabled) focus = button;
    }
    list.replaceChildren(fragment);
    more.hidden = matches.length <= limit;
    if (previousFocus !== undefined) (focus || input).focus({ preventScroll: true });
  }

  const applySearch = () => {
    if (!current() || composing) return;
    limit = PAGE_SIZE;
    results.scrollTop = 0;
    refresh();
  };
  input.addEventListener("input", applySearch);
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; applySearch(); });
  more.addEventListener("click", () => {
    if (!current()) return;
    const focused = document.activeElement === more;
    const firstNew = limit;
    limit += PAGE_SIZE;
    refresh();
    if (focused) {
      const next = [...list.children].slice(firstNew).find(row => !row.firstElementChild.disabled)?.firstElementChild;
      (next || (!more.hidden ? more : input)).focus();
    }
  });
  sheet.panel.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const last = more.hidden ? [...list.querySelectorAll("button:not(:disabled)")].at(-1) || input : more;
    if (document.activeElement !== (event.shiftKey ? sheet.closeButton : last)) return;
    event.preventDefault();
    (event.shiftKey ? last : sheet.closeButton).focus();
  });
  refresh();
  input.focus({ preventScroll: true });
  return { close: sheet.close, refresh };
}
