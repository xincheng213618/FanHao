const PAGE_SIZE = 20;
const QUERY_LIMIT = 120;

export function createBookTextSearch({ formatNumber }) {
  let active = null;
  let saved = null;

  function close({ restoreFocus = false } = {}) {
    if (!active) return false;
    const view = active;
    active = null;
    view.request?.abort();
    view.dialog.close();
    view.dialog.remove();
    if (restoreFocus && view.trigger.isConnected) view.trigger.focus({ preventScroll: true });
    view.onClose?.();
    return true;
  }

  function owns(view) {
    return active === view && view.dialog.isConnected && view.isCurrent();
  }

  function open(options) {
    if (!options.trigger.isConnected || !options.isCurrent()) return;
    close();
    if (saved?.key !== options.key) saved = { key: options.key, query: "", items: [], nextAfter: null, complete: false };
    const dialog = document.createElement("dialog");
    dialog.className = `novel-book-text-search${options.night ? " night" : ""}`;
    dialog.setAttribute("aria-label", "搜索全书正文");
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "搜索全书正文";
    const dismiss = button("关闭全书搜索", "关闭");
    header.append(title, dismiss);
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "search";
    input.maxLength = QUERY_LIMIT;
    input.enterKeyHint = "search";
    input.autocomplete = "off";
    input.placeholder = "输入正文关键词";
    input.setAttribute("aria-label", "全书正文关键词");
    const initial = options.initialQuery.trim().slice(0, QUERY_LIMIT);
    input.value = initial || saved.query;
    const submit = button("搜索正文", "搜索");
    submit.type = "submit";
    form.append(input, submit);
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const list = document.createElement("ul");
    const more = button("加载更多匹配章节");
    const retry = button("重试");
    dialog.append(header, form, status, list, more, retry);
    const view = { ...options, dialog, input, status, list, more, retry, session: saved, count: 0 };
    active = view;
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!composing) void load(view, input.value.trim());
    });
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Escape" || composing || event.isComposing || event.keyCode === 229 || !owns(view)) return;
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    });
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      if (!composing && owns(view)) close({ restoreFocus: true });
    });
    dismiss.addEventListener("click", () => { if (owns(view)) close({ restoreFocus: true }); });
    more.addEventListener("click", () => {
      if (!view.request && view.session.nextAfter !== null) void load(view, view.session.query, view.session.nextAfter);
    });
    retry.addEventListener("click", () => { if (!view.request) view.retryAction?.(); });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    render(view);
    if ((initial && initial !== saved.query) || (saved.query && !saved.complete)) void load(view, input.value);
  }

  function render(view) {
    const { session, status, more, retry, list } = view;
    status.textContent = view.busy || view.error || (session.complete
      ? session.items.length ? `“${session.query}” · 已显示 ${formatNumber(session.items.length)} 个匹配章节` : "全书没有匹配正文。"
      : "每章显示第一处匹配。");
    view.dialog.setAttribute("aria-busy", String(Boolean(view.request)));
    more.hidden = session.nextAfter === null || Boolean(view.error);
    retry.hidden = !view.retryAction;
    more.disabled = retry.disabled = Boolean(view.request);
    for (const result of session.items.slice(view.count)) {
      const row = document.createElement("li");
      const select = button("");
      select.className = "novel-book-text-result";
      const title = document.createElement("strong");
      title.textContent = `${formatNumber(result.index)} · ${result.title || "正文"}`;
      const snippet = document.createElement("span");
      const mark = document.createElement("mark");
      mark.textContent = result.match;
      snippet.append(result.before, mark, result.after);
      select.append(title, snippet);
      select.addEventListener("click", () => {
        if (select.isConnected) void selectMatch(view, result);
      });
      row.append(select);
      list.append(row);
    }
    view.count = session.items.length;
  }

  function clearResults(view) {
    Object.assign(view.session, { items: [], nextAfter: null, complete: false });
    view.list.replaceChildren();
    view.count = 0;
  }

  function start(view, message) {
    view.request?.abort();
    const request = new AbortController();
    Object.assign(view, { request, busy: message, error: "", retryAction: null });
    render(view);
    return request;
  }

  function fail(view, error, retryAction, searching = false) {
    if (searching && [404, 405, 501].includes(error?.status)) {
      clearResults(view);
      view.error = "电脑端未提供全书搜索，或这本书已移除。";
    } else if (error?.status === 409) {
      clearResults(view);
      view.error = "目录版本已变化，请重新打开书籍。";
    } else {
      view.error = error?.message || (searching ? "全书正文搜索失败" : "匹配章节读取失败");
      view.retryAction = retryAction;
    }
  }

  async function load(view, query, after = 0) {
    if (!owns(view) || !query || query.length > QUERY_LIMIT) return;
    if (!after) {
      clearResults(view);
      view.session.query = query;
    }
    const firstNew = view.session.items.length;
    const refocus = view.dialog.ownerDocument.activeElement === view.more;
    const request = start(view, "正在搜索全书正文…");
    try {
      const { id, sourceRealm, catalogRevision } = view.book;
      const params = new URLSearchParams({ q: query, after: String(after), sourceRealm, catalogRevision });
      const data = await view.read(`/api/novels/${encodeURIComponent(id)}/search-text?${params}`, request.signal);
      if (!owns(view) || view.request !== request) return;
      if (!validPage(data, view.book, query, after)) throw new Error("搜索结果与当前书籍不一致，请重试");
      view.session.items.push(...data.matches);
      view.session.nextAfter = data.nextAfter;
      view.session.complete = true;
    } catch (error) {
      if (owns(view) && view.request === request) fail(view, error, () => void load(view, query, after), true);
    } finally {
      if (owns(view) && view.request === request) {
        view.request = null;
        view.busy = "";
        render(view);
        if (refocus && [document.body, view.dialog, view.more].includes(document.activeElement)) {
          (view.list.children[firstNew]?.querySelector("button") || (view.retry.hidden ? view.input : view.retry)).focus({ preventScroll: true });
        }
      }
    }
  }

  async function selectMatch(view, result) {
    if (!owns(view) || view.request) return;
    const query = view.session.query;
    const request = start(view, "正在打开匹配章节…");
    try {
      const data = await view.readChapter(result, request.signal);
      if (!owns(view) || view.request !== request) return;
      close();
      view.openMatch(result, query, data);
    } catch (error) {
      if (!owns(view) || view.request !== request) return;
      view.request = null;
      view.busy = "";
      fail(view, error, () => void selectMatch(view, result));
      render(view);
    }
  }

  return { open, close, reset() { close(); saved = null; } };
}

function button(label, text = label) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  if (label && label !== text) node.setAttribute("aria-label", label);
  return node;
}

function validPage(data, book, query, after) {
  if (data?.bookId !== book.id || data.sourceRealm !== book.sourceRealm || data.catalogRevision !== book.catalogRevision
      || data.query !== query || !Array.isArray(data.matches) || data.matches.length > PAGE_SIZE) return false;
  let index = after;
  for (const item of data.matches) {
    if (typeof item?.id !== "string" || !item.id || !Number.isSafeInteger(item.index) || item.index <= index
      || [item.title, item.before, item.match, item.after].some(value => typeof value !== "string")) return false;
    index = item.index;
  }
  return data.nextAfter === null || (index > after && data.nextAfter === index);
}
