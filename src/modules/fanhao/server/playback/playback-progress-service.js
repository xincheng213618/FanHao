export function createPlaybackProgressService({
  getLibrary,
  publicFavoriteFolders,
  recentWatchedDays,
  userState,
  userStateService
}) {
  let historyCache = null;
  let progressRevision = 0;
  let workProgressCache = new WeakMap();
  let workProgressCacheProgress = null;
  let workProgressCacheRevision = -1;

  function getVideoProgress(videoId, work = null) {
    const progress = userState.progress[videoId];
    if (!progress || !Number.isFinite(progress.position) || !Number.isFinite(progress.duration) || progress.duration <= 0) {
      return null;
    }

    const percent = Math.max(0, Math.min(100, (progress.position / progress.duration) * 100));
    return {
      videoId,
      workId: progress.workId || null,
      position: progress.position,
      duration: progress.duration,
      percent,
      updatedAt: progress.updatedAt || null
    };
  }

  function getWorkProgress(work) {
    ensureWorkProgressCache();
    if (workProgressCache.has(work)) return workProgressCache.get(work);

    let latest = null;
    let latestUpdatedAt = "";
    for (const video of work.videos || []) {
      const progress = getVideoProgress(video.id, work);
      if (!progress) continue;
      const updatedAt = String(progress.updatedAt || "");
      if (!latest || updatedAt.localeCompare(latestUpdatedAt) > 0) {
        latest = progress;
        latestUpdatedAt = updatedAt;
      }
    }
    workProgressCache.set(work, latest);
    return latest;
  }

  function ensureWorkProgressCache() {
    if (workProgressCacheProgress === userState.progress && workProgressCacheRevision === progressRevision) return;
    workProgressCache = new WeakMap();
    workProgressCacheProgress = userState.progress;
    workProgressCacheRevision = progressRevision;
  }

  function progressUpdatedTime(progress) {
    const timestamp = Date.parse(progress?.updatedAt || "");
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function progressWork(videoId, progress) {
    const library = getLibrary();
    if (progress?.workId && library.worksById.has(progress.workId)) {
      return library.worksById.get(progress.workId);
    }

    const file = library.filesById.get(videoId);
    if (!file || file.type !== "video") return null;
    for (const work of library.worksById.values()) {
      if ((work.videos || []).some((video) => video.id === videoId)) return work;
    }
    return null;
  }

  function historyEntries(options = {}) {
    const days = Number(options.days || 0);
    const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    const entries = cachedHistoryEntries();
    const matched = cutoff ? entries.filter((entry) => entry.updatedTime >= cutoff) : entries;
    const limit = Number(options.limit || 0);
    return limit > 0 ? matched.slice(0, limit) : matched.slice();
  }

  function cachedHistoryEntries() {
    const library = getLibrary();
    const progress = userState.progress || {};
    if (
      historyCache?.library === library
      && historyCache.progress === progress
      && historyCache.revision === progressRevision
    ) {
      return historyCache.entries;
    }

    const byWorkId = new Map();

    for (const [videoId, progressRow] of Object.entries(progress)) {
      const updatedTime = progressUpdatedTime(progressRow);
      const work = progressWork(videoId, progressRow);
      if (!work) continue;

      const existing = byWorkId.get(work.id);
      if (!existing || updatedTime > existing.updatedTime) {
        byWorkId.set(work.id, {
          work,
          updatedAt: progressRow?.updatedAt || "",
          updatedTime
        });
      }
    }

    const entries = [...byWorkId.values()].sort((a, b) => b.updatedTime - a.updatedTime || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    historyCache = { entries, library, progress, revision: progressRevision };
    return entries;
  }

  function historyWorks(options = {}) {
    return historyEntries(options).map((item) => item.work);
  }

  function saveVideoProgress(videoId, body = {}) {
    const library = getLibrary();
    const position = Number(body.position || 0);
    const duration = Number(body.duration || body.total || 0);
    const bodyWorkId = String(body.workId || "");
    const workId = bodyWorkId && library.worksById.has(bodyWorkId) ? bodyWorkId : null;

    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) {
      const error = new Error("播放进度无效");
      error.statusCode = 400;
      throw error;
    }

    userState.progress[videoId] = {
      workId,
      position: Math.max(0, position),
      duration,
      updatedAt: new Date().toISOString()
    };
    progressRevision += 1;
    userStateService.save();
    return getVideoProgress(videoId, library.worksById.get(workId));
  }

  function userStateSummary() {
    const library = getLibrary();
    const favoriteCount = Object.keys(userState.favorites).filter((workId) => library.worksById.has(workId)).length;
    const allHistory = historyEntries();
    const recentHistory = historyEntries({ days: recentWatchedDays });

    return {
      favoriteCount,
      historyCount: allHistory.length,
      recentWatchedCount: recentHistory.length,
      recentWatchedDays,
      latestProgressAt: allHistory[0]?.updatedAt || "",
      favoriteFolders: publicFavoriteFolders()
    };
  }

  return {
    getVideoProgress,
    getWorkProgress,
    historyEntries,
    historyWorks,
    saveVideoProgress,
    userStateSummary
  };
}
