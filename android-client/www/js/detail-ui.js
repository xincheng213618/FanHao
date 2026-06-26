export function createDetailSectionTitle(title, meta) {
  const node = document.createElement("div");
  node.className = "detail-section-title";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = meta;
  node.append(strong, span);
  return node;
}

export function revealDetailBlock(node) {
  window.requestAnimationFrame(() => {
    node.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
