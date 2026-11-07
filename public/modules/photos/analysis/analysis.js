const PAGE = 200;
const number = new Intl.NumberFormat("zh-CN");
const els = {
  summary: document.querySelector("#analysis-summary"),
  filters: document.querySelector("#analysis-filters"),
  count: document.querySelector("#analysis-count"),
  rows: document.querySelector("#analysis-rows"),
  more: document.querySelector("#analysis-more")
};
let data = null;
let limit = PAGE;
const details = new Map();

function bytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value || 0), unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function issueRange(prefix, from, to) {
  return from === to || to == null ? `${prefix}${from}` : `${prefix}${from}–${to}`;
}

function coverage(item) {
  return item.count ? item.numbered / item.count : 0;
}

function visibleCollections() {
  const form = new FormData(els.filters);
  const query = String(form.get("q") || "").trim().toLowerCase();
  const show = form.get("show");
  const sort = form.get("sort");
  let list = data.collections.filter((item) => {
    if (query && !`${item.title} ${item.category}`.toLowerCase().includes(query)) return false;
    if (show === "missing") return item.missing > 0;
    if (show === "duplicates") return item.duplicateGroups > 0;
    if (show === "unnumbered") return item.numbered === 0;
    return true;
  });
  const by = {
    missing: (a, b) => b.missing - a.missing,
    duplicates: (a, b) => b.duplicateBytes - a.duplicateBytes,
    size: (a, b) => b.size - a.size,
    coverage: (a, b) => coverage(a) - coverage(b) || b.count - a.count
  }[sort];
  if (by) list = [...list].sort((a, b) => by(a, b) || b.count - a.count);
  return list;
}

function renderSummary() {
  const t = data.totals;
  const parts = [
    `${number.format(t.collections)} 个合集`,
    `${number.format(t.albums)} 期`,
    bytes(t.size),
    `期号可核对 ${t.albums ? Math.round((t.numbered / t.albums) * 100) : 0}%`,
    `缺期 ${number.format(t.missing)}`,
    `疑似重复 ${number.format(t.duplicateGroups)} 组`
  ];
  els.summary.textContent = parts.join(" · ");
}

function renderRows() {
  const list = visibleCollections();
  els.count.textContent = `${number.format(list.length)} 个`;
  els.rows.replaceChildren(...list.slice(0, limit).map(renderRow));
  els.more.hidden = list.length <= limit;
  els.more.textContent = `显示更多 · ${number.format(Math.min(limit, list.length))} / ${number.format(list.length)}`;
}

function renderRow(item) {
  const wrapper = element("div", "analysis-entry");
  const row = element("button", "analysis-row");
  row.type = "button";
  row.setAttribute("aria-expanded", "false");
  const name = element("span", "analysis-name");
  name.append(element("strong", "", item.title), element("small", "", item.category === item.title ? "" : item.category));
  const ratio = coverage(item);
  const bar = element("span", "analysis-coverage");
  const meter = element("span", "analysis-meter");
  const fill = element("i");
  fill.style.width = `${Math.round(ratio * 100)}%`;
  meter.append(fill);
  bar.append(meter, element("span", "", `${Math.round(ratio * 100)}%`));
  row.append(
    name,
    element("span", "analysis-num", number.format(item.count)),
    element("span", "analysis-num", bytes(item.size)),
    element("span", "analysis-range", item.prefix ? issueRange(item.prefix, item.min, item.max) : "—"),
    bar,
    element("span", `analysis-num${item.missing ? " is-warn" : " is-muted"}`, item.missing ? number.format(item.missing) : "—"),
    element("span", `analysis-num${item.duplicateGroups ? " is-warn" : " is-muted"}`,
      item.duplicateGroups ? `${number.format(item.duplicateGroups)} 组 · ${bytes(item.duplicateBytes)}` : "—")
  );
  row.addEventListener("click", () => toggleDetail(wrapper, row, item));
  wrapper.append(row);
  return wrapper;
}

async function toggleDetail(wrapper, row, item) {
  const open = row.getAttribute("aria-expanded") === "true";
  wrapper.querySelector(".analysis-detail")?.remove();
  row.setAttribute("aria-expanded", String(!open));
  if (open) return;
  const panel = element("div", "analysis-detail");
  const actions = element("div", "analysis-detail-actions");
  const openLink = element("a", "", "打开合集 →");
  openLink.href = `/photo/collection/${encodeURIComponent(item.id)}`;
  actions.append(openLink);
  panel.append(actions, element("p", "analysis-note", "正在读取…"));
  wrapper.append(panel);
  try {
    let request = details.get(item.id);
    if (!request) {
      request = fetch(`/api/image-library/photo-collection-health?${new URLSearchParams({ collection: item.id })}`)
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "读取失败");
          return body;
        });
      details.set(item.id, request);
      request.catch(() => details.delete(item.id));
    }
    const health = await request;
    panel.querySelector(".analysis-note").remove();
    renderDetail(panel, health);
  } catch (error) {
    panel.querySelector(".analysis-note").textContent = error.message;
  }
}

function renderDetail(panel, health) {
  const family = health.numbering?.[0];
  if (family?.missing) {
    const section = element("section");
    section.append(element("h3", "", `缺少的期号 · ${number.format(family.missing)}`));
    const chips = element("ul", "analysis-chips");
    for (const range of family.missingRanges) chips.append(element("li", "", issueRange(family.prefix, range[0], range[1])));
    if (family.truncated) chips.append(element("li", "is-more", "仅显示前 120 段"));
    section.append(chips);
    panel.append(section);
  }
  if (health.duplicates?.length) {
    const section = element("section");
    section.append(element("h3", "", `疑似重复 · ${number.format(health.duplicateGroupCount)} 组`));
    const list = element("ol", "analysis-duplicates");
    for (const group of health.duplicates) {
      const item = element("li");
      const files = element("ul");
      for (const [index, entry] of group.items.entries()) {
        const file = element("li");
        const link = element("a", "", entry.title);
        link.href = entry.routePath || "#";
        file.append(link, element("span", "", [bytes(entry.size), index === 0 ? "最大" : ""].filter(Boolean).join(" · ")));
        files.append(file);
      }
      item.append(element("strong", "", group.label), files);
      list.append(item);
    }
    section.append(list, element("p", "analysis-note", "按期号或同日同标题判断，只做提示。"));
    panel.append(section);
  }
  if (!family?.missing && !health.duplicates?.length) panel.append(element("p", "analysis-note", "没有发现缺期或重复。"));
}

els.filters.addEventListener("input", () => { limit = PAGE; renderRows(); });
els.filters.addEventListener("submit", (event) => event.preventDefault());
els.more.addEventListener("click", () => { limit += PAGE; renderRows(); });

fetch("/api/image-library/photo-analysis")
  .then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "套图分析读取失败");
    return body;
  })
  .then((body) => { data = body; renderSummary(); renderRows(); })
  .catch((error) => { els.summary.textContent = error.message; });
