export const $ = (id) => document.getElementById(id);

let toastTimer = null;

export function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function safeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text, window.location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return escapeHtml(text);
  } catch {
    return "";
  }
}
