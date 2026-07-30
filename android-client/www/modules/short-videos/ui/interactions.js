export function createShortVideoInteractions() {
  function bindReliableTap(element, action) {
    let touchStart = null;
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      Promise.resolve(action?.()).finally(() => {
        window.setTimeout(() => {
          opened = false;
        }, 420);
      });
    };
    element.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
    element.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      const touch = event.touches[0];
      touchStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
      if (!touchStart || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0];
      const dx = Math.abs(touch.clientX - touchStart.x);
      const dy = Math.abs(touch.clientY - touchStart.y);
      const elapsed = Date.now() - touchStart.at;
      touchStart = null;
      if (dx > 14 || dy > 14 || elapsed > 850) return;
      event.preventDefault();
      open();
    }, { passive: false });
    element.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });
  }

  function shortVideoToast(message) {
    document.querySelector(".short-video-mobile-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-mobile-toast";
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }

  return { bindReliableTap, shortVideoToast };
}
