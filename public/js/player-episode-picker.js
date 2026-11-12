const PAGE_SIZE = 30;
const READ_TIMEOUT_MS = 12000;
const formatNumber = new Intl.NumberFormat("zh-CN").format;

export function createEpisodePicker({ dialog, trigger, readPage, current, select }) {
  if (!dialog || !trigger) return { close() {} };
  const input = dialog.querySelector("input");
  const form = dialog.querySelector("form");
  const list = dialog.querySelector("[data-episode-items]");
  const status = dialog.querySelector("[data-episode-picker-status]");
  const previous = dialog.querySelector("[data-episode-picker-previous]");
  const next = dialog.querySelector("[data-episode-picker-next]");
  const clear = dialog.querySelector("[data-episode-picker-clear]");
  const retry = dialog.querySelector("[data-episode-picker-retry]");
  let page = null, request = null, failed = null, composing = false;

  function cancelRead() {
    if (!request) return;
    const active = request;
    request = null;
    window.clearTimeout(active.timeout);
    active.controller.abort();
  }

  function reset() {
    cancelRead();
    page = null;
    failed = null;
    composing = false;
    list.replaceChildren();
    dialog.removeAttribute("aria-busy");
  }

  function close(restoreFocus = false) {
    reset();
    if (dialog.open) dialog.close();
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function syncControls() {
    previous.disabled = Boolean(request || failed) || !page?.offset;
    next.disabled = Boolean(request || failed) || !page || page.offset + page.items.length >= page.total;
    retry.hidden = !failed;
    if (request) dialog.setAttribute("aria-busy", "true");
    else dialog.removeAttribute("aria-busy");
  }

  function render(value, notice) {
    const owner = current();
    const fragment = document.createDocumentFragment();
    for (const [index, item] of value.items.entries()) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const position = value.query ? 0 : value.offset + index + 1;
      button.textContent = `${position ? `${formatNumber(position)}. ` : ""}${item.title || "未命名剧集"}`;
      if (item.id === owner?.id) {
        button.setAttribute("aria-current", "true");
        const badge = document.createElement("small");
        badge.textContent = "正在播放";
        button.append(" ", badge);
      }
      button.addEventListener("click", () => {
        if (!dialog.open || request || page !== value || !button.isConnected || current()?.id !== owner?.id) return;
        close(item.id === owner?.id);
        if (item.id !== owner?.id) select(item, position);
      });
      row.append(button);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    list.scrollTop = 0;
    const first = formatNumber(value.offset + 1), last = formatNumber(value.offset + value.items.length);
    if (!value.total) status.textContent = value.query ? "没有匹配的剧集。" : "剧集目录为空。";
    else if (value.query) {
      const range = value.total > PAGE_SIZE ? ` · 第 ${first}–${last} 条` : "";
      status.textContent = `${notice}匹配 ${formatNumber(value.total)} 集${range}`;
    } else status.textContent = `${notice}第 ${first}–${last} / ${formatNumber(value.total)} 集`;
    syncControls();
  }

  async function load(spec) {
    if (!dialog.open || !current()) return;
    cancelRead();
    const active = { controller: new AbortController(), timeout: 0 };
    const previousPage = page;
    const focus = document.activeElement;
    const draft = input.value;
    request = active;
    failed = null;
    list.replaceChildren();
    status.textContent = "正在读取剧集…";
    syncControls();
    const showFailure = message => {
      request = null;
      failed = spec;
      status.textContent = message;
      syncControls();
      if ([previous, next, retry].includes(focus) && [focus, document.body, dialog].includes(document.activeElement)) retry.focus();
    };
    active.timeout = window.setTimeout(() => {
      if (request !== active) return;
      active.controller.abort();
      showFailure("读取剧集超时，请重试。");
    }, READ_TIMEOUT_MS);
    try {
      let offset = spec.offset;
      let result = await readPage(offset, PAGE_SIZE, active.controller.signal, spec.query);
      if (request !== active || !dialog.open) return;
      if (result.items.length !== Math.min(PAGE_SIZE, Math.max(0, result.total - offset))) throw new Error("剧集目录不完整，请重试。");
      if (offset > 0 && offset >= result.total && result.total) {
        offset = pageOffset(result.total);
        result = await readPage(offset, PAGE_SIZE, active.controller.signal, spec.query);
        if (request !== active || !dialog.open) return;
        if (offset >= result.total || result.items.length !== Math.min(PAGE_SIZE, result.total - offset)) throw new Error("剧集目录已变化，请重试。");
      }
      if (new Set(result.items.map(item => item.id)).size !== result.items.length) throw new Error("剧集目录包含重复项，请重试。");
      request = null;
      page = { ...result, offset: result.total ? offset : 0, query: spec.query };
      const changed = previousPage && previousPage.query === spec.query && previousPage.snapshot !== page.snapshot;
      const notice = spec.target > page.total && page.total ? `目录只有 ${formatNumber(page.total)} 集。` : changed ? "目录已更新。" : "";
      render(page, notice);
      if (spec.revealCurrent) {
        const currentButton = list.querySelector('[aria-current="true"]');
        if (currentButton) list.scrollTop = currentButton.getBoundingClientRect().top - list.getBoundingClientRect().top
          - (list.clientHeight - currentButton.offsetHeight) / 2;
      }
      if (spec.target >= page.offset + 1 && spec.target <= page.offset + page.items.length && document.activeElement === input && input.value === draft) {
        const target = list.children[spec.target - page.offset - 1]?.querySelector("button");
        target?.focus();
      } else if ([previous, next, retry].includes(focus) && [focus, document.body, dialog].includes(document.activeElement)) {
        (list.querySelector("button") || input).focus();
      }
    } catch (error) {
      if (request !== active || !dialog.open) return;
      if (error?.code === "ACCOUNT_CHANGED") { close(); return; }
      showFailure(error.message || "剧集目录读取失败，请重试。");
    } finally { window.clearTimeout(active.timeout); }
  }

  function showDirectory() {
    input.value = "";
    clear.hidden = true;
    void load({ offset: pageOffset(current()?.position || 1), query: "", revealCurrent: true });
  }

  trigger.addEventListener("click", () => {
    if (!current() || document.querySelector("dialog[open], .player-move-dialog")) return;
    dialog.showModal();
    input.focus();
    showDirectory();
  });
  dialog.querySelector("[data-episode-picker-close]").addEventListener("click", () => close(true));
  dialog.addEventListener("close", () => { if (!dialog.open) reset(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!composing) close(true); });
  dialog.addEventListener("keydown", event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      close(true);
    }
  });
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (composing) return;
    const query = input.value.trim();
    if (!query) { showDirectory(); return; }
    clear.hidden = false;
    const ordinal = query.normalize("NFKC").match(/^(?:第\s*)?(\d+)(?:\s*[集话話])?$/u);
    if (ordinal) {
      const target = Number(ordinal[1]);
      if (!Number.isSafeInteger(target) || target <= 0) {
        cancelRead();
        page = null;
        failed = null;
        list.replaceChildren();
        status.textContent = "请输入大于 0 的目录序号。";
        syncControls();
        return;
      }
      void load({ offset: pageOffset(target), query: "", target });
    } else void load({ offset: 0, query });
  });
  clear.addEventListener("click", () => { input.focus(); showDirectory(); });
  previous.addEventListener("click", () => { if (page && !request) void load({ offset: Math.max(0, page.offset - PAGE_SIZE), query: page.query }); });
  next.addEventListener("click", () => { if (page && !request) void load({ offset: page.offset + PAGE_SIZE, query: page.query }); });
  retry.addEventListener("click", () => { if (failed && !request) void load(failed); });
  return { close };
}

function pageOffset(position) {
  return Math.floor((position - 1) / PAGE_SIZE) * PAGE_SIZE;
}
