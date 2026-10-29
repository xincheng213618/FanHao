export function parsePlaybackStart(value) {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(String(value).trim())) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(Math.floor(seconds)) && seconds >= 0 ? seconds : null;
}

export function createPlaybackTimeLink(href, videoId, position) {
  const base = new URL(href);
  const seconds = Number(position);
  if (!/^https?:$/.test(base.protocol) || !videoId || !Number.isFinite(seconds) || seconds < 0) return null;
  const link = new URL(base.pathname, base.origin);
  const keys = base.searchParams.get("diskDrive") && base.searchParams.get("diskPath") ? ["diskDrive", "diskPath"]
    : base.searchParams.get("mediaId") ? ["mediaId"] : ["workId"];
  for (const key of keys) {
    if (base.searchParams.get(key)) link.searchParams.set(key, base.searchParams.get(key));
  }
  if (!link.search) return null;
  link.searchParams.set("videoId", videoId);
  link.searchParams.set("t", String(Math.round(seconds * 1000) / 1000));
  return link.href;
}

export function createPlaybackTimeLinkControl({ button, status, getLink }) {
  let available = false, busy = false, revision = 0, dialog = null;
  const render = () => {
    if (!button) return;
    button.disabled = !available;
    button.setAttribute("aria-disabled", String(!available || busy));
    button.textContent = busy ? "正在复制…" : "复制时间链接";
  };
  const clearStatus = () => { if (status) { status.hidden = true; status.textContent = ""; } };
  function closeDialog() { dialog?.close(); }
  function showFallback(href) {
    closeDialog();
    const current = document.createElement("dialog");
    current.className = "player-utility-dialog player-time-link-dialog";
    current.setAttribute("aria-labelledby", "playerTimeLinkTitle");
    const heading = document.createElement("h2");
    heading.id = "playerTimeLinkTitle";
    heading.textContent = "复制时间链接";
    const note = document.createElement("p");
    note.textContent = "链接已选中，可按 Ctrl+C、⌘C 或长按复制。";
    const label = document.createElement("label");
    label.textContent = "定位链接";
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = href;
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(input);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => current.close());
    current.addEventListener("close", () => { current.remove(); if (dialog === current) dialog = null; });
    current.append(heading, note, label, close);
    document.body.append(current);
    dialog = current;
    current.showModal();
    input.focus();
    input.select();
  }
  button?.addEventListener("click", async () => {
    if (!available || busy) return;
    const link = getLink();
    if (!link?.href) return;
    const owner = revision;
    busy = true;
    clearStatus();
    render();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link.href);
      if (owner === revision && button.isConnected && status) {
        status.textContent = `已复制 ${link.label} 的时间链接`;
        status.hidden = false;
      }
    } catch {
      if (owner === revision && button.isConnected) showFallback(link.href);
    } finally {
      busy = false;
      render();
    }
  });
  render();
  return {
    setAvailable(value) { available = Boolean(value); render(); },
    invalidate() { revision++; available = false; clearStatus(); closeDialog(); render(); }
  };
}
