import { formatNumber } from "../../../../js/format.js";
import { imageUrlForWork } from "../../../../js/image.js?v=assets-78764ed05056";
import { getWorkSource } from "../../../../js/work-source.js?v=assets-78764ed05056";
import {
  compactWorkCardTitle,
  compactWorkCode,
  displayCardDate,
  displayPercent,
  displayWorkTitle,
  formatCompactRating,
  progressPercent,
  workCardRating,
  workGridBadge,
  workGridMeta,
  workGridPerson,
  workGridRankBadge
} from "./card-presentation.js?v=assets-78764ed05056";
import { createWorkCoverLoader } from "./cover-loader.js?v=assets-78764ed05056";

const compactRatingCount = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function createWorkCards({ getActiveUrl, roots = [], showView, workDetailDataService = null, favoriteFolders = null, onFavoriteSaved }) {
  const coverLoader = createWorkCoverLoader({ getActiveUrl });
  const cardWorks = new WeakMap();
  const folderButtons = new WeakMap();

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
    decorateFallbackThumb(thumb, work, coverGrid);
    const imagePath = imageUrlForWork(work);
    if (imagePath) coverLoader.schedule(thumb, imagePath);

    const body = document.createElement("div");
    body.className = "work-summary";
    const title = document.createElement("strong");
    title.className = "work-card-title";
    title.textContent = coverGrid ? displayWorkTitle(work, true) : (compactMeta ? compactWorkCardTitle(work) : displayWorkTitle(work, false));
    const folderButton = favoriteFolders && work.id && !work.missingLocal ? createFolderButton(card, work) : null;

    if (coverGrid) {
      body.append(title);
      const identity = document.createElement("div");
      identity.className = "work-card-grid-identity";
      const code = compactWorkCode(work);
      if (code) {
        const codeLine = document.createElement("span");
        codeLine.className = "work-card-code";
        codeLine.textContent = code;
        identity.append(codeLine);
      }
      const personName = hidePerson ? "" : workGridPerson(work);
      if (personName) {
        const personLine = document.createElement(work.personId ? "button" : "span");
        personLine.className = "work-card-grid-person";
        personLine.textContent = personName;
        if (work.personId) {
          personLine.type = "button";
          Object.assign(personLine.dataset, { personId: String(work.personId), workIntentIgnore: "1" });
        }
        identity.append(personLine);
      }
      if (identity.children.length) body.append(identity);
      const gridMeta = workGridMeta(work);
      if (gridMeta) {
        const meta = document.createElement("span");
        meta.className = "work-card-grid-meta";
        meta.textContent = gridMeta;
        body.append(meta);
      }
      if (folderButton) body.append(folderButton);
      card.append(createWorkCoverFrame(thumb, work), body);
      return card;
    }

    const primaryFacts = createPrimaryFacts(work);
    let person = null;
    if (!hidePerson) {
      person = document.createElement(work.personId ? "button" : "span");
      person.className = "work-person";
      person.textContent = workPersonName(work) || "未知演员";
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
    if (folderButton) body.append(folderButton);
    card.append(thumb, body);
    return card;
  }

  function bindCardSurface(root) {
    root.addEventListener("click", (event) => {
      const card = event.target?.closest?.(".work-card");
      if (!card || !root.contains(card)) return;
      const work = cardWorks.get(card);
      if (!work) return;
      const folderButton = folderButtons.get(card);
      if (folderButton?.contains(event.target)) {
        favoriteFolders.openSavePicker(work, { trigger: folderButton, onSaved: saved => {
          const current = cardWorks.get(card);
          if (card.isConnected && String(current?.id) === String(saved.id)) {
            Object.assign(current, { favorite: saved.favorite, favoriteFolderId: saved.favoriteFolderId, favoriteFolderName: saved.favoriteFolderName });
            syncFolderButton(folderButton, current);
            syncFavoriteCoverStatus(card, current);
          }
          onFavoriteSaved?.(saved, card);
        } });
        return;
      }
      const person = event.target?.closest?.(".work-person[data-person-id], .work-card-grid-person[data-person-id]");
      if (person && card.contains(person)) {
        showView("personDetail", { personId: person.dataset.personId, scope: personScopeForWork(work) }, { push: true });
        return;
      }
      openWorkCard(work);
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

  function createFolderButton(card, work) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "work-card-folder-button";
    button.dataset.workIntentIgnore = "1";
    button.setAttribute("aria-haspopup", "dialog");
    syncFolderButton(button, work);
    folderButtons.set(card, button);
    return button;
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
    updateWorkCard(card, work) {
      if (!cardWorks.has(card)) return;
      cardWorks.set(card, work);
      const button = folderButtons.get(card);
      if (button) syncFolderButton(button, work);
    },
    releaseWorkCard(card) {
      cardWorks.delete(card);
      folderButtons.delete(card);
      delete card.dataset.workDetailId;
    },
    createChip,
    displayPersonName,
    progressPercent,
    resetCoverLoading: coverLoader.reset
  };
}

function syncFolderButton(button, work) {
  const text = work.favorite ? "改夹" : "收藏到…";
  const label = `${text} ${compactWorkCode(work) || displayWorkTitle(work)}${work.favoriteFolderName ? `，当前 ${work.favoriteFolderName}` : ""}`;
  if (button.textContent !== text) button.textContent = text;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  button.classList.toggle("active", Boolean(work.favorite));
}

function syncFavoriteCoverStatus(card, work) {
  const frame = card.querySelector(".work-cover-frame");
  if (!frame) return;
  const status = workGridBadge(work);
  if (status.variant === "favorite") {
    const current = frame.querySelector(".work-cover-bottom .work-cover-badge");
    if (current) {
      current.className = "work-cover-badge favorite";
      current.textContent = status.text;
      return;
    }
    const badge = createCoverBadge(status.text, "work-cover-badge favorite");
    const bottom = frame.querySelector(".work-cover-bottom");
    if (bottom) bottom.append(badge);
    else appendCoverBadges(frame, "work-cover-bottom", [badge]);
  } else if (work.favorite && !frame.querySelector(".favorite-marker")) {
    const marker = createCoverBadge("★", "work-cover-indicator marker favorite-marker", "已收藏");
    const top = frame.querySelector(".work-cover-top");
    if (top) top.append(marker);
    else appendCoverBadges(frame, "work-cover-top", [marker]);
  }
}

function personScopeForWork(work) {
  return String(getWorkSource(work)?.variant || "").includes("western") ? "western" : "main";
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

  const topBadges = [];
  const rank = workGridRankBadge(work);
  const status = workGridBadge(work);
  if (rank.text) {
    const rankNo = Number(work.ranking.rankNo);
    const podium = [1, 2, 3].includes(rankNo) ? ` podium-${rankNo}` : "";
    topBadges.push(createCoverBadge(rank.text, `work-cover-badge rank${podium}`));
  }
  if (!work.missingLocal) {
    const flags = work.traits?.flags || {};
    for (const [enabled, label, description, variant] of [
      [work.favorite && status.variant !== "favorite", "★", "已收藏", "favorite-marker"],
      [work.localMarkers?.includes("A"), "A", "已标记 A", "local-marker"],
      [flags.ltxLocal, "本机LTX", "本机 LTX 处理完成"],
      [flags.ltx && !flags.ltxLocal, "LTX", "LTX 版本标记"],
      [flags.embeddedChinese, "C", "视频文件名或目录名标记为内嵌中字"],
      [flags.uncensored, "U", "无码版本标记"],
      [flags.hasChineseSidecar, "中字", "有外挂中文字幕文件"],
      [flags.hasSidecar && !flags.hasChineseSidecar, "外挂字幕", "有独立字幕文件"]
    ]) {
      if (enabled) topBadges.push(createCoverBadge(label, `work-cover-indicator marker${variant ? ` ${variant}` : ""}`, description));
    }
    if (flags.quality4k) topBadges.push(createCoverBadge("4K", "work-cover-indicator quality"));
  }

  const bottomBadges = [];
  if (work.missingLocal && work.availability?.hasMagnet === true) {
    const label = work.availability.hasSubtitles ? "中字磁链" : "含磁链";
    bottomBadges.push(createCoverBadge(label, "work-cover-indicator magnet", `${label}，资料来源标记`));
  }
  const rating = createCoverRating(work);
  if (rating) bottomBadges.push(rating);
  if (status.text) bottomBadges.push(createCoverBadge(status.text, `work-cover-badge ${status.variant}`));
  appendCoverBadges(frame, "work-cover-top", topBadges);
  appendCoverBadges(frame, "work-cover-bottom", bottomBadges);
  return frame;
}

function appendCoverBadges(frame, className, badges) {
  if (!badges.length) return;
  const group = document.createElement("div");
  group.className = className;
  group.append(...badges);
  frame.append(group);
}

function createCoverBadge(text, className, label = "") {
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = text;
  if (label) {
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", label);
    badge.title = label;
  }
  return badge;
}

function createCoverRating(work) {
  const rating = workCardRating(work);
  if (rating === null) return null;
  const text = Number.isInteger(rating) ? rating.toFixed(1) : String(rating);
  const count = Number(work.infoSummary?.ratingCount || 0);
  const hasCount = Number.isFinite(count) && count > 0;
  const label = hasCount ? `${text}分，${formatNumber(count)}人评价` : `${text}分`;
  const badge = createCoverBadge(`★ ${text}`, "work-cover-indicator rating", label);
  if (hasCount) {
    const countText = document.createElement("span");
    countText.className = "work-cover-rating-count";
    countText.textContent = compactRatingCount.format(count).toLowerCase();
    badge.append(countText);
  }
  return badge;
}

function decorateFallbackThumb(thumb, work, coverGrid) {
  const code = workCode(work);
  const label = code || fallbackText(workPersonName(work) || displayWorkTitle(work, true));
  const meta = thumbMeta(work, coverGrid);
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

function thumbMeta(work, coverGrid) {
  const date = displayCardDate(work.infoSummary?.releaseDate || work.modifiedAt);
  const year = /^(\d{4})/.exec(date || "")?.[1] || "";
  const rating = workCardRating(work);
  const percent = progressPercent(work);
  const parts = [];
  if (year) parts.push(year);
  if (!coverGrid && rating !== null) parts.push(`${formatCompactRating(rating)}分`);
  if (rating === null && percent) parts.push(`已看 ${displayPercent(percent)}%`);
  if (work.missingLocal) parts.push("未下载");
  return parts.slice(0, 2).join(" · ");
}

function workPersonName(work) {
  return work?.personDisplayName || work?.personName || "";
}

function createPrimaryFacts(work) {
  const rating = workCardRating(work);
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
