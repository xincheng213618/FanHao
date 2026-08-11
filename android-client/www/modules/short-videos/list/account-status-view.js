import { normalizeAuthorAccountStatus } from "../shared.js?v=20260811-android-author-status-01";

let authorStatusDescriptionSerial = 0;

export function renderAuthorAccountStatusTools({ listState, formatNumber, onChange } = {}) {
  const format = typeof formatNumber === "function" ? formatNumber : (value) => String(value);
  const wrap = document.createElement("section");
  wrap.className = "short-video-mobile-author-account-tools";
  const summary = document.createElement("div");
  summary.className = "short-video-mobile-author-account-summary";
  const heading = document.createElement("strong");
  heading.textContent = "作者账号";
  const detail = document.createElement("small");
  const data = listState?.data || {};
  const loaded = Array.isArray(data.authors) ? data.authors.length : 0;
  const total = Math.max(0, Number(data.total || 0));
  const scopeTotal = Math.max(total, Number(data.scopeTotal || 0));
  const bannedTotal = Math.max(0, Number(data.bannedTotal || 0));
  const bannedOnly = normalizeAuthorAccountStatus(listState?.authorAccountStatus) === "banned";
  detail.textContent = listState?.loading
    ? "正在读取作者"
    : bannedOnly
      ? `已封禁 ${format(total)} / 全部 ${format(scopeTotal)} 位作者`
      : data.hasMore
        ? `已显示 ${format(loaded)} / ${format(total)} 位作者`
        : `${format(total || loaded)} 位作者`;
  summary.append(heading, detail);

  const select = document.createElement("select");
  select.className = "short-video-mobile-author-account-filter";
  select.setAttribute("aria-label", "作者账号状态筛选");
  for (const [value, label] of [["all", "全部账号"], ["banned", `已封禁 (${format(bannedTotal)})`]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = normalizeAuthorAccountStatus(listState?.authorAccountStatus);
  select.addEventListener("change", () => {
    const authorAccountStatus = normalizeAuthorAccountStatus(select.value);
    if (authorAccountStatus !== listState?.authorAccountStatus) onChange?.({ authorAccountStatus });
  });
  wrap.append(summary, select);
  return wrap;
}

export function appendAuthorAccountStatus(button, author = {}, container = button) {
  if (!button || author.accountStatus !== "banned") return;
  const name = String(author.name || "未知作者").trim() || "未知作者";
  const reasonText = String(author.accountStatusReason || "").trim() || "抖音账号已封禁";
  const badge = document.createElement("span");
  badge.className = "short-video-mobile-author-banned";
  badge.textContent = "已封禁";
  const reason = document.createElement("small");
  reason.id = `short-video-mobile-author-status-${++authorStatusDescriptionSerial}`;
  reason.className = "short-video-mobile-author-banned-reason";
  reason.textContent = `封禁原因：${reasonText}`;
  button.setAttribute("aria-label", `查看 ${name} 的作品，账号已封禁`);
  button.setAttribute("aria-describedby", reason.id);
  container?.append(badge, reason);
}
