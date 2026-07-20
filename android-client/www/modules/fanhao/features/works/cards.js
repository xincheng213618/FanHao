import { formatNumber } from "../../../../js/format.js";
import { imageUrlForWork } from "../../../../js/image.js?v=20260717-fanhao-cover-prepare-01";
import {
  compactWorkCardTitle,
  compactWorkCode,
  displayCardDate,
  displayPercent,
  displayWorkTitle,
  formatCompactRating,
  numericRating,
  progressPercent,
  workGridBadge,
  workGridMeta,
  workGridRankBadge
} from "./card-presentation.js?v=20260721-fanhao-work-detail-01";
import { createWorkCoverLoader } from "./cover-loader.js?v=20260717-fanhao-work-covers-01";

export function createWorkCards({ getActiveUrl, roots = [], showView, workDetailDataService = null }) {
  const coverLoader = createWorkCoverLoader({ getActiveUrl });
  const cardWorks = new WeakMap();

  for (const root of roots.filter(Boolean)) {
    bindCardSurface(root);
    workDetailDataService?.bindContainer(root);
  }

  function createWorkCard(work, options = {}) {
    const compactMeta = Boolean(options.compactMeta);
    const showRatingMeta = Boolean(options.showRatingMeta);
    const hidePerson = Boolean(options.hidePerson);
    const coverGrid = Boolean(options.coverGrid);
    const card = document.createElement("article");
    card.className = `work-card${coverGrid ? " cover-grid-card" : ""}${work.missingLocal ? " missing-local" : ""}`;
    card.role = "button";
    card.tabIndex = 0;
    cardWorks.set(card, work);
    if (!work.missingLocal) card.dataset.workDetailId = String(work.id);

    const thumb = document.createElement("div");
    thumb.className = "work-thumb";
    decorateFallbackThumb(thumb, work);
    const imagePath = imageUrlForWork(work);
    if (imagePath) coverLoader.schedule(thumb, imagePath);

    const body = document.createElement("div");
    body.className = "work-summary";
    const title = document.createElement("strong");
    title.className = "work-card-title";
    title.textContent = coverGrid ? displayWorkTitle(work, true) : (compactMeta ? compactWorkCardTitle(work) : displayWorkTitle(work, false));

    if (coverGrid) {
      body.append(title);
      const code = compactWorkCode(work);
      if (code) {
        const codeLine = document.createElement("span");
        codeLine.className = "work-card-code";
        codeLine.textContent = code;
        body.append(codeLine);
      }
      const gridMeta = workGridMeta(work);
      if (gridMeta) {
        const meta = document.createElement("span");
        meta.className = "work-card-grid-meta";
        meta.textContent = gridMeta;
        body.append(meta);
      }
      card.append(createWorkCoverFrame(thumb, work), body);
      return card;
    }

    const primaryFacts = createPrimaryFacts(work);
    let person = null;
    if (!hidePerson) {
      person = document.createElement(work.personId ? "button" : "span");
      person.className = "work-person";
      person.textContent = workPersonName(work) || "未知作者";
      if (work.personId) {
        person.type = "button";
        person.dataset.personId = String(work.personId);
        person.dataset.workIntentIgnore = "1";
      }
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

    body.append(title);
    if (person) body.append(person);
    if (primaryFacts) body.append(primaryFacts);
    if (!compactMeta && percent) body.append(createProgressMeter(work.progress, percent));
    if (chips?.children.length) body.append(chips);
    card.append(thumb, body);
    return card;
  }

  function bindCardSurface(root) {
    root.addEventListener("click", (event) => {
      const card = event.target?.closest?.(".work-card");
      if (!card || !root.contains(card)) return;
      const person = event.target?.closest?.(".work-person[data-person-id]");
      if (person && card.contains(person)) {
        showView("personDetail", { personId: person.dataset.personId }, { push: true });
        return;
      }
      const work = cardWorks.get(card);
      if (work) openWorkCard(work);
    });

    root.addEventListener("keydown", (event) => {
      const card = event.target?.closest?.(".work-card");
      if (!card || event.target !== card || !root.contains(card)) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      const work = cardWorks.get(card);
      if (!work) return;
      event.preventDefault();
      openWorkCard(work);
    });
  }

  function openWorkCard(work) {
    if (work.missingLocal) {
      if (work.javdbUrl) window.open(work.javdbUrl, "_blank", "noreferrer");
      return;
    }
    void workDetailDataService?.warm(work.id);
    showView("workDetail", { workId: work.id }, { push: true });
  }

  return {
    createWorkCard,
    createChip,
    displayPersonName,
    progressPercent,
    resetCoverLoading: coverLoader.reset
  };
}

export function createChip(text, variant = "") {
  const chip = document.createElement("span");
  chip.className = `mini-chip${variant ? ` ${variant}` : ""}`;
  chip.textContent = text;
  return chip;
}

export function displayPersonName(person) {
  return person?.actorProfile?.displayName || person?.name || "";
}

function createWorkCoverFrame(thumb, work) {
  const frame = document.createElement("div");
  frame.className = "work-cover-frame";
  frame.append(thumb);
  for (const badgeData of [workGridRankBadge(work), workGridBadge(work)]) {
    if (!badgeData.text) continue;
    const badge = document.createElement("span");
    badge.className = `work-cover-badge ${badgeData.variant}`;
    badge.textContent = badgeData.text;
    frame.append(badge);
  }
  return frame;
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

function workCode(work) {
  for (const candidate of [work?.infoSummary?.code, work?.code, work?.directoryName, work?.title, work?.relativePath]) {
    const code = extractWorkCode(candidate);
    if (code) return code;
  }
  return "";
}

function extractWorkCode(value) {
  const text = String(value || "").trim();
  const match = text && /(?:^|[^A-Z0-9])([A-Z]{1,10})[\s._-]*(\d{2,6}[A-Z]?)(?=$|[^A-Z0-9])/iu.exec(text);
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
