// Keep unchanged rows (and their focus, expanded details and loaded images)
// attached when polling or appending another page.
export function createKeyedListRenderer(container) {
  let entries = new Map();
  let emptyMarkup = null;
  return function render(items, keyOf, markupOf, emptyHtml = "") {
    if (!items.length) {
      if (entries.size || emptyMarkup !== emptyHtml) container.innerHTML = emptyHtml;
      entries.clear();
      emptyMarkup = emptyHtml;
      return;
    }
    if (emptyMarkup !== null) {
      container.replaceChildren();
      emptyMarkup = null;
    }
    const next = new Map();
    let cursor = container.firstElementChild;
    for (const item of items) {
      const key = String(keyOf(item));
      if (next.has(key)) continue;
      const html = markupOf(item);
      let entry = entries.get(key);
      if (!entry || entry.html !== html) {
        const template = document.createElement("template");
        template.innerHTML = html.trim();
        const node = template.content.firstElementChild;
        if (entry) {
          if (cursor === entry.node) cursor = node;
          entry.node.replaceWith(node);
        }
        entry = { node, html };
      }
      if (entry.node !== cursor) container.insertBefore(entry.node, cursor);
      cursor = entry.node.nextElementSibling;
      next.set(key, entry);
    }
    for (const [key, entry] of entries) {
      if (!next.has(key)) entry.node.remove();
    }
    entries = next;
  };
}
