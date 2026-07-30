export function openMobileActionSheet(config = {}) {
  document.querySelector(".mobile-action-sheet-overlay")?.remove();
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
  const title = document.createElement("strong");
  title.textContent = titleText;
  panel.append(title);

  const close = () => overlay.remove();
  for (const option of config.options || []) {
    if (option?.hidden) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `fanhao-sort-option mobile-action-sheet-option${option.variant ? ` ${option.variant}` : ""}`;
    button.classList.toggle("active", option.active === true || option.value === config.value);
    button.textContent = option.label;
    button.disabled = Boolean(option.disabled);
    button.addEventListener("click", () => {
      if (option.closeOnSelect !== false) close();
      option.select?.(option.value, button, close);
    });
    panel.append(button);
  }

  backdrop.addEventListener("click", close);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  overlay.append(backdrop, panel);
  document.body.append(overlay);
  panel.querySelector(".active:not(:disabled), button:not(:disabled)")?.focus();
  return { close, overlay, panel };
}
