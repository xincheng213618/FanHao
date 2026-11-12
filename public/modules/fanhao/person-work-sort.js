const sortOptions = [
  { label: "评分", first: "ratingDesc", second: "ratingAsc", path: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" },
  { label: "发行日期", first: "releaseDesc", second: "releaseAsc", path: "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" },
  { label: "最近更新", first: "updated", path: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  { label: "文件大小", first: "sizeDesc", second: "sizeAsc", path: "M4 13h16l-2-7H6Zm0 0v5h16v-5m-3 2.5h1" },
  { label: "番号", first: "codeAsc", second: "codeDesc", path: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" }
];

function sortIcon(path) {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.75");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  icon.append(shape);
  return icon;
}

export function createPersonWorkSort(select) {
  for (const [value, label] of [
    ["ratingAsc", "评分最低"], ["sizeAsc", "文件最小"], ["durationAsc", "时长最短"],
    ["codeAsc", "番号升序"], ["codeDesc", "番号降序"]
  ]) select.append(new Option(label, value));

  const group = document.createElement("div");
  group.className = "person-work-sort";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "作品排序");
  for (const option of sortOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "person-sort-option";
    const direction = document.createElement("span");
    direction.className = "person-sort-direction";
    direction.setAttribute("aria-hidden", "true");
    button.append(sortIcon(option.path), direction);
    button.addEventListener("click", () => {
      const value = option.second && select.value === option.first ? option.second : option.first;
      if (select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    group.append(button);
  }

  const more = document.createElement("label");
  more.className = "person-sort-more";
  const ellipsis = document.createElement("span");
  ellipsis.textContent = "···";
  ellipsis.setAttribute("aria-hidden", "true");
  select.setAttribute("aria-label", "更多排序");
  more.append(ellipsis, select);
  group.append(more);
  return group;
}

export function syncPersonWorkSort(select) {
  const group = select.closest(".person-work-sort");
  if (!group) return;
  let hasShortcut = false;
  for (const [index, button] of [...group.querySelectorAll(".person-sort-option")].entries()) {
    const { label, first, second } = sortOptions[index];
    const active = select.value === first || select.value === second;
    const order = select.value.endsWith("Asc") ? "升序" : "降序";
    const description = active && second ? `${label}，${order}` : label;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", description);
    button.title = description;
    button.lastElementChild.textContent = active && second ? (order === "升序" ? "↑" : "↓") : "";
    hasShortcut ||= active;
  }
  const more = select.parentElement;
  more.classList.toggle("active", !hasShortcut);
  select.title = hasShortcut ? "更多排序" : `更多排序 · ${select.selectedOptions[0]?.textContent || ""}`;
}
