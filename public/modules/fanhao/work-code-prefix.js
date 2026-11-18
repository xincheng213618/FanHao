const FC2_PPV_PATTERN = /^(FC2[-_\s]?PPV)[-_\s]?\d+/i;
const FC2_PATTERN = /^(FC2)[-_\s]?\d+/i;

export function matchWorkCodePrefix(value) {
  const code = String(value || "").trim();
  const marker = code.match(/^(?:\[[^\]]+\][.\s_-]*)+/)?.[0] || "";
  const start = marker.length;
  const normalized = code.slice(start).replace(/[‐‑‒–—―]/g, "-");
  const fc2Ppv = normalized.match(FC2_PPV_PATTERN);
  const fc2 = fc2Ppv || normalized.match(FC2_PATTERN);
  if (fc2) return { prefix: fc2Ppv ? "FC2-PPV" : "FC2", start, end: start + fc2[1].length };

  const separated = normalized.match(/^([A-Z0-9]+(?:[-_][A-Z]+)*)[-_\s]+(?=\d)/i)?.[1];
  const text = separated && /[A-Z]/i.test(separated) ? separated : normalized.match(/^([A-Z]+)(?=\d{2,})/i)?.[1];
  return text ? { prefix: text.toUpperCase().replaceAll("_", "-"), start, end: start + text.length } : null;
}
