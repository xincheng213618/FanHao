import { createAndroidVideoSection } from "../../js/android-player.js?v=20260721-fanhao-media-relocate-16";
import { cacheAgeText } from "../../js/cache.js?v=20260705-mobile-actions-01";
import { createDetailSectionTitle } from "../../js/detail-ui.js";
import { extractWorkCode, formatBytes, formatNumber } from "../../js/format.js";
import { createInfoPreviewSection } from "../../js/info-preview.js";
import { absoluteUrl, createFallbackCover, imageUrlForPerson, imageUrlForWork, loadPreviewImage } from "../../js/image.js?v=20260717-fanhao-cover-prepare-01";
import { getWorkSource } from "../../js/work-source.js?v=20260710-western-merge-01";
import { personDetailPath } from "./features/people/detail-request.js?v=20260721-fanhao-person-year-15";
import { createPersonDetailHero } from "./features/people/detail-hero.js?v=20260721-fanhao-person-categories-21";
import { createPersonDetailWorkToolbar } from "./features/people/detail-work-toolbar.js?v=20260721-fanhao-person-year-15";
import { createWorkActions } from "./features/works/actions.js?v=20260811-favorite-folders-02";
import { createWorkDetailToolbar } from "./features/works/detail-toolbar.js?v=20260730-fanhao-work-detail-ui-46";
import { createWorkPreviewMedia } from "./features/works/preview-media.js?v=20260712-fanhao-refactor-01";

const PLAY_OPEN_COOLDOWN_MS = 1400;
export function createDetailViews(context) {
  const {
    els,
    getActiveUrl,
    getLibrary,
    openInLibrary,
    showView,
    setActiveBottom,
    renderWorks,
    renderMessage,
    getWorksLimit = () => 80,
    getWorkListRequestState = () => ({ filter: "all", sort: "updated" }),
    getWorkFilterMode = () => "all",
    getWorkFilterOptions = () => [],
    setWorkFilterMode = () => false,
    getWorkSortMode = () => "updated",
    getWorkSortOptions = () => [],
    setWorkSortMode = () => false,
    increaseWorksLimit = () => {},
    renderCurrentView = () => {},
    renderCurrentViewPreservingScroll = () => {},
    mediaViewer,
    favoriteFolders,
    onUserStateChange,
    pageDataService,
    workDetailDataService
  } = context;
  const videoSection = createAndroidVideoSection({ getActiveUrl, openInLibrary });
  const infoSection = createInfoPreviewSection({ getActiveUrl });
  const workActions = createWorkActions({
    detailErrorMessage,
    extractWorkCode,
    favoriteFolders,
    formatNumber,
    getActiveUrl,
    onUserStateChange,
    renderMessage,
    renderWorkDetail
  });
  const previewMedia = createWorkPreviewMedia({
    detailErrorMessage,
    getActiveUrl,
    mediaViewer,
    renderMessage,
    renderWorkDetail
  });
  let personYearSelection = { personId: "", value: "all" };
  const renderPersonHero = (person, options = {}) => createPersonDetailHero(person, {
    ...options,
    activeUrl: getActiveUrl(),
    mediaViewer
  });
  const setDetailChromeTitle = (value) => {
    const title = els.moduleChrome?.querySelector("[data-fanhao-detail-title]");
    if (title) title.textContent = String(value || "").trim() || "详情";
  };
  async function renderPersonDetail(personId, isActive = () => true) {
    const activeUrl = getActiveUrl();
    setActiveBottom("people");
    els.viewKicker.textContent = "演员";
    els.viewTitle.textContent = "正在加载";
    els.viewMeta.textContent = "";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载演员资料</div>`;
    const selectedYear = getPersonWorkYear(personId);
    const path = personDetailPath(personId, { ...getWorkListRequestState(), year: selectedYear, limit: getWorksLimit() });
    let renderedCache = false;
    const indexedPerson = findPersonInLibrary(personId);
    if (indexedPerson) renderPersonPreview(indexedPerson);
    const renderPersonData = (data) => {
      const person = mergeIndexedPerson(indexedPerson, data.person, data.works);
      const works = data.works || [];
      setDetailChromeTitle(person.actorProfile?.displayName || person.name || "演员详情");
      els.viewTitle.textContent = "演员详情";
      els.viewMeta.textContent = "";
      els.viewContent.innerHTML = "";
      els.viewContent.append(renderPersonHero(person, {
        categories: data.categories,
        filmographyCount: data.filmographyCount
      }));
      els.viewContent.append(createDetailSectionTitle("作品", ""));
      renderWorks(works, "这个演员下面还没有作品。", {
        facets: data.facets,
        total: data.total || works.length,
        activeFilterTotal: data.total || works.length,
        coverGrid: true,
        hidePerson: true,
        hideControls: true,
        hasServerMore: works.length < Number(data.total || works.length),
        onLoadMore: () => {
          increaseWorksLimit(48);
          return renderCurrentViewPreservingScroll();
        }
      });
      els.viewContent.append(createPersonDetailWorkToolbar({
        filterMode: getWorkFilterMode(),
        filterOptions: getWorkFilterOptions(works, data.facets),
        yearMode: data.year || selectedYear,
        yearOptions: data.years,
        sortMode: getWorkSortMode(),
        sortOptions: getWorkSortOptions(),
        onFilterChange: (value) => setWorkFilterMode(value, { replace: true }),
        onYearChange: (value) => setPersonWorkYear(personId, value),
        onSortChange: setWorkSortMode
      }));
    };
    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        onCached(data) {
          if (!data?.person) return;
          renderedCache = true;
          renderPersonData(data);
        }
      });
      if (!result || !isActive()) return;
      if (!result.unchanged) renderPersonData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
      } else if (renderPersonFallback(personId, error)) {
        return;
      } else {
        els.viewTitle.textContent = "演员";
        renderMessage(detailErrorMessage(error, "演员资料读取失败，请检查服务连接"), "error");
      }
    }
  }

  function getPersonWorkYear(personId) {
    const normalizedId = String(personId || "");
    if (personYearSelection.personId !== normalizedId) personYearSelection = { personId: normalizedId, value: "all" };
    return personYearSelection.value;
  }

  function setPersonWorkYear(personId, value) {
    const normalizedId = String(personId || "");
    const requested = String(value || "").trim().toLowerCase();
    const next = requested === "unknown" || /^(?:19|20)\d{2}$/.test(requested) ? requested : "all";
    if (getPersonWorkYear(normalizedId) === next) return false;
    personYearSelection = { personId: normalizedId, value: next };
    renderCurrentView();
    return true;
  }
  function renderPersonPreview(person) {
    setDetailChromeTitle(person.actorProfile?.displayName || person.name || "演员详情");
    els.viewTitle.textContent = "演员详情";
    els.viewMeta.textContent = "";
    els.viewContent.innerHTML = "";
    els.viewContent.append(renderPersonHero(person));
    els.viewContent.append(createDetailSectionTitle("作品", ""));
    const loading = document.createElement("div");
    loading.className = "loading-row";
    loading.textContent = "正在加载作品";
    els.viewContent.append(loading);
  }

  function mergeIndexedPerson(indexedPerson, detailPerson, works = []) {
    const fallbackAvatarUrl = detailPerson?.avatarUrl
      || indexedPerson?.avatarUrl
      || works.map((work) => imageUrlForWork(work)).find(Boolean)
      || "";
    if (!indexedPerson) return { ...detailPerson, avatarUrl: fallbackAvatarUrl };
    return {
      ...indexedPerson,
      ...detailPerson,
      actorProfile: detailPerson?.actorProfile || indexedPerson.actorProfile || null,
      avatarUrl: fallbackAvatarUrl
    };
  }

  function renderPersonFallback(personId, error) {
    const person = findPersonInLibrary(personId);
    if (!person) return false;

    setDetailChromeTitle(person.actorProfile?.displayName || person.name || "演员详情");
    els.viewTitle.textContent = "演员详情";
    els.viewMeta.textContent = "";
    els.viewContent.innerHTML = "";
    els.viewContent.append(renderPersonHero(person));
    els.viewContent.append(createDetailSectionTitle("作品", ""));
    renderMessage(`作品列表暂时无法加载：${detailErrorMessage(error, "请检查服务连接")}`, "quiet", false);
    return true;
  }

  function findPersonInLibrary(personId) {
    const people = getLibrary()?.people || [];
    return people.find((person) => person.id === personId) || null;
  }

  async function renderWorkDetail(workId, isActive = () => true) {
    setActiveBottom("works");
    els.viewKicker.textContent = "作品详情";
    els.viewTitle.textContent = "正在加载";
    els.viewMeta.textContent = "";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载作品详情</div>`;
    let renderedCache = false;
    const applyWorkHeader = (data, cacheEntry = null) => {
      const work = data.work;
      const code = extractWorkCode(work);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      const heading = code || work.title || work.directoryName || "作品";
      setDetailChromeTitle(heading);
      els.viewTitle.textContent = heading;
      const personName = workPersonName(work);
      els.viewMeta.textContent = personName ? `${personName}${suffix}` : suffix.trim();
    };
    const renderWorkData = (data, cacheEntry = null) => {
      const work = data.work;
      const person = data.person || null;
      applyWorkHeader(data, cacheEntry);
      els.viewContent.innerHTML = "";
      const playbackSection = videoSection.createVideoList(work, { showFiles: false, showTitle: false });
      const playDefaultVideo = () => videoSection.playDefaultVideo(playbackSection, work);
      const hero = createWorkDetailHero(work, playDefaultVideo);
      const factPanel = createWorkFactPanel(work);
      const previewPanel = previewMedia.render(work);
      const fallbackInfoPanel = !factPanel ? infoSection.createInlineInfoPanel(work) : null;
      const personPanel = createWorkPeoplePanel(person, work);

      els.viewContent.append(hero);
      if (factPanel) els.viewContent.append(factPanel);
      if (personPanel) els.viewContent.append(personPanel);
      if (previewPanel) els.viewContent.append(previewPanel);
      els.viewContent.append(playbackSection);
      if (!factPanel) {
        if (fallbackInfoPanel) els.viewContent.append(fallbackInfoPanel);
      }
      els.viewContent.append(createWorkDetailToolbar({
        work,
        onPlay: playDefaultVideo,
        factsTarget: factPanel || fallbackInfoPanel
      }));
    };
    try {
      const result = await workDetailDataService.load(workId, {
        signal: isActive.signal,
        isActive,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderWorkData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (result.unchanged) {
        applyWorkHeader(result.data);
        return;
      }
      renderWorkData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存。", "quiet", false);
      } else {
        els.viewTitle.textContent = "作品详情";
        renderMessage(detailErrorMessage(error, "作品详情读取失败，请检查服务连接"), "error");
      }
    }
  }
  function createWorkDetailHero(work, onDirectPlay) {
    const activeUrl = getActiveUrl();
    const hero = document.createElement("div");
    hero.className = "detail-hero work-detail-hero";
    const cover = document.createElement("button");
    cover.type = "button";
    cover.className = "work-detail-cover work-detail-play-cover";
    cover.disabled = !(work.videos || []).length;
    const coverVisual = document.createElement("div");
    coverVisual.className = "work-detail-cover-visual";
    coverVisual.textContent = "NO COVER";
    const imagePath = imageUrlForWork(work);
    const imageUrl = absoluteUrl(activeUrl, imagePath);
    if (imagePath) loadPreviewImage(coverVisual, imageUrl, { cacheBaseUrl: activeUrl });
    const playMark = document.createElement("span");
    playMark.className = "cover-play-mark";
    playMark.setAttribute("aria-hidden", "true");
    const playLabel = document.createElement("span");
    playLabel.className = "work-detail-play-label";
    const idlePlayLabel = cover.disabled ? "暂无视频" : work.progress?.percent ? "继续播放" : "点击播放";
    playLabel.textContent = idlePlayLabel;
    cover.append(coverVisual, playMark, playLabel);
    cover.addEventListener("click", async () => {
      if (cover.disabled) return;
      const startedAt = performance.now();
      cover.disabled = true;
      cover.setAttribute("aria-busy", "true");
      playLabel.textContent = "正在打开";
      try {
        await onDirectPlay?.();
      } catch {
        // The player mount will render any detailed fallback state; keep the cover stable.
      } finally {
        await waitForMinimumOpenTime(startedAt);
        cover.disabled = !(work.videos || []).length;
        cover.removeAttribute("aria-busy");
        playLabel.textContent = idlePlayLabel;
      }
    });

    const body = document.createElement("div");
    body.className = "detail-hero-body";
    const title = document.createElement("strong");
    title.className = "work-detail-title";
    title.textContent = work.title || work.directoryName || "未命名作品";

    const author = document.createElement(work.personId ? "button" : "span");
    author.className = "work-detail-author";
    author.textContent = workPersonName(work) ? `演员：${workPersonName(work)}` : "演员：未知";
    if (work.personId) {
      author.type = "button";
      author.addEventListener("click", () => showView("personDetail", { personId: work.personId }, { push: true }));
    }

    const titleBlock = document.createElement("div");
    titleBlock.className = "work-detail-title-block";
    titleBlock.append(title, author);

    const actions = workActions.createActionRow(work);

    const metaBody = document.createElement("div");
    metaBody.className = "work-detail-meta-body";
    body.append(titleBlock);
    metaBody.append(actions);
    hero.append(body, cover, metaBody);
    return hero;
  }

  function waitForMinimumOpenTime(startedAt) {
    const elapsed = performance.now() - startedAt;
    const remaining = PLAY_OPEN_COOLDOWN_MS - elapsed;
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
  }

  function createWorkDetailHighlights(work) {
    const info = work.infoMetadata || null;
    const summary = work.infoSummary || null;
    if (!info && !summary) return null;

    const fields = fieldMap(info?.fields || []);
    const rating = ratingFact(info || summary);
    const releaseDate = cleanFactValue(info?.releaseDate || summary?.releaseDate || fields.get("日期"));
    const duration = durationText(info?.durationMinutes ?? summary?.durationMinutes ?? fields.get("时长")) || playbackDurationText(work);
    const videoSize = formatBytes((work.videos || []).reduce((total, video) => total + Math.max(0, Number(video?.size || 0)), 0));
    const items = [];
    if (releaseDate) items.push({ label: "日期", value: releaseDate });
    if (duration) items.push({ label: "时长", value: duration });
    if (rating.text) items.push({ label: "评分", value: compactRatingText(rating.text), accent: true });
    if (videoSize) items.push({ label: "大小", value: videoSize });
    if (!items.length) return null;

    const strip = document.createElement("div");
    strip.className = "work-detail-highlights";
    strip.dataset.count = String(items.length);
    for (const item of items) {
      const chip = document.createElement("div");
      chip.className = `work-detail-highlight${item.accent ? " rating" : ""}`;
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("strong");
      value.textContent = item.value;
      chip.append(label, value);
      strip.append(chip);
    }
    return strip;
  }

  function playbackDurationText(work) {
    const seconds = Math.max(0, ...(work.videos || []).map((video) => Number(video?.progress?.duration || 0)).filter(Number.isFinite));
    return seconds > 0 ? `${Math.max(1, Math.round(seconds / 60))} 分钟` : "";
  }

  function compactRatingText(value) {
    return String(value || "")
      .replace(/，/g, " · ")
      .replace(/\s*分/g, "分")
      .replace(/\s*人评价/g, "人")
      .trim();
  }

  function createWorkFactPanel(work) {
    const info = work.infoMetadata || null;
    const summary = work.infoSummary || null;
    if (!info && !summary) return null;

    const fields = fieldMap(info?.fields || []);
    const code = cleanFactValue(info?.code || summary?.code || extractWorkCode(work));
    const maker = cleanFactValue(info?.maker || fields.get("片商"));
    const label = cleanFactValue(info?.label || fields.get("发行商"));
    const series = cleanFactValue(info?.series || fields.get("系列"));
    const director = cleanFactValue(info?.director || fields.get("导演"));
    const workType = workTypeFact(work);
    const tags = arrayFact(info?.tags).length ? arrayFact(info.tags) : splitFactList(fields.get("类别"));

    const highlights = createWorkDetailHighlights(work);
    const hasContent = [code, workType, maker, label, series, director, tags.length, highlights].some(Boolean);
    if (!hasContent) return null;

    const section = document.createElement("div");
    section.className = "detail-block work-facts-block";
    section.append(createDetailSectionTitle("作品资料", ""));

    const panel = document.createElement("div");
    panel.className = "work-facts-panel";
    if (highlights) {
      highlights.classList.add("work-facts-highlights");
      panel.append(highlights);
    }
    appendFactRow(panel, "番号", code, { copyable: true });
    appendFactRow(panel, "类型", singleFactList(workType), { chips: true });
    appendFactRow(panel, "导演", singleFactList(director), { chips: true, searchable: true });
    appendFactRow(panel, "片商", singleFactList(maker), { chips: true, searchable: true });
    appendFactRow(panel, "系列", singleFactList(series), { chips: true, searchable: true });
    appendFactRow(panel, "类别", tags, { chips: true, searchable: true });
    appendFactRow(panel, "发行商", singleFactList(label), { chips: true, searchable: true });

    section.append(panel);
    return section;
  }

  function fieldMap(fields) {
    const map = new Map();
    for (const field of fields || []) {
      const label = normalizeFactLabel(field.label);
      const value = cleanFactValue(field.value);
      if (label && value && !map.has(label)) map.set(label, value);
    }
    return map;
  }

  function normalizeFactLabel(label) {
    return String(label || "").replace(/[._\s-]+/g, "").trim();
  }

  function appendFactRow(panel, label, value, options = {}) {
    const listValue = Array.isArray(value) ? value.filter(Boolean) : [];
    const textValue = Array.isArray(value) ? "" : cleanFactValue(value);
    if (!listValue.length && !textValue) return;

    const row = document.createElement("div");
    row.className = "work-fact-row";
    const term = document.createElement("span");
    term.className = "work-fact-label";
    term.textContent = label;

    const detail = document.createElement("div");
    detail.className = "work-fact-value";
    if (options.rating) detail.append(createRatingStars(options.rating));

    if (options.chips) {
      const chips = document.createElement("div");
      chips.className = "work-fact-chip-row";
      for (const item of listValue.slice(0, 18)) {
        const canNavigate = Boolean(options.searchable);
        const chip = document.createElement(canNavigate ? "button" : "span");
        chip.className = "work-fact-chip";
        chip.textContent = item;
        if (canNavigate) {
          chip.type = "button";
          chip.setAttribute("aria-label", `搜索 ${item}`);
          chip.addEventListener("click", () => showView("search", { query: item }, { push: true }));
        }
        chips.append(chip);
      }
      detail.append(chips);
    } else {
      const text = document.createElement("span");
      text.textContent = textValue;
      detail.append(text);

      if (options.copyable) {
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "work-fact-copy";
        copy.textContent = "复制";
        copy.addEventListener("click", () => copyFactValue(textValue, copy));
        detail.append(copy);
      }
    }

    row.append(term, detail);
    panel.append(row);
  }

  function singleFactList(value) {
    const text = cleanFactValue(value);
    return text ? [text] : [];
  }

  function workTypeFact(work) {
    const source = getWorkSource(work);
    if (source.vr) return "VR";
    if (source.variant?.includes("collection")) return "珍藏";
    if (source.variant?.includes("western")) return "欧美";
    return "";
  }

  function createRatingStars(value) {
    const rating = Number(value || 0);
    const node = document.createElement("span");
    node.className = "work-rating-stars";
    const max = 5;
    const full = Math.max(0, Math.min(max, Math.round(rating)));
    node.textContent = `${"★".repeat(full)}${"☆".repeat(max - full)}`;
    return node;
  }

  async function copyFactValue(value, button) {
    const previous = button.textContent;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败";
    }
    window.setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  }

  function ratingFact(info) {
    const value = Number(info?.rating ?? 0);
    if (!Number.isFinite(value) || value <= 0) return { text: "", value: 0 };
    const count = Number(info?.ratingCount || 0);
    return {
      value,
      text: count ? `${value} 分，${formatNumber(count)} 人评价` : `${value} 分`
    };
  }

  function durationText(value) {
    if (value === null || value === undefined || value === "") return "";
    const text = String(value).trim();
    if (!text) return "";
    if (/分钟|分鐘|分|m|min/i.test(text)) return text;
    const number = Number(text);
    return Number.isFinite(number) ? `${number} 分钟` : text;
  }

  function arrayFact(value) {
    return Array.isArray(value) ? value.map(cleanFactValue).filter(Boolean) : [];
  }

  function splitFactList(value) {
    return String(value || "")
      .split(/[,，、;；/|]/)
      .map(cleanFactValue)
      .filter(Boolean);
  }

  function cleanFactValue(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function createWorkPeoplePanel(person, work) {
    const activeUrl = getActiveUrl();
    const actors = workActorsForDisplay(work, person);
    if (!actors.length) return null;

    const section = document.createElement("div");
    section.className = "detail-block work-people-block";
    section.append(createDetailSectionTitle("演员", actors.length > 1 ? `${formatNumber(actors.length)} 人` : ""));

    const list = document.createElement("div");
    list.className = actors.length > 1 ? "work-actor-strip" : "work-actor-list";

    for (const actor of actors) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `work-actor-card${actors.length > 1 ? " compact" : ""}`;
      if (actor.person?.id) {
        card.addEventListener("click", () => showView("personDetail", { personId: actor.person.id }, { push: true }));
      } else {
        card.addEventListener("click", () => showView("search", { query: actor.name }, { push: true }));
      }

      const visual = createFallbackCover(actor.name);
      card.append(visual);
      const imagePath = actor.person ? imageUrlForPerson(actor.person) : "";
      if (imagePath) loadPreviewImage(visual, absoluteUrl(activeUrl, imagePath), { cacheBaseUrl: activeUrl });

      const body = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = actor.displayName;
      const meta = document.createElement("span");
      meta.textContent = actor.person
        ? `${formatNumber(actor.person.workCount)} 部作品`
        : "搜索相关作品";
      body.append(name, meta);

      card.append(body);
      list.append(card);
    }

    section.append(list);
    return section;
  }

  function workActorsForDisplay(work, person) {
    const names = actorNamesFromInfo(work);
    const people = getLibrary?.()?.people || [];
    const seen = new Set();
    const actors = [];
    for (const name of names) {
      const normalized = normalizePersonName(name);
      if (!normalized || seen.has(normalized)) continue;
      const matched = findPersonByActorName(name, people);
      seen.add(normalized);
      actors.push({
        name,
        displayName: matched ? displayPersonName(matched) : name,
        person: matched || null
      });
    }

    const primaryPerson = person || findPersonById(work.personId, people);
    if (primaryPerson) {
      const key = normalizePersonName(displayPersonName(primaryPerson));
      const rawKey = normalizePersonName(primaryPerson.name);
      const alreadyIncluded = seen.has(key) || seen.has(rawKey);
      if (!alreadyIncluded) {
        actors.push({
          name: displayPersonName(primaryPerson),
          displayName: displayPersonName(primaryPerson),
          person: primaryPerson
        });
      }
    }

    if (!actors.length && work.personName) {
      const matched = findPersonByActorName(work.personName, people);
      actors.push({
        name: work.personName,
        displayName: matched ? displayPersonName(matched) : work.personName,
        person: matched || null
      });
    }
    return actors.slice(0, 10);
  }

  function actorNamesFromInfo(work) {
    const info = work.infoMetadata || null;
    const fields = fieldMap(info?.fields || []);
    const actors = arrayFact(info?.actors).length ? arrayFact(info.actors) : splitFactList(fields.get("演员"));
    return actors.length ? actors : [];
  }

  function findPersonById(personId, people) {
    if (!personId) return null;
    return (people || []).find((item) => item.id === personId) || null;
  }

  function findPersonByActorName(name, people) {
    const target = normalizePersonName(name);
    if (!target) return null;

    let partialMatch = null;
    for (const person of people || []) {
      const aliases = personNameAliases(person);
      if (aliases.some((alias) => normalizePersonName(alias) === target)) return person;
      if (!partialMatch && aliases.some((alias) => {
        const normalized = normalizePersonName(alias);
        return normalized && (normalized.includes(target) || target.includes(normalized));
      })) {
        partialMatch = person;
      }
    }
    return partialMatch;
  }

  function personNameAliases(person) {
    const names = [
      person?.name,
      person?.actorProfile?.displayName,
      person?.actorProfile?.name,
      ...(person?.actorProfile?.aliases || [])
    ].filter(Boolean);
    const aliases = [];
    for (const name of names) {
      aliases.push(name);
      aliases.push(...String(name).split(/[、,，/|]/));
    }
    return aliases.map(cleanFactValue).filter(Boolean);
  }

  function displayPersonName(person) {
    return person?.actorProfile?.displayName || person?.name || "未知演员";
  }

  function workPersonName(work) {
    return work?.personDisplayName || work?.personName || "";
  }

  function normalizePersonName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\s._・·,，、|/()[\]【】「」『』"'’‘“”]+/g, "")
      .trim();
  }

  function detailErrorMessage(error, fallback) {
    const message = String(error?.message || "").trim();
    if (!message) return fallback;
    if (/failed to fetch|network|timeout/i.test(message)) return fallback;
    return message;
  }

  return {
    renderPersonDetail,
    renderWorkDetail
  };
}
