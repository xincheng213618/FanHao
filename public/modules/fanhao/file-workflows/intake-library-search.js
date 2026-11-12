import { classificationQuery, EDITION_FILTERS } from "../browse-traits.js";
import { captureWebAccount, checkWebAccountResponse } from "../../../platform/accounts/session-context.js";
import { createLibraryPeopleFilter } from "./intake-library-people.js?v=2";

const classificationFilters = new Map([["ltx-local", "ltxLocal"], ...EDITION_FILTERS.map(([key, label]) => [label.toLowerCase(), key])]);
const reviewStoragePrefix = "fanhao.subtitle-reviewed-no-chinese:";
const chineseBit = 1, vrBit = 2, reviewedBit = 4;
const settingsKey = "fanhao.subtitle-workbench-settings.v1";
const resumeKey = "fanhao.subtitle-workbench-resume.v1";
const resumeRadius = 54;

function readWorkbenchState(storage, key) {
  try {
    const account = captureWebAccount();
    const saved = JSON.parse(globalThis[storage].getItem(key));
    if (saved?.revision === account.revision && (!saved.owner || !account.owner || saved.owner === account.owner)) return saved;
  } catch { /* Browsing still works without storage. */ }
  return null;
}

function writeWorkbenchState(storage, key, state) {
  try {
    const account = captureWebAccount();
    globalThis[storage].setItem(key, JSON.stringify({ ...state, ...account }));
  } catch { /* Browsing still works without storage. */ }
}

function storedReviews() {
  const ids = new Set();
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(reviewStoragePrefix) && localStorage.getItem(key) === "1") ids.add(key.slice(reviewStoragePrefix.length));
    }
  } catch { /* A browser that blocks local storage can still browse and play. */ }
  return ids;
}

function isVrWork(work) {
  const text = [work.relativePath, work.title, work.directoryName].join("\n").replaceAll("\\", "/");
  return /v:\/|\bvr\b/i.test(text) || work.traits?.tags?.includes("VR");
}

function workCardMeta(work) {
  return [work.personDisplayName || work.personName, work.infoSummary?.releaseDate?.slice(0, 10), `${work.videoCount} 份视频`]
    .filter(Boolean).join(" · ");
}

function personWorkMatches(work, query) {
  if (!query) return true;
  const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase();
  const fields = [work.title, work.directoryName, work.infoSummary?.title, work.infoSummary?.code,
    work.personName, work.personDisplayName, ...(work.personAliases || [])].map(normalize);
  const terms = normalize(query).split(/\s+/);
  return terms.every((term) => fields.some((field) => field.includes(term) ||
    (/^[a-z]{2,12}[-_]?\d{2,}$/i.test(term) && field.replace(/[-_\s]/g, "").includes(term.replace(/[-_]/g, "")))));
}

async function readCatalog(url, signal) {
  const account = captureWebAccount();
  const headers = account.owner ? { "X-FanHao-Account-Owner": account.owner } : undefined;
  const response = await fetch(url, { cache: "no-store", signal, headers });
  checkWebAccountResponse(response, account);
  if (!response.ok) throw new Error("馆藏读取失败，请重试。");
  return response.json();
}

export function createIntakeLibrarySearch({ section, form, status, results, selectVideo, catalog }) {
  const input = form.querySelector("input");
  const pageSize = catalog ? 18 : 12;
  let classification = "", selectedWorkId = "", lastWorkId = "";
  let excludeChinese = false, excludeVr = false, onlyMarkedA = false, onlyUnreviewed = false, personId = "", currentQuery = "", feed;
  let request, selecting = false, peopleScan;
  const reviewed = catalog ? storedReviews() : new Set();
  const subtitleChanges = new Map(), subtitleReads = new Map();
  const observer = catalog && new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && feed && !feed.failed) void loadFeed(feed);
  }, { rootMargin: "280px" });
  const people = catalog ? createLibraryPeopleFilter({ ...catalog.people, readCatalog, select(id) {
    personId = id;
    search(input.value.trim());
  } }) : null;

  function showStatus(text = "", error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle("error", error);
  }

  function showResults(...rows) {
    results.replaceChildren(...rows);
    results.hidden = !rows.length;
    results.scrollTop = 0;
  }

  function browseSettings() {
    return { query: currentQuery, classification, personId, sort: catalog.sort.value, cardSize: catalog.cardSize.value,
      excludeChinese, excludeVr, onlyMarkedA, onlyUnreviewed };
  }

  function applyBrowseSettings(settings = {}) {
    input.value = typeof settings.query === "string" ? settings.query.slice(0, input.maxLength) : "";
    classification = classificationFilters.has(settings.classification) ? settings.classification : "";
    personId = typeof settings.personId === "string" ? settings.personId.slice(0, 200) : "";
    people.setSelection(personId);
    for (const button of catalog.tools.querySelectorAll("[data-classification]")) {
      button.setAttribute("aria-pressed", String(button.dataset.classification === classification));
    }
    for (const key of ["sort", "cardSize"]) {
      const select = catalog[key];
      select.value = [...select.options].some(option => option.value === settings[key]) ? settings[key] : select.options[0].value;
    }
    results.dataset.size = catalog.cardSize.value;
    excludeChinese = settings.excludeChinese === true;
    excludeVr = settings.excludeVr === true;
    onlyMarkedA = settings.onlyMarkedA === true;
    onlyUnreviewed = settings.onlyUnreviewed === true;
    for (const [button, pressed] of [[catalog.excludeChinese, excludeChinese], [catalog.excludeVr, excludeVr],
      [catalog.onlyMarkedA, onlyMarkedA], [catalog.onlyUnreviewed, onlyUnreviewed]]) {
      button.setAttribute("aria-pressed", String(pressed));
    }
  }

  function readResume() {
    const resume = readWorkbenchState("localStorage", resumeKey);
    return resume?.settings && typeof resume.workId === "string" && resume.workId.length > 0
      && Number.isSafeInteger(resume.offset) && resume.offset >= 0 ? resume : null;
  }

  function showResumeStatus(text = "", canRestart = false) {
    catalog.resumeStatus.textContent = text;
    catalog.restart.hidden = !canRestart;
    catalog.resumeTools.hidden = !text && !canRestart;
  }

  function rememberWork(owner, workId) {
    if (!owner || owner !== feed) return;
    const id = String(workId);
    const entry = owner.cards.get(id);
    if (!entry) return;
    writeWorkbenchState("localStorage", resumeKey, { workId: id, offset: entry.sourceOffset, settings: browseSettings() });
    catalog.resume.hidden = !readResume();
  }

  function subtitleFlags(work) {
    return { ...work.traits?.flags, ...subtitleChanges.get(String(work.id)) };
  }

  function hasChineseSubtitles(work) {
    const flags = subtitleFlags(work);
    return Boolean(flags.embeddedChinese || flags.hasChineseSidecar);
  }

  function hiddenBySubtitleFilters(work, { excludingChinese, unreviewedOnly }) {
    return Boolean((excludingChinese && hasChineseSubtitles(work)) || (unreviewedOnly && reviewed.has(String(work.id))));
  }

  function updateSubtitleBadge(badges, flags) {
    let badge = badges.querySelector("[data-subtitle-badge]");
    const label = flags.hasChineseSidecar ? "中字" : flags.hasSidecar ? "外挂字幕" : "";
    if (!label) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "cover-badge cover-marker";
      badge.dataset.subtitleBadge = "";
      badges.append(badge);
    }
    badge.textContent = label;
  }

  function updateReviewBadge(badges, id) {
    const badge = badges.querySelector("[data-review-badge]");
    if (!reviewed.has(id)) { badge?.remove(); return; }
    if (badge) return;
    const label = document.createElement("span");
    label.className = "cover-badge cover-marker";
    label.dataset.reviewBadge = "";
    label.textContent = "已查无中字";
    badges.append(label);
  }

  function workCard(work, action) {
    const title = work.title || work.directoryName;
    const card = control("", action);
    card.className = "work-card";
    card.dataset.workId = work.id;
    card.setAttribute("aria-pressed", String(selectedWorkId === String(work.id)));
    const cover = document.createElement("span");
    cover.className = "work-cover cover-wrap";
    const coverUrl = work.coverId ? `/media/image/${encodeURIComponent(work.coverId)}`
      : work.cachedCover?.coverUrl || work.remoteCoverUrl || work.infoSummary?.imageUrl;
    const placeholder = document.createElement("span");
    placeholder.className = "placeholder-cover";
    placeholder.textContent = "无封面";
    cover.append(placeholder);
    if (coverUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = coverUrl;
      cover.append(image);
    }
    const flags = subtitleFlags(work);
    const badges = document.createElement("span");
    badges.className = "work-cover-top";
    for (const [enabled, label, className] of [
      [work.localMarkers?.includes("A"), "A", "cover-marker"],
      [flags.ltxLocal || flags.ltx, flags.ltxLocal ? "本机LTX" : "LTX", "cover-marker"],
      [flags.embeddedChinese, "C", "cover-marker"],
      [flags.quality4k, "4K", "cover-quality"]
    ]) {
      if (!enabled) continue;
      const badge = document.createElement("span");
      badge.className = `cover-badge ${className}`;
      badge.textContent = label;
      badges.append(badge);
    }
    updateSubtitleBadge(badges, flags);
    updateReviewBadge(badges, String(work.id));
    badges.setAttribute("aria-hidden", "true");
    const code = work.infoSummary?.code;
    if (code) {
      const number = document.createElement("span");
      number.className = "cover-badge";
      number.textContent = code;
      badges.prepend(number);
    }
    cover.append(badges);
    const rating = Number(work.infoSummary?.rating);
    if (rating > 0) {
      const bottom = document.createElement("span");
      bottom.className = "work-cover-bottom";
      const score = document.createElement("span");
      score.className = "cover-badge cover-rating";
      score.textContent = `★ ${rating.toFixed(2)}`;
      bottom.append(score);
      cover.append(bottom);
    }
    const body = document.createElement("span");
    body.className = "work-body";
    const name = document.createElement("span");
    name.className = "work-title";
    name.textContent = title;
    const meta = document.createElement("span");
    meta.className = "work-updated";
    meta.textContent = workCardMeta(work);
    body.append(name, meta);
    card.append(cover, body);
    return card;
  }

  async function run(text, task, { selection = false, onError = (error) => showStatus(error.message, true) } = {}) {
    request?.abort();
    const owner = request = new AbortController();
    const { signal } = owner;
    selecting = selection;
    showStatus(text);
    try { return await task(signal); }
    catch (error) { if (!signal.aborted) onError(error); }
    finally { if (request === owner) selecting = false; }
  }

  function control(label, action, detail) {
    const button = document.createElement("button");
    button.type = "button";
    if (detail) {
      button.className = "queue-pick";
      const title = document.createElement("strong");
      const summary = document.createElement("small");
      title.textContent = label;
      summary.textContent = detail;
      button.title = detail;
      button.append(title, summary);
    } else button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function navigation(...buttons) {
    const row = document.createElement("div");
    row.className = "library-search-nav";
    row.append(...buttons);
    return row;
  }

  async function openVideo(video, work, showWorks, signal) {
    showStatus("正在加入字幕工作台…");
    const selected = await selectVideo(video, work.id, signal);
    if (signal.aborted) return false;
    if (selected && catalog) {
      showWorks(true);
      return true;
    }
    if (selected) showResults();
    showStatus();
    return selected;
  }

  function openWork(work, showWorks, keepFileList = false) {
    lastWorkId = String(work.id);
    void run("正在读取馆藏视频…", (signal) => readWork(work, showWorks, signal, { keepFileList }), { selection: true });
  }

  async function readWork(work, showWorks, signal, { keepFileList = false, isCurrent = () => true } = {}) {
    const owner = feed;
    const data = await readCatalog(`/api/works/${encodeURIComponent(work.id)}`, signal);
    if (signal.aborted || !isCurrent()) return false;
    if (data.work?.id != null && String(data.work.id) !== String(work.id)) throw new Error("作品已变化，请重新选择。");
    const videos = (data.work?.videos || []).filter((video) => video.sourcePath);
    if (catalog && data.work) {
      const entry = feed?.cards.get(String(work.id));
      if (entry) {
        entry.work = { ...entry.work, ...data.work, videoCount: videos.length };
        entry.card.querySelector(".work-updated").textContent = workCardMeta(entry.work);
        updateSubtitleBadge(entry.card.querySelector(".work-cover-top"), subtitleFlags(entry.work));
      }
    }
    if (videos.length === 1 && !keepFileList) {
      const opened = await openVideo(videos[0], work, showWorks, signal);
      if (opened) rememberWork(owner, work.id);
      return opened;
    }
    const choices = videos.map((video) => control(video.name,
      () => void run("正在加入字幕工作台…", (nextSignal) => openVideo(video, work, showWorks, nextSignal), { selection: true }), video.sourcePath));
    if (catalog) {
      catalog.showFiles(work, choices, videos, () => openWork(work, showWorks, true));
      if (videos.length) rememberWork(owner, work.id);
      showWorks(true);
      return true;
    }
    const back = control("返回作品列表", () => { request?.abort(); showWorks(); });
    results.dataset.layout = "files";
    showResults(navigation(back), ...choices);
    showStatus(videos.length ? "请选择要处理字幕的视频。" : "这部作品没有可用的本地视频。");
    back.focus();
    return true;
  }

  function followingWork(owner, workId) {
    let afterCurrent = false;
    for (const [id, { work, card }] of owner.cards) {
      if (afterCurrent && !card.hidden) return work;
      if (id === workId) afterCurrent = true;
    }
    return null;
  }

  function openNextWork(workId, isCurrent) {
    const owner = feed;
    if (!owner?.cards.has(workId)) return "outside";
    return run("正在寻找下一部作品…", async (signal) => {
      const interrupted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      let next = followingWork(owner, workId);
      while (!next && owner.offset !== null) {
        await Promise.race([loadFeed(owner), interrupted]);
        if (signal.aborted || !isCurrent()) return;
        if (owner.failed) throw new Error("下一部作品读取失败，请重试。");
        next = followingWork(owner, workId);
      }
      if (!next) {
        showFeedSummary(owner);
        return "last";
      }
      const opened = await readWork(next, () => showFeedSummary(owner), signal, { isCurrent });
      if (!opened || signal.aborted) return;
      lastWorkId = String(next.id);
    }, { selection: true, onError(error) { showFeedSummary(owner); throw error; } });
  }

  async function readWorksPage(endpoint, params, offset, filters, signal, firstPage = null) {
    const { excludingChinese, excludingVr, unreviewedOnly, scopedQuery = "" } = filters;
    const works = [], positions = [];
    let cursor = offset, total = 0;
    // Fetch enough source rows to fill the visible page without walking the entire library.
    const refine = excludingChinese || excludingVr || unreviewedOnly || scopedQuery;
    const maxReads = refine ? 4 : 1;
    params.set("limit", String(refine ? pageSize * 2 : pageSize));
    for (let read = 0; read < maxReads; read++) {
      signal.throwIfAborted();
      params.set("offset", String(cursor));
      const data = firstPage || await readCatalog(`${endpoint}?${params}`, signal);
      firstPage = null;
      total = Number(data.total) || 0;
      const rows = data.works || [];
      if (!rows.length) return { works, positions, total, nextOffset: null };
      for (const work of rows) {
        const position = cursor++;
        if (work.videoCount > 0 && !hiddenBySubtitleFilters(work, filters)
          && !(excludingVr && isVrWork(work))
          && personWorkMatches(work, scopedQuery)) {
          works.push(work);
          positions.push(position);
        }
        if (works.length === pageSize) break;
      }
      if (works.length === pageSize || cursor >= total) break;
    }
    return { works, positions, total, nextOffset: cursor < total ? cursor : null };
  }

  async function readResumeWindow(owner) {
    const anchor = owner.anchor;
    const start = Math.max(0, anchor.offset - resumeRadius);
    const params = new URLSearchParams(owner.params);
    params.set("limit", String(resumeRadius * 2 + 1));
    params.set("offset", String(start));
    const data = await readCatalog(`${owner.endpoint}?${params}`, owner.controller.signal);
    const { owner: accountOwner } = captureWebAccount();
    if (anchor.owner && accountOwner && anchor.owner !== accountOwner) return null;
    const index = data.works?.findIndex(work => String(work.id) === anchor.workId) ?? -1;
    if (index < 0) return null;
    return { offset: start + index, page: { ...data, works: data.works.slice(index) } };
  }

  function globalCatalogSource(query) {
    const q = classification ? classificationQuery(classification, query) : query;
    const filter = onlyMarkedA ? "localOnly,localMarkedA" : "localOnly";
    const params = new URLSearchParams({ filter, sort: catalog.sort.value });
    if (q) params.set("q", q);
    return { endpoint: q ? "/api/fanhao/search" : "/api/works", params, key: JSON.stringify([q, filter]) };
  }

  function showPeopleCounts(scan, keepSelection = false) {
    if (scan !== peopleScan) return;
    const mask = (excludeChinese ? chineseBit : 0) | (excludeVr ? vrBit : 0) | (onlyUnreviewed ? reviewedBit : 0);
    if (scan.displayedMask === mask) return;
    scan.displayedMask = mask;
    const counts = new Map();
    let total = 0;
    for (const [id, buckets] of scan.buckets) {
      const count = buckets.reduce((sum, value, flags) => sum + ((flags & mask) === 0 ? value : 0), 0);
      total += count;
      if (id && count) counts.set(id, count);
    }
    people.setCounts(counts, total);
    if (!keepSelection && personId && !counts.has(personId)) {
      personId = "";
      people.setSelection("");
      startFeed(currentQuery);
    }
  }

  async function readPeopleCounts(scan, source, query) {
    const params = new URLSearchParams(source.params);
    const { signal } = scan.controller;
    params.set("limit", "1000");
    try {
      let offset = 0, total;
      do {
        signal.throwIfAborted();
        params.set("offset", String(offset));
        const data = await readCatalog(`${source.endpoint}?${params}`, signal);
        if (scan !== peopleScan || signal.aborted) return;
        const works = data.works || [];
        for (const work of works) {
          const workId = String(work.id);
          if (scan.entries.has(workId) || !(work.videoCount > 0)) continue;
          const id = personWorkMatches(work, query) ? String(work.personId || "") : "";
          const flags = (hasChineseSubtitles(work) ? chineseBit : 0) | (isVrWork(work) ? vrBit : 0)
            | (reviewed.has(workId) ? reviewedBit : 0);
          if (!scan.buckets.has(id)) scan.buckets.set(id, Array(8).fill(0));
          scan.buckets.get(id)[flags]++;
          scan.entries.set(workId, { id, flags, embeddedChinese: Boolean(work.traits?.flags?.embeddedChinese) });
        }
        if (!works.length) break;
        offset += works.length;
        total = Number(data.total) || 0;
      } while (offset < total);
      scan.ready = true;
      showPeopleCounts(scan, scan.keepSelection);
    } catch {
      if (scan !== peopleScan || signal.aborted) return;
      scan.failed = true;
      people.setCounts(new Map(), 0, "人物统计失败，重新搜索可重试。");
    }
  }

  function updatePeopleCounts(source, query, keepSelection) {
    if (!(query || classification || onlyMarkedA || excludeChinese || excludeVr || onlyUnreviewed)) {
      if (!peopleScan) return;
      peopleScan.controller.abort();
      peopleScan = null;
      people.setCounts(null, 0);
      return;
    }
    if (peopleScan?.key === source.key && !peopleScan.failed) {
      if (!peopleScan.ready && keepSelection) peopleScan.keepSelection = true;
      if (peopleScan.ready) showPeopleCounts(peopleScan, keepSelection);
      return;
    }
    peopleScan?.controller.abort();
    peopleScan = { key: source.key, controller: new AbortController(), buckets: new Map(), entries: new Map(), keepSelection };
    people.setCounts(new Map(), 0, "正在统计匹配人物…");
    void readPeopleCounts(peopleScan, source, query);
  }

  function showFeedSummary(owner) {
    if (owner !== feed) return;
    const visible = owner.cards.size - owner.hiddenWorks.size;
    const count = visible.toLocaleString("zh-CN");
    if (!visible && owner.offset === null) {
      showStatus("没有匹配的馆藏视频。");
      return;
    }
    const excluded = [owner.excludingChinese && "中字", owner.excludingVr && "VR", owner.unreviewedOnly && "已查无中字"].filter(Boolean);
    showStatus(`已显示 ${count} 部${excluded.length ? ` · 已排除${excluded.join("、")}` : ""}`);
  }

  function loadFeed(owner) {
    if (owner !== feed || owner.offset === null) return;
    owner.loading ||= readFeed(owner);
    return owner.loading;
  }

  async function readFeed(owner) {
    observer.unobserve(catalog.more);
    owner.failed = false;
    catalog.retry.hidden = true;
    catalog.loadStatus.textContent = owner.cards.size ? "正在加载更多影片…" : "正在搜索馆藏…";
    try {
      const resume = owner.anchor ? await readResumeWindow(owner) : null;
      const { works, positions, nextOffset } = await readWorksPage(owner.endpoint, owner.params,
        resume?.offset ?? owner.offset, owner, owner.controller.signal, resume?.page);
      if (owner !== feed || owner.controller.signal.aborted) return;
      catalog.resume.hidden = !readResume();
      if (owner.anchor) {
        owner.anchor = null;
        owner.resumed = Boolean(resume);
        showResumeStatus(resume ? "已回到上次处理位置。" : "上次处理位置已变化，已从头显示当前筛选。", Boolean(resume));
      }
      owner.offset = nextOffset;
      const cards = [];
      for (const [index, work] of works.entries()) {
        const id = String(work.id);
        if (owner.cards.has(id) || hiddenBySubtitleFilters(work, owner)) continue;
        const card = workCard(work, () => openWork(work, () => showFeedSummary(owner)));
        owner.cards.set(id, { card, work, sourceOffset: positions[index] });
        cards.push(card);
      }
      results.append(...cards);
      results.hidden = !owner.cards.size;
      if (owner.resumed && owner.focusAnchor && cards.length) {
        const focus = owner.focusAnchor;
        owner.focusAnchor = null;
        if (document.activeElement === focus) {
          cards[0].scrollIntoView({ block: "nearest" });
          cards[0].focus({ preventScroll: true });
        }
      }
      if (owner.resumed && !owner.cards.size && nextOffset === null) showResumeStatus("上次处理位置之后没有匹配的作品。", true);
      if (!selecting) showFeedSummary(owner);
      catalog.loadStatus.textContent = "";
      catalog.more.hidden = nextOffset === null;
    } catch {
      if (owner !== feed || owner.controller.signal.aborted) return;
      owner.failed = true;
      if (owner.anchor) showResumeStatus("上次处理位置读取失败，请重试。");
      catalog.loadStatus.textContent = "馆藏读取失败。";
      catalog.retry.hidden = false;
    } finally {
      owner.loading = null;
      if (owner === feed && !owner.failed && owner.offset !== null) observer.observe(catalog.more);
    }
  }

  function startFeed(query, { anchor = null, keepSelection = false } = {}) {
    currentQuery = query;
    request?.abort();
    selecting = false;
    feed?.controller.abort();
    observer.unobserve(catalog.more);
    showResults();
    showStatus();
    showResumeStatus(anchor ? "正在定位上次处理位置…" : "");
    writeWorkbenchState("sessionStorage", settingsKey, { settings: browseSettings() });
    results.dataset.layout = "cards";
    const source = globalCatalogSource(query);
    const params = new URLSearchParams(source.params);
    let { endpoint } = source;
    if (personId) {
      endpoint = `/api/people/${encodeURIComponent(personId)}`;
      if (classification) params.set("filter", `${params.get("filter")},${classificationFilters.get(classification)}`);
      params.delete("q");
      params.set("includeMissingLocal", "0");
      params.set("includeCompilation", "1");
    }
    feed = { controller: new AbortController(), endpoint, params, offset: 0, cards: new Map(), hiddenWorks: new Set(),
      excludingChinese: excludeChinese, excludingVr: excludeVr, unreviewedOnly: onlyUnreviewed,
      scopedQuery: personId ? query : "", loading: null, failed: false, anchor, focusAnchor: anchor ? document.activeElement : null };
    catalog.more.hidden = false;
    void loadFeed(feed);
    updatePeopleCounts(source, query, keepSelection);
  }

  function updateCatalogWork(id) {
    const entry = feed?.cards.get(id);
    if (entry) {
      const { card, work } = entry;
      const badges = card.querySelector(".work-cover-top");
      updateSubtitleBadge(badges, subtitleFlags(work));
      updateReviewBadge(badges, id);
      card.hidden = hiddenBySubtitleFilters(work, feed);
      if (card.hidden) feed.hiddenWorks.add(id);
      else feed.hiddenWorks.delete(id);
      showFeedSummary(feed);
    }
    if (peopleScan && !peopleScan.ready) peopleScan.keepSelection = true;
    const counted = peopleScan?.entries.get(id);
    if (!counted) return;
    const subtitle = subtitleChanges.get(id);
    const hasChinese = subtitle ? counted.embeddedChinese || subtitle.hasChineseSidecar : Boolean(counted.flags & chineseBit);
    const nextFlags = (counted.flags & vrBit) | (hasChinese ? chineseBit : 0) | (reviewed.has(id) ? reviewedBit : 0);
    if (counted.flags === nextFlags) return;
    const buckets = peopleScan.buckets.get(counted.id);
    buckets[counted.flags]--;
    buckets[nextFlags]++;
    counted.flags = nextFlags;
    peopleScan.displayedMask = undefined;
    if (peopleScan.ready) showPeopleCounts(peopleScan, true);
  }

  function updateReview(id, value) {
    if (value) reviewed.add(id);
    else reviewed.delete(id);
    updateCatalogWork(id);
    catalog.onReviewChanged();
  }

  function setReviewed(workId, value) {
    const id = String(workId);
    const key = reviewStoragePrefix + id;
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
    updateReview(id, value);
  }

  async function subtitleChanged(workId, saved) {
    if (!catalog || !workId) return;
    const id = String(workId);
    subtitleReads.get(id)?.abort();
    subtitleReads.delete(id);
    if (saved) {
      subtitleChanges.set(id, { hasSidecar: true, hasChineseSidecar: true });
      if (reviewed.has(id)) {
        try { setReviewed(id, false); return; }
        catch { /* The successful subtitle save still updates the catalog. */ }
      }
      updateCatalogWork(id);
      return;
    }
    const controller = new AbortController();
    subtitleReads.set(id, controller);
    try {
      const { work } = await readCatalog(`/api/works/${encodeURIComponent(id)}`, controller.signal);
      if (subtitleReads.get(id) !== controller || !work?.traits?.flags) return;
      const { hasSidecar, hasChineseSidecar } = work.traits.flags;
      subtitleChanges.set(id, { hasSidecar, hasChineseSidecar });
      updateCatalogWork(id);
    } catch { /* Keep the last verified catalog state if the updated work cannot be read. */ }
    finally { if (subtitleReads.get(id) === controller) subtitleReads.delete(id); }
  }

  function search(query, offset = 0, previousOffsets = []) {
    currentQuery = query;
    if (catalog) { startFeed(query); return; }
    showResults();
    void run("正在搜索馆藏…", async (signal) => {
      const params = new URLSearchParams({ q: query, filter: "localOnly" });
      const { works, total, nextOffset } = await readWorksPage("/api/fanhao/search", params, offset, {}, signal);
      if (signal.aborted) return;
      function showWorks() {
        showStatus(works.length ? `当前结果 ${total.toLocaleString("zh-CN")} 部` : "当前页没有匹配的馆藏视频。");
        const rows = works.map((work) => control(work.title || work.directoryName,
          () => openWork(work, showWorks), `${work.personDisplayName || work.personName || "馆藏"} · ${work.videoCount} 份视频`));
        const pages = [];
        if (previousOffsets.length) pages.push(control("上一页", () => search(query, previousOffsets.at(-1), previousOffsets.slice(0, -1))));
        if (nextOffset !== null) pages.push(control("下一页", () => search(query, nextOffset, [...previousOffsets, offset])));
        if (pages.length) rows.push(navigation(...pages));
        showResults(...rows);
      }
      showWorks();
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query || catalog) search(query);
  });

  if (catalog) {
    const filters = catalog.tools.querySelectorAll("[data-classification]");
    for (const filter of filters) filter.addEventListener("click", () => {
      classification = filter.dataset.classification;
      for (const button of filters) button.setAttribute("aria-pressed", String(button === filter));
      search(input.value.trim());
    });
    catalog.sort.addEventListener("change", () => search(input.value.trim()));
    catalog.cardSize.addEventListener("change", () => {
      results.dataset.size = catalog.cardSize.value;
      writeWorkbenchState("sessionStorage", settingsKey, { settings: browseSettings() });
    });
    catalog.excludeChinese.addEventListener("click", () => {
      excludeChinese = !excludeChinese;
      catalog.excludeChinese.setAttribute("aria-pressed", String(excludeChinese));
      search(input.value.trim());
    });
    catalog.excludeVr.addEventListener("click", () => {
      excludeVr = !excludeVr;
      catalog.excludeVr.setAttribute("aria-pressed", String(excludeVr));
      search(input.value.trim());
    });
    catalog.onlyMarkedA.addEventListener("click", () => {
      onlyMarkedA = !onlyMarkedA;
      catalog.onlyMarkedA.setAttribute("aria-pressed", String(onlyMarkedA));
      search(input.value.trim());
    });
    catalog.onlyUnreviewed.addEventListener("click", () => {
      onlyUnreviewed = !onlyUnreviewed;
      catalog.onlyUnreviewed.setAttribute("aria-pressed", String(onlyUnreviewed));
      search(input.value.trim());
    });
    window.addEventListener("storage", (event) => {
      if (event.key?.startsWith(reviewStoragePrefix)) updateReview(event.key.slice(reviewStoragePrefix.length), event.newValue === "1");
      if (event.key === resumeKey || event.key === null) catalog.resume.hidden = !readResume();
    });
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove"]) {
      window.addEventListener(type, () => { if (feed) feed.focusAnchor = null; }, { passive: true, capture: true });
    }
    catalog.resume.addEventListener("click", () => {
      const anchor = readResume();
      if (!anchor) { catalog.resume.hidden = true; return; }
      applyBrowseSettings(anchor.settings);
      startFeed(input.value.trim(), { anchor, keepSelection: true });
    });
    catalog.restart.addEventListener("click", () => {
      input.value = currentQuery;
      startFeed(currentQuery, { keepSelection: true });
      input.focus({ preventScroll: true });
    });
    catalog.retry.addEventListener("click", () => { if (feed) void loadFeed(feed); });
  }

  return {
    setActive(active) {
      section.hidden = !active;
      if (active) return;
      request?.abort();
      feed?.controller.abort();
      if (catalog) {
        feed = null;
        observer.unobserve(catalog.more);
        catalog.more.hidden = true;
      }
      showResults();
      showStatus();
    },
    browse() {
      if (!catalog) { search(input.value.trim()); return; }
      const saved = readWorkbenchState("sessionStorage", settingsKey);
      if (saved?.settings) applyBrowseSettings(saved.settings);
      catalog.resume.hidden = !readResume();
      startFeed(input.value.trim(), { keepSelection: true });
      void people.load();
    },
    cancelSelection() {
      if (!selecting) return;
      request?.abort();
      if (feed) showFeedSummary(feed);
      else showStatus();
    },
    focusLastWork() {
      const card = [...results.querySelectorAll("[data-work-id]:not([hidden])")].find((item) => item.dataset.workId === lastWorkId);
      card?.scrollIntoView({ block: "nearest" });
      (card || input).focus({ preventScroll: true });
    },
    openNextWork,
    subtitleChanged,
    isReviewed(workId) { return reviewed.has(String(workId || "")); },
    setReviewed,
    setSelectedWork(id) {
      selectedWorkId = String(id || "");
      for (const card of results.querySelectorAll("[data-work-id]")) {
        card.setAttribute("aria-pressed", String(card.dataset.workId === selectedWorkId));
      }
    }
  };
}
