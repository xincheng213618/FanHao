const A_PREFIX = /^(?:\[A\.?\][.\s_-]*)+/i;

export function hasLocalWorkMarkerPrefix(value) {
  return A_PREFIX.test(String(value || "").trim());
}

export function stripLocalWorkMarkerPrefix(value) {
  return String(value || "").trim().replace(A_PREFIX, "").trim();
}

export function splitLocalWorkTitle(value, leadingCode) {
  let title = String(value || "").trim();
  let marked = false;
  while (true) {
    const unmarked = stripLocalWorkMarkerPrefix(title);
    marked ||= unmarked !== title;
    const next = unmarked.replace(leadingCode, "").trim();
    if (next === title) return { title, marked };
    title = next;
  }
}
