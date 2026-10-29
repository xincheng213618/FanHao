export function createSearchRecoveryPanel(options) {
  return createReadRecoveryPanel(options);
}

export function createReadRecoveryPanel({ message, isCurrent, retry, clear, getFocusTarget,
  heading = "搜索暂时失败", hintText = "重试将保留当前搜索条件。", retryLabel = "重试搜索",
  className = "search-error-state", retryClass = "search-retry-button" }) {
  const panel = document.createElement("div");
  panel.className = `empty-state read-error-state ${className}`;
  const copy = document.createElement("div");
  copy.className = "empty-state-copy";
  const title = document.createElement("strong");
  title.textContent = heading;
  const detail = document.createElement("span");
  detail.setAttribute("role", "alert");
  detail.textContent = message || "暂时无法读取结果，请重试。";
  const hint = document.createElement("span");
  hint.textContent = hintText;
  copy.append(title, detail, hint);
  const actions = document.createElement("div");
  actions.className = "empty-state-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `folder-button ${retryClass}`;
  button.textContent = retryLabel;
  let busy = false;
  button.addEventListener("click", async () => {
    if (busy || !panel.isConnected || !isCurrent()) return;
    busy = true;
    const hadFocus = document.activeElement === button;
    let newerFocusIntent = false;
    const events = new AbortController();
    const noteIntent = event => {
      if (event.type !== "focusin" || event.target !== document.body) newerFocusIntent = true;
    };
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) {
      document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: events.signal });
    }
    button.disabled = true;
    button.textContent = "正在重试…";
    try {
      await retry();
      if (!hadFocus || newerFocusIntent || !isCurrent()) return;
      const target = getFocusTarget();
      if (target?.isConnected) {
        if (!target.matches("button, input, a, select, textarea")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest" });
      }
    } finally {
      events.abort();
      busy = false;
      if (panel.isConnected && isCurrent()) { button.disabled = false; button.textContent = retryLabel; }
    }
  });
  actions.append(button);
  if (clear) {
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "text-button";
    clearButton.textContent = "清空搜索";
    clearButton.addEventListener("click", () => { if (panel.isConnected && isCurrent()) clear(); });
    actions.append(clearButton);
  }
  panel.append(copy, actions);
  return panel;
}
