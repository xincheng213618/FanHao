export function createPlaybackProgressService({
  getLibrary,
  publicFavoriteFolders,
  recentWatchedDays,
  userState,
  userStateService
}) {
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
    const candidates = (work.videos || [])
      .map((video) => getVideoProgress(video.id, work))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return candidates[0] || null;
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
    const byWorkId = new Map();

    for (const [videoId, progress] of Object.entries(userState.progress)) {
      const updatedTime = progressUpdatedTime(progress);
      if (cutoff && (!updatedTime || updatedTime < cutoff)) continue;
      const work = progressWork(videoId, progress);
      if (!work) continue;

      const existing = byWorkId.get(work.id);
      if (!existing || updatedTime > existing.updatedTime) {
        byWorkId.set(work.id, {
          work,
          updatedAt: progress?.updatedAt || "",
          updatedTime
        });
      }
    }

    const entries = [...byWorkId.values()].sort((a, b) => b.updatedTime - a.updatedTime || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const limit = Number(options.limit || 0);
    return limit > 0 ? entries.slice(0, limit) : entries;
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
