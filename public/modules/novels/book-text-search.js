import { captureWebAccount } from "../../platform/accounts/session-context.js";

export function createNovelBookTextSearch({ api, formatNumber }) {
  let session = null;
  let active = null;

  function close({ restoreFocus = false } = {}) {
    if (!active) return;
    const view = active;
    active = null;
    view.request?.abort();
    view.dialog.close();
    view.dialog.remove();
    if (restoreFocus && view.trigger.isConnected) view.trigger.focus({ preventScroll: true });
  }

  function owns(view) {
    if (active !== view || !view.dialog.isConnected || !view.isCurrent()) return false;
    try {
      const account = captureWebAccount();
      return view.account.owner === account.owner && view.account.revision === account.revision;
    } catch { return false; }
  }

  function render(view) {
    const { status, list, more, retry } = view;
    const { items, query, nextAfter, complete, error, retryAfter } = session;
    status.textContent = view.request ? "正在搜索全书正文…" : error || (complete
      ? items.length ? `“${query}” · 已显示 ${formatNumber(items.length)} 个匹配章节${nextAfter !== null ? "，还有更多" : ""}` : "全书没有匹配正文。"
      : "输入想查找的正文。每个章节显示第一处匹配。");
    more.hidden = nextAfter === null || Boolean(error);
    more.disabled = Boolean(view.request);
    retry.hidden = !error || retryAfter === null;
    retry.disabled = Boolean(view.request);
    view.dialog.setAttribute("aria-busy", String(Boolean(view.request)));
    if (view.renderedItems !== items) {
      list.replaceChildren();
      view.renderedItems = items;
      view.renderedCount = 0;
    }
    for (const item of items.slice(view.renderedCount)) {
      const row = document.createElement("li");
      const open = button("", "novel-book-text-result");
      const title = document.createElement("strong");
      title.textContent = item.title || `第 ${item.index} 章`;
      const excerpt = document.createElement("span");
      const highlight = document.createElement("mark");
      highlight.textContent = item.match;
      excerpt.append(item.before, highlight, item.after);
      open.append(title, excerpt);
      open.addEventListener("click", () => {
        if (!open.isConnected || !owns(view)) return;
        const focused = document.activeElement === open;
        close();
        view.openMatch(item, query, focused);
      });
      row.append(open);
      list.append(row);
    }
    view.renderedCount = items.length;
  }

  async function load(view, query, after = 0) {
    if (!owns(view) || !query) return;
    if (after && view.request) return;
    view.request?.abort();
    const request = new AbortController();
    view.request = request;
    if (!after) Object.assign(session, { query, items: [], nextAfter: null, complete: false });
    session.error = "";
    session.retryAfter = null;
    const refocus = after && document.activeElement === view.more;
    render(view);
    const firstNew = session.items.length;
    try {
      const { id, sourceRealm, catalogRevision } = view.book;
      const params = new URLSearchParams({ q: query, after: String(after), sourceRealm, catalogRevision });
      const data = await api(`/api/novels/${encodeURIComponent(id)}/search-text?${params}`, { signal: request.signal, cache: "no-store" });
      if (!owns(view) || view.request !== request) return;
      if (!validPage(data, view.book, query, after)) throw new Error("正文搜索结果已变化，请重新搜索");
      session.items.push(...data.matches);
      session.nextAfter = data.nextAfter;
      session.complete = true;
    } catch (error) {
      if (!owns(view) || view.request !== request) return;
      session.error = error.status === 404 ? "服务暂不支持全书正文搜索，或书籍已移除。" : error.message || "全书正文搜索失败";
      session.retryAfter = after;
      if (error.status === 409 || error.status === 404) {
        session.items = [];
        session.nextAfter = null;
        session.retryAfter = null;
      }
    } finally {
      if (owns(view) && view.request === request) {
        view.request = null;
        render(view);
        if (refocus && [document.body, view.more].includes(document.activeElement)) {
          (view.list.children[firstNew]?.querySelector("button") || (view.retry.hidden ? view.input : view.retry)).focus({ preventScroll: true });
        }
      }
    }
  }

  function open({ book, trigger, initialQuery = "", isCurrent, openMatch }) {
    if (!book.sourceRealm || !book.catalogRevision || !trigger.isConnected || !isCurrent()) return;
    let account;
    try { account = captureWebAccount(); } catch { return; }
    close();
    const key = JSON.stringify([account.owner, account.revision, book.sourceRealm, book.id, book.catalogRevision]);
    if (session?.key !== key) session = { key, query: "", items: [], nextAfter: null, complete: false, error: "", retryAfter: null };

    const dialog = document.createElement("dialog");
    dialog.className = "novel-book-text-search";
    dialog.setAttribute("aria-labelledby", "novel-book-text-search-title");
    const heading = document.createElement("h2");
    heading.id = "novel-book-text-search-title";
    heading.textContent = "搜索全书正文";
    const dismiss = button("关闭", "novel-secondary-button");
    const header = document.createElement("header");
    header.append(heading, dismiss);
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "search";
    input.maxLength = 120;
    input.placeholder = "输入正文关键词";
    input.setAttribute("aria-label", "全书正文关键词");
    input.setAttribute("enterkeyhint", "search");
    const initial = initialQuery.trim().slice(0, 120);
    input.value = initial || session.query;
    const submit = button("搜索", "novel-primary-button");
    submit.type = "submit";
    form.append(input, submit);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const list = document.createElement("ul");
    const more = button("加载更多匹配章节", "novel-secondary-button");
    const retry = button("重试", "novel-secondary-button");
    dialog.append(header, form, status, list, more, retry);
    const view = { dialog, input, trigger, book, account, isCurrent, openMatch, status, list, more, retry, request: null };
    active = view;
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    form.addEventListener("submit", event => { event.preventDefault(); if (!composing) void load(view, input.value.trim()); });
    form.addEventListener("keydown", event => {
      if (composing || event.isComposing || event.keyCode === 229) event.stopPropagation();
    });
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || composing || active !== view) return;
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    });
    more.addEventListener("click", () => { if (session.nextAfter !== null) void load(view, session.query, session.nextAfter); });
    retry.addEventListener("click", () => { if (session.retryAfter !== null) void load(view, session.query, session.retryAfter); });
    dismiss.addEventListener("click", () => { if (active === view) close({ restoreFocus: true }); });
    dialog.addEventListener("cancel", event => { event.preventDefault(); if (active === view && !composing) close({ restoreFocus: true }); });
    render(view);
    (trigger.closest(".novel-reader-page") || document.body).append(dialog);
    dialog.showModal();
    input.focus();
    if ((initial && initial !== session.query) || (session.query && !session.complete && !session.error)) void load(view, input.value);
  }

  return { open, close };
}

function button(label, className) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  return node;
}

function validPage(data, book, query, after) {
  if (data?.bookId !== book.id || data.sourceRealm !== book.sourceRealm || data.catalogRevision !== book.catalogRevision
      || data.query !== query || !Array.isArray(data.matches) || data.matches.length > 20) return false;
  let index = after;
  for (const match of data.matches) {
    if (typeof match?.id !== "string" || !match.id || !Number.isSafeInteger(match.index) || match.index <= index
      || [match.title, match.before, match.match, match.after].some(value => typeof value !== "string")) return false;
    index = match.index;
  }
  return data.nextAfter === null || (index > after && data.nextAfter === index);
}
