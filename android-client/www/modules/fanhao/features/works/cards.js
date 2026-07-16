import { formatDate, formatNumber } from "../../../../js/format.js";
import { absoluteUrl, imageUrlForWork, loadPreviewImage } from "../../../../js/image.js?v=20260717-fanhao-cover-prepare-01";

export function createWorkCards({ getActiveUrl, showView }) {
  function createWorkCard(work, options = {}) {
    const compactMeta = Boolean(options.compactMeta);
    const showRatingMeta = Boolean(options.showRatingMeta);
    const card = document.createElement("article");
    card.className = `work-card${work.missingLocal ? " missing-local" : ""}`;
    card.role = "button";
    card.tabIndex = 0;
    card.addEventListener("click", () => openWorkCard(work));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openWorkCard(work);
    });

    const thumb = document.createElement("div");
    thumb.className = "work-thumb";
    decorateFallbackThumb(thumb, work);
    const imagePath = imageUrlForWork(work);
    if (imagePath) {
      const activeUrl = getActiveUrl();
      loadPreviewImage(thumb, absoluteUrl(activeUrl, imagePath), { cacheBaseUrl: activeUrl });
    }

    const body = document.createElement("div");
    body.className = "work-summary";
    const title = document.createElement("strong");
    title.className = "work-card-title";
    title.textContent = displayWorkTitle(work, compactMeta);
    const primaryFacts = createPrimaryFacts(work);
    const person = document.createElement(work.personId ? "button" : "span");
    person.className = "work-person";
    person.textContent = workPersonName(work) || "未知人物";
    if (work.personId) {
      person.type = "button";
      person.addEventListener("click", (event) => {
        event.stopPropagation();
        showView("personDetail", { personId: work.personId }, { push: true });
      });
    }

    const percent = progressPercent(work);
    let chips = null;
    if (!compactMeta || showRatingMeta) {
      chips = document.createElement("div");
      chips.className = "work-chips";
      if (work.ranking?.rankNo) chips.append(createChip(`TOP ${formatNumber(work.ranking.rankNo)}`, "rank"));
      if (work.missingLocal) chips.append(createChip("未下载", "missing"));
      if (!compactMeta && work.favorite) chips.append(createChip("已收藏", "favorite"));
      if (!primaryFacts && work.infoSummary?.rating) {
        const count = work.infoSummary.ratingCount ? ` · ${formatNumber(work.infoSummary.ratingCount)} 人` : "";
        chips.append(createChip(`★ ${work.infoSummary.rating}${count}`, "rating"));
      }
    }

    body.append(title, person);
    if (primaryFacts) body.append(primaryFacts);
    if (!compactMeta && percent) body.append(createProgressMeter(work.progress, percent));
    if (chips?.children.length) body.append(chips);
    card.append(thumb, body);
    return card;
  }

  function openWorkCard(work) {
    if (work.missingLocal) {
      if (work.javdbUrl) window.open(work.javdbUrl, "_blank", "noreferrer");
      return;
    }
    showView("workDetail", { workId: work.id }, { push: true });
  }

  return { createWorkCard, createChip, progressPercent, displayPersonName };
}

export function createChip(text, variant = "") {
  const chip = document.createElement("span");
  chip.className = `mini-chip${variant ? ` ${variant}` : ""}`;
  chip.textContent = text;
  return chip;
}

export function progressPercent(work) {
  const percent = Number(work?.progress?.percent || 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.max(0, Math.min(100, percent));
}

export function displayPersonName(person) {
  return person?.actorProfile?.displayName || person?.name || "";
}

function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function decorateFallbackThumb(thumb, work) {
  const code = workCode(work);
  const label = code || fallbackText(workPersonName(work) || displayWorkTitle(work, true));
  const meta = thumbMeta(work);
  thumb.classList.add("fallback-cover");
  thumb.textContent = "";
  const codeLine = document.createElement("strong");
  codeLine.className = "work-thumb-code";
  codeLine.textContent = label;
  thumb.append(codeLine);
  if (meta) {
    const metaLine = document.createElement("span");
    metaLine.className = "work-thumb-meta";
    metaLine.textContent = meta;
    thumb.append(metaLine);
  }
}

function thumbMeta(work) {
  const date = displayCardDate(work.infoSummary?.releaseDate || work.modifiedAt);
  const year = /^(\d{4})/.exec(date || "")?.[1] || "";
  const rating = numericRating(work.infoSummary?.rating);
  const percent = progressPercent(work);
  const parts = [];
  if (year) parts.push(year);
  if (rating !== null) parts.push(`${formatCompactRating(rating)}分`);
  if (rating === null && percent) parts.push(`已看 ${displayPercent(percent)}%`);
  if (work.missingLocal) parts.push("未下载");
  return parts.slice(0, 2).join(" · ");
}

function formatCompactRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return "";
  return Number.isInteger(rating) ? rating.toFixed(1) : rating.toFixed(2).replace(/0$/u, "");
}

function workPersonName(work) {
  return work?.personDisplayName || work?.personName || "";
}

function createPrimaryFacts(work) {
  const rating = numericRating(work.infoSummary?.rating);
  const date = displayCardDate(work.infoSummary?.releaseDate) || displayCardDate(work.modifiedAt) || (work.missingLocal ? "未下载" : "日期未知");
  const wrap = document.createElement("div");
  wrap.className = "work-card-facts";
  const ratingLine = document.createElement("div");
  ratingLine.className = `work-card-rating-line${rating === null ? " empty" : ""}`;
  const stars = document.createElement("span");
  stars.className = "work-card-stars";
  stars.textContent = ratingStars(rating || 0);
  const text = document.createElement("span");
  text.className = "work-card-rating-text";
  if (rating !== null) {
    const count = Number(work.infoSummary?.ratingCount || 0);
    const ratingText = Number.isInteger(rating) ? rating.toFixed(1) : String(rating);
    text.textContent = count ? `${ratingText}分 · ${formatNumber(count)}人` : `${ratingText}分`;
  } else {
    text.textContent = "暂无评分";
  }
  ratingLine.append(stars, text);
  wrap.append(ratingLine);
  if (date) {
    const dateLine = document.createElement("div");
    dateLine.className = "work-card-date";
    dateLine.textContent = date;
    wrap.append(dateLine);
  }
  return wrap;
}

function ratingStars(value) {
  const rating = Math.max(0, Math.min(5, Number(value || 0)));
  const full = Math.round(rating);
  return `${"★".repeat(full)}${"☆".repeat(5 - full)}`;
}

function displayCardDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : formatDate(raw);
}

function displayWorkTitle(work, compactMeta) {
  const rawTitle = work.title || work.directoryName || "未命名作品";
  if (!compactMeta) return rawTitle;
  let cleaned = String(rawTitle).trim();
  for (let index = 0; index < 4; index += 1) {
    const previous = cleaned;
    cleaned = cleaned
      .replace(/^\[[^\]]+\][\s._-]*/u, "")
      .replace(/^【[^】]+】[\s._-]*/u, "")
      .replace(/^[A-Z]{2,10}[\s._-]*\d{2,6}[A-Z]?[\s._-]*/iu, "")
      .replace(/^[\s._\-:：・]+/u, "")
      .trim();
    if (cleaned === previous) break;
  }
  cleaned = cleaned.replace(/\s*生写真\d+枚セット\s*$/u, "").trim();
  return cleaned || rawTitle;
}

function workCode(work) {
  for (const candidate of [work?.infoSummary?.code, work?.code, work?.directoryName, work?.title, work?.relativePath]) {
    const code = extractWorkCode(candidate);
    if (code) return code;
  }
  return "";
}

function extractWorkCode(value) {
  const text = String(value || "").trim();
  const match = text && /(?:^|[^A-Z0-9])([A-Z]{2,10})[\s._-]*(\d{2,6}[A-Z]?)(?=$|[^A-Z0-9])/iu.exec(text);
  return match ? `${match[1].toUpperCase()}-${match[2].toUpperCase()}` : "";
}

function createProgressMeter(progress, percent) {
  const meter = document.createElement("div");
  meter.className = "work-progress";
  const meta = document.createElement("div");
  meta.className = "work-progress-meta";
  const label = document.createElement("span");
  label.textContent = percent >= 98 ? "接近看完" : `已看 ${displayPercent(percent)}%`;
  const updated = document.createElement("span");
  updated.textContent = formatProgressTime(progress?.updatedAt);
  meta.append(label, updated);
  const track = document.createElement("div");
  track.className = "work-progress-track";
  const bar = document.createElement("span");
  bar.style.width = `${Math.min(100, Math.max(3, percent))}%`;
  track.append(bar);
  meter.append(meta, track);
  return meter;
}

function displayPercent(percent) {
  if (percent <= 0) return 0;
  return Math.max(1, Math.min(100, Math.floor(percent)));
}

function formatProgressTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff >= 0 && diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function fallbackText(value) {
  return String(value || "?").trim().slice(0, 2) || "?";
}
