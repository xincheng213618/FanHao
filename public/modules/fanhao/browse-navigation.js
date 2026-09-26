// Move the existing navigation into a native modal on small screens so routes,
// selected state, and event handlers have one owner on both layouts.
export function createBrowseNavigation() {
  const sidebar = document.querySelector(".fanhao-sidebar");
  const nav = document.querySelector("#fanhaoNavigation");
  const trigger = document.querySelector("#fanhaoNavigationButton");
  const dialog = document.querySelector("#fanhaoNavigationDialog");
  const closeButton = document.querySelector("#closeFanhaoNavigation");
  const narrow = window.matchMedia("(max-width: 900px)");
  if (!sidebar || !nav || !trigger || !dialog) return { close() {}, sync() {} };

  const close = () => { if (dialog.open) dialog.close(); };
  trigger.addEventListener("click", () => {
    dialog.append(nav);
    trigger.setAttribute("aria-expanded", "true");
    dialog.showModal();
    (nav.querySelector('[aria-current="page"]') || closeButton)?.focus();
  });
  closeButton.addEventListener("click", close);
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [closeButton, ...nav.querySelectorAll("a[href]")];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  dialog.addEventListener("close", () => {
    sidebar.append(nav);
    trigger.setAttribute("aria-expanded", "false");
    if (narrow.matches) trigger.focus();
    else nav.querySelector('[aria-current="page"]')?.focus();
  });
  narrow.addEventListener("change", () => { if (!narrow.matches) close(); });

  return {
    close,
    sync() {
      const selected = nav.querySelector('[aria-current="page"]');
      trigger.textContent = `栏目 · ${selected?.textContent || "资料库"}`;
    }
  };
}
