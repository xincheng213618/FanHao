import { captureWebAccount } from "../../platform/accounts/session-context.js";

const STORAGE_PREFIX = "fanhao.novel.readLater.v1:";
const BOOK_LIMIT = 100;
const PAGE_SIZE = 8;

export function readingLaterBookKey(book) {
  return `read-later:${JSON.stringify([book.sourceRealm, String(book.id)])}`;
}

export function createNovelReadLater({ formatNumber, openBook }) {
  let cached = null;
  let browse = null;

  function scopeFor(sourceRealm) {
    if (typeof sourceRealm !== "string" || !sourceRealm) return null;
    try {
      const account = captureWebAccount();
      return { sourceRealm, account, key: `${STORAGE_PREFIX}${JSON.stringify([account.owner || "guest", sourceRealm])}` };
    } catch { return null; }
  }

  function isCurrent(scope) {
    try {
      const current = captureWebAccount();
      return current.owner === scope.account.owner && current.revision === scope.account.revision;
    } catch { return false; }
  }

  function read(scope) {
    const raw = localStorage.getItem(scope.key);
    if (cached?.key === scope.key && cached.raw === raw) return cached.books;
    const value = raw ? JSON.parse(raw) : { version: 1, books: [] };
    if (value?.version !== 1 || !Array.isArray(value.books)) throw new Error("待读清单无法读取");
    const books = new Map();
    for (const row of value.books) {
      if (!row || typeof row.id !== "string" || !row.id || row.id.length > 200 || books.has(row.id)
        || typeof row.title !== "string" || typeof row.author !== "string") continue;
      books.set(row.id, { id: row.id, title: row.title.slice(0, 200), author: row.author.slice(0, 120) });
      if (books.size >= BOOK_LIMIT) break;
    }
    cached = { key: scope.key, raw, books };
    return books;
  }

  function write(scope, books) {
    const raw = JSON.stringify({ version: 1, books: [...books.values()] });
    localStorage.setItem(scope.key, raw);
    cached = { key: scope.key, raw, books };
  }

  function toggleControl(book, fallbackRealm) {
    const scope = scopeFor(book.sourceRealm || fallbackRealm);
    const id = String(book.id ?? "");
    if (!scope || !id || id.length > 200) return null;
    const control = document.createElement("span");
    control.className = "novel-read-later-control";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-secondary-button novel-read-later-toggle";
    const status = document.createElement("span");
    status.className = "novel-read-later-feedback";
    status.setAttribute("role", "status");
    control.append(button, status);
    const sync = (saved) => {
      button.textContent = saved ? "已加入待读" : "加入待读";
      button.setAttribute("aria-pressed", String(saved));
      button.title = saved ? "从「我的阅读」的待读清单移除" : "加入「我的阅读」的待读清单";
    };
    const reportError = () => { status.textContent = "待读清单无法读取或保存，请检查浏览器存储。"; };
    sync(false);
    try { sync(read(scope).has(id)); } catch { /* Report storage failure if the user tries to change the list. */ }
    button.addEventListener("click", () => {
      if (!button.isConnected || !isCurrent(scope)) return;
      try {
        const next = new Map(read(scope));
        const saved = next.has(id);
        if (saved) next.delete(id);
        else {
          if (next.size >= BOOK_LIMIT) { status.textContent = `待读清单已满，最多保存 ${BOOK_LIMIT} 本。`; return; }
          const entry = { id, title: String(book.title || id).slice(0, 200), author: String(book.author || "").slice(0, 120) };
          write(scope, new Map([[id, entry], ...next]));
        }
        if (saved) write(scope, next);
        sync(!saved);
        status.textContent = "";
      } catch { reportError(); }
    });
    return control;
  }

  function renderShelf(sourceRealm) {
    const scope = scopeFor(sourceRealm);
    if (!scope) return null;
    if (browse?.key !== scope.key) browse = { key: scope.key, query: "", limit: PAGE_SIZE };
    const presentation = browse;
    const section = document.createElement("section");
    section.className = "novel-read-later";
    section.setAttribute("aria-label", "待读清单");
    const heading = document.createElement("h2");
    heading.textContent = "待读清单";
    const count = document.createElement("span");
    count.className = "novel-read-later-count";
    heading.append(count);
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索书名或作者";
    search.setAttribute("aria-label", "搜索待读清单");
    search.value = presentation.query;
    const header = document.createElement("header");
    header.append(heading, search);
    const list = document.createElement("ul");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "novel-secondary-button";
    more.textContent = "显示更多";
    const status = document.createElement("p");
    status.className = "novel-read-later-feedback";
    status.setAttribute("role", "status");
    section.append(header, list, more, status);
    const current = () => section.isConnected && isCurrent(scope);
    const normalize = value => value.normalize("NFKC").trim().toLocaleLowerCase();
    const render = () => {
      list.replaceChildren();
      let books;
      try { books = [...read(scope).values()]; }
      catch {
        more.hidden = true;
        status.textContent = "待读清单无法读取，请检查浏览器存储。";
        return;
      }
      const query = normalize(presentation.query);
      const matches = books.filter(book => !query || normalize(`${book.title} ${book.author}`).includes(query));
      count.textContent = ` ${formatNumber(books.length)} 本`;
      search.hidden = !books.length && !query;
      if (!matches.length) {
        more.hidden = true;
        status.textContent = query ? "没有匹配的待读小说。" : "还没有待读小说。";
        return;
      }
      status.textContent = "";
      for (const [index, item] of matches.slice(0, presentation.limit).entries()) {
        const book = { ...item, sourceRealm };
        const row = document.createElement("li");
        row.dataset.novelBookKey = readingLaterBookKey(book);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "novel-read-later-open";
        open.textContent = book.title;
        open.addEventListener("click", () => { if (open.isConnected && current()) openBook(book); });
        const author = document.createElement("small");
        author.textContent = book.author;
        const copy = document.createElement("div");
        copy.append(open, author);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "novel-read-later-remove";
        remove.textContent = "移除";
        remove.setAttribute("aria-label", `从待读移除 ${book.title}`);
        remove.addEventListener("click", () => {
          if (!remove.isConnected || !current()) return;
          try {
            const focused = document.activeElement === remove;
            const next = new Map(read(scope));
            next.delete(book.id);
            write(scope, next);
            render();
            if (focused) {
              const controls = list.querySelectorAll(".novel-read-later-remove");
              const fallback = search.hidden ? heading : search;
              if (fallback === heading) heading.tabIndex = -1;
              (controls[Math.min(index, controls.length - 1)] || fallback).focus({ preventScroll: true });
            }
          } catch { status.textContent = "移除失败，待读记录仍保留。"; }
        });
        row.append(copy, remove);
        list.append(row);
      }
      more.hidden = matches.length <= presentation.limit;
    };
    search.addEventListener("input", () => {
      if (!current()) return;
      presentation.query = search.value;
      presentation.limit = PAGE_SIZE;
      render();
    });
    more.addEventListener("click", () => {
      if (!current()) return;
      const focused = document.activeElement === more;
      const next = presentation.limit;
      presentation.limit += PAGE_SIZE;
      render();
      if (focused && more.hidden) {
        list.children[next]?.querySelector("button")?.focus({ preventScroll: true });
      }
    });
    render();
    return section;
  }

  return { toggleControl, renderShelf };
}
