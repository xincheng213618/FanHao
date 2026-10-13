import assert from 'node:assert/strict';
import { FULL_SCRIPTS, expandCommands, isGeneratedCacheOnlyChange, parseNullTerminatedPaths, selectScripts } from './run_verification.mjs';
import { readFileSync } from 'node:fs';

const commands = expandCommands(
  ['verify:first', 'verify:second'],
  {
    'verify:first': 'node one.mjs && npm run verify:shared',
    'verify:second': 'npm run verify:shared && node two.mjs',
    'verify:shared': 'node shared.mjs',
  },
);
assert.deepEqual(commands, ['node one.mjs', 'node shared.mjs', 'node two.mjs']);

for (const [file, script] of [
  ['android-client/scripts/verify-android-security.mjs', 'verify:android-security'],
  ['tools/verify_manga_download_metadata.mjs', 'verify:manga-download'],
  ['tools/verify_manga_image_dimensions.mjs', 'verify:manga-image-dimensions'],
  ['tools/verify_music_metadata_smart_counts.mjs', 'verify:music-smart-counts'],
  ['tools/verify_person_identity_statement_reuse.mjs', 'verify:person-identity-statements'],
  ['tools/verify_novel_empty_pages.mjs', 'verify:novel-empty-pages'],
  ['tools/verify_media_detail_projection.mjs', 'verify:media-detail-projection'],
  ['tools/verify_work_info_detail_cache.mjs', 'verify:work-info-cache'],
  ['tools/verify_work_info_summary_projection.mjs', 'verify:work-info-cache'],
  ['tools/verify_work_info_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tools/verify_work_info_derived_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tools/verify_work_info_catalog_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tools/verify_work_info_prefix_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tools/fixtures/work-info-cache-recovery.mjs', 'verify:work-info-recovery'],
  ['tools/verify_work_search_cache_recovery.mjs', 'verify:work-search-cache'],
  ['tools/fixtures/work-search-cache-recovery.mjs', 'verify:work-search-cache'],
  ['tools/fixtures/work-search-cache-legacy.txt', 'verify:work-search-cache'],
  ['tools/fixtures/missing-code-search-cache-legacy.txt', 'verify:work-search-cache'],
  ['tools/verify_android_novel_style_reuse.mjs', 'verify:android-novel-styles'],
  ['tools/verify_android_novel_mobile_ui.mjs', 'verify:android-novel-ui'],
  ['tools/verify_android_novel_source_identity.mjs', 'verify:android-novels'],
  ['tools/verify_android_novel_paging_alignment.mjs', 'verify:android-novel-paging'],
  ['tools/verify_music_artist_projection.mjs', 'verify:music-artist-projection'],
  ['tools/verify_music_track_projection.mjs', 'verify:music-track-projection'],
  ['tools/fixtures/music-track-projection-store-legacy.txt', 'verify:music-track-projection'],
  ['tools/fixtures/music-track-projection-lyrics-legacy.txt', 'verify:music-track-projection'],
  ['tools/verify_music_report_projection.mjs', 'verify:music-report-projection'],
  ['tools/verify_video_probe_cache_recovery.mjs', 'verify:video-probe-cache-recovery'],
  ['tools/verify_work_search_index_retention.mjs', 'verify:work-search-retention'],
  ['tools/fixtures/work-search-index-retention-legacy.txt', 'verify:work-search-retention'],
  ['tools/verify_work_search_postings.mjs', 'verify:work-search-postings'],
  ['tools/fixtures/work-search-postings-legacy.txt', 'verify:work-search-postings'],
  ['tools/verify_code_prefix_cache_recovery.mjs', 'verify:code-prefix-cache-recovery'],
  ['tools/verify_person_page_cache_keys.mjs', 'verify:person-page-cache'],
  ['tools/verify_person_page_cache_budget.mjs', 'verify:person-page-cache'],
  ['tools/verify_work_page_cache_keys.mjs', 'verify:work-page-cache'],
  ['tools/verify_ranking_cache_recovery.mjs', 'verify:ranking-cache'],
  ['tools/verify_actor_movie_cache_recovery.mjs', 'verify:actor-movie-cache'],
  ['tools/verify_actor_movie_info_cache_recovery.mjs', 'verify:actor-movie-info-cache'],
  ['tools/verify_access_analytics_close.mjs', 'verify:access-analytics-close'],
  ['tools/verify_work_detail_cache.mjs', 'verify:work-detail-cache'],
  ['tools/verify_manga_file_streams.mjs', 'verify:manga-streams'],
  ['tools/verify_stored_zip_stream_lifecycle.mjs', 'verify:manga-streams'],
  ['src/modules/photos/server/stored-zip-stream.js', 'verify:manga-streams'],
  ['tools/verify_android_update_streams.mjs', 'verify:android-update-streams'],
  ['tools/verify_novel_collection_refresh.mjs', 'verify:novel-collection-refresh'],
  ['public/modules/novels/collection-admin.js', 'verify:novel-collection-refresh'],
]) {
  const plan = selectScripts([file]);
  assert(plan.scripts.includes(script), `${file} must select ${script}`);
  assert.equal(plan.unknownSourceFiles.length, 0);
}
assert(FULL_SCRIPTS.includes('verify:novel-collection-refresh'));

const lifecycleCommands = expandCommands(
  ['verify:android-one', 'verify:android-two'],
  {
    'preverify:android-one': 'npm --prefix android-client run sync:cache',
    'verify:android-one': 'node android-one.mjs',
    'preverify:android-two': 'npm --prefix android-client run sync:cache',
    'verify:android-two': 'node android-two.mjs',
  },
);
assert.deepEqual(lifecycleCommands, [
  'npm --prefix android-client run sync:cache',
  'node android-one.mjs',
  'node android-two.mjs',
]);

assert.deepEqual(
  parseNullTerminatedPaths(Buffer.from('public/空 格.js\0android-client/www/modules/novels/小说.css\0')),
  ['public/空 格.js', 'android-client/www/modules/novels/小说.css'],
);

const cacheAppBefore = 'import "./cache.js?v=assets-111111111111";\nconst ready = true;\n';
const cacheAppAfter = 'import "./cache.js?v=assets-222222222222";\nconst ready = true;\n';
assert(isGeneratedCacheOnlyChange('android-client/www/app.js', cacheAppBefore, cacheAppAfter));
assert(!isGeneratedCacheOnlyChange(
  'android-client/www/app.js',
  cacheAppBefore,
  'import "./cache.js?v=assets-222222222222";\nconst ready = false;\n',
));
const cacheConfigBefore = 'export const CLIENT_VERSION = "assets-111111111111";\n';
const cacheConfigAfter = 'export const CLIENT_VERSION = "assets-222222222222";\n';
assert(isGeneratedCacheOnlyChange('android-client/www/js/config.js', cacheConfigBefore, cacheConfigAfter));
assert(!isGeneratedCacheOnlyChange(
  'android-client/www/images/icon.png',
  Buffer.from([0x00, 0x11]).toString('latin1'),
  Buffer.from([0x00, 0x22]).toString('latin1'),
));
assert(!isGeneratedCacheOnlyChange(
  'android-client/www/app.js',
  'const unchanged = true;\r\n',
  'const unchanged = true;\n',
));

const discoveredChanges = [
  { file: 'android-client/www/modules/novels/styles.css', before: '.reader { color: red; }', after: '.reader { color: blue; }' },
  { file: 'android-client/www/app.js', before: cacheAppBefore, after: cacheAppAfter },
  { file: 'android-client/www/js/cache.js', before: 'import "../app.js?v=assets-111111111111";\n', after: 'import "../app.js?v=assets-222222222222";\n' },
];
const meaningfulFiles = discoveredChanges
  .filter(({ file, before, after }) => !isGeneratedCacheOnlyChange(file, before, after))
  .map(({ file }) => file);
assert.deepEqual(meaningfulFiles, ['android-client/www/modules/novels/styles.css']);
const novelWithFilteredCacheNoise = selectScripts(meaningfulFiles);
assert(novelWithFilteredCacheNoise.scripts.includes('verify:android-novels'));
assert(!novelWithFilteredCacheNoise.scripts.includes('verify:android-client'));

const android = selectScripts(['android-client/www/app.js']);
assert(android.scripts.includes('verify:android-client'));
assert(android.scripts.includes('verify:android-security'));
assert.equal(android.unknownSourceFiles.length, 0);

const androidNovel = selectScripts(['android-client/www/modules/novels/mobile-refinements.css']);
assert(androidNovel.scripts.includes('verify:android-novels'));
assert(!androidNovel.scripts.includes('verify:android-client'));

const nativeShortVideo = selectScripts([
  'android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java',
]);
assert(nativeShortVideo.scripts.includes('verify:short-video-client'));
assert(!nativeShortVideo.scripts.includes('verify:android-media'));

assert(selectScripts(['public/modules/market-dashboard/app.js']).scripts.includes('verify:market-dashboard'));
assert(selectScripts(['public/games/gomoku/gomoku.js']).scripts.includes('verify:gomoku'));
assert(selectScripts(['public/games/jump/integration.js']).scripts.includes('verify:jump'));

const androidUpdate = selectScripts(['src/modules/system/server/android-update/service.js']);
assert(androidUpdate.scripts.includes('verify:android-release-workflow'));
assert(androidUpdate.scripts.includes('verify:android-update-streams'));
assert(androidUpdate.scripts.includes('verify:android-security'));

const sharedPublicShell = selectScripts(['public/app.js']);
assert(sharedPublicShell.scripts.includes('verify:startup'));
assert.deepEqual(sharedPublicShell.unknownSourceFiles, ['public/app.js']);

const downloader = selectScripts(['src/modules/short-videos/download-manager/manager_core/read_models.py']);
assert(selectScripts(['src/modules/short-videos/download-manager/manager_core/library_sync.py']).scripts.includes('verify:short-video-sync'));
assert(selectScripts(['src/modules/short-videos/server/store.js']).scripts.includes('verify:short-video-sync'));
assert(selectScripts(['tools/verify_short_video_incremental_sync.mjs']).scripts.includes('verify:short-video-sync'));
assert.deepEqual(downloader.scripts, ['verify:douyin-manager', 'verify:imports'], "independent downloader changes must not run unrelated short-video/Android suites");
assert.deepEqual(selectScripts(['tools/verify_douyin_manager_latest_requests.mjs']).scripts, downloader.scripts);
assert.deepEqual(selectScripts(['src/modules/short-videos/download-manager/tests/test_manager_profile_snapshot.py']).scripts, downloader.scripts);
assert(selectScripts(['src/modules/short-videos/server/runtime.js']).scripts.includes('verify:short-video-runtime'), "main-service short videos retain their wider lifecycle gates");
for (const file of ['runtime', 'store', 'product']) {
  assert(selectScripts([`src/modules/short-videos/server/${file}.js`]).scripts.includes('verify:short-video-images'));
}
for (const file of ['file-server', 'media-response-service', 'media-blob-worker-client']) {
  const media = selectScripts([`src/platform/server/${file}.js`]);
  assert(media.scripts.includes('verify:music-cover-async'));
  assert(media.scripts.includes('verify:image-library'));
  assert(media.scripts.includes('verify:video-playback'), "shared media changes must include consuming behavior");
  assert(media.scripts.includes('verify:short-video-images'));
}
assert(selectScripts(['server.js']).scripts.includes('verify:fanhao'));
assert(selectScripts(['public/modules/fanhao/people-page.js']).scripts.includes('verify:fanhao-requests-browser'));
assert(selectScripts(['src/modules/novels/server/store.js']).scripts.includes('verify:novel-summary-cache'));
assert(selectScripts(['src/modules/music/server/runtime.js']).scripts.includes('verify:music-cover-async'));
assert.deepEqual(selectScripts(['tools/verify_work_facets.mjs']).scripts, ['verify:work-facets', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_work_cache_budget.mjs']).scripts, ['verify:work-cache-budget', 'verify:work-facets', 'verify:code-prefixes', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_code_prefix_cache_budget.mjs']).scripts, ['verify:code-prefixes', 'verify:work-cache-budget', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/diagnose_work_cache_heap.mjs']).scripts, ['verify:work-cache-budget', 'verify:work-facets', 'verify:code-prefixes', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_file_stream_lifecycle.mjs']).scripts, ['verify:file-streams', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_work_cover_async.mjs']).scripts, ['verify:work-cover-async', 'verify:imports']);
assert.deepEqual(selectScripts(['lib/cover-frame.js']).scripts, ['verify:work-cover-async', 'verify:gallery-cover-async', 'verify:image-library', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_gallery_cover_async.mjs']).scripts, ['verify:gallery-cover-async', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_image_query_correctness.mjs']).scripts, ['verify:image-query', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/diagnose_image_query_cpu.mjs']).scripts, ['verify:image-query', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_image_query_cache.mjs']).scripts, ['verify:image-query-cache', 'verify:image-query', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_video_probe_cache.mjs']).scripts, ['verify:video-probe-cache', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_video_probe_lifecycle.mjs']).scripts, ['verify:video-probe-cache', 'verify:imports']);
assert(selectScripts(['src/platform/server/video-probe-task-pool.js']).scripts.includes('verify:video-probe-cache'));
assert(selectScripts(['src/platform/server/local-image-read-queue.js']).scripts.includes('verify:music-cover-async'));
for (const script of ['verify:video-probe-cache', 'verify:music-cover-async', 'verify:gallery-cover-async']) {
  assert(selectScripts(['server.js']).scripts.includes(script), 'server lifecycle assembly must select resource ownership checks');
}
for (const script of ['verify:media-images', 'verify:media-streams', 'verify:archive-images']) {
  assert(selectScripts(['server.js']).scripts.includes(script), 'server lifecycle assembly must select media resource checks');
}
assert.deepEqual(selectScripts(['tools/verify_media_blob_worker.mjs']).scripts, ['verify:media-images', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_remote_image_lifecycle.mjs']).scripts, ['verify:media-images', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_media_stream_lifecycle.mjs']).scripts, ['verify:media-streams', 'verify:imports']);
assert(selectScripts(['src/platform/server/remote-image-warm-queue.js']).scripts.includes('verify:media-images'));
assert(selectScripts(['public/modules/content-index/gallery-page.js']).scripts.includes('verify:photo-reader-browser'));
assert(selectScripts(['public/modules/content-index/gallery-renderer.js']).scripts.includes('verify:photo-reader-browser'));
for (const file of ['public/modules/content-index/gallery-page.js', 'public/modules/content-index/gallery-renderer.js']) {
  assert(selectScripts([file]).scripts.includes('verify:gallery-rendering'));
  assert(selectScripts([file]).scripts.includes('verify:browser-behavior'));
}
assert.deepEqual(selectScripts(['tools/verify_gallery_list_rendering.mjs']).scripts, ['verify:gallery-rendering', 'verify:photo-reader-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_android_channel_rendering.mjs']).scripts, ['verify:android-channel-rendering', 'verify:photo-search', 'verify:imports']);
for (const name of ['image_cache', 'cache_stats']) {
  assert.deepEqual(selectScripts([`tools/verify_android_${name}.mjs`]).scripts, ['verify:android-cache', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/fixtures/image-library-channel-server.mjs']).scripts, ['verify:image-query', 'verify:image-query-cache', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/fixtures/android-gallery-navigation-harness.mjs']).scripts, ['verify:android-media', 'verify:photo-search', 'verify:imports']);
const channelScripts = selectScripts(['android-client/www/platform/content-index/channel-views.js']).scripts;
for (const script of ['verify:android-media', 'verify:android-photos', 'verify:android-channel-rendering', 'verify:photo-search', 'verify:browser-behavior']) assert(channelScripts.includes(script));
for (const file of ['src/modules/content-index/server/image-library-service.js', 'src/modules/content-index/server/image-library-index-service.js', 'src/modules/content-index/server/image-query-cache.js', 'src/modules/content-index/server/image-gallery-db-service.js', 'lib/gallery-metadata-revision.js', 'src/modules/media/server/gallery-metadata-service.js', 'server.js']) {
  for (const script of ['verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering']) assert(selectScripts([file]).scripts.includes(script));
}
for (const file of ['public/modules/content-index/catalog.css', 'public/modules/content-index/styles.css']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:gallery-rendering', 'verify:photo-reader', 'verify:photo-reader-browser', 'verify:photo-search', 'verify:browser-behavior', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_short_video_quality_queries.mjs']).scripts, ['verify:short-video-quality', 'verify:short-video-store', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_short_video_store.mjs']).scripts, ['verify:short-video-store', 'verify:imports']);
for (const file of ['sources', 'lifecycle']) {
  assert.deepEqual(selectScripts([`tools/verify_short_video_image_${file}.mjs`]).scripts, ['verify:short-video-images', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_short_video_product_lifecycle.mjs']).scripts, ['verify:short-video-images', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']);
for (const file of ['actor_avatar_import', 'actor_profile_atomicity', 'actor_profile_reservation_guards', 'core_image_store']) {
  assert.deepEqual(selectScripts([`tools/verify_${file}.mjs`]).scripts, ['verify:actor-avatar-import', 'verify:core-images', 'verify:imports']);
}
for (const file of ['src/modules/fanhao/server/people/actor-avatar-service.js', 'src/modules/fanhao/server/admin/admin-actor-avatar-service.js', 'src/modules/system/server/admin/routes.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:actor-avatar-import', 'verify:core-images', 'verify:fanhao', 'verify:settings', 'verify:auth', 'verify:mutation-auth', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_static_file_lifecycle.mjs']).scripts, ['verify:static-files', 'verify:auth', 'verify:mutation-auth', 'verify:imports']);
for (const file of ['src/platform/server/static-files.js', 'src/platform/server/http-app.js', 'src/apps/short-video-server.js', 'tools/verify_file_workflows_ui.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:static-files', 'verify:shutdown', 'verify:products', 'verify:auth', 'verify:accounts', 'verify:mutation-auth', 'verify:startup', 'verify:file-workflows-ui', 'verify:imports']);
}
for (const file of ['tools/verify_module_lifecycle.mjs', 'tools/verify_server_shutdown_lifecycle.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:shutdown', 'verify:imports']);
}
for (const file of ['src/fanhao/module-registry.js', 'src/platform/server/server-host.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:modules', 'verify:shutdown', 'verify:products', 'verify:startup', 'verify:imports']);
}
for (const script of ['verify:shutdown', 'verify:static-files', 'verify:android-update-streams', 'verify:manga-streams']) assert(selectScripts(['server.js']).scripts.includes(script));
const actualScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
for (const file of ['file_stream_lifecycle', 'file_server_async']) {
  assert.deepEqual(selectScripts([`tools/verify_${file}.mjs`]).scripts, ['verify:file-streams', 'verify:imports']);
}
const sharedFileScripts = selectScripts(['src/platform/server/file-server.js']).scripts;
for (const script of ['verify:archive-images', 'verify:short-video-actions', 'verify:products', 'verify:android-update-streams', 'verify:manga-streams']) {
  assert(sharedFileScripts.includes(script), `shared file server changes must cover ${script}`);
}
const fullCommands = expandCommands(FULL_SCRIPTS, actualScripts);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_work_search_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_android_novel_style_reuse.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_android_novel_paging_alignment.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_work_search_index_retention.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_work_search_postings.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_music_track_projection.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_music_artist_projection.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_music_report_projection.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_video_probe_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_code_prefix_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_actor_movie_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_actor_movie_info_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tools/verify_access_analytics_close.mjs').length, 1);
for (const file of ['cache_recovery', 'derived_cache_recovery', 'catalog_cache_recovery', 'prefix_cache_recovery']) {
  assert.equal(fullCommands.filter(command => command === `node tools/verify_work_info_${file}.mjs`).length, 1);
}
for (const file of ['verify_android_update_streams', 'verify_manga_file_streams', 'verify_stored_zip_stream_lifecycle', 'verify_manga_image_dimensions', 'verify_music_metadata_smart_counts', 'verify_person_identity_statement_reuse', 'verify_novel_empty_pages', 'verify_media_detail_projection', 'verify_work_info_detail_cache', 'verify_work_info_summary_projection', 'verify_person_page_cache_keys', 'verify_person_page_cache_budget', 'verify_work_page_cache_keys', 'verify_work_detail_cache', 'verify_ranking_cache_recovery']) {
  assert.equal(fullCommands.filter(command => command === `node tools/${file}.mjs`).length, 1);
}
for (const command of ['node tools/verify_android_image_cache.mjs', 'node tools/verify_android_cache_stats.mjs']) {
  assert.equal(fullCommands.filter((entry) => entry === command).length, 1, 'Android cache checks must run once in full verification');
  const sharedCacheCommands = expandCommands(selectScripts(['android-client/www/js/cache.js']).scripts, actualScripts);
  assert.equal(sharedCacheCommands.filter((entry) => entry === command).length, 1, 'shared cache changes must include cache behavior');
}
for (const file of ['verify_static_file_lifecycle', 'verify_module_lifecycle', 'verify_server_shutdown_lifecycle', 'verify_gallery_list_rendering', 'verify_android_channel_rendering', 'verify_short_video_quality_queries', 'verify_short_video_image_sources', 'verify_short_video_image_lifecycle', 'verify_actor_avatar_import', 'verify_file_server_async', 'verify_short_video_product_lifecycle']) {
  assert.equal(fullCommands.filter((command) => command === `node tools/${file}.mjs`).length, 1, `${file} must run once in full verification`);
}
for (const file of ['public/js/standalone-host.js', 'public/standalone-app.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:photo-reader-browser', 'verify:manga-reader-browser', 'verify:music-reader-browser', 'verify:novel-reader-browser', 'verify:photo-reader', 'verify:browser-behavior', 'verify:imports']);
}
assert.deepEqual(selectScripts(['public/modules/photos/manga-page.js']).scripts, ['verify:manga-reader-browser', 'verify:manga', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_manga_reader_requests.mjs']).scripts, ['verify:manga-reader-browser', 'verify:manga', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_manga_lookup_performance.mjs']).scripts, ['verify:manga-lookup', 'verify:manga', 'verify:imports']);
for (const file of ['src/modules/photos/server/manga-service.js', 'src/modules/photos/server/manga-database.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:manga', 'verify:manga-lookup', 'verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_music_facet_cache.mjs']).scripts, ['verify:music-facet-cache', 'verify:music-scale', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_music_lyric_search.mjs']).scripts, ['verify:music-lyric-search', 'verify:imports']);
for (const file of ['store', 'lyrics-search']) {
  const selected = expandCommands(selectScripts([`src/modules/music/server/${file}.js`]).scripts, actualScripts);
  assert.equal(selected.filter(command => command === 'node tools/verify_music_lyric_search.mjs').length, 1, 'music search changes must include focused behavior');
}
assert.equal(fullCommands.filter(command => command === 'node tools/verify_music_lyric_search.mjs').length, 1, 'music search must run once in full verification');
for (const file of ['tools/verify_music_summary_reuse.mjs', 'tools/verify_music_active_catalogue.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:music-summary-cache', 'verify:music-scale', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_studio_cache_dependencies.mjs']).scripts, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_android_music_list_rendering.mjs']).scripts, ['verify:android-music-rendering', 'verify:android-music', 'verify:imports']);
for (const name of ['catalogue', 'playback', 'transition']) {
  assert.deepEqual(selectScripts([`tools/verify_android_music_${name}_requests.mjs`]).scripts, ['verify:android-music', 'verify:android-music-rendering', 'verify:imports']);
}
for (const file of ['src/modules/fanhao/server/library/cache-contracts.js', 'src/modules/fanhao/server/library/table-stamp-query.js', 'src/modules/fanhao/server/catalog/studio-service.js', 'src/modules/fanhao/server/catalog/code-prefix-service.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']);
}
assert(selectScripts(['server.js']).scripts.includes('verify:studio-cache'));
assert(selectScripts(['src/modules/music/server/store.js']).scripts.includes('verify:music-summary-cache'));
for (const name of ['facet-cache', 'facets', 'constants', 'store', 'scan']) {
  assert(selectScripts([`src/modules/music/server/${name}.js`]).scripts.includes('verify:music-facet-cache'));
}
assert.deepEqual(selectScripts(['tools/verify_music_playback_lifecycle.mjs']).scripts, ['verify:music-playback', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/player/engine.js']).scripts, ['verify:music-playback', 'verify:music-reader-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/music-page.js']).scripts, ['verify:music-reader-browser', 'verify:music-requests', 'verify:music-playback', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/views/components.js']).scripts, ['verify:music-reader-browser', 'verify:music-requests', 'verify:music-playback', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/actions.js']).scripts, ['verify:music-requests', 'verify:music-reader-browser', 'verify:music-playback', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']);
for (const name of ['music-progress-writer', 'progress-session', 'api']) {
  assert.deepEqual(selectScripts([`public/modules/music/${name}.js`]).scripts, ['verify:music-progress', 'verify:music-progress-browser', 'verify:music-rescan-worker', 'verify:music-scale', 'verify:imports']);
}
for (const name of ['writer', 'clients', 'order']) {
  assert.deepEqual(selectScripts([`tools/verify_music_progress_${name}.mjs`]).scripts, ['verify:music-progress', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_music_progress_requests.mjs']).scripts, ['verify:music-progress-browser', 'verify:music-progress', 'verify:imports']);
for (const name of ['progress-receipts', 'routes', 'store']) {
  assert(selectScripts([`src/modules/music/server/${name}.js`]).scripts.includes('verify:music-progress'));
}
for (const name of ['music-views', 'music-progress-writer', 'progress-session', 'progress-transport', 'music-catalogue-requests', 'music-catalogue-refresh']) {
  assert.deepEqual(selectScripts([`android-client/www/modules/music/${name}.js`]).scripts, ['verify:android-security', 'verify:auth', 'verify:mutation-auth', 'verify:imports', 'verify:android-music', 'verify:music-progress', 'verify:android-music-rendering']);
}
assert.deepEqual(selectScripts(['tools/verify_music_request_ownership.mjs']).scripts, ['verify:music-requests', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_music_reader_requests.mjs']).scripts, ['verify:music-reader-browser', 'verify:music-requests', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_novel_reader_requests.mjs']).scripts, ['verify:novel-reader-browser', 'verify:novel-reader', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_web_novel_chapter_identity.mjs']).scripts, ['verify:novel-reader', 'verify:imports']);
for (const file of ['public/modules/novels/novel-page.js', 'public/modules/novels/collection-admin.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:novel-collection-refresh', 'verify:novel-reader-browser', 'verify:novel-reader', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:browser-behavior', 'verify:imports']);
}
for (const file of ['tools/verify_novel_progress_writer.mjs', 'tools/verify_novel_progress_order.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:novel-progress', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tools/verify_novel_progress_requests.mjs']).scripts, ['verify:novel-progress-browser', 'verify:novel-progress', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/novels/progress-writer.js']).scripts, ['verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-reader', 'verify:novel-reader-browser', 'verify:imports']);
for (const file of ['src/modules/novels/server/store.js', 'src/modules/novels/server/routes.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:novels', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-summary-cache', 'verify:imports']);
}
assert(selectScripts(['src/platform/server/archive-task-pool.js']).scripts.includes('verify:archive-images'));
assert(selectScripts(['src/platform/server/image-reader-cache-service.js']).scripts.includes('verify:archive-images'));
assert.deepEqual(selectScripts(['tools/verify_archive_reader_lifecycle.mjs']).scripts, ['verify:archive-images', 'verify:gallery-db', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/fixtures/archive_image_helper_fixture.mjs']).scripts, ['verify:archive-images', 'verify:gallery-db', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_web_gallery_requests.mjs']).scripts, ['verify:photo-reader-browser', 'verify:photo-reader', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/diagnose_web_gallery_navigation.mjs']).scripts, ['verify:photo-reader-browser', 'verify:photo-reader', 'verify:imports']);
assert(selectScripts(['src/modules/media/server/runtime.js']).scripts.includes('verify:gallery-cover-async'));
assert(selectScripts(['src/platform/server/video-probe-service.js']).scripts.includes('verify:video-probe-cache'));
assert.deepEqual(selectScripts(['tools/verify_novel_write_worker.mjs']).scripts, ['verify:novel-write-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/fixtures/novel-write-worker-fault.mjs']).scripts, ['verify:novel-write-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_novel_credentials_async.mjs']).scripts, ['verify:novel-credentials-async', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_novel_collection_worker.mjs']).scripts, ['verify:novel-collection-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/fixtures/novel-collection-worker-fault.mjs']).scripts, ['verify:novel-collection-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/verify_novel_reimport_async.mjs']).scripts, ['verify:novel-reimport-async', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/rescan_novel_library.py']).scripts, ['verify:novels', 'verify:novel-summary-cache', 'verify:imports']);

const docs = selectScripts(['docs/site/reference/verification.md']);
assert.deepEqual(docs.scripts, ['command:npm --prefix docs test', 'command:npm --prefix docs run build']);

const unknown = selectScripts(['tools/new_unclassified_source.mjs']);
assert(unknown.scripts.includes('verify:startup'));
assert.deepEqual(unknown.unknownSourceFiles, ['tools/new_unclassified_source.mjs']);

console.log('Verification runner fixtures passed.');
