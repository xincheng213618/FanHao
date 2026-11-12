const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const PAGE_SIZE = 60;
const normalize = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");

function byName(left, right) {
  return collator.compare(left.name, right.name) || collator.compare(String(left.id), String(right.id));
}

export function compareSeriesByLocalCount(left, right) {
  return Number(right.localWorkCount) - Number(left.localWorkCount) || byName(left, right);
}

export function createStudioSeriesPicker({ formatNumber, selectSeries }) {
  const dialog = document.createElement("dialog");
  dialog.className = "studio-series-picker";
  dialog.setAttribute("aria-labelledby", "studioSeriesPickerTitle");
  dialog.innerHTML = `
    <header>
      <div><h2 id="studioSeriesPickerTitle">查找系列</h2><p class="studio-series-picker-studio"></p></div>
      <form method="dialog"><button type="submit" aria-label="关闭系列选择器">关闭</button></form>
    </header>
    <div class="studio-series-picker-controls">
      <label>系列名或番号前缀<input type="search" placeholder="搜索系列名或前缀" autocomplete="off" autofocus></label>
      <label>排序<select aria-label="系列排序"><option value="count">本地作品最多</option><option value="name">系列名称</option></select></label>
    </div>
    <p class="studio-series-picker-status" role="status"></p>
    <ul class="studio-series-picker-list" aria-label="匹配系列"></ul>
    <button class="studio-series-picker-more" type="button" hidden>显示更多系列</button>`;
  const input = dialog.querySelector("input");
  const sort = dialog.querySelector("select");
  const list = dialog.querySelector("ul");
  const status = dialog.querySelector("[role=status]");
  const more = dialog.querySelector(".studio-series-picker-more");
  let owner, series = [], matches = [], shown = 0;

  function choose(item) {
    if (!dialog.open || !owner) return;
    const { studioId, launcher } = owner;
    dialog.close();
    selectSeries(studioId, String(item.id), launcher);
  }

  function appendMatches() {
    const page = matches.slice(shown, shown + PAGE_SIZE);
    for (const { item, prefixes } of page) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      if (String(item.id) === owner.selectedId) button.setAttribute("aria-current", "true");
      const main = document.createElement("span");
      main.className = "studio-series-picker-name";
      main.textContent = item.name || "未命名系列";
      if (prefixes.length) {
        const codes = document.createElement("small");
        codes.textContent = prefixes.slice(0, 3).join(" · ");
        main.append(codes);
      }
      const count = document.createElement("span");
      count.className = "studio-series-picker-count";
      count.textContent = `${formatNumber(item.localWorkCount)} 部`;
      button.append(main, count);
      button.addEventListener("click", () => choose(item));
      row.append(button);
      list.append(row);
    }
    shown += page.length;
    more.hidden = shown >= matches.length;
  }

  function filter() {
    const words = normalize(input.value).split(/\s+/).filter(Boolean);
    const compare = sort.value === "name" ? byName : compareSeriesByLocalCount;
    matches = series.filter(({ searchText }) => words.every((word) => searchText.includes(word)))
      .sort((left, right) => compare(left.item, right.item));
    shown = 0;
    list.replaceChildren();
    list.scrollTop = 0;
    status.textContent = matches.length ? `${formatNumber(matches.length)} / ${formatNumber(series.length)} 个系列` : "没有匹配的系列。";
    appendMatches();
  }

  input.addEventListener("input", (event) => { if (!event.isComposing) filter(); });
  input.addEventListener("compositionend", filter);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || matches.length !== 1) return;
    event.preventDefault();
    choose(matches[0].item);
  });
  sort.addEventListener("change", filter);
  more.addEventListener("click", () => {
    const firstNewIndex = shown;
    appendMatches();
    list.children[firstNewIndex]?.firstElementChild?.focus();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    owner = null;
    series = matches = [];
    list.replaceChildren();
  });
  document.body.append(dialog);
  return {
    open(studio, items, selectedId, launcher) {
      owner = { studioId: String(studio.id), selectedId: String(selectedId), launcher };
      series = items.map((item) => {
        const prefixes = [...new Set([item.primaryPrefix, ...(item.prefixes || []).map(({ prefix }) => prefix)].filter(Boolean))];
        return { item, prefixes, searchText: normalize([item.name, ...prefixes].join(" ")) };
      });
      dialog.querySelector(".studio-series-picker-studio").textContent = studio.name;
      input.value = "";
      filter();
      if (!dialog.open) dialog.showModal();
    },
    close() { if (dialog.open) dialog.close(); }
  };
}
