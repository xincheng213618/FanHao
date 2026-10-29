export function installWorkSearchShortcut(input) {
  if (!input) return;
  const document = input.ownerDocument;
  const visible = (element) => element.isConnected && element.getClientRects().length > 0
    && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && document.defaultView.getComputedStyle(element).visibility !== "hidden";
  const hint = document.createElement("kbd");
  hint.className = "search-shortcut-hint";
  hint.textContent = "/";
  hint.setAttribute("aria-hidden", "true");
  input.after(hint);
  input.setAttribute("aria-keyshortcuts", "/");
  input.title = "按 / 聚焦全库搜索";

  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.defaultPrevented || event.repeat
      || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return;
    if (input.disabled || input.readOnly || !visible(input)) return;
    if ([...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].some(visible)) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
}
