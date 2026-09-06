import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createMangaService, mangaWholeDownloadReady as serverMangaWholeDownloadReady } from "../src/modules/photos/server/manga-service.js";
import { streamStoredZip } from "../src/modules/photos/server/stored-zip-stream.js";
import { mangaJobChapterStats, mangaTaskMonitorDelayMs, mangaWholeDownloadReady, mergeMangaTaskState, photoIndexTaskProgress, selectMangaTaskDisplayJobs } from "../android-client/www/platform/content-index/channel-views.js?verify-manga-tasks=1";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), "..");
const routerSource = fs.readFileSync(path.join(projectRoot, "public", "js", "router.js"), "utf8");
const pageSource = fs.readFileSync(path.join(projectRoot, "public", "modules", "photos", "manga-page.js"), "utf8");
const mangaCssSource = fs.readFileSync(path.join(projectRoot, "public", "modules", "photos", "manga.css"), "utf8");
const routeSource = fs.readFileSync(path.join(projectRoot, "src", "modules", "photos", "server", "routes.js"), "utf8");
const androidMangaSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "platform", "content-index", "channel-views.js"), "utf8");
const androidAppSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "app.js"), "utf8");
const androidConfigSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "js", "config.js"), "utf8");
const androidPhotoModuleSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "modules", "photos", "android-module.js"), "utf8");
const androidDomSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "js", "dom.js"), "utf8");
const androidIndexSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "index.html"), "utf8");
const androidMangaCssSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "css", "lists.css"), "utf8");
const androidSectionsCssSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "css", "sections.css"), "utf8");
const androidSettingsCssSource = fs.readFileSync(path.join(projectRoot, "android-client", "www", "css", "settings-nav.css"), "utf8");

assert.match(routerSource, /view:\s*"manga"/);
assert.match(routerSource, /\/manga\/\$\{encodeRouteSegment\(route\.mangaComicId\)\}\/read\//);
assert.match(pageSource, /CHAPTER DIRECTORY/);
assert.match(pageSource, /下载整本/);
assert.match(pageSource, /下载本话/);
assert.match(pageSource, /data-action="update"/);
assert.match(pageSource, /data-action="delete"/);
assert.match(pageSource, /添加新的漫画/);
assert.match(pageSource, /manga-job-progress-track/);
assert.match(pageSource, /data-action="catalog"/);
assert.match(pageSource, /chapterAvailable/);
assert.match(pageSource, /等待首章下载/);
assert.match(mangaCssSource, /@media \(max-width: 620px\)/);
assert.match(mangaCssSource, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(mangaCssSource, /@media \(max-width: 350px\)/);
assert.match(pageSource, /\/api\/manga\/\$\{encodeURIComponent\(comicId\)\}\/update/);
assert.match(routeSource, /serveComicDownload/);
assert.match(routeSource, /serveChapterDownload/);
assert.match(routeSource, /mangaService\.startUpdate/);
assert.match(routeSource, /mangaService\.updateStatus/);
assert.match(routeSource, /mangaService\.trashComic/);
assert.match(routeSource, /mangaService\.startAdd/);
assert.match(routeSource, /mangaService\.jobStatus/);
assert.match(routeSource, /mangaService\.listJobs/);
assert.match(routeSource, /mangaService\.retryJob/);
assert.match(routeSource, /mangaService\.clearFinishedJobs/);
assert.match(routeSource, /\/api\/manga\/jobs\/history/);
assert.match(routeSource, /\/api\/manga\/storage/);
assert.match(routeSource, /mangaService\.storageStatus/);
assert.match(routeSource, /mangaService\.purgeTrash/);
assert(routeSource.includes('const mangaTrashRestoreMatch = /^\\/api\\/manga\\/trash\\/([^/]+)\\/restore$/'));
assert.match(routeSource, /mangaService\.restoreTrashEntry/);
assert.match(fs.readFileSync(path.join(projectRoot, "src", "modules", "photos", "server", "manga-service.js"), "utf8"), /\.manga-jobs\.json/);
assert.match(fs.readFileSync(path.join(projectRoot, "src", "modules", "photos", "server", "manga-service.js"), "utf8"), /后台重启，任务已中断，请重新采集/);
assert.match(androidMangaSource, /createMangaLibraryActions/);
assert.match(androidMangaSource, /createMangaTaskManager/);
assert.match(androidMangaSource, /selectMangaTaskDisplayJobs\(mangaTaskJobs, mangaAddJob, 6\)/);
assert.match(androidMangaSource, /let mangaTaskHistoryOpen = false/);
assert.match(androidMangaSource, /const visibleJobs = mangaTaskHistoryOpen\s*\? jobs\s*:\s*attentionJobs;/, "completed manga tasks must stay hidden until task history is expanded");
assert.match(androidMangaSource, /mangaJobRunning\(previous\) && merged\.status === "complete"\) showMangaTaskNotice\(merged\)/, "a running manga task must raise a completion notice exactly on settlement");
assert.match(androidMangaSource, /}, 5200\);/, "manga completion notices must disappear automatically");
assert.match(androidMangaCssSource, /\.manga-task-notice/);
assert.match(androidMangaSource, /function mangaDetailJobVisible\(job = \{\}\) \{\s*return mangaJobRunning\(job\) \|\| job\.status === "failed";/, "manga details must retain only active or failed task cards");
assert.match(androidMangaSource, /else if \(mangaTaskNoticeMatchesComic\(comic\)\) jobSlot\.append\(createMangaCompletionNotice\(\)\)/, "manga details must replace a completed task card with the temporary completion notice");
assert.match(androidMangaSource, /querySelectorAll\("\[data-manga-completion-notice\]"\).*?node\.remove/, "manga completion notices must be removed from detail pages when their timer expires");
assert.match(androidMangaSource, /compact: !mangaTaskHistoryOpen/);
assert.match(androidMangaSource, /indicator\.setAttribute\("aria-expanded"/);
assert.match(androidMangaSource, /function createMangaTaskConnectionNotice\(\)/);
assert.match(androidMangaSource, /电脑端暂时未连接/);
assert.match(androidMangaSource, /当前显示上次任务状态/);
assert.match(androidMangaSource, /indicator\.textContent = connectionError \? "连接中断"/);
assert.match(androidMangaSource, /ensureMangaTaskMonitor/);
assert.match(androidMangaSource, /\/api\/manga\/jobs\?limit=12/);
assert.match(androidMangaSource, /\/api\/manga\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/retry/);
assert.match(androidMangaSource, /\/api\/manga\/jobs\/history/);
assert.match(androidMangaSource, /clearFinishedMangaTaskHistory/);
assert.match(androidMangaSource, /retryMangaTask/);
assert.match(androidMangaSource, /requestConfirmation/);
assert.match(androidMangaSource, /confirmLabel: "移入回收站",\s*danger: true/);
assert.match(androidMangaSource, /startMangaUpdate/);
assert.match(androidMangaSource, /mangaJobRunning\(data\.update\)\) void watchMangaUpdate\(data\.comic\.id, data\.comic\)/, "opening a running manga task from the library must keep its detail progress live");
assert.match(androidMangaSource, /deleteMangaComic/);
assert.match(androidMangaSource, /createMangaJobProgress/);
assert.match(androidMangaSource, /input\.value = mangaAddUrl/);
assert.match(androidMangaSource, /input\.disabled = mangaJobRunning\(mangaAddJob\)/);
assert.match(androidMangaSource, /panel\.querySelector\("\.manga-operation-error"\)\?\.remove\(\)/);
assert.match(androidMangaSource, /mangaAddError = job\.message/);
assert.match(androidMangaSource, /updateMangaAddState\(\{ status: "failed", message: error\.message/, "add startup failures must reach the inline form state");
assert.match(androidMangaSource, /mangaAddJob\?\.status === "failed" \? "重新采集"/);
assert.match(androidMangaSource, /下载整本/);
assert.match(androidMangaSource, /整本待完成/);
assert.match(androidMangaSource, /下载本话/);
assert.match(androidMangaSource, /返回目录/);
assert.match(androidMangaSource, /createMangaChapterNavigation/);
assert.match(androidMangaSource, /className = "manga-chapter-download"/);
assert.match(androidMangaSource, /suppressResume: Boolean\(resumeRequest\)/);
assert.match(androidMangaSource, /restoreRequestedMangaPage\(resumeRequest, list, tracker\)/);
assert.doesNotMatch(androidMangaSource, /els\.viewContent\.append\(createChannelFavoritePanel\(mangaChapterContentItem/);
assert.match(androidMangaSource, /mangaReadingProgress/);
assert.match(androidMangaSource, /回到第/);
assert.match(androidMangaSource, /上一话/);
assert.match(androidMangaSource, /下一话/);
assert.match(androidMangaSource, /timeoutMs: 10000/);
assert.match(androidMangaSource, /电脑端响应较慢，最多再等待 10 秒/);
assert.match(androidMangaSource, /function renderMangaDetailFailure/);
assert.match(androidMangaSource, /漫画资料暂时打不开/);
assert.match(androidMangaSource, /返回书库/);
assert.match(androidMangaSource, /function renderMangaChapterFailure/);
assert.match(androidMangaSource, /重新读取/);
assert.match(androidMangaSource, /正在使用手机缓存/);
assert.match(androidMangaSource, /重新连接/);
assert.match(androidMangaSource, /itemType\.startsWith\("photoCollection"\)/);
assert.match(androidMangaSource, /manga-detail-hero/);
assert.match(androidMangaSource, /manga-section-title/);
assert.match(androidMangaSource, /els\.viewTitle\.textContent = "套图详情"/);
assert.doesNotMatch(androidMangaSource, /photo-detail-back/);
assert.match(androidMangaSource, /document\.createElement\("div"\);\s*\n\s*page\.className = "manga-reader-page"/);
assert.match(androidAppSource, /currentView === "mangaChapter" && currentViewParams\.id/);
assert.match(androidAppSource, /classList\.toggle\("photo-detail-view", currentView === "photoDetail"\)/);
assert.match(androidAppSource, /classList\.toggle\("manga-detail-view", currentView === "mangaDetail"\)/);
assert.match(androidAppSource, /classList\.toggle\("manga-reader-view", currentView === "mangaChapter"\)/);
assert.match(androidAppSource, /const shouldRestoreHistory = !options\.skipHistory && Boolean\(window\.history\.state\?\.settingsOpen\);[\s\S]*?hideSettingsSurface\(\);[\s\S]*?if \(shouldRestoreHistory\) \{\s*window\.history\.back\(\);/, "settings must close synchronously before Android Back restores browser history");
assert.match(androidAppSource, /const danger = options\.danger === true/);
assert.match(androidAppSource, /setAttribute\("role", danger \? "alertdialog" : "dialog"\)/);
assert.match(androidAppSource, /suspendAppConfirmationBackground/);
assert.match(androidAppSource, /trapAppConfirmationFocus/);
assert.match(androidAppSource, /showView\("mangaDetail", \{ id: currentViewParams\.id \}/);
assert.match(androidAppSource, /previous\?\.view === "mangaDetail"/);
assert.match(androidAppSource, /previous\?\.view === "channel" && normalizeChannelMode\(previous\.params\?\.mode\) === "manga"/);
assert.match(androidPhotoModuleSource, /showMangaCatalog:[\s\S]*?resetStack: true/);
assert.match(androidMangaCssSource, /\.manga-library-actions/);
assert.match(androidMangaCssSource, /\.manga-task-manager/);
assert.match(androidMangaCssSource, /\.manga-task-manager-actions/);
assert.match(androidMangaCssSource, /\.manga-task-card/);
assert.match(androidMangaCssSource, /\.manga-task-card-actions/);
assert.match(androidMangaCssSource, /\.manga-task-card\.is-compact/);
assert.match(androidMangaCssSource, /\.manga-task-manager-indicator\.has-failure/);
assert.match(androidMangaCssSource, /\.manga-task-connection/);
assert.match(androidMangaCssSource, /\.manga-job-progress-track/);
assert.match(androidMangaCssSource, /\.manga-detail-cover/);
assert.match(androidMangaCssSource, /\.channel-list\.manga-list/);
assert.match(androidMangaCssSource, /\.photo-collection-card/);
assert.match(androidMangaCssSource, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(androidSectionsCssSource, /grid-template-columns: 44px minmax\(0, 1fr\) 44px/);
assert.match(androidMangaCssSource, /\.manga-chapter-card:has\(\.manga-chapter-open:active\)/);
assert.match(androidMangaCssSource, /\.manga-connection-failure-actions/);
assert.match(androidMangaCssSource, /\.manga-connection-failure-actions\.single/);
assert.match(androidMangaCssSource, /\.manga-cache-notice/);
assert.match(androidIndexSource, /id="appConfirmSheet"[^>]+role="dialog"/);
assert.match(androidIndexSource, /id="appConfirmMark"[^>]*>i<\/span>/);
assert.doesNotMatch(androidMangaCssSource.match(/\.manga-reader-progress\s*\{[\s\S]*?\}/)?.[0] || "", /position:\s*sticky|top:\s*54px/, "the full reader progress card must scroll away instead of covering manga pages");
assert.match(androidMangaCssSource, /scroll-margin-top: 60px/);
assert.match(androidMangaCssSource, /\.manga-reader-page span\s*\{[\s\S]*?opacity: 0\.72;[\s\S]*?pointer-events: none;/, "page counters must stay visually quiet and never intercept reading gestures");
assert.match(androidSectionsCssSource, /width: calc\(100% \+ 32px\)/);
assert.match(androidSectionsCssSource, /body\.photo-detail-view \.bottom-nav,[\s\S]*?body\.manga-reader-view \.bottom-nav\s*\{\s*display: none;/);
assert.match(androidSectionsCssSource, /body\.photo-detail-view \.app-shell,[\s\S]*?body\.manga-reader-view \.app-shell\s*\{[\s\S]*?padding-bottom: calc\(16px \+ env\(safe-area-inset-bottom\)\);/);
assert.match(androidIndexSource, /电脑漫画书库/);
assert.match(androidIndexSource, /漫画原图属于受保护内容/);
assert.match(androidDomSource, /mangaStorageStatus/);
assert.match(androidDomSource, /mangaTrashList/);
assert.match(androidAppSource, /updateMangaStorageStatus/);
const androidClientVersion = androidConfigSource.match(/CLIENT_VERSION\s*=\s*"([^"]+)"/)?.[1] || "";
assert.ok(androidClientVersion, "Android client config must expose a cache identity");
assert.ok(androidAppSource.includes(`./js/dom.js?v=${androidClientVersion}`), "Android DOM imports must follow the current client cache identity");
assert.match(androidAppSource, /\/api\/manga\/storage/);
assert.match(androidAppSource, /\/api\/manga\/trash/);
assert.match(androidIndexSource, /id="mangaTrashList"/);
assert.match(androidIndexSource, /id="mangaStorageProgressTrack"[^>]+role="progressbar"[^>]+aria-label="漫画原图完整性"/);
assert.match(androidDomSource, /mangaStorageHealthStatus/);
assert.match(androidAppSource, /const pendingImages = Math\.max\(0, imageTotal - downloadedImages - failedImages\)/);
assert.match(androidAppSource, /可从对应书页再次更新补齐/);
assert.match(androidSettingsCssSource, /\.manga-storage-health\.has-issues \.manga-storage-health-head strong/);
assert.match(androidAppSource, /data-manga-trash-restore/);
assert.match(androidAppSource, /\/api\/manga\/trash\/\$\{encodeURIComponent\(item\.name\)\}\/restore/);
assert.match(androidIndexSource, /id="appConfirmOverlay"/);
assert.match(androidAppSource, /requestAppConfirmation/);
assert.match(androidAppSource, /清空漫画回收站/);
assert.doesNotMatch(androidAppSource, /window\.confirm/);
assert.match(androidMangaSource, /renderMangaLibraryFailure/);
assert.match(androidMangaSource, /韩漫书库暂时打不开/);
assert.match(androidMangaSource, /if \(pageComplete \|\| loadingMore\) \{\s*renderChannelData\(normalizedMode, currentPage, null, pendingPaging\);\s*renderedCache = true;\s*renderedCacheSignature = channelDataSignature\(currentPage\);/s);
assert.match(androidMangaSource, /const cached = pageComplete && !loadingMore \? null : await readCachedJson/);
assert.match(androidMangaSource, /当前书库来自手机缓存/);
assert.match(androidMangaSource, /normalizedMode === "manga" \? 10000 : 12000/);
assert.match(androidAppSource, /currentView === "mangaDetail"/);
assert.match(androidAppSource, /showView\("channel", \{ mode: "manga" \}/);

const visibleMangaTasks = selectMangaTaskDisplayJobs([
  { id: "manga-update-1000-1", comicId: "comic-a", title: "漫画 A", status: "failed", startedAt: "2026-08-30T01:00:00Z" },
  { id: "manga-update-2000-2", comicId: "comic-a", title: "漫画 A", status: "complete", startedAt: "2026-08-30T02:00:00Z" },
  { id: "manga-update-1500-1", comicId: "comic-b", title: "漫画 B", status: "failed", startedAt: "2026-08-30T01:30:00Z" },
  { id: "manga-update-2500-1", title: "漫画 C", sourceUrl: "https://jmd9.com/manga/52655", status: "failed", startedAt: "2026-08-30T02:30:00Z" },
  { id: "manga-update-3000-1", title: "漫画 C", sourceUrl: "https://www.91jmd.com/manga/52655", status: "complete", startedAt: "2026-08-30T03:00:00Z" }
]);
const settledMangaTask = { id: "task-new", comicId: "comic-a", status: "complete", startedAt: "2026-08-30T04:00:00Z", finishedAt: "2026-08-30T04:01:00Z" };
assert.equal(mergeMangaTaskState(settledMangaTask, { ...settledMangaTask, status: "running", finishedAt: "" }), settledMangaTask, "a delayed list response must not resurrect a completed task");
const failedMangaTask = { ...settledMangaTask, status: "failed" };
assert.equal(mergeMangaTaskState(failedMangaTask, { ...failedMangaTask, status: "running", finishedAt: "" }), failedMangaTask, "a delayed running snapshot must not erase an authoritative task failure");
assert.equal(mergeMangaTaskState({ ...failedMangaTask, finishedAt: "" }, { ...failedMangaTask, status: "running", finishedAt: "" }).status, "running", "a temporary client polling error must recover when the server is still running");
assert.equal(mergeMangaTaskState(settledMangaTask, { id: "task-old", status: "complete", startedAt: "2026-08-30T01:00:00Z" }), settledMangaTask, "older history must not replace the latest job for a comic");
assert.equal(mergeMangaTaskState(settledMangaTask, { id: "task-newer", status: "running", startedAt: "2026-08-30T05:00:00Z" }).id, "task-newer", "a new update must supersede the previous completion");
assert.equal(mergeMangaTaskState({ status: "starting", startedAt: "2026-08-30T06:00:00Z" }, { id: "server-job", status: "running", startedAt: "2026-08-30T05:00:00Z" }).id, "server-job", "phone clock skew must not prevent a server job from replacing its local starting placeholder");
assert.deepEqual(visibleMangaTasks.map((job) => job.id), ["manga-update-1500-1", "manga-update-3000-1", "manga-update-2000-2"], "a newer retry must supersede its stale failure while unrelated failures stay ahead of completed history");
const failedBeforeHistory = selectMangaTaskDisplayJobs([
  { id: "older-failed", comicId: "failed-book", status: "failed", startedAt: "2026-08-29T00:00:00Z" },
  ...Array.from({ length: 8 }, (_, index) => ({ id: `recent-complete-${index}`, comicId: `finished-book-${index}`, status: "complete", startedAt: "2026-08-30T00:00:00Z" }))
]);
assert.equal(failedBeforeHistory[0].id, "older-failed", "recent completed history must not push an unresolved failure outside the visible task limit");
const activeMangaRetry = selectMangaTaskDisplayJobs([
  { id: "manga-update-1000-1", comicId: "comic-a", status: "failed", startedAt: "2026-08-30T01:00:00Z" }
], { id: "manga-update-4000-1", comicId: "comic-a", status: "running", startedAt: "2026-08-30T04:00:00Z" });
assert.deepEqual(activeMangaRetry.map((job) => job.id), ["manga-update-4000-1"], "a running retry must immediately replace the previous failure in the task manager");
assert.equal(mangaTaskMonitorDelayMs([{ id: "running", status: "running" }]), 1_400, "running downloads must retain near-live progress polling");
assert.equal(mangaTaskMonitorDelayMs([]), 30_000, "an idle manga library must back off task polling to protect phone battery and server resources");
assert.equal(mangaTaskMonitorDelayMs([], { connectionError: true }), 10_000, "a visible connection failure must retry sooner than the idle interval");
assert.equal(mangaTaskMonitorDelayMs([{ id: "running", status: "running" }], { hidden: true }), 60_000, "a backgrounded app must not keep high-frequency task polling active");
assert.deepEqual(
  mangaJobChapterStats({ totalChapters: 22, cachedChapters: 0, completedChapters: 16 }),
  { total: 22, completed: 16, remaining: 6 },
  "live chapter progress must replace stale initial cached/pending counts with completed and remaining totals"
);
assert.deepEqual(
  mangaJobChapterStats({ totalChapters: 10, cachedChapters: 8, completedChapters: 1 }),
  { total: 10, completed: 9, remaining: 1 },
  "incremental update progress must include chapters that were already cached before the run"
);
const incompleteComic = { chapterCount: 22, doneChapterCount: 1, imageCount: 3900, downloadedCount: 244, failedCount: 0 };
const failedComic = { chapterCount: 22, doneChapterCount: 22, imageCount: 3900, downloadedCount: 3899, failedCount: 1 };
const completeComic = { chapterCount: 22, doneChapterCount: 22, imageCount: 3900, downloadedCount: 3900, failedCount: 0 };
assert.equal(mangaWholeDownloadReady(incompleteComic), false, "Android must not label a partial archive as a whole-book download");
assert.equal(mangaWholeDownloadReady(failedComic), false, "Android must keep whole-book download disabled while files have failed");
assert.equal(mangaWholeDownloadReady(completeComic), true, "Android must enable whole-book download after every chapter and image is complete");
assert.equal(serverMangaWholeDownloadReady(incompleteComic), false, "the download endpoint must reject partial manga archives");
assert.equal(serverMangaWholeDownloadReady(failedComic), false, "the download endpoint must reject failed manga archives");
assert.equal(serverMangaWholeDownloadReady(completeComic), true, "the download endpoint must accept a complete manga archive");
assert.match(fs.readFileSync(path.join(projectRoot, "src", "modules", "photos", "server", "manga-service.js"), "utf8"), /MANGA_DOWNLOAD_INCOMPLETE/);
assert.match(fs.readFileSync(path.join(projectRoot, "src", "modules", "photos", "server", "manga-service.js"), "utf8"), /MANGA_DOWNLOAD_FILES_MISSING/);
const photoScanProgress = photoIndexTaskProgress({
  status: "running",
  logs: [
    "unrelated output",
    'IMAGE_LIBRARY_PROGRESS {"phase":"photo-root-complete","percent":45,"root":"T:\\\\","rootIndex":1,"rootTotal":2,"itemCount":30165,"message":"已扫描 1/2 个目录"}'
  ]
});
assert.deepEqual(photoScanProgress, {
  percent: 45,
  message: "已扫描 1/2 个目录",
  phase: "photo-root-complete",
  root: "T:\\",
  rootIndex: 1,
  rootTotal: 2,
  itemCount: 30165
}, "Android photo maintenance must decode machine-readable background scan progress");
assert.equal(photoIndexTaskProgress({ status: "done", logs: [] }).percent, 100, "completed photo scans must render a full progress state even for legacy task logs");
assert.doesNotMatch(androidMangaSource, /createPhotoIndexManager|\/api\/admin\/tasks/, "photo browsing must not expose index maintenance or poll its background tasks");
assert.match(androidMangaSource, /channelDataSignature\(mergedData\) === renderedCacheSignature[\s\S]*?applyChannelHeader\(normalizedMode, mergedData\)/, "unchanged photo responses must still refresh the content header");
assert.doesNotMatch(androidMangaCssSource, /\.photo-index-manager|\.photo-index-progress-track/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-zip-"));
try {
  const firstPath = path.join(temporaryRoot, "first.zip");
  const secondPath = path.join(temporaryRoot, "second.zip");
  fs.writeFileSync(firstPath, Buffer.from("first chapter archive"));
  fs.writeFileSync(secondPath, Buffer.from("second chapter archive"));
  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  await streamStoredZip(sink, [
    { path: firstPath, name: "0001_第一话.zip" },
    { path: secondPath, name: "0002_第二话.zip" }
  ]);
  const archive = Buffer.concat(chunks);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.notEqual(archive.indexOf(Buffer.from("0001_第一话.zip")), -1);
  assert.notEqual(archive.indexOf(Buffer.from("0002_第二话.zip")), -1);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 14), 2);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const updateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-update-service-"));
try {
  const cacheRoot = path.join(updateRoot, "55comic_cache_3980");
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, "catalog.json"), JSON.stringify({
    title: "测试漫画",
    url: "https://www.55comic.com/book/3980"
  }));
  const firstImageDir = path.join(cacheRoot, "chapters", "001", "images");
  const secondImageDir = path.join(cacheRoot, "chapters", "002", "images");
  fs.mkdirSync(firstImageDir, { recursive: true });
  fs.mkdirSync(secondImageDir, { recursive: true });
  const pngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader, 0);
  pngHeader.writeUInt32BE(720, 16);
  pngHeader.writeUInt32BE(800, 20);
  fs.writeFileSync(path.join(firstImageDir, "001.png"), pngHeader);
  fs.writeFileSync(path.join(secondImageDir, "001.png"), pngHeader);
  fs.writeFileSync(path.join(cacheRoot, "manifest.json"), JSON.stringify({
    chapters: [
      {
        index: 1,
        title: "第一话",
        status: "done",
        images: [{ index: 1, local_path: "chapters/001/images/001.png", content_type: "image/png", bytes: pngHeader.length, status: "downloaded" }]
      },
      {
        index: 2,
        title: "第二话",
        status: "done",
        images: [{ index: 1, local_path: "chapters/002/images/001.png", content_type: "image/png", bytes: pngHeader.length, status: "downloaded" }]
      }
    ]
  }));
  fs.writeFileSync(
    path.join(updateRoot, "smtt6_sources.txt"),
    "# manga sources\nhttps://www.55comic.com/book/3980\nhttps://jmd9.com/manga/50163\n"
  );

  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }

  const calls = [];
  const child = new FakeChild();
  const mangaService = createMangaService({
    root: updateRoot,
    databasePath: path.join(updateRoot, "manga.sqlite"),
    projectRoot,
    pythonPath: "python-test",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    mimeTypes: {},
    normalizeExt: (value) => path.extname(String(value || "")).toLowerCase(),
    notFound() {},
    safeStat(filePath) {
      try { return fs.statSync(filePath); } catch { return null; }
    },
    async serveArchiveMemberImage() {}
  });
  const comic = mangaService.publicSummary(mangaService.cacheDirs()[0]);
  assert.throws(
    () => mangaService.startAdd("not-a-url"),
    (error) => error?.statusCode === 400 && /有效的漫画作品链接/.test(error.message)
  );
  assert.throws(
    () => mangaService.startAdd("https://example.com/manga/123"),
    (error) => error?.statusCode === 400 && /只支持 smtt6、jmd9\/91jmd 和 55comic/.test(error.message)
  );
  const initialStorage = mangaService.storageStatus(true);
  assert.equal(initialStorage.comicCount, 1);
  assert.equal(initialStorage.chapterCount, 2);
  assert.equal(initialStorage.imageCount, 2);
  assert.equal(initialStorage.trash.itemCount, 0);
  assert.ok(initialStorage.bytes >= pngHeader.length * 2);
  const firstChapter = mangaService.publicChapter(cacheRoot, 1);
  assert.equal(firstChapter.images[0].width, 720);
  assert.equal(firstChapter.images[0].height, 800);
  assert.equal(firstChapter.navigation.position, 1);
  assert.equal(firstChapter.navigation.total, 2);
  assert.equal(firstChapter.navigation.previous, null);
  assert.equal(firstChapter.navigation.next.index, 2);
  const secondChapter = mangaService.publicChapter(cacheRoot, 2);
  assert.equal(secondChapter.navigation.previous.index, 1);
  assert.equal(secondChapter.navigation.next, null);

  function memoryResponse() {
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    response.writeHead = (statusCode, headers = {}) => {
      response.statusCode = statusCode;
      response.headers = headers;
      return response;
    };
    return { response, chunks };
  }

  const chapterDownload = memoryResponse();
  await mangaService.serveChapterDownload({ method: "GET" }, chapterDownload.response, comic.id, 1);
  const chapterArchive = Buffer.concat(chapterDownload.chunks);
  assert.equal(chapterDownload.response.statusCode, 200, "chapters stored as loose images must still be downloadable as ZIP files");
  assert.equal(chapterArchive.readUInt32LE(0), 0x04034b50);
  assert.notEqual(chapterArchive.indexOf(Buffer.from("0001.png")), -1);

  const wholeDownload = memoryResponse();
  await mangaService.serveComicDownload({ method: "GET" }, wholeDownload.response, comic.id);
  const wholeArchive = Buffer.concat(wholeDownload.chunks);
  assert.equal(wholeDownload.response.statusCode, 200, "a complete loose-image manga must stream as a whole-book ZIP");
  assert.notEqual(wholeArchive.indexOf(Buffer.from("0001_第一话/0001.png")), -1);
  assert.notEqual(wholeArchive.indexOf(Buffer.from("0002_第二话/0001.png")), -1);
  assert.equal(wholeArchive.readUInt16LE(wholeArchive.length - 14), 2);

  const manifestPath = path.join(cacheRoot, "manifest.json");
  const completeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({
    ...completeManifest,
    chapters: completeManifest.chapters.map((chapter, index) => index === 1 ? { ...chapter, status: "pending", images: [] } : chapter)
  }));
  const incompleteDownload = memoryResponse();
  await mangaService.serveComicDownload({ method: "GET" }, incompleteDownload.response, comic.id);
  assert.equal(incompleteDownload.response.statusCode, 409, "a partial loose-image manga must be rejected instead of streamed as a whole book");
  assert.equal(JSON.parse(Buffer.concat(incompleteDownload.chunks).toString("utf8")).code, "MANGA_DOWNLOAD_INCOMPLETE");
  fs.writeFileSync(manifestPath, JSON.stringify(completeManifest));

  const first = mangaService.startAdd("https://www.55comic.com/book/3980");
  const duplicate = mangaService.startUpdate(comic.id);
  assert.equal(first.started, true);
  assert.equal(first.existing, true);
  assert.equal(first.job.status, "running");
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.job.id, first.job.id);
  const visibleJobs = mangaService.listJobs();
  assert.equal(visibleJobs.length, 1);
  assert.equal(visibleJobs[0].title, "测试漫画");
  assert.equal(visibleJobs[0].comicAvailable, true);
  assert.equal(visibleJobs[0].sourceUrl, "https://www.55comic.com/book/3980");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "python-test");
  assert.ok(calls[0].args.includes("--no-record-source"));
  assert.ok(!calls[0].args.includes("--full-scan"));
  assert.equal(calls[0].options.windowsHide, true);
  assert.throws(
    () => mangaService.trashComic(comic.id),
    (error) => error?.statusCode === 409
  );

  child.stdout.write([
    'MANGA_PROGRESS {"event":"catalog","totalChapters":10,"cachedChapters":8,"pendingChapters":2}',
    'MANGA_PROGRESS {"event":"chapter-start","chapterIndex":9,"chapterTitle":"第9话"}',
    'MANGA_PROGRESS {"event":"chapter-images","chapterIndex":9,"chapterTitle":"第9话","totalImages":40}',
    'MANGA_PROGRESS {"event":"image-progress","chapterIndex":9,"completedImages":20,"totalImages":40,"downloadedImages":20,"failedImages":0,"downloadedBytes":2048}',
    ""
  ].join("\n"));
  const firstChapterRunning = mangaService.updateStatus(comic.id);
  assert.equal(firstChapterRunning.progressPercent, 25);
  assert.equal(firstChapterRunning.currentChapterIndex, 9);
  assert.equal(firstChapterRunning.totalImages, 40);
  assert.equal(firstChapterRunning.downloadedBytes, 2048);
  child.stdout.write('MANGA_PROGRESS {"event":"chapter-complete","chapterIndex":9,"status":"done","downloadedImages":40,"failedImages":0}\n');
  const chapterCompletePercent = mangaService.updateStatus(comic.id).progressPercent;
  assert.equal(chapterCompletePercent, 50);
  child.stdout.write('MANGA_PROGRESS {"event":"chapter-start","chapterIndex":10,"chapterTitle":"第10话"}\n');
  assert.equal(mangaService.updateStatus(comic.id).progressPercent, chapterCompletePercent);
  child.stderr.write("[010] failed: example\n");
  const running = mangaService.updateStatus(comic.id);
  assert.equal(running.currentChapterIndex, 10);
  assert.equal(running.totalImages, 0);
  assert.equal(running.downloadedBytes, 0);
  assert.equal(running.completedChapters, 1);
  child.emit("close", 0);
  const finished = mangaService.updateStatus(comic.id);
  assert.equal(finished.status, "complete");
  assert.equal(finished.totalChapters, 10);
  assert.equal(finished.cachedChapters, 8);
  assert.equal(finished.pendingChapters, 2);
  assert.equal(finished.processedChapters, 2);
  assert.equal(finished.failedChapters, 1);
  assert.equal(finished.progressPercent, 100);

  const added = mangaService.startAdd("https://jmd9.com/manga/999");
  assert.equal(added.existing, false);
  assert.equal(added.job.kind, "add");
  assert.equal(calls.length, 2);
  child.stdout.write('MANGA_PROGRESS {"event":"catalog","totalChapters":0,"cachedChapters":0,"pendingChapters":0}\n');
  child.emit("close", 0);
  assert.equal(mangaService.jobStatus(added.job.id).status, "complete");

  const added91jmd = mangaService.startAdd("https://www.91jmd.com/manga/52655/");
  assert.equal(added91jmd.existing, false);
  assert.equal(added91jmd.job.kind, "add");
  assert.equal(calls.length, 3);
  assert.ok(calls[2].args.includes("https://www.91jmd.com/manga/52655"));
  assert.ok(calls[2].args.includes(path.join(updateRoot, "jmd9_cache_52655")));
  child.emit("close", 0);

  const aliasCache = path.join(updateRoot, "jmd9_cache_52655");
  fs.mkdirSync(aliasCache, { recursive: true });
  fs.writeFileSync(path.join(aliasCache, "catalog.json"), JSON.stringify({
    title: "91jmd 别名测试",
    url: "https://91jmd.com/manga/52655"
  }));
  fs.writeFileSync(path.join(aliasCache, "manifest.json"), JSON.stringify({ chapters: [] }));
  const aliasDuplicate = mangaService.startAdd("https://jmd9.com/manga/52655");
  assert.equal(aliasDuplicate.existing, true);
  assert.equal(aliasDuplicate.job.kind, "update");
  assert.equal(calls.length, 4);
  child.emit("close", 0);

  const deleted = mangaService.trashComic(comic.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.recoverable, true);
  assert.equal(deleted.sourceRemoved, true);
  assert.equal(fs.existsSync(cacheRoot), false);
  const trashRoot = path.join(updateRoot, ".trash", deleted.trashName);
  assert.equal(fs.existsSync(trashRoot), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(trashRoot, "deleted.json"), "utf8")).title, "测试漫画");
  const sources = fs.readFileSync(path.join(updateRoot, "smtt6_sources.txt"), "utf8");
  assert.doesNotMatch(sources, /55comic/);
  assert.match(sources, /jmd9/);
  const deletedStorage = mangaService.storageStatus(true);
  assert.equal(deletedStorage.trash.itemCount, 1);
  assert.ok(deletedStorage.trash.bytes >= pngHeader.length * 2);
  assert.throws(
    () => mangaService.restoreTrashEntry("../outside"),
    (error) => error?.statusCode === 400
  );
  const restored = mangaService.restoreTrashEntry(deleted.trashName);
  assert.equal(restored.restored, true);
  assert.equal(restored.sourceTracked, true);
  assert.equal(restored.comic.id, comic.id);
  assert.equal(fs.existsSync(cacheRoot), true);
  assert.equal(restored.storage.trash.itemCount, 0);
  assert.match(fs.readFileSync(path.join(updateRoot, "smtt6_sources.txt"), "utf8"), /55comic/);
  const deletedAgain = mangaService.trashComic(restored.comic.id);
  assert.equal(deletedAgain.recoverable, true);
  const restoredTrashRoot = path.join(updateRoot, ".trash", deletedAgain.trashName);
  const purged = mangaService.purgeTrash();
  assert.equal(purged.removedCount, 1);
  assert.ok(purged.removedBytes >= pngHeader.length * 2);
  assert.equal(purged.storage.trash.itemCount, 0);
  assert.equal(fs.existsSync(restoredTrashRoot), false);
} finally {
  fs.rmSync(updateRoot, { recursive: true, force: true });
}

const persistenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-job-history-"));
try {
  class PersistentFakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }
  const children = [];
  const createPersistentService = () => createMangaService({
    root: persistenceRoot,
    databasePath: path.join(persistenceRoot, "manga.sqlite"),
    projectRoot,
    pythonPath: "python-test",
    spawnProcess() {
      const child = new PersistentFakeChild();
      children.push(child);
      return child;
    },
    mimeTypes: {},
    normalizeExt: (value) => path.extname(String(value || "")).toLowerCase(),
    notFound() {},
    safeStat(filePath) {
      try { return fs.statSync(filePath); } catch { return null; }
    },
    async serveArchiveMemberImage() {}
  });

  const firstService = createPersistentService();
  const completedStart = firstService.startAdd("https://jmd9.com/manga/70001");
  children.at(-1).stdout.write('MANGA_PROGRESS {"event":"catalog","totalChapters":12,"cachedChapters":12,"pendingChapters":0}\n');
  children.at(-1).emit("close", 0);
  assert.equal(firstService.jobStatus(completedStart.job.id).status, "complete");
  const historyPath = path.join(persistenceRoot, ".manga-jobs.json");
  assert.equal(fs.existsSync(historyPath), true, "completed jobs must be durably recorded");
  assert.equal(fs.readdirSync(persistenceRoot).some((name) => name.startsWith(".manga-jobs.json.tmp-")), false, "atomic history writes must not leave temporary files");

  const restartedService = createPersistentService();
  const restoredComplete = restartedService.jobStatus(completedStart.job.id);
  assert.equal(restoredComplete.status, "complete");
  assert.equal(restoredComplete.progressPercent, 100);
  assert.equal(restoredComplete.totalChapters, 12);
  assert.equal(restoredComplete.pendingChapters, 0);
  assert.throws(
    () => restartedService.retryJob(completedStart.job.id),
    (error) => error?.statusCode === 409 && /只有失败/.test(error.message),
    "completed jobs must not be replayed as retries"
  );

  const interruptedStart = restartedService.startAdd("https://91jmd.com/manga/70002");
  children.at(-1).stdout.write('MANGA_PROGRESS {"event":"catalog","totalChapters":20,"cachedChapters":10,"pendingChapters":10}\n');
  const clearWhileRunning = restartedService.clearFinishedJobs();
  assert.deepEqual(clearWhileRunning, {
    ok: true,
    removedCount: 1,
    remainingCount: 1,
    runningCount: 1
  });
  assert.equal(restartedService.jobStatus(completedStart.job.id), null, "finished history must be removed immediately");
  assert.equal(restartedService.jobStatus(interruptedStart.job.id).status, "running", "clear must never remove a running job");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(historyPath, "utf8")).jobs.map((job) => job.id),
    [interruptedStart.job.id],
    "clear must durably retain only the running task"
  );

  const afterCrashService = createPersistentService();
  const interrupted = afterCrashService.jobStatus(interruptedStart.job.id);
  assert.equal(interrupted.status, "failed", "a running task from the previous process must not revive as a ghost task");
  assert.match(interrupted.message, /后台重启，任务已中断，请重新采集/);
  assert.equal(interrupted.totalChapters, 20);
  assert.equal(interrupted.cachedChapters, 10);

  const afterRepairRestart = createPersistentService();
  assert.equal(afterRepairRestart.jobStatus(interruptedStart.job.id).status, "failed", "the repaired interrupted state must itself be persisted");
  assert.equal(afterRepairRestart.listJobs().length, 1);
  const retried = afterRepairRestart.retryJob(interruptedStart.job.id);
  assert.equal(retried.started, true);
  assert.equal(retried.job.status, "running");
  assert.equal(retried.job.kind, "add");
  assert.notEqual(retried.job.id, interruptedStart.job.id, "retry must create a fresh auditable task record");
  const duplicateRetry = afterRepairRestart.retryJob(interruptedStart.job.id);
  assert.equal(duplicateRetry.started, false, "repeated retry taps must reuse the active collector");
  assert.equal(duplicateRetry.job.id, retried.job.id);
  children.at(-1).emit("close", 0);
  assert.equal(afterRepairRestart.jobStatus(retried.job.id).status, "complete");

  const clearAfterRetry = afterRepairRestart.clearFinishedJobs();
  assert.deepEqual(clearAfterRetry, {
    ok: true,
    removedCount: 2,
    remainingCount: 0,
    runningCount: 0
  });
  assert.deepEqual(afterRepairRestart.listJobs(), []);
  assert.deepEqual(createPersistentService().listJobs(), [], "cleared terminal history must stay cleared after restart");
} finally {
  fs.rmSync(persistenceRoot, { recursive: true, force: true });
}

const malformedHistoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-job-history-invalid-"));
try {
  const options = {
    root: malformedHistoryRoot,
    databasePath: path.join(malformedHistoryRoot, "manga.sqlite"),
    projectRoot,
    pythonPath: "python-test",
    spawnProcess() { throw new Error("not expected"); },
    mimeTypes: {},
    normalizeExt: (value) => path.extname(String(value || "")).toLowerCase(),
    notFound() {},
    safeStat(filePath) {
      try { return fs.statSync(filePath); } catch { return null; }
    },
    async serveArchiveMemberImage() {}
  };
  const historyPath = path.join(malformedHistoryRoot, ".manga-jobs.json");
  fs.writeFileSync(historyPath, "{not-json", "utf8");
  assert.deepEqual(createMangaService(options).listJobs(), [], "corrupt history must fail closed without breaking service startup");

  fs.writeFileSync(historyPath, JSON.stringify({
    schemaVersion: 1,
    jobs: [{
      id: "manga-update-1700000000000-1",
      cacheDirectory: "../outside",
      sourceUrl: "https://jmd9.com/manga/1",
      status: "complete",
      startedAt: "2026-08-30T00:00:00.000Z"
    }]
  }), "utf8");
  assert.deepEqual(createMangaService(options).listJobs(), [], "history cache paths must reject traversal records");

  const jobs = Array.from({ length: 55 }, (_, index) => ({
    id: `manga-update-${1700000000000 + index}-${index + 1}`,
    kind: "update",
    cacheDirectory: `jmd9_cache_${index + 1}`,
    sourceUrl: `https://jmd9.com/manga/${index + 1}`,
    status: "complete",
    startedAt: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
    processed: [],
    completed: [],
    failed: [],
    progressPercent: 100,
    message: "处理完成"
  }));
  fs.writeFileSync(historyPath, JSON.stringify({ schemaVersion: 1, jobs }), "utf8");
  const bounded = createMangaService(options).listJobs(100);
  assert.equal(bounded.length, 50, "restored task history must stay bounded");
  assert.equal(bounded[0].id, jobs.at(-1).id, "restored task history must retain newest jobs first");
} finally {
  fs.rmSync(malformedHistoryRoot, { recursive: true, force: true });
}

console.log("Manga library verification passed.");
