export function renderShortVideoAuthorProfileHistory(author = {}, options = {}) {
  const formatCompact = options.formatCompact || ((value) => String(value));
  const formatDate = options.formatDate || ((value) => String(value || ""));
  const currentName = String(author.name || "").trim().toLocaleLowerCase("zh-CN");
  const previousNames = uniqueHistory(author.nameHistory, "name")
    .filter((item) => item.value.toLocaleLowerCase("zh-CN") !== currentName);
  const favoritedHistory = uniqueHistory(author.totalFavoritedHistory, "value", { numeric: true });
  if (!previousNames.length && !favoritedHistory.length) return [];

  const section = document.createElement("div");
  section.className = "short-video-author-page-history";
  if (previousNames.length) {
    section.append(renderHistoryRow("曾用名", previousNames.slice(0, 6), (item) => item.value, formatDate));
  }
  if (favoritedHistory.length) {
    section.append(renderHistoryRow(
      "获赞记录",
      favoritedHistory.slice(0, 6),
      (item) => formatCompact(item.value),
      formatDate
    ));
  }
  return [section];
}

function uniqueHistory(source, field, options = {}) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(source) ? source : []) {
    const raw = item && typeof item === "object" ? item[field] : item;
    const value = options.numeric ? optionalNumber(raw) : String(raw || "").trim();
    if (value === null || value === "") continue;
    const key = `${typeof value}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      value,
      firstSeenAt: String(item?.firstSeenAt || ""),
      lastSeenAt: String(item?.lastSeenAt || item?.firstSeenAt || "")
    });
  }
  return result.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}

function renderHistoryRow(labelText, entries, valueText, formatDate) {
  const row = document.createElement("div");
  const label = document.createElement("span");
  label.className = "short-video-author-page-history-label";
  label.textContent = labelText;
  const values = document.createElement("div");
  for (const item of entries) {
    const chip = document.createElement("span");
    chip.className = "short-video-author-page-history-chip";
    chip.textContent = valueText(item);
    const date = formatDate(item.lastSeenAt);
    if (date) chip.title = `最近记录 ${date}`;
    values.append(chip);
  }
  row.append(label, values);
  return row;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}
