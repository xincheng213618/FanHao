import { captureWebAccount } from "../../platform/accounts/session-context.js";
import { localBookmarkBooks, readStoredBookmarks, writeStoredBookmarks } from "./bookmarks.js?v=20261113-novel-bookmark-shelf-01";

const PAGE_SIZE = 16;
const BOOK_BATCH_SIZE = 50;

export function createNovelBookmarkShelf({ api, formatNumber, openBookmark, isReadingHome }) {
  let presentation = null;
  let controller = null;

  function cancelRead() {
    controller?.abort();
    controller = null;
  }

  function renderShelf(sourceRealm) {
    if (!sourceRealm) return null;
    let account;
    try { account = captureWebAccount(); } catch { return null; }
    const key = JSON.stringify([account.owner, account.revision, sourceRealm]);
    if (presentation?.key !== key) presentation = { key, expanded: false, query: "", page: 0, metadata: null };
    const browse = presentation;
    cancelRead();

    const section = document.createElement("details");
    section.className = "novel-bookmark-shelf";
    section.open = browse.expanded;
    section.innerHTML = `
      <summary>本机书签</summary>
      <input type="search" aria-label="搜索本机书签" placeholder="书名或章节标题" autocomplete="off">
      <p class="novel-bookmark-shelf-status" role="status"></p>
      <button type="button" class="novel-secondary-button" data-retry hidden>重试书目读取</button>
      <ul></ul>
      <nav aria-label="书签分页" hidden><button type="button" data-prev>上一页</button><span></span><button type="button" data-next>下一页</button></nav>`;
    const input = section.querySelector("input"), list = section.querySelector("ul"), status = section.querySelector("[role=status]");
    const retry = section.querySelector("[data-retry]"), pager = section.querySelector("nav"), count = pager.querySelector("span");
    const previous = pager.querySelector("[data-prev]"), next = pager.querySelector("[data-next]");
    input.value = browse.query;
    let records = null, lastOpen = null, composing = false;
    const current = () => {
      if (!section.isConnected || !section.open || !isReadingHome() || presentation !== browse) return false;
      try {
        const latest = captureWebAccount();
        return latest.owner === account.owner && latest.revision === account.revision;
      } catch { return false; }
    };

    function syncRows() {
      if (!records || !browse.metadata) return;
      const query = normalize(browse.query);
      const groups = records.books.map(book => ({ ...book, currentBook: browse.metadata.get(book.id) }));
      groups.sort((a, b) => (a.currentBook?.title || a.id).localeCompare(b.currentBook?.title || b.id));
      const matches = groups.flatMap(book => book.items.filter(mark => !query || normalize(`${book.currentBook?.title || ""} ${mark.title}`).includes(query))
        .map(mark => ({ book, mark })));
      const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      browse.page = Math.max(0, Math.min(browse.page, pages - 1));
      pager.hidden = pages === 1;
      previous.disabled = browse.page === 0;
      next.disabled = browse.page === pages - 1;
      count.textContent = `${browse.page + 1} / ${pages}`;
      list.replaceChildren(...matches.slice(browse.page * PAGE_SIZE, (browse.page + 1) * PAGE_SIZE).map(renderRow));
      status.textContent = [matches.length ? `${formatNumber(matches.length)} 个书签` : query ? "没有匹配的书签。" : "阅读正文时可保存当前位置。",
        records.unreadable ? "部分本机书签无法读取。" : ""].filter(Boolean).join(" ");
    }

    function renderRow({ book, mark }) {
      const row = document.createElement("li"), copy = document.createElement("div");
      const open = document.createElement("button"), title = document.createElement("small"), remove = document.createElement("button");
      const bookTitle = book.currentBook?.title || "书籍不可用";
      const rowKey = `bookmark:${JSON.stringify([sourceRealm, book.id, mark.id])}`;
      row.dataset.novelBookKey = rowKey;
      open.type = remove.type = "button";
      open.className = "novel-bookmark-shelf-open";
      open.textContent = `${mark.title} · ${Math.round(mark.ratio * 10000) / 100}%`;
      open.setAttribute("aria-label", `${bookTitle} · ${open.textContent}`);
      open.disabled = !book.currentBook || book.currentBook.catalogRevision !== mark.catalogRevision;
      title.textContent = bookTitle + (open.disabled && book.currentBook ? " · 目录已更新" : "");
      remove.textContent = "移除";
      remove.className = "novel-bookmark-shelf-remove";
      remove.setAttribute("aria-label", `移除书签 ${bookTitle} · ${mark.title}`);
      copy.append(open, title);
      row.append(copy, remove);

      open.addEventListener("click", async () => {
        if (!current() || !row.isConnected || open.disabled || lastOpen === open) return;
        lastOpen?.removeAttribute("aria-busy");
        lastOpen = open;
        open.setAttribute("aria-busy", "true");
        status.textContent = "正在打开书签…";
        try {
          const error = await openBookmark(book.id, sourceRealm, mark, rowKey);
          if (error && current() && lastOpen === open) status.textContent = error;
        } catch {
          if (current() && lastOpen === open) status.textContent = "书签打开失败，请重试。";
        } finally {
          open.removeAttribute("aria-busy");
          if (lastOpen === open) lastOpen = null;
        }
      });
      remove.addEventListener("click", () => {
        if (!current() || !row.isConnected) return;
        try {
          const index = [...list.children].indexOf(row);
          const focused = document.activeElement === remove;
          writeStoredBookmarks(book.key, readStoredBookmarks(book.key).filter(item => item.id !== mark.id));
          records = localBookmarkBooks(account, sourceRealm);
          syncRows();
          if (focused) (list.children[Math.min(index, list.children.length - 1)]?.querySelector(".novel-bookmark-shelf-remove") || input).focus({ preventScroll: true });
        } catch { status.textContent = "移除失败，请检查浏览器存储。"; }
      });
      return row;
    }

    async function load() {
      if (!current() || controller) return;
      const request = new AbortController();
      controller = request;
      if (document.activeElement === retry) input.focus({ preventScroll: true });
      retry.hidden = true;
      status.textContent = "正在读取书签书目…";
      try {
        records = localBookmarkBooks(account, sourceRealm);
        const candidates = records.books;
        const metadata = new Map();
        for (let offset = 0; offset < candidates.length; offset += BOOK_BATCH_SIZE) {
          const params = new URLSearchParams({ sourceRealm });
          for (const book of candidates.slice(offset, offset + BOOK_BATCH_SIZE)) params.append("id", book.id);
          const result = await api(`/api/novels/bookmarks/books?${params}`, { signal: request.signal });
          if (!current() || request.signal.aborted) return;
          if (result.sourceRealm !== sourceRealm || !Array.isArray(result.books)) throw new Error("书签书目版本已变化，请刷新后重试。");
          for (const book of result.books) metadata.set(book.id, book);
        }
        browse.metadata = metadata;
        browse.checkedRevisions = new Map(candidates.map(book => [book.id, new Set(book.items.map(mark => mark.catalogRevision))]));
        syncRows();
      } catch (error) {
        if (!current() || request.signal.aborted) return;
        status.textContent = error.message || "书签书目读取失败，请重试。";
        retry.hidden = false;
      } finally { if (controller === request) controller = null; }
    }

    function present() {
      if (!current()) return;
      if (!browse.metadata) { void load(); return; }
      try {
        records = localBookmarkBooks(account, sourceRealm);
        if (records.books.some(book => book.items.some(mark => !browse.checkedRevisions.get(book.id)?.has(mark.catalogRevision)))) {
          void load();
          return;
        }
        syncRows();
      } catch { status.textContent = "无法读取本机书签，请检查浏览器存储。"; }
    }

    section.addEventListener("toggle", () => {
      if (!section.isConnected || !isReadingHome() || presentation !== browse) return;
      const opening = section.open && !browse.expanded;
      browse.expanded = section.open;
      if (opening) void load();
      else if (!section.open) cancelRead();
    });
    const search = () => {
      if (!current() || composing) return;
      browse.query = input.value;
      browse.page = 0;
      syncRows();
    };
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; search(); });
    input.addEventListener("input", search);
    retry.addEventListener("click", load);
    for (const [button, direction] of [[previous, -1], [next, 1]]) button.addEventListener("click", () => {
      if (!current() || button.disabled) return;
      browse.page += direction;
      syncRows();
      if (button.disabled) (direction < 0 ? next : previous).focus({ preventScroll: true });
    });
    if (section.open) queueMicrotask(present);
    return section;
  }

  return { renderShelf, cancelRead };
}

function normalize(text) { return text.normalize("NFKC").trim().toLocaleLowerCase(); }
