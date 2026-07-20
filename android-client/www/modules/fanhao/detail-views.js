import { createAndroidVideoSection } from "../../js/android-player.js";
import { cacheAgeText } from "../../js/cache.js?v=20260705-mobile-actions-01";
import { createDetailSectionTitle } from "../../js/detail-ui.js";
import { extractWorkCode, formatDate, formatNumber } from "../../js/format.js";
import { createInfoPreviewSection } from "../../js/info-preview.js";
import { absoluteUrl, createFallbackCover, imageUrlForPerson, imageUrlForWork, loadPreviewImage } from "../../js/image.js?v=20260717-fanhao-cover-prepare-01";
import { getWorkSource } from "../../js/work-source.js?v=20260710-western-merge-01";
import { personDetailPath } from "./features/people/detail-request.js?v=20260720-fanhao-person-query-01";
import { createPersonDetailHero } from "./features/people/detail-hero.js?v=20260721-fanhao-author-portraits-06";
import { createPersonDetailWorkToolbar } from "./features/people/detail-work-toolbar.js?v=20260721-fanhao-person-browser-07";
import { createWorkActions } from "./features/works/actions.js?v=20260721-fanhao-person-detail-02";
import { createWorkDetailToolbar } from "./features/works/detail-toolbar.js?v=20260721-fanhao-work-detail-flow-09";
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
    renderCurrentViewPreservingScroll = () => {},
    mediaViewer,
    onUserStateChange,
    pageDataService,
    workDetailDataService
  } = context;
  const videoSection = createAndroidVideoSection({ getActiveUrl, openInLibrary });
  const infoSection = createInfoPreviewSection({ getActiveUrl });
  const workActions = createWorkActions({
    detailErrorMessage,
    extractWorkCode,
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
    els.viewKicker.textContent = "作者";
    els.viewTitle.textContent = "正在加载";
    els.viewMeta.textContent = "";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载作者资料</div>`;
    const path = personDetailPath(personId, { ...getWorkListRequestState(), limit: getWorksLimit() });
    let renderedCache = false;
    const indexedPerson = findPersonInLibrary(personId);
    if (indexedPerson) renderPersonPreview(indexedPerson);
    const renderPersonData = (data) => {
      const person = mergeIndexedPerson(indexedPerson, data.person, data.works);
      const works = data.works || [];
      setDetailChromeTitle(person.actorProfile?.displayName || person.name || "作者详情");
      els.viewTitle.textContent = "作者详情";
      els.viewMeta.textContent = "";
      els.viewContent.innerHTML = "";
      els.viewContent.append(renderPersonHero(person));
      els.viewContent.append(createDetailSectionTitle("作品", ""));
      renderWorks(works, "这个作者下面还没有作品。", {
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
        sortMode: getWorkSortMode(),
        sortOptions: getWorkSortOptions(),
        onFilterChange: (value) => setWorkFilterMode(value, { replace: true }),
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
        els.viewTitle.textContent = "作者";
        renderMessage(detailErrorMessage(error, "作者资料读取失败，请检查服务连接"), "error");
      }
    }
  }
  function renderPersonPreview(person) {
    setDetailChromeTitle(person.actorProfile?.displayName || person.name || "作者详情");
    els.viewTitle.textContent = "作者详情";
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

    setDetailChromeTitle(person.actorProfile?.displayName || person.name || "作者详情");
    els.viewTitle.textContent = "作者详情";
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
      const relatedPanel = createRelatedWorksPanel(work, person, isActive);

      els.viewContent.append(hero);
      if (factPanel) els.viewContent.append(factPanel);
      if (previewPanel) els.viewContent.append(previewPanel);
      els.viewContent.append(playbackSection);
      if (!factPanel) {
        if (fallbackInfoPanel) els.viewContent.append(fallbackInfoPanel);
      }
      if (personPanel) els.viewContent.append(personPanel);
      if (relatedPanel) els.viewContent.append(relatedPanel);
      els.viewContent.append(createWorkDetailToolbar({
        work,
        onPlay: playDefaultVideo,
        factsTarget: factPanel || fallbackInfoPanel,
        relatedTarget: relatedPanel
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
    author.textContent = workPersonName(work) ? `作者：${workPersonName(work)}` : "作者：未知";
    if (work.personId) {
      author.type = "button";
      author.addEventListener("click", () => showView("personDetail", { personId: work.personId }, { push: true }));
    }

    const titleBlock = document.createElement("div");
    titleBlock.className = "work-detail-title-block";
    titleBlock.append(title, author);

    const actions = workActions.createActionRow(work);

    const highlights = createWorkDetailHighlights(work);
    const metaBody = document.createElement("div");
    metaBody.className = "work-detail-meta-body";
    body.append(titleBlock);
    if (highlights) metaBody.append(highlights);
    metaBody.append(actions);
    if (work.modifiedAt) {
      const updated = document.createElement("span");
      updated.className = "work-detail-updated";
      updated.textContent = `更新：${formatDate(work.modifiedAt)}`;
      metaBody.append(updated);
    }
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
    const duration = durationText(info?.durationMinutes ?? summary?.durationMinutes ?? fields.get("时长"));
    const items = [];
    if (rating.text) items.push({ label: "评分", value: compactRatingText(rating.text), accent: true });
    if (releaseDate) items.push({ label: "日期", value: releaseDate });
    if (duration) items.push({ label: "时长", value: duration });
    if (!items.length) return null;

    const strip = document.createElement("div");
    strip.className = "work-detail-highlights";
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
    const releaseDate = cleanFactValue(info?.releaseDate || summary?.releaseDate || fields.get("日期"));
    const duration = durationText(info?.durationMinutes ?? summary?.durationMinutes ?? fields.get("时长"));
    const maker = cleanFactValue(info?.maker || fields.get("片商"));
    const label = cleanFactValue(info?.label || fields.get("发行商"));
    const series = cleanFactValue(info?.series || fields.get("系列"));
    const director = cleanFactValue(info?.director || fields.get("导演"));
    const rating = ratingFact(info || summary);
    const workType = workTypeFact(work);
    const tags = arrayFact(info?.tags).length ? arrayFact(info.tags) : splitFactList(fields.get("类别"));
    const actors = arrayFact(info?.actors).length ? arrayFact(info.actors) : splitFactList(fields.get("演员"));

    const hasContent = [code, workType, releaseDate, duration, maker, label, series, director, rating.text, tags.length, actors.length].some(Boolean);
    if (!hasContent) return null;

    const section = document.createElement("div");
    section.className = "detail-block work-facts-block";
    section.append(createDetailSectionTitle("作品资料", ""));

    const panel = document.createElement("div");
    panel.className = "work-facts-panel";
    appendFactRow(panel, "番号", code, { copyable: true });
    appendFactRow(panel, "类型", singleFactList(workType), { chips: true });
    appendFactRow(panel, "日期", releaseDate);
    appendFactRow(panel, "时长", duration);
    appendFactRow(panel, "导演", singleFactList(director), { chips: true, searchable: true });
    appendFactRow(panel, "片商", singleFactList(maker), { chips: true, searchable: true });
    appendFactRow(panel, "系列", singleFactList(series), { chips: true, searchable: true });
    appendFactRow(panel, "评分", rating.text, { rating: rating.value });
    appendFactRow(panel, "类别", tags, { chips: true, searchable: true });
    appendFactRow(panel, "演员", actors, { chips: true, actorLinks: true });
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
        const person = options.actorLinks ? findPersonByActorName(item, getLibrary?.()?.people || []) : null;
        const canNavigate = Boolean(person || options.searchable || options.actorLinks);
        const chip = document.createElement(canNavigate ? "button" : "span");
        chip.className = "work-fact-chip";
        chip.textContent = item;
        if (canNavigate) {
          chip.type = "button";
          chip.classList.toggle("linked", Boolean(person));
          chip.setAttribute("aria-label", person ? `打开作者 ${displayPersonName(person)}` : `搜索 ${item}`);
          chip.addEventListener("click", () => {
            if (person) {
              showView("personDetail", { personId: person.id }, { push: true });
            } else {
              showView("search", { query: item }, { push: true });
            }
          });
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
    section.append(createDetailSectionTitle(actors.length > 1 ? "演员" : "作者", actors.length > 1 ? `${formatNumber(actors.length)} 人` : ""));

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
    return person?.actorProfile?.displayName || person?.name || "未知作者";
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

  function createRelatedWorksPanel(work, person, isActive = () => true) {
    const personId = person?.id || work.personId;
    if (!personId) return null;

    const section = document.createElement("div");
    section.className = "detail-block related-works-block";
    const heading = createDetailSectionTitle("同作者作品", "正在加载");
    const meta = heading.querySelector("span");
    const strip = document.createElement("div");
    strip.className = "related-work-strip";
    strip.innerHTML = `<div class="loading-row">正在加载相关作品</div>`;
    section.append(heading, strip);
    loadRelatedWorks(work, personId, strip, meta, isActive);
    return section;
  }

  async function loadRelatedWorks(currentWork, personId, mount, meta, isActive = () => true) {
    const activeUrl = getActiveUrl();
    const path = `/api/people/${encodeURIComponent(personId)}?limit=120&offset=0`;
    const render = (payload, cacheEntry = null) => {
      const works = relatedWorksForDisplay(payload?.works || [], currentWork.id);
      mount.innerHTML = "";
      if (meta) {
        const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
        meta.textContent = works.length ? `${formatNumber(works.length)} 部${suffix}` : suffix.trim();
      }

      if (!works.length) {
        const empty = document.createElement("div");
        empty.className = "message-box quiet";
        empty.textContent = "暂时没有其他相关作品。";
        mount.append(empty);
        return;
      }
      for (const item of works.slice(0, 12)) {
        mount.append(createRelatedWorkCard(item));
      }
    };
    let renderedCache = false;
    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        onCached(data, cacheEntry) {
          if (!data?.works) return;
          renderedCache = true;
          render(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (!result.unchanged) render(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) return;
      mount.innerHTML = "";
      const box = document.createElement("div");
      box.className = "message-box error";
      box.textContent = detailErrorMessage(error, "相关作品读取失败，请检查服务连接");
      mount.append(box);
      if (meta) meta.textContent = "";
    }
  }

  function relatedWorksForDisplay(works, currentWorkId) {
    return [...works]
      .filter((item) => item && item.id !== currentWorkId)
      .sort((a, b) => compareRelatedWork(a, b));
  }

  function compareRelatedWork(a, b) {
    const aRating = numericRating(a.infoSummary?.rating);
    const bRating = numericRating(b.infoSummary?.rating);
    const aHasRating = aRating !== null;
    const bHasRating = bRating !== null;
    if (aHasRating !== bHasRating) return aHasRating ? -1 : 1;
    if (aHasRating && aRating !== bRating) return bRating - aRating;

    const aCount = Number(a.infoSummary?.ratingCount || 0);
    const bCount = Number(b.infoSummary?.ratingCount || 0);
    if (aCount !== bCount) return bCount - aCount;

    const aCover = imageUrlForWork(a) ? 1 : 0;
    const bCover = imageUrlForWork(b) ? 1 : 0;
    if (aCover !== bCover) return bCover - aCover;

    return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
  }

  function createRelatedWorkCard(work) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "related-work-card";
    workDetailDataService.bind(card, work.id);
    card.addEventListener("click", () => {
      void workDetailDataService.warm(work.id);
      showView("workDetail", { workId: work.id }, { push: true });
    });

    const thumb = document.createElement("div");
    thumb.className = "related-work-thumb";
    thumb.textContent = "NO COVER";
    const imagePath = imageUrlForWork(work);
    if (imagePath) {
      const activeUrl = getActiveUrl();
      loadPreviewImage(thumb, absoluteUrl(activeUrl, imagePath), { cacheBaseUrl: activeUrl });
    }

    const body = document.createElement("div");
    body.className = "related-work-body";
    const title = document.createElement("strong");
    title.textContent = work.title || work.directoryName || "未命名作品";
    const meta = document.createElement("span");
    meta.textContent = relatedWorkMeta(work);
    body.append(title, meta);

    card.append(thumb, body);
    return card;
  }

  function relatedWorkMeta(work) {
    const rating = numericRating(work.infoSummary?.rating);
    const ratingText = rating ? `★ ${rating}` : "";
    const date = displayWorkDate(work.infoSummary?.releaseDate || work.modifiedAt);
    const parts = [ratingText, date].filter(Boolean);
    return parts.length ? parts.join(" · ") : "暂无评分日期";
  }

  function displayWorkDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    return formatDate(raw);
  }

  function numericRating(value) {
    if (value === null || value === undefined || value === "") return null;
    const rating = Number(value);
    return Number.isFinite(rating) ? rating : null;
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
