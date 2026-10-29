import { normalizeShortVideoTopic } from "./state.js?v=20260716-short-video-state-01";

let nextCaptionId = 0;

export function createShortVideoCaptionController({
  panel, container, paragraph, video, appendCaptionText, captionTitleWithTags
}) {
  const videoId = String(video?.id || "");
  // Reused topic buttons close over this stable, controller-owned metadata
  // object, so richer metadata cannot leave their author/title payload stale.
  const metadata = { ...video };
  let disposed = false, pending = null, signature = null, canExpand = false;
  let expanded = container.classList.contains("is-expanded");
  const listeners = [];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "short-video-caption-expand";
  button.hidden = true;
  button.tabIndex = -1;
  if (!paragraph.id) paragraph.id = `short-video-caption-${++nextCaptionId}`;
  button.setAttribute("aria-controls", paragraph.id);
  container.append(button);
  const hasCurrentRole = () => panel.classList.contains("is-current")
    && !panel.classList.contains("is-ghost-panel")
    && (!panel.dataset?.videoId || String(panel.dataset.videoId) === videoId);
  const isCurrent = () => !disposed && panel.isConnected && container.isConnected && paragraph.isConnected && hasCurrentRole();
  const isInteractable = () => isCurrent() && !panel.inert && !container.closest?.("[inert]");
  const isTopic = node => node?.nodeType === 1 && node.classList?.contains("short-video-caption-tag");
  const setAttribute = (element, name, value) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const syncButton = () => {
    const label = expanded ? "收起" : "展开";
    if (button.textContent !== label) button.textContent = label;
    if (button.hidden !== !canExpand) button.hidden = !canExpand;
    button.tabIndex = canExpand ? 0 : -1;
    setAttribute(button, "aria-expanded", String(expanded));
    setAttribute(button, "aria-label", expanded ? "收起文案" : "展开完整文案");
  };
  const cancelPending = () => {
    const previous = pending;
    pending = null;
    if (!previous) return;
    previous.cancelled = true;
    if (previous.handle != null) window.cancelAnimationFrame(previous.handle);
  };
  const measure = () => {
    if (!isCurrent() || !(paragraph.clientWidth > 0)) return;
    const computed = window.getComputedStyle?.(paragraph) || globalThis.getComputedStyle?.(paragraph);
    const fontSize = parseFloat(computed?.fontSize) || 16;
    const lineHeight = parseFloat(computed?.lineHeight) || fontSize * 1.4;
    const lines = Math.max(1, parseFloat(computed?.getPropertyValue?.("--short-video-caption-collapsed-lines")) || 2);
    const overflow = Number(paragraph.scrollHeight || 0) > lineHeight * lines + 1;
    if (canExpand !== overflow) {
      canExpand = overflow;
      container.classList.toggle("can-expand", canExpand);
    }
    if (!canExpand && document.activeElement === button && isInteractable()) {
      paragraph.tabIndex = -1;
      paragraph.focus?.({ preventScroll: true });
    }
    syncButton();
  };
  const schedule = (initial = false) => {
    if (disposed || !hasCurrentRole() || (!initial && !isCurrent())) {
      cancelPending();
      return;
    }
    if (pending) return;
    const owner = { handle: null, cancelled: false };
    pending = owner;
    owner.handle = window.requestAnimationFrame(() => {
      if (pending !== owner || disposed) return;
      pending = null;
      measure();
    });
    if (owner.cancelled && owner.handle != null) window.cancelAnimationFrame(owner.handle);
  };
  function sync() { schedule(); }
  const restoreFocus = (focused, topic) => {
    if (!focused || !isInteractable()) return;
    const active = document.activeElement;
    // Never override an input, modal or other control that gained focus while
    // content was being updated. Native node moves may leave focus on body.
    if (active !== focused && active && active !== document.body) return;
    if (focused.isConnected && paragraph.contains(focused)) {
      if (active !== focused) focused.focus?.({ preventScroll: true });
      return;
    }
    const replacement = topic
      ? [...paragraph.querySelectorAll(".short-video-caption-tag")].find(node => node.textContent === topic)
      : null;
    const target = replacement || (!button.hidden ? button : paragraph);
    if (target === paragraph) paragraph.tabIndex = -1;
    target.focus?.({ preventScroll: true });
  };
  const render = (next, initial = false) => {
    const text = String(captionTitleWithTags(next) || "");
    const tags = [...new Set((Array.isArray(next.tags) ? next.tags : []).map(normalizeShortVideoTopic).filter(Boolean))].sort();
    const nextSignature = JSON.stringify([text, tags]);
    Object.assign(metadata, next);
    if (signature === nextSignature) return false;
    const focused = document.activeElement;
    const ownedFocus = paragraph.contains(focused);
    const topic = ownedFocus && isTopic(focused) ? focused.textContent : null;
    const scroll = paragraph.scrollTop;
    const oldTopics = new Map();
    if (!initial) for (const node of paragraph.querySelectorAll(".short-video-caption-tag")) {
      const candidates = oldTopics.get(node.textContent) || [];
      candidates.push(node); oldTopics.set(node.textContent, candidates);
    }
    const staging = document.createElement("span");
    appendCaptionText(staging, text, metadata, {
      isCurrent: tag => isInteractable() && paragraph.contains(tag)
    });
    const desired = [...staging.childNodes].map(node => isTopic(node)
      ? oldTopics.get(node.textContent)?.shift() || node : node);
    let cursor = paragraph.firstChild;
    for (const node of desired) {
      if (node === cursor) cursor = cursor.nextSibling;
      else if (node.nodeType === 3 && cursor?.nodeType === 3) {
        if (cursor.textContent !== node.textContent) cursor.textContent = node.textContent;
        cursor = cursor.nextSibling;
      } else paragraph.insertBefore(node, cursor);
    }
    while (cursor) {
      const nextNode = cursor.nextSibling;
      cursor.remove(); cursor = nextNode;
    }
    paragraph.scrollTop = scroll;
    signature = nextSignature;
    if (ownedFocus) restoreFocus(focused, topic);
    return true;
  };
  function update(next) {
    if (!isCurrent() || !videoId || String(next?.id || "") !== videoId) return false;
    if (render({ ...metadata, ...next })) sync();
    return true;
  }
  const toggle = event => {
    event.preventDefault(); event.stopPropagation();
    if (!isInteractable() || !canExpand) return;
    expanded = !expanded;
    container.classList.toggle("is-expanded", expanded);
    syncButton();
    sync();
  };
  const paragraphClick = event => {
    if (event.defaultPrevented || event.target?.closest?.("button, a") || expanded) return;
    toggle(event);
  };
  const listen = (target, name, handler) => {
    if (typeof target?.addEventListener !== "function") return;
    target.addEventListener(name, handler);
    listeners.push([target, name, handler]);
  };
  listen(button, "click", toggle);
  listen(paragraph, "click", paragraphClick);
  listen(window, "resize", sync);
  listen(document, "fullscreenchange", sync);
  listen(document.fonts, "loadingdone", sync);
  const Observer = globalThis.ResizeObserver || window.ResizeObserver;
  const observer = typeof Observer === "function" ? new Observer(sync) : null;
  observer?.observe(container); observer?.observe(paragraph);
  document.fonts?.ready?.then?.(() => { if (isCurrent()) sync(); }, () => {});
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelPending(); observer?.disconnect();
    listeners.splice(0).forEach(([target, name, handler]) => target.removeEventListener(name, handler));
    if (panel.shortVideoSyncCaptionOverflow === sync) delete panel.shortVideoSyncCaptionOverflow;
  }
  render(metadata, true);
  syncButton();
  panel.shortVideoSyncCaptionOverflow = sync;
  schedule(true);
  return { update, sync, dispose };
}
