let activeSheet = null;
const lifecycleWindows = new WeakSet();

function installSheetLifecycle(target) {
  if (!target?.addEventListener || lifecycleWindows.has(target)) return;
  lifecycleWindows.add(target);
  const retire = () => {
    if (activeSheet?.window === target) activeSheet.close(false);
  };
  target.addEventListener("fanhaoViewWillRender", retire);
  target.addEventListener("pagehide", retire);
}

export function closeMobileActionSheet(restoreFocus = true) {
  const owner = activeSheet;
  if (owner?.document === document) {
    if (owner.close(restoreFocus)) return true;
    if (activeSheet === owner) activeSheet = null;
  }
  const overlay = document.querySelector(".mobile-action-sheet-overlay");
  if (!overlay) return false;
  overlay.remove();
  return true;
}

export function openMobileActionSheet(config = {}) {
  activeSheet?.close(false);
  activeSheet = null;
  document.querySelector(".mobile-action-sheet-overlay")?.remove();
  const sheetDocument = document;
  const sheetWindow = typeof window === "undefined" ? null : window;
  const trigger = config.trigger || document.activeElement;
  installSheetLifecycle(sheetWindow);
  const titleText = String(config.title || "操作");
  const overlay = document.createElement("div");
  overlay.className = "fanhao-sort-overlay mobile-action-sheet-overlay";
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "fanhao-sort-backdrop mobile-action-sheet-backdrop";
  backdrop.setAttribute("aria-label", `关闭${titleText}`);
  const panel = document.createElement("section");
  panel.className = "fanhao-sort-sheet mobile-action-sheet-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", titleText);
  const header = document.createElement("header");
  header.className = "mobile-action-sheet-head";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "mobile-action-sheet-close";
  closeButton.textContent = "关闭";
  closeButton.setAttribute("aria-label", `关闭${titleText}`);
  header.append(title, closeButton);
  panel.append(header);

  let closed = false;
  const owner = { document: sheetDocument, window: sheetWindow, close: null };
  const ownsSheet = () => !closed && activeSheet === owner
    && sheetDocument.querySelector(".mobile-action-sheet-overlay") === overlay;
  const close = (restoreFocus = true) => {
    if (!ownsSheet()) return false;
    closed = true;
    activeSheet = null;
    overlay.remove();
    if (restoreFocus && sheetDocument === document && trigger && sheetDocument.body.contains(trigger) && !trigger.disabled) {
      trigger.focus?.({ preventScroll: true });
    }
    return true;
  };
  owner.close = close;
  closeButton.addEventListener("click", () => close());
  for (const option of config.options || []) {
    if (option?.hidden) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `fanhao-sort-option mobile-action-sheet-option${option.variant ? ` ${option.variant}` : ""}`;
    button.classList.toggle("active", option.active === true || option.value === config.value);
    button.textContent = option.label;
    button.disabled = Boolean(option.disabled);
    button.addEventListener("click", () => {
      if (!ownsSheet() || button.disabled) return;
      if (option.closeOnSelect !== false) close(false);
      option.select?.(option.value, button, close);
    });
    panel.append(button);
  }

  backdrop.addEventListener("click", close);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && close()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  overlay.append(backdrop, panel);
  activeSheet = owner;
  document.body.append(overlay);
  (panel.querySelector(".mobile-action-sheet-option.active:not(:disabled)")
    || panel.querySelector(".mobile-action-sheet-option:not(:disabled)") || closeButton).focus();
  return { close, overlay, panel, header, closeButton };
}
