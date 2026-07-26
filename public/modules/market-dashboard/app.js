const groupsElement = document.querySelector("#groups");
const groupTemplate = document.querySelector("#groupTemplate");
const cardTemplate = document.querySelector("#cardTemplate");
const statusElement = document.querySelector("#connectionStatus");
const lastUpdatedElement = document.querySelector("#lastUpdated");
const sourceLabelElement = document.querySelector("#sourceLabel");
const totalCountElement = document.querySelector("#totalCount");
const usdCnyValueElement = document.querySelector("#usdCnyValue");
const refreshStateElement = document.querySelector("#refreshState");
const refreshButton = document.querySelector("#refreshButton");
const pauseButton = document.querySelector("#pauseButton");
const errorPanel = document.querySelector("#errorPanel");
const sourceCardsElement = document.querySelector("#sourceCards");
const sourceStatusSummaryElement = document.querySelector("#sourceStatusSummary");

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

let refreshTimer = null;
let countdownTimer = null;
let paused = false;
let nextRefreshAt = 0;
let refreshSeconds = 30;

function formatNumber(value, maxDigits = 4) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: value < 1 ? Math.min(4, maxDigits) : 0,
    maximumFractionDigits: maxDigits
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  const formatted = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
  return `${sign}${formatted}%`;
}

function getMoveClass(item) {
  if (!Number.isFinite(item.changePercent) || item.changePercent === 0) return "is-flat";
  return item.changePercent > 0 ? "is-up" : "is-down";
}

function getRangePercent(item) {
  if (!Number.isFinite(item.low) || !Number.isFinite(item.high) || !Number.isFinite(item.value)) return 50;
  const width = item.high - item.low;
  if (width <= 0) return 50;
  return Math.min(100, Math.max(0, ((item.value - item.low) / width) * 100));
}

function renderSecondaryLine(item) {
  if (Number.isFinite(item.secondaryValue)) {
    return `约 ${formatNumber(item.secondaryValue, item.id === "silver" ? 3 : 2)} ${item.secondaryUnit}`;
  }
  if (Number.isFinite(item.inverseValue) && item.inverseLabel) {
    return item.inverseLabel.replace("{value}", formatNumber(item.inverseValue, 6));
  }
  if (Number.isFinite(item.bid) && Number.isFinite(item.ask)) {
    return `买 ${formatNumber(item.bid)} / 卖 ${formatNumber(item.ask)}`;
  }
  return "";
}

function createExternalLink(label, url, className = "") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const link = document.createElement("a");
  link.href = parsed.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  if (className) link.className = className;
  return link;
}

function renderSources(sources = []) {
  sourceCardsElement.replaceChildren();
  if (!sources.length) {
    sourceCardsElement.append(Object.assign(document.createElement("p"), {
      className: "source-loading",
      textContent: "暂无来源状态"
    }));
    sourceStatusSummaryElement.textContent = "暂无数据";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const source of sources) {
    const card = document.createElement("article");
    card.className = `source-card is-${source.status || "unknown"}`;

    const heading = document.createElement("div");
    heading.className = "source-card__heading";
    const titleRow = document.createElement("div");
    titleRow.className = "source-card__title";
    const dot = document.createElement("span");
    dot.className = "source-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const title = createExternalLink(source.title, source.url, "source-title-link")
      || Object.assign(document.createElement("strong"), { textContent: source.title });
    titleRow.append(dot, title);
    const status = document.createElement("span");
    status.className = "source-state";
    status.textContent = source.statusLabel || "状态未知";
    heading.append(titleRow, status);

    const coverage = document.createElement("p");
    coverage.textContent = source.coverage || "";
    const meta = document.createElement("p");
    meta.className = "source-card__meta";
    meta.textContent = `${source.role || "行情源"} · 当前覆盖 ${Number(source.itemCount || 0)} 项`;
    card.append(heading, coverage, meta);
    fragment.append(card);
  }
  sourceCardsElement.append(fragment);
  const healthyCount = sources.filter((source) => source.status === "ok").length;
  sourceStatusSummaryElement.textContent = `${healthyCount}/${sources.length} 个来源正常`;
}

function renderCard(item) {
  const fragment = cardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".quote-card");
  const badge = fragment.querySelector(".move-badge");
  const rangeFill = fragment.querySelector(".range__bar span");
  const rangeLabels = fragment.querySelectorAll(".range__labels span");
  const digits = item.value < 1 ? 6 : 4;

  fragment.querySelector(".quote-symbol").textContent = item.symbol;
  fragment.querySelector("h3").textContent = item.title;
  fragment.querySelector(".quote-subtitle").textContent = item.subtitle;
  fragment.querySelector(".quote-value").textContent = formatNumber(item.value, digits);
  fragment.querySelector(".quote-unit").textContent = item.unit || "";
  fragment.querySelector(".secondary-line").textContent = renderSecondaryLine(item);

  badge.textContent = formatPercent(item.changePercent);
  badge.classList.add(getMoveClass(item));
  rangeFill.style.width = `${getRangePercent(item)}%`;
  rangeLabels[0].textContent = `低 ${formatNumber(item.low, digits)}`;
  rangeLabels[1].textContent = `高 ${formatNumber(item.high, digits)}`;
  card.querySelector('[data-field="open"]').textContent = formatNumber(item.open, digits);
  card.querySelector('[data-field="previousClose"]').textContent = formatNumber(item.previousClose, digits);
  card.querySelector('[data-field="marketTime"]').textContent = item.marketTime || "--";
  const sourceCell = card.querySelector('[data-field="source"]');
  const sourceLink = createExternalLink(item.source || "--", item.sourceUrl, "quote-source-link");
  sourceCell.replaceChildren(sourceLink || document.createTextNode(item.source || "--"));
  return fragment;
}

function renderGroups(groups) {
  groupsElement.replaceChildren();
  for (const group of groups) {
    const fragment = groupTemplate.content.cloneNode(true);
    const section = fragment.querySelector(".market-section");
    const grid = fragment.querySelector(".card-grid");
    section.dataset.group = group.id;
    fragment.querySelector("h2").textContent = group.title;
    fragment.querySelector("p").textContent = group.note;
    for (const item of group.items) grid.append(renderCard(item));
    groupsElement.append(fragment);
  }
}

function updateSummary(payload) {
  const items = payload.groups.flatMap((group) => group.items);
  totalCountElement.textContent = `${items.length} 项`;
  usdCnyValueElement.textContent = Number.isFinite(payload.usdCny) ? numberFormatter.format(payload.usdCny) : "--";
  lastUpdatedElement.textContent = `本地刷新 ${timeFormatter.format(new Date(payload.generatedAt))}`;
  sourceLabelElement.textContent = `数据源 ${payload.source}${payload.cached ? " · 缓存" : ""}`;
}

function showError(message) {
  errorPanel.hidden = false;
  errorPanel.textContent = message;
  statusElement.textContent = "异常";
  statusElement.className = "status-chip is-error";
}

function clearError() {
  errorPanel.hidden = true;
  errorPanel.textContent = "";
  statusElement.textContent = "已连接";
  statusElement.className = "status-chip is-ok";
}

async function loadQuotes() {
  refreshButton.disabled = true;
  try {
    const response = await fetch(`/api/market-dashboard/quotes?t=${Date.now()}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || "行情接口返回异常");
    renderGroups(payload.groups);
    renderSources(payload.sources);
    updateSummary(payload);
    clearError();
    if (payload.issues?.length) showError(payload.issues.join("；"));
    refreshSeconds = payload.refreshSeconds || 30;
    scheduleNextRefresh();
  } catch (error) {
    showError(error.message);
  } finally {
    refreshButton.disabled = false;
  }
}

function updateCountdown() {
  if (paused) {
    refreshStateElement.textContent = "暂停";
    return;
  }
  const remaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  refreshStateElement.textContent = `${remaining}s`;
}

function scheduleNextRefresh() {
  clearTimeout(refreshTimer);
  clearInterval(countdownTimer);
  if (paused) {
    updateCountdown();
    return;
  }
  nextRefreshAt = Date.now() + refreshSeconds * 1000;
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);
  refreshTimer = setTimeout(loadQuotes, refreshSeconds * 1000);
}

refreshButton.addEventListener("click", () => {
  clearTimeout(refreshTimer);
  loadQuotes();
});

pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.querySelector("span").textContent = paused ? "▶" : "Ⅱ";
  pauseButton.title = paused ? "恢复自动刷新" : "暂停自动刷新";
  pauseButton.setAttribute("aria-label", pauseButton.title);
  scheduleNextRefresh();
});

await loadQuotes();
