import { FOLLOWING_AUTHOR_SORT_OPTIONS, normalizeFollowingAuthorFilter, normalizeFollowingAuthorSort } from "../shared.js?v=20260713-follow-toggle-08";

export function renderFollowingAuthorTools({ listState, onChange }) {
  const data = listState.data || {};
  const wrap = document.createElement("section");
  wrap.className = "short-video-mobile-following-tools";

  const summary = document.createElement("div");
  summary.className = "short-video-mobile-following-summary";
  const total = document.createElement("strong");
  total.textContent = `关注 ${formatCount(data.scopeTotal || data.total || 0)}`;
  const unliked = document.createElement("small");
  unliked.textContent = `未点赞 ${formatCount(data.unlikedTotal || 0)}`;
  summary.append(total, unliked);

  const select = document.createElement("select");
  select.className = "short-video-mobile-following-sort";
  select.setAttribute("aria-label", "我的关注排序");
  for (const [value, label] of FOLLOWING_AUTHOR_SORT_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = normalizeFollowingAuthorSort(listState.authorSort);
  select.addEventListener("change", () => {
    onChange({
      source: "following",
      author: "all",
      authorSort: normalizeFollowingAuthorSort(select.value)
    });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });

  const unlikedOnly = normalizeFollowingAuthorFilter(listState.authorFilter) === "unliked";
  const filter = document.createElement("button");
  filter.type = "button";
  filter.className = "short-video-mobile-following-filter";
  filter.classList.toggle("active", unlikedOnly);
  filter.setAttribute("aria-pressed", String(unlikedOnly));
  filter.textContent = `只看未点赞 ${formatCount(data.unlikedTotal || 0)}`;
  filter.addEventListener("click", () => {
    onChange({
      source: "following",
      author: "all",
      authorFilter: unlikedOnly ? "all" : "unliked"
    });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });

  wrap.append(summary, select, filter);
  return wrap;
}

function formatCount(value) {
  return Math.max(0, Number(value || 0)).toLocaleString("zh-CN");
}
