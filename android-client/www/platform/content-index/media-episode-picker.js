const PAGE_SIZE = 24;
const QUERY_LIMIT = 120;

export function openMediaEpisodePicker({ trigger, signal, seriesKey, currentId, position, isCurrent, read, titleFor, select, onClose }) {
  const document = trigger.ownerDocument;
  const dialog = document.createElement("dialog");
  dialog.className = "media-episode-picker";
  dialog.setAttribute("aria-label", "选集");
  const header = document.createElement("header");
  const heading = document.createElement("strong");
  heading.textContent = "选集";
  const dismiss = button("关闭", "关闭选集");
  header.append(heading, dismiss);

  const search = field("搜剧集标题", "搜索", "search");
  search.input.type = "search";
  search.input.maxLength = QUERY_LIMIT;
  const jump = field("目录序号", "定位", "go");
  jump.input.inputMode = "numeric";
  jump.input.maxLength = 16;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const list = document.createElement("ul");
  const pagination = document.createElement("footer");
  const previous = button("上一页");
  const next = button("下一页");
  const retry = button("重试");
  pagination.append(previous, retry, next);
  dialog.append(header, search.form, jump.form, status, list, pagination);

  let request = null;
  let page = null;
  let retryAction = null;
  let composing = false;
  function button(text, label) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    if (label) node.setAttribute("aria-label", label);
    return node;
  }
  function field(label, action, enterKeyHint) {
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.enterKeyHint = enterKeyHint;
    input.autocomplete = "off";
    const submit = button(action);
    submit.type = "submit";
    form.append(input, submit);
    return { form, input };
  }

  function close(restoreFocus = false) {
    if (!dialog.isConnected) return false;
    request?.abort();
    signal?.removeEventListener("abort", onAbort);
    dialog.close();
    dialog.remove();
    if (restoreFocus && isCurrent()) trigger.focus({ preventScroll: true });
    onClose();
    return true;
  }
  const onAbort = () => close();

  function renderPage(data, query, focusedOrdinal, revealCurrent) {
    const { items, offset, total } = data;
    status.textContent = items.length ? `${offset + 1}–${offset + items.length} / ${total} ${query ? "个结果" : "集"}`
      : query ? "没有找到匹配剧集。" : "目录中没有可播放剧集。";
    previous.hidden = offset === 0;
    next.hidden = offset + items.length >= total;
    list.scrollTop = 0;
    let focused = null;
    let current = null;
    items.forEach((item, index) => {
      const ordinal = query ? null : offset + index + 1;
      const row = document.createElement("li");
      const title = titleFor(item);
      const choice = button(ordinal === null ? title : `${ordinal} · ${title}`);
      choice.className = "media-episode-picker-choice";
      if (item.id === currentId) {
        choice.setAttribute("aria-current", "true");
        current = choice;
      }
      choice.addEventListener("click", () => {
        if (isCurrent() && dialog.isConnected && choice.isConnected && close()) select(item, data, ordinal);
      });
      if (ordinal !== null && ordinal === focusedOrdinal) focused = choice;
      row.append(choice);
      list.append(row);
    });
    focused?.focus({ preventScroll: true });
    const visible = focused || (revealCurrent ? current : null);
    visible?.scrollIntoView({ block: "nearest" });
  }

  async function load(query, offset, { ordinal = null, revision = null, revealCurrent = false } = {}) {
    if (!isCurrent() || !dialog.isConnected) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    page = null;
    retryAction = null;
    list.replaceChildren();
    status.textContent = "正在读取选集…";
    list.setAttribute("aria-busy", "true");
    previous.hidden = next.hidden = retry.hidden = true;
    try {
      const data = await read({ query, offset, limit: PAGE_SIZE, signal: controller.signal });
      if (!isCurrent()) { close(); return; }
      if (request !== controller || controller.signal.aborted) return;
      const ids = data?.items?.map?.(item => String(item?.id || "").trim());
      if (data?.seriesKey !== seriesKey || data.offset !== offset || !Number.isSafeInteger(data.total) || data.total < 0
        || !Array.isArray(ids) || ids.length !== Math.min(PAGE_SIZE, Math.max(0, data.total - offset))
        || ids.includes("") || new Set(ids).size !== ids.length
        || data.items.some(item => item.seriesKey && item.seriesKey !== seriesKey)) throw new Error("选集目录有变化");
      if (revision && (revision.listRevision !== data.listRevision || revision.scannedAt !== data.scannedAt || revision.total !== data.total)) {
        await load(query, 0);
        return;
      }
      if (ordinal && ordinal > data.total) {
        status.textContent = data.total ? `目录共有 ${data.total} 集，请输入范围内的序号。` : "目录中没有可播放剧集。";
        return;
      }
      page = { data, query };
      renderPage(data, query, ordinal, revealCurrent);
    } catch (error) {
      if (!isCurrent() || error?.code === "ACCOUNT_CHANGED") { close(); return; }
      if (request !== controller || controller.signal.aborted) return;
      status.textContent = error?.message === "选集目录有变化" ? error.message : "选集读取失败。";
      retryAction = () => load(query, offset, { ordinal, revealCurrent });
      retry.hidden = false;
    } finally {
      if (request === controller) {
        request = null;
        list.removeAttribute("aria-busy");
      }
    }
  }

  search.input.addEventListener("compositionstart", () => { composing = true; });
  search.input.addEventListener("compositionend", () => { composing = false; });
  search.form.addEventListener("submit", event => {
    event.preventDefault();
    if (!composing) void load(search.input.value.trim().slice(0, QUERY_LIMIT), 0);
  });
  jump.form.addEventListener("submit", event => {
    event.preventDefault();
    const value = jump.input.value.normalize("NFKC").trim();
    const ordinal = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(ordinal) || ordinal < 1) {
      status.textContent = "请输入正整数目录序号。";
      return;
    }
    search.input.value = "";
    void load("", Math.floor((ordinal - 1) / PAGE_SIZE) * PAGE_SIZE, { ordinal });
  });
  previous.addEventListener("click", () => {
    if (page?.data.offset > 0) void load(page.query, page.data.offset - PAGE_SIZE, { revision: page.data });
  });
  next.addEventListener("click", () => {
    if (page && page.data.offset + PAGE_SIZE < page.data.total) void load(page.query, page.data.offset + PAGE_SIZE, { revision: page.data });
  });
  retry.addEventListener("click", () => retryAction?.());
  dismiss.setAttribute("autofocus", "");
  dismiss.addEventListener("click", () => close(true));
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    if (!composing) close(true);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  void load("", position ? Math.floor((position - 1) / PAGE_SIZE) * PAGE_SIZE : 0, { revealCurrent: true });
  return close;
}
