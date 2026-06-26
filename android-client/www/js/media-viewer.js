export function createMediaViewer() {
  let overlay = null;
  let lastFocused = null;

  function bindImageTrigger(element, imageUrl, title = "") {
    if (!element || !imageUrl) return;
    element.classList.add("image-view-trigger");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      openImage(imageUrl, title);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openImage(imageUrl, title);
    });
  }

  function openImage(imageUrl, title = "") {
    if (!imageUrl) return false;
    close();
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    overlay = document.createElement("div");
    overlay.className = "media-viewer";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    const shell = document.createElement("div");
    shell.className = "media-viewer-shell";

    const head = document.createElement("div");
    head.className = "media-viewer-head";
    const caption = document.createElement("strong");
    caption.textContent = title || "封面";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "media-viewer-close";
    closeButton.setAttribute("aria-label", "关闭");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    head.append(caption, closeButton);

    const img = document.createElement("img");
    img.alt = title || "";
    img.src = imageUrl;

    shell.append(head, img);
    overlay.append(shell);
    document.body.append(overlay);
    document.body.classList.add("media-viewer-open");
    closeButton.focus({ preventScroll: true });
    return true;
  }

  function close() {
    if (!overlay) return false;
    overlay.remove();
    overlay = null;
    document.body.classList.remove("media-viewer-open");
    lastFocused?.focus?.({ preventScroll: true });
    lastFocused = null;
    return true;
  }

  function isOpen() {
    return Boolean(overlay);
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close();
  });

  return {
    bindImageTrigger,
    openImage,
    close,
    isOpen
  };
}
