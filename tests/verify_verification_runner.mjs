import assert from 'node:assert/strict';
import { DAILY_SCRIPTS, FULL_SCRIPTS, ANDROID_SCRIPTS, WEB_SCRIPTS, expandCommands, isGeneratedCacheOnlyChange, parseNullTerminatedPaths, selectScripts } from './run_verification.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

assert.deepEqual(selectScripts(['tests/verify_web_settings_drafts.mjs']).scripts, ['verify:web-settings-browser', 'verify:imports']);
for (const file of ['public/modules/system/settings-controller.js', 'public/modules/system/admin.css']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:system-control', 'verify:settings', 'verify:web-settings-browser', 'verify:imports']);
}
assert(FULL_SCRIPTS.includes('verify:web-settings-browser'));
assert(!DAILY_SCRIPTS.includes('verify:web-settings-browser'));
assert(!WEB_SCRIPTS.includes('verify:web-settings-browser'), 'admin settings keep their independent browser entry');
for (const script of FULL_SCRIPTS) assert(selectScripts(['public/admin.js']).scripts.includes(script), 'admin host changes retain their full verification policy');

const webPackageScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
const webCommands = expandCommands(WEB_SCRIPTS, webPackageScripts);
assert.equal(webPackageScripts['verify:web-core'], 'node tests/run_verification.mjs web');
assert.equal(webCommands.length, new Set(webCommands).size, 'Web verification must execute shared commands once');
for (const script of ['verify:web-browser-behavior', 'verify:fanhao-requests', 'verify:web-player-browser', 'verify:web-player-plyr', 'verify:photo-reader-browser', 'verify:manga-reader-browser', 'verify:novel-reader-browser', 'verify:music-reader-browser', 'verify:tools-txt-browser', 'verify:tools-gomoku-browser', 'verify:person-profile-browser']) {
  assert(WEB_SCRIPTS.includes(script), `Web verification must retain its ${script} flow`);
}
assert(!webCommands.some(command => /android-client|verify_fanhao_structure|sync:cache|server\.js/.test(command)), 'Web verification must use Web fixtures without Android UI gates, cache writes or a real server');
const webFullCommands = new Set(expandCommands(FULL_SCRIPTS, webPackageScripts));
for (const command of webCommands) assert(webFullCommands.has(command), `the combined suite must retain the Web command: ${command}`);
const webPlan = spawnSync(process.execPath, [fileURLToPath(new URL('./run_verification.mjs', import.meta.url)), 'web', '--plan'], { encoding: 'utf8' });
assert.equal(webPlan.status, 0, webPlan.stderr);
assert.match(webPlan.stdout, /Verification mode: web/);
assert.match(webPlan.stdout, /verify:music-reader-browser/);
assert(!/^> /m.test(webPlan.stdout), '--plan must not execute its selected commands');
assert(!webPlan.stdout.includes('Verification passed:'), '--plan must not claim execution succeeded');

assert.equal(webPackageScripts['verify:web-bootstrap-browser'], 'node tests/verify_web_bootstrap_recovery.mjs');
assert.deepEqual(selectScripts(['tests/verify_web_bootstrap_recovery.mjs']).scripts, ['verify:web-bootstrap-browser', 'verify:imports']);
assert(WEB_SCRIPTS.includes('verify:web-bootstrap-browser'), 'shared entry failures have no parent browser fixture and must run in the Web group');
assert(FULL_SCRIPTS.includes('verify:web-bootstrap-browser'));
assert(!DAILY_SCRIPTS.includes('verify:web-bootstrap-browser'));
const sharedHtml = selectScripts(['public/index.html']);
assert.deepEqual(sharedHtml.scripts, FULL_SCRIPTS, 'shared HTML retains the conservative full verification selection');
assert.deepEqual(sharedHtml.unknownSourceFiles, ['public/index.html']);

assert.equal(webPackageScripts['verify:tools-2048-browser'], 'node tests/verify_tools_2048_lifecycle.mjs');
assert.deepEqual(selectScripts(['tests/verify_tools_2048_lifecycle.mjs']).scripts, ['verify:tools-2048-browser', 'verify:imports']);
for (const file of ['public/games/2048/main.js', 'public/games/2048/worker.js', 'public/games/2048/index.html', 'public/games/2048/ai_core.wasm']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:tools-2048-browser', 'verify:imports']);
}
assert(WEB_SCRIPTS.includes('verify:tools-2048-browser'), 'the tools AI game has an independent browser lifecycle fixture');
assert(FULL_SCRIPTS.includes('verify:tools-2048-browser'));
assert(!DAILY_SCRIPTS.includes('verify:tools-2048-browser'));

assert.equal(webPackageScripts['verify:music-search-dedup-browser'], 'node tests/verify_music_search_deduplication.mjs');
assert.deepEqual(selectScripts(['tests/verify_music_search_deduplication.mjs']).scripts, ['verify:music-search-dedup-browser', 'verify:imports']);
for (const file of ['public/modules/music/actions.js', 'public/modules/music/format.js', 'tests/verify_music_reader_requests.mjs']) {
  assert(selectScripts([file]).scripts.includes('verify:music-search-dedup-browser'));
}
assert(FULL_SCRIPTS.includes('verify:music-search-dedup-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-search-dedup-browser'));
assert(!WEB_SCRIPTS.includes('verify:music-search-dedup-browser'), 'the Web parent includes its browser positives; scale and counterfactuals retain the dedicated entry');
assert.deepEqual(selectScripts(['public/modules/music/format.js']).scripts, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:music-facet-cache', 'verify:music-summary-cache', 'verify:music-progress', 'verify:music-cover-async', 'verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:imports']);

for (const [file, script] of [
  ['android-client/www/modules/novels/android-module.js', 'verify:android-novel-layout'],
  ['android-client/www/modules/novels/novel-views.js', 'verify:android-novel-layout'],
  ['android-client/www/modules/novels/styles.css', 'verify:android-novel-layout'],
  ['tests/verify_android_novel_mobile_layout.mjs', 'verify:android-novel-layout'],
  ['tests/serve_android_gallery_navigation_fixture.mjs', 'verify:android-novel-layout'],
  ['tests/fixtures/android-gallery-navigation-browser.mjs', 'verify:android-novel-layout'],
  ['tests/fixtures/android-gallery-navigation-browser.html', 'verify:android-novel-layout'],
  ['android-client/www/platform/content-index/channel-views.js', 'verify:android-manga-layout'],
  ['android-client/www/modules/photos/styles.css', 'verify:android-manga-layout'],
  ['tests/verify_android_manga_mobile_layout.mjs', 'verify:android-manga-layout'],
  ['tests/serve_android_gallery_navigation_fixture.mjs', 'verify:android-manga-layout'],
  ['android-client/www/modules/media/styles.css', 'verify:android-gallery-layout'],
  ['android-client/www/modules/photos/styles.css', 'verify:android-gallery-layout'],
  ['tests/verify_android_gallery_mobile_layout.mjs', 'verify:android-gallery-layout'],
  ['tests/serve_android_gallery_navigation_fixture.mjs', 'verify:android-gallery-layout'],
  ['tests/fixtures/android-gallery-navigation-browser.mjs', 'verify:android-gallery-layout'],
  ['tests/fixtures/android-gallery-navigation-browser.html', 'verify:android-gallery-layout'],
  ['android-client/www/js/bottom-layout.js', 'verify:android-bottom-layout'],
  ['android-client/www/css/settings-nav.css', 'verify:android-bottom-layout'],
  ['android-client/www/modules/music/home.css', 'verify:android-bottom-layout'],
  ['android-client/www/modules/short-videos/styles/list.css', 'verify:android-bottom-layout'],
  ['tests/verify_android_bottom_layout.mjs', 'verify:android-bottom-layout'],
  ['tests/verify_android_bottom_layout_metrics.mjs', 'verify:android-bottom-layout'],
  ['tests/verify_web_player_time_links.mjs', 'verify:web-player-time-links'],
  ['tests/verify_web_player_file_list.mjs', 'verify:web-player-file-list'],
  ['public/js/player-page.js', 'verify:web-player-file-list'],
  ['public/player.html', 'verify:web-player-file-list'],
  ['public/js/player-page.js', 'verify:web-player-time-links'],
  ['public/js/player-time-link.js', 'verify:web-player-time-links'],
  ['public/js/player-time-jump.js', 'verify:web-player-browser'],
  ['public/js/player-time-jump.js', 'verify:web-player-plyr'],
  ['public/player.html', 'verify:web-player-time-links'],
  ['tests/verify_gallery_page_jump.mjs', 'verify:gallery-page-jump'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-page-jump'],
  ['tests/verify_gallery_reader_width.mjs', 'verify:gallery-reader-width'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-reader-width'],
  ['tests/verify_gallery_visible_loading.mjs', 'verify:gallery-visible-loading'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-visible-loading'],
  ['tests/verify_gallery_image_pan.mjs', 'verify:gallery-image-pan'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-image-pan'],
  ['tests/verify_gallery_fullscreen.mjs', 'verify:gallery-fullscreen-browser'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-fullscreen-browser'],
  ['public/modules/content-index/styles.css', 'verify:gallery-fullscreen-browser'],
  ['tests/verify_gallery_catalog_recovery.mjs', 'verify:gallery-catalog-recovery-browser'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-catalog-recovery-browser'],
  ['public/modules/content-index/styles.css', 'verify:gallery-catalog-recovery-browser'],
  ['tests/verify_gallery_list_return.mjs', 'verify:gallery-list-return'],
  ['public/modules/content-index/gallery-page.js', 'verify:gallery-list-return'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-list-return'],
  ['tests/verify_novel_ranking_recovery.mjs', 'verify:novel-ranking-recovery'],
  ['tests/verify_novel_book_mutation.mjs', 'verify:novel-book-mutation'],
  ['public/modules/novels/novel-page.js', 'verify:novel-book-mutation'],
  ['tests/verify_novel_reader_keyboard.mjs', 'verify:novel-reader-keyboard'],
  ['public/modules/novels/novel-page.js', 'verify:novel-reader-keyboard'],
  ['tests/verify_novel_list_return.mjs', 'verify:novel-list-return-browser'],
  ['public/modules/novels/list-return.js', 'verify:novel-list-return-browser'],
  ['public/modules/novels/novel-page.js', 'verify:novel-list-return-browser'],
  ['tests/verify_novel_reader_fullscreen.mjs', 'verify:novel-reader-fullscreen'],
  ['public/modules/novels/reader-fullscreen.js', 'verify:novel-reader-fullscreen'],
  ['public/modules/novels/novel-page.js', 'verify:novel-reader-fullscreen'],
  ['tests/verify_novel_upload_encoding.mjs', 'verify:novel-upload-encoding'],
  ['public/modules/novels/novel-page.js', 'verify:novel-upload-encoding'],
  ['tests/verify_novel_book_recovery.mjs', 'verify:novel-book-recovery-browser'],
  ['public/modules/novels/novel-page.js', 'verify:novel-book-recovery-browser'],
  ['public/modules/novels/reader-refinements.css', 'verify:novel-book-recovery-browser'],
  ['tests/verify_novel_bookmarks.mjs', 'verify:novel-bookmarks-browser'],
  ['public/modules/novels/bookmarks.js', 'verify:novel-bookmarks-browser'],
  ['public/modules/novels/novel-page.js', 'verify:novel-bookmarks-browser'],
  ['public/modules/novels/reader-refinements.css', 'verify:novel-bookmarks-browser'],
  ['tests/verify_novel_author_browser.mjs', 'verify:novel-author-browser'],
  ['public/modules/novels/author-browser.js', 'verify:novel-author-browser'],
  ['public/modules/novels/novel-page.js', 'verify:novel-author-browser'],
  ['public/modules/novels/styles.css', 'verify:novel-author-browser'],
  ['public/modules/novels/novel-page.js', 'verify:novel-ranking-recovery'],
  ['public/modules/fanhao/features/works/work-page-state.js', 'verify:fanhao-requests'],
  ['public/modules/fanhao/features/works/work-page-state.js', 'verify:fanhao-requests-browser'],
  ['tests/verify_fanhao_collection_paging.mjs', 'verify:fanhao-requests'],
  ['tests/verify_fanhao_person_delete_refresh.mjs', 'verify:fanhao-requests'],
  ['tests/verify_fanhao_favorite_updates.mjs', 'verify:fanhao-favorite-browser'],
  ['public/modules/fanhao/features/works/work-actions.js', 'verify:fanhao-favorite-browser'],
  ['public/modules/fanhao/features/collections/collection-page.js', 'verify:fanhao-favorite-browser'],
  ['tests/verify_fanhao_collection_recovery.mjs', 'verify:fanhao-collection-recovery-browser'],
  ['public/modules/fanhao/features/collections/collection-page.js', 'verify:fanhao-collection-recovery-browser'],
  ['public/modules/fanhao/search-recovery.js', 'verify:fanhao-collection-recovery-browser'],
  ['public/modules/fanhao/styles.css', 'verify:fanhao-collection-recovery-browser'],
  ['tests/verify_fanhao_startup_recovery.mjs', 'verify:fanhao-startup-recovery-browser'],
  ['public/modules/fanhao/code-prefix-page.js', 'verify:fanhao-startup-recovery-browser'],
  ['public/modules/fanhao/search-recovery.js', 'verify:fanhao-startup-recovery-browser'],
  ['public/modules/fanhao/styles.css', 'verify:fanhao-startup-recovery-browser'],
  ['tests/verify_fanhao_sort_controls.mjs', 'verify:fanhao-sort-controls-browser'],
  ['public/modules/fanhao/people-page.js', 'verify:fanhao-sort-controls-browser'],
  ['public/modules/fanhao/features/collections/collection-page.js', 'verify:fanhao-sort-controls-browser'],
  ['public/modules/fanhao/styles.css', 'verify:fanhao-sort-controls-browser'],
  ['public/modules/fanhao/search-recovery.js', 'verify:fanhao-requests-browser'],
  ['tests/verify_novel_reader_position.mjs', 'verify:novel-reader-position'],
  ['public/modules/novels/novel-page.js', 'verify:novel-reader-position'],
  ['public/modules/novels/reader-refinements.css', 'verify:novel-reader-position'],
  ['tests/verify_music_lyric_find.mjs', 'verify:music-lyric-find-browser'],
  ['public/modules/music/music-page.js', 'verify:music-lyric-find-browser'],
  ['public/modules/music/views/lyric-finder.js', 'verify:music-lyric-find-browser'],
  ['tests/verify_gallery_control_construction.mjs', 'verify:gallery-control-construction'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-control-construction'],
  ['tests/verify_music_queue_move_performance.mjs', 'verify:music-queue-move-browser'],
  ['public/modules/music/music-page.js', 'verify:music-queue-move-browser'],
  ['public/modules/music/actions.js', 'verify:music-queue-move-browser'],
  ['tests/verify_music_rating_writes.mjs', 'verify:music-rating-browser'],
  ['tests/verify_music_search_suggestions.mjs', 'verify:music-search-suggestions-browser'],
  ['public/modules/music/music-page.js', 'verify:music-search-suggestions-browser'],
  ['tests/verify_music_playlist_dialog_keyboard.mjs', 'verify:music-playlist-dialog-browser'],
  ['public/modules/music/music-page.js', 'verify:music-playlist-dialog-browser'],
  ['tests/verify_music_volume_controls.mjs', 'verify:music-volume-browser'],
  ['public/modules/music/music-page.js', 'verify:music-volume-browser'],
  ['public/modules/music/styles/player.css', 'verify:music-volume-browser'],
  ['tests/verify_music_browse_navigation.mjs', 'verify:music-browse-navigation-browser'],
  ['public/modules/music/music-page.js', 'verify:music-browse-navigation-browser'],
  ['public/modules/music/actions.js', 'verify:music-browse-navigation-browser'],
  ['tests/verify_music_library_recovery.mjs', 'verify:music-library-recovery-browser'],
  ['public/modules/music/actions.js', 'verify:music-library-recovery-browser'],
  ['public/modules/music/music-page.js', 'verify:music-library-recovery-browser'],
  ['public/modules/music/styles/library.css', 'verify:music-library-recovery-browser'],
  ['tests/verify_music_track_context.mjs', 'verify:music-track-context-browser'],
  ['public/modules/music/music-page.js', 'verify:music-track-context-browser'],
  ['public/modules/music/styles/player.css', 'verify:music-track-context-browser'],
  ['public/modules/music/actions.js', 'verify:music-rating-browser'],
  ['public/modules/music/views/components.js', 'verify:music-rating-browser'],
  ['tests/verify_gallery_search_input.mjs', 'verify:gallery-search-input'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-search-input'],
  ['tests/verify_tools_txt_browser.mjs', 'verify:tools-txt-browser'],
  ['public/modules/tools/tools-page.js', 'verify:tools-txt-browser'],
  ['public/modules/tools/txt-format-tool.js', 'verify:tools-txt-browser'],
  ['public/modules/tools/styles.css', 'verify:tools-txt-browser'],
  ['public/js/standalone-host.js', 'verify:tools-txt-browser'],
  ['tests/verify_music_playback_recovery.mjs', 'verify:music-playback-recovery-browser'],
  ['public/modules/music/player/engine.js', 'verify:music-playback-recovery-browser'],
  ['tests/verify_manga_image_retry.mjs', 'verify:manga-image-retry'],
  ['public/modules/photos/manga-page.js', 'verify:manga-image-retry'],
  ['tests/verify_manga_chapter_navigation.mjs', 'verify:manga-chapter-navigation'],
  ['public/modules/photos/manga-page.js', 'verify:manga-chapter-navigation'],
  ['tests/verify_manga_library_input.mjs', 'verify:manga-library-input-browser'],
  ['public/modules/photos/manga-page.js', 'verify:manga-library-input-browser'],
  ['tests/verify_manga_reader_position.mjs', 'verify:manga-reader-position'],
  ['public/modules/photos/manga-page.js', 'verify:manga-reader-position'],
  ['tests/verify_manga_page_navigation.mjs', 'verify:manga-page-navigation-browser'],
  ['public/modules/photos/manga-page.js', 'verify:manga-page-navigation-browser'],
  ['public/modules/photos/manga.css', 'verify:manga-page-navigation-browser'],
  ['tests/verify_novel_navigation_recovery.mjs', 'verify:novel-navigation-recovery'],
  ['public/modules/novels/novel-page.js', 'verify:novel-navigation-recovery'],
  ['public/modules/novels/reader-refinements.css', 'verify:novel-navigation-recovery'],
  ['tests/verify_novel_reader_panels.mjs', 'verify:novel-reader-panels'],
  ['tests/verify_novel_search_input.mjs', 'verify:novel-search-input'],
  ['tests/verify_music_queue_context.mjs', 'verify:music-queue-context-browser'],
  ['public/modules/music/music-page.js', 'verify:music-queue-context-browser'],
  ['public/modules/music/styles/player.css', 'verify:music-queue-context-browser'],
  ['public/modules/novels/novel-page.js', 'verify:novel-search-input'],
  ['tests/verify_gallery_image_retry.mjs', 'verify:gallery-image-retry'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-image-retry'],
  ['public/modules/content-index/styles.css', 'verify:gallery-image-retry'],
  ['public/modules/novels/novel-page.js', 'verify:novel-reader-panels'],
  ['public/modules/novels/reader-refinements.css', 'verify:novel-reader-panels'],
  ['public/modules/fanhao/search-shortcut.js', 'verify:fanhao-requests-browser'],
  ['tests/verify_person_profile_lifecycle.mjs', 'verify:person-profile-browser'],
  ['public/modules/fanhao/person-profile.js', 'verify:person-profile-browser'],
  ['public/modules/fanhao/lazy-person-profile.js', 'verify:person-profile-browser'],
  ['tests/verify_browser_behavior.mjs', 'verify:web-browser-behavior'],
  ['tests/verify_browser_behavior.mjs', 'verify:browser-behavior'],
  ['tests/verify_gallery_search_focus.mjs', 'verify:gallery-search-focus'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:gallery-search-focus'],
  ['tests/verify_tools_gomoku_lifecycle.mjs', 'verify:tools-gomoku-browser'],
  ['public/games/gomoku/gomoku.js', 'verify:tools-gomoku-browser'],
  ['public/games/gomoku/index.html', 'verify:tools-gomoku-browser'],
  ['public/games/gomoku/styles.css', 'verify:tools-gomoku-browser'],
  ['src/modules/fanhao/server/duplicates/service.js', 'verify:duplicates'],
  ['public/modules/fanhao/duplicates/app.js', 'verify:duplicates'],
  ['tests/verify_duplicate_model.mjs', 'verify:duplicates'],
  ['tests/verify_duplicate_identity.mjs', 'verify:duplicates'],
  ['tools/subtitles_batch.mjs', 'verify:subtitles'],
  ['lib/subtitle-batch-policy.js', 'verify:subtitles'],
  ['tests/verify_subtitle_batch.mjs', 'verify:subtitles'],
  ['tools/clean.py', 'verify:subtitle-cleanup'],
  ['lib/subtitles.js', 'verify:subtitles'],
  ['src/modules/fanhao/server/playback/subtitle-runtime.js', 'verify:subtitles'],
  ['tests/verify_subtitle_service.mjs', 'verify:subtitles'],
  ['tests/verify_subtitlecat_provider.mjs', 'verify:subtitles'],
  ['tests/verify_subtitles_browser.mjs', 'verify:subtitles'],
  ['public/js/player-page.js', 'verify:subtitles'],
  ['public/js/player-page.js', 'verify:web-player-browser'],
  ['public/player.html', 'verify:web-player-browser'],
  ['tests/verify_web_player_lifecycle.mjs', 'verify:web-player-browser'],
  ['tests/verify_web_player_lifecycle.mjs', 'verify:web-player-plyr'],
  ['tests/verify_web_player_plyr.mjs', 'verify:web-player-plyr'],
  ['public/js/player-page.js', 'verify:web-player-plyr'],
  ['public/player.html', 'verify:web-player-plyr'],
  ['tests/verify_photo_pager_keyboard.mjs', 'verify:photo-pager-keyboard'],
  ['tests/verify_manga_image_layout.mjs', 'verify:manga-image-layout'],
  ['tests/verify_novel_catalog.mjs', 'verify:novel-catalog'],
  ['public/modules/novels/novel-page.js', 'verify:novel-catalog'],
  ['public/modules/novels/styles.css', 'verify:novel-catalog'],
  ['public/modules/novels/reader-refinements.css', 'verify:novel-catalog'],
  ['public/modules/photos/manga-page.js', 'verify:manga-image-layout'],
  ['public/modules/content-index/gallery-renderer.js', 'verify:photo-pager-keyboard'],
  ['android-client/scripts/verify-android-security.mjs', 'verify:android-security'],
  ['tests/verify_manga_download_metadata.mjs', 'verify:manga-download'],
  ['tests/verify_short_video_keyboard.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_playback_settings.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_playback_recovery.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_first_frame.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_switch.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_navigation.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_media_cache.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_seek.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_buffered_progress.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_hold_speed.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_gestures.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_wheel.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_auto_next.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_watch_resume.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_watch_queue.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_gallery_handoff.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_gallery_metadata.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_gallery_loading.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_author_handoff.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_playback_attempts.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_sound_preview.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_sound_focus.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_modal_playback.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_panel_loading.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_share_lifecycle.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_author_opening.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_fullscreen.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_picture_in_picture.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_picture_controls.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_seek_rendering.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_gallery_frames.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_progress_loop.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_caption.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_reel_metadata.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_interaction_state.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_tap_intent.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_page_lifecycle.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_adjacent_visibility.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_gallery_sound.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_author_disposal.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_author_lifecycle_async.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_comments_lifecycle.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_comments_loading.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_prewarm_budget.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_startup_preload.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_collection_restore.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_collection_lifecycle.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_list_lifecycle.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_delete_playback.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_transcode_page.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_transcode_lifecycle.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_read_request.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_detail_requests.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_detail_loading.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_retry_intent.mjs', 'verify:short-video-playback'],
  ['tests/verify_short_video_media_representation.mjs', 'verify:short-video-runtime'],
  ['tests/verify_short_video_startup_cache.mjs', 'verify:short-video-runtime'],
  ['tests/verify_short_video_transcode_source.mjs', 'verify:short-video-runtime'],
  ['tests/verify_native_short_video_first_frame.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_recovery.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_manual_retry.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_player_callbacks.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_continuation.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_playback_requests.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_readiness.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_recovery.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_image_recovery.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_sound.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_interruption_advance.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_rebind.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gallery_segment_rebind.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_seek_rendering.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_checkpoint.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_session.mjs', 'verify:short-video-client'],
  ['tests/verify_short_video_restored_actions.mjs', 'verify:short-video-client'],
  ['tests/fixtures/NativeShortVideoCheckpointHarness.java', 'verify:short-video-client'],
  ['tests/fixtures/NativeShortVideoSessionHarness.java', 'verify:short-video-client'],
  ['tests/fixtures/NativeShortVideoPlaybackHarness.java', 'verify:short-video-client'],
  ['tests/verify_native_short_video_screen_awake.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_gestures.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_overlay_playback.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_cover_ownership.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_frame_loading.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_bitmap_decode.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_author_requests.mjs', 'verify:short-video-client'],
  ['tests/verify_android_short_video_list_lifecycle.mjs', 'verify:short-video-client'],
  ['tests/verify_android_short_video_back.mjs', 'verify:short-video-client'],
  ['tests/verify_android_short_video_suggestions.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_audio.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_audio_focus.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_prefetch.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_cache_startup.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_interaction.mjs', 'verify:short-video-client'],
  ['tests/verify_native_short_video_request_lifecycle.mjs', 'verify:short-video-client'],
  ['tests/verify_file_server_conditional.mjs', 'verify:file-streams'],
  ['tests/verify_manga_image_dimensions.mjs', 'verify:manga-image-dimensions'],
  ['tests/verify_music_metadata_smart_counts.mjs', 'verify:music-smart-counts'],
  ['tests/verify_person_identity_statement_reuse.mjs', 'verify:person-identity-statements'],
  ['tests/verify_novel_empty_pages.mjs', 'verify:novel-empty-pages'],
  ['tests/verify_media_detail_projection.mjs', 'verify:media-detail-projection'],
  ['tests/verify_work_info_detail_cache.mjs', 'verify:work-info-cache'],
  ['tests/verify_work_info_summary_projection.mjs', 'verify:work-info-cache'],
  ['tests/verify_work_info_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tests/verify_work_info_derived_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tests/verify_work_info_catalog_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tests/verify_work_info_prefix_cache_recovery.mjs', 'verify:work-info-recovery'],
  ['tests/fixtures/work-info-cache-recovery.mjs', 'verify:work-info-recovery'],
  ['tests/verify_work_search_cache_recovery.mjs', 'verify:work-search-cache'],
  ['tests/fixtures/work-search-cache-recovery.mjs', 'verify:work-search-cache'],
  ['tests/fixtures/work-search-cache-legacy.txt', 'verify:work-search-cache'],
  ['tests/fixtures/missing-code-search-cache-legacy.txt', 'verify:work-search-cache'],
  ['tests/verify_android_mobile_action_sheet.mjs', 'verify:android-mobile-sheets'],
  ['tests/verify_android_settings_focus.mjs', 'verify:android-mobile-sheets'],
  ['tests/verify_android_music_back.mjs', 'verify:android-music'],
  ['tests/verify_android_fanhao_player_requests.mjs', 'verify:android-fanhao-player'],
  ['tests/verify_android_fanhao_player_lifecycle.mjs', 'verify:android-fanhao-player'],
  ['tests/verify_android_novel_style_reuse.mjs', 'verify:android-novel-styles'],
  ['tests/verify_android_novel_mobile_ui.mjs', 'verify:android-novel-ui'],
  ['tests/verify_android_novel_source_identity.mjs', 'verify:android-novels'],
  ['tests/verify_android_novel_paging_alignment.mjs', 'verify:android-novel-paging'],
  ['tests/verify_music_artist_projection.mjs', 'verify:music-artist-projection'],
  ['tests/verify_music_track_projection.mjs', 'verify:music-track-projection'],
  ['tests/fixtures/music-track-projection-store-legacy.txt', 'verify:music-track-projection'],
  ['tests/fixtures/music-track-projection-lyrics-legacy.txt', 'verify:music-track-projection'],
  ['tests/verify_music_report_projection.mjs', 'verify:music-report-projection'],
  ['tests/verify_video_probe_cache_recovery.mjs', 'verify:video-probe-cache-recovery'],
  ['tests/verify_work_search_index_retention.mjs', 'verify:work-search-retention'],
  ['tests/fixtures/work-search-index-retention-legacy.txt', 'verify:work-search-retention'],
  ['tests/verify_work_search_postings.mjs', 'verify:work-search-postings'],
  ['tests/fixtures/work-search-postings-legacy.txt', 'verify:work-search-postings'],
  ['tests/verify_code_prefix_cache_recovery.mjs', 'verify:code-prefix-cache-recovery'],
  ['tests/verify_person_page_cache_keys.mjs', 'verify:person-page-cache'],
  ['tests/verify_person_page_cache_budget.mjs', 'verify:person-page-cache'],
  ['tests/verify_work_page_cache_keys.mjs', 'verify:work-page-cache'],
  ['tests/verify_ranking_cache_recovery.mjs', 'verify:ranking-cache'],
  ['tests/verify_actor_movie_cache_recovery.mjs', 'verify:actor-movie-cache'],
  ['tests/verify_actor_movie_info_cache_recovery.mjs', 'verify:actor-movie-info-cache'],
  ['tests/verify_access_analytics_close.mjs', 'verify:access-analytics-close'],
  ['tests/verify_work_detail_cache.mjs', 'verify:work-detail-cache'],
  ['tests/verify_manga_file_streams.mjs', 'verify:manga-streams'],
  ['tests/verify_stored_zip_stream_lifecycle.mjs', 'verify:manga-streams'],
  ['src/modules/photos/server/stored-zip-stream.js', 'verify:manga-streams'],
  ['tests/verify_android_update_streams.mjs', 'verify:android-update-streams'],
  ['tests/verify_novel_collection_refresh.mjs', 'verify:novel-collection-refresh'],
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
assert(sharedPublicShell.scripts.includes('verify:fanhao-startup-recovery-browser'));
assert(sharedPublicShell.scripts.includes('verify:fanhao-sort-controls-browser'));
assert.deepEqual(sharedPublicShell.unknownSourceFiles, ['public/app.js']);

const downloader = selectScripts(['src/modules/short-videos/download-manager/manager_core/read_models.py']);
assert(selectScripts(['src/modules/short-videos/download-manager/manager_core/library_sync.py']).scripts.includes('verify:short-video-sync'));
assert(selectScripts(['src/modules/short-videos/server/store.js']).scripts.includes('verify:short-video-sync'));
assert(selectScripts(['tests/verify_short_video_incremental_sync.mjs']).scripts.includes('verify:short-video-sync'));
assert.deepEqual(downloader.scripts, ['verify:douyin-manager', 'verify:imports'], "independent downloader changes must not run unrelated short-video/Android suites");
assert.deepEqual(selectScripts(['tests/verify_douyin_manager_latest_requests.mjs']).scripts, downloader.scripts);
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
assert.deepEqual(selectScripts(['tests/verify_fanhao_favorite_updates.mjs']).scripts, ['verify:fanhao-favorite-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_fanhao_local_marker_updates.mjs']).scripts, ['verify:fanhao-requests', 'verify:fanhao-favorite-browser', 'verify:imports']);
assert(webCommands.includes('node tests/verify_fanhao_local_marker_updates.mjs --metadata-only'), 'Web request checks must retain marker path and pending-read contracts');
assert.deepEqual(selectScripts(['public/modules/fanhao/features/works/work-actions.js']).scripts, ['verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs', 'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:fanhao-favorite-browser', 'verify:fanhao-collection-recovery-browser', 'verify:fanhao-sort-controls-browser', 'verify:imports']);
assert(selectScripts(['src/modules/novels/server/store.js']).scripts.includes('verify:novel-summary-cache'));
assert(selectScripts(['src/modules/music/server/runtime.js']).scripts.includes('verify:music-cover-async'));
assert.deepEqual(selectScripts(['tests/verify_work_facets.mjs']).scripts, ['verify:work-facets', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_work_cache_budget.mjs']).scripts, ['verify:work-cache-budget', 'verify:work-facets', 'verify:code-prefixes', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_code_prefix_cache_budget.mjs']).scripts, ['verify:code-prefixes', 'verify:work-cache-budget', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/diagnose_work_cache_heap.mjs']).scripts, ['verify:work-cache-budget', 'verify:work-facets', 'verify:code-prefixes', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_file_stream_lifecycle.mjs']).scripts, ['verify:file-streams', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_work_cover_async.mjs']).scripts, ['verify:work-cover-async', 'verify:imports']);
assert.deepEqual(selectScripts(['lib/cover-frame.js']).scripts, ['verify:work-cover-async', 'verify:gallery-cover-async', 'verify:image-library', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_gallery_cover_async.mjs']).scripts, ['verify:gallery-cover-async', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_image_query_correctness.mjs']).scripts, ['verify:image-query', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/diagnose_image_query_cpu.mjs']).scripts, ['verify:image-query', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_image_query_cache.mjs']).scripts, ['verify:image-query-cache', 'verify:image-query', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_video_probe_cache.mjs']).scripts, ['verify:video-probe-cache', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_video_probe_lifecycle.mjs']).scripts, ['verify:video-probe-cache', 'verify:imports']);
assert(selectScripts(['src/platform/server/video-probe-task-pool.js']).scripts.includes('verify:video-probe-cache'));
assert(selectScripts(['src/platform/server/local-image-read-queue.js']).scripts.includes('verify:music-cover-async'));
for (const script of ['verify:video-probe-cache', 'verify:music-cover-async', 'verify:gallery-cover-async']) {
  assert(selectScripts(['server.js']).scripts.includes(script), 'server lifecycle assembly must select resource ownership checks');
}
for (const script of ['verify:media-images', 'verify:media-streams', 'verify:archive-images']) {
  assert(selectScripts(['server.js']).scripts.includes(script), 'server lifecycle assembly must select media resource checks');
}
assert.deepEqual(selectScripts(['tests/verify_media_blob_worker.mjs']).scripts, ['verify:media-images', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_remote_image_lifecycle.mjs']).scripts, ['verify:media-images', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_media_stream_lifecycle.mjs']).scripts, ['verify:media-streams', 'verify:imports']);
assert(selectScripts(['src/platform/server/remote-image-warm-queue.js']).scripts.includes('verify:media-images'));
assert(selectScripts(['public/modules/content-index/gallery-page.js']).scripts.includes('verify:photo-reader-browser'));
assert(selectScripts(['public/modules/content-index/gallery-renderer.js']).scripts.includes('verify:photo-reader-browser'));
for (const file of ['public/modules/content-index/gallery-page.js', 'public/modules/content-index/gallery-renderer.js']) {
  assert(selectScripts([file]).scripts.includes('verify:gallery-rendering'));
  assert(selectScripts([file]).scripts.includes('verify:browser-behavior'));
}
assert.deepEqual(selectScripts(['tests/verify_gallery_list_rendering.mjs']).scripts, ['verify:gallery-rendering', 'verify:gallery-control-construction', 'verify:gallery-search-input', 'verify:gallery-list-return', 'verify:photo-reader-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_gallery_list_return.mjs']).scripts, ['verify:gallery-list-return', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_rating_writes.mjs']).scripts, ['verify:music-rating-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_search_suggestions.mjs']).scripts, ['verify:music-search-suggestions-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_list_return.mjs']).scripts, ['verify:novel-list-return-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_fanhao_collection_recovery.mjs']).scripts, ['verify:fanhao-collection-recovery-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_fanhao_startup_recovery.mjs']).scripts, ['verify:fanhao-startup-recovery-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_alphabet_browsing.mjs']).scripts, ['verify:music-alphabet-browser', 'verify:imports']);
for (const file of ["public/modules/music/music-page.js","public/modules/music/views/components.js","public/modules/music/styles/library.css","public/modules/music/styles/responsive.css","tests/verify_music_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:music-alphabet-browser'));
assert(FULL_SCRIPTS.includes('verify:music-alphabet-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-alphabet-browser'));
assert.deepEqual(selectScripts(['tests/verify_music_load_more_keyboard.mjs']).scripts, ['verify:music-load-more-keyboard-browser', 'verify:imports']);
for (const file of ["public/modules/music/music-page.js", "public/modules/music/views/components.js", "public/modules/music/styles/library.css", "public/modules/music/styles/responsive.css", "tests/verify_music_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:music-load-more-keyboard-browser'));
assert(FULL_SCRIPTS.includes('verify:music-load-more-keyboard-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-load-more-keyboard-browser'));
assert.deepEqual(selectScripts(['tests/verify_music_queue_search.mjs']).scripts, ['verify:music-queue-search-browser', 'verify:imports']);
for (const file of ['public/modules/music/music-page.js', 'public/modules/music/views/components.js', 'public/modules/music/actions.js', 'public/modules/music/styles/player.css', 'public/modules/music/styles/responsive.css', 'tests/verify_music_reader_requests.mjs']) {
  assert(selectScripts([file]).scripts.includes('verify:music-queue-search-browser'));
}
assert.equal(webPackageScripts['verify:music-queue-search-browser'], 'node tests/verify_music_queue_search.mjs');
assert(FULL_SCRIPTS.includes('verify:music-queue-search-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-queue-search-browser'));
assert(!WEB_SCRIPTS.includes('verify:music-queue-search-browser'), 'the full music browser entry already contains queue search positives');
assert.deepEqual(selectScripts(['tests/verify_manga_add_draft.mjs']).scripts, ['verify:manga-add-draft-browser', 'verify:imports']);
for (const file of ["public/modules/photos/manga-page.js","tests/verify_manga_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:manga-add-draft-browser'));
assert(FULL_SCRIPTS.includes('verify:manga-add-draft-browser'));
assert(!DAILY_SCRIPTS.includes('verify:manga-add-draft-browser'));
assert.deepEqual(selectScripts(['tests/verify_manga_directory_return.mjs']).scripts, ['verify:manga-directory-return-browser', 'verify:imports']);
for (const file of ["public/modules/photos/manga-page.js", "public/modules/photos/manga.css", "tests/verify_manga_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:manga-directory-return-browser'));
assert(FULL_SCRIPTS.includes('verify:manga-directory-return-browser'));
assert(!DAILY_SCRIPTS.includes('verify:manga-directory-return-browser'));
assert.deepEqual(selectScripts(['tests/verify_manga_directory_search.mjs']).scripts, ['verify:manga-directory-search-browser', 'verify:imports']);
for (const file of ["public/modules/photos/manga-page.js", "public/modules/photos/manga.css", "tests/verify_manga_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:manga-directory-search-browser'));
assert(FULL_SCRIPTS.includes('verify:manga-directory-search-browser'));
assert(!DAILY_SCRIPTS.includes('verify:manga-directory-search-browser'));
assert.deepEqual(selectScripts(['tests/verify_manga_library_cards.mjs']).scripts, ['verify:manga-library-cards-browser', 'verify:imports']);
for (const file of ['public/modules/photos/manga-page.js', 'public/modules/photos/manga.css', 'tests/verify_manga_reader_requests.mjs']) {
  assert(selectScripts([file]).scripts.includes('verify:manga-library-cards-browser'));
}
assert.equal(webPackageScripts['verify:manga-library-cards-browser'], 'node tests/verify_manga_library_cards.mjs');
assert(FULL_SCRIPTS.includes('verify:manga-library-cards-browser'));
assert(!DAILY_SCRIPTS.includes('verify:manga-library-cards-browser'));
assert(!WEB_SCRIPTS.includes('verify:manga-library-cards-browser'), 'the parent manga browser entry includes card retention positives');
assert.deepEqual(selectScripts(['tests/verify_manga_library_covers.mjs']).scripts, ['verify:manga-library-covers-browser', 'verify:imports']);
for (const file of ['public/modules/photos/manga-page.js', 'public/modules/photos/manga.css', 'tests/verify_manga_reader_requests.mjs']) {
  assert(selectScripts([file]).scripts.includes('verify:manga-library-covers-browser'));
}
assert.equal(webPackageScripts['verify:manga-library-covers-browser'], 'node tests/verify_manga_library_covers.mjs');
assert(FULL_SCRIPTS.includes('verify:manga-library-covers-browser'));
assert(!DAILY_SCRIPTS.includes('verify:manga-library-covers-browser'));
assert(!WEB_SCRIPTS.includes('verify:manga-library-covers-browser'), 'the parent manga browser entry includes cover loading positives');
assert.equal(webPackageScripts['verify:manga-fit-position-browser'], 'node tests/verify_manga_fit_position.mjs');
assert.deepEqual(selectScripts(['tests/verify_manga_fit_position.mjs']).scripts, ['verify:manga-fit-position-browser', 'verify:imports']);
for (const file of ['public/modules/photos/manga-page.js', 'public/modules/photos/manga.css', 'tests/verify_manga_reader_requests.mjs']) {
  assert(selectScripts([file]).scripts.includes('verify:manga-fit-position-browser'));
}
assert(FULL_SCRIPTS.includes('verify:manga-fit-position-browser'));
assert(!DAILY_SCRIPTS.includes('verify:manga-fit-position-browser'));
assert(!WEB_SCRIPTS.includes('verify:manga-fit-position-browser'), 'the parent manga browser entry includes width-position positives');
assert.deepEqual(selectScripts(['tests/verify_fanhao_people_index_snapshot.mjs']).scripts, ['verify:fanhao-people-index-browser', 'verify:imports']);
for (const file of ["public/modules/fanhao/people-page.js"]) assert(selectScripts([file]).scripts.includes('verify:fanhao-people-index-browser'));
assert(FULL_SCRIPTS.includes('verify:fanhao-people-index-browser'));
assert(!DAILY_SCRIPTS.includes('verify:fanhao-people-index-browser'));
assert.deepEqual(selectScripts(['tests/verify_music_compact_rows.mjs']).scripts, ['verify:music-compact-rows-browser', 'verify:imports']);
for (const file of ["public/modules/music/styles/responsive.css","tests/verify_music_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:music-compact-rows-browser'));
assert(FULL_SCRIPTS.includes('verify:music-compact-rows-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-compact-rows-browser'));
assert.deepEqual(selectScripts(['tests/verify_gallery_range_metadata.mjs']).scripts, ['verify:gallery-range-metadata-browser', 'verify:imports']);
for (const file of ["public/modules/content-index/gallery-renderer.js","tests/verify_web_gallery_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:gallery-range-metadata-browser'));
assert(FULL_SCRIPTS.includes('verify:gallery-range-metadata-browser'));
assert(!DAILY_SCRIPTS.includes('verify:gallery-range-metadata-browser'));
assert.deepEqual(selectScripts(['tests/verify_novel_import_navigation.mjs']).scripts, ['verify:novel-import-navigation-browser', 'verify:imports']);
for (const file of ["public/modules/novels/novel-page.js","tests/verify_novel_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:novel-import-navigation-browser'));
assert(FULL_SCRIPTS.includes('verify:novel-import-navigation-browser'));
assert(!DAILY_SCRIPTS.includes('verify:novel-import-navigation-browser'));
assert.deepEqual(selectScripts(['public/modules/music/styles/responsive.css']).scripts, ["verify:music-rescan-worker","verify:music-scale","verify:music-facet-cache","verify:music-summary-cache","verify:music-progress","verify:music-cover-async","verify:music-reader-browser","verify:music-queue-search-browser","verify:music-compact-rows-browser","verify:music-alphabet-browser","verify:music-load-more-keyboard-browser","verify:imports"]);
assert.deepEqual(selectScripts(['tests/verify_web_player_adjacent_files.mjs']).scripts, ['verify:web-player-adjacent-files', 'verify:imports']);
for (const file of ["public/js/player-page.js","public/player.html","tests/verify_web_player_lifecycle.mjs"]) assert(selectScripts([file]).scripts.includes('verify:web-player-adjacent-files'));
assert(FULL_SCRIPTS.includes('verify:web-player-adjacent-files'));
assert(!DAILY_SCRIPTS.includes('verify:web-player-adjacent-files'));
assert.deepEqual(selectScripts(['tests/verify_gallery_zoom_anchor.mjs']).scripts, ['verify:gallery-zoom-anchor-browser', 'verify:imports']);
for (const file of ["public/modules/content-index/gallery-renderer.js","tests/verify_web_gallery_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:gallery-zoom-anchor-browser'));
assert(FULL_SCRIPTS.includes('verify:gallery-zoom-anchor-browser'));
assert(!DAILY_SCRIPTS.includes('verify:gallery-zoom-anchor-browser'));
assert.deepEqual(selectScripts(['tests/verify_music_drawer_navigation.mjs']).scripts, ['verify:music-drawer-navigation-browser', 'verify:imports']);
for (const file of ["public/modules/music/music-page.js","tests/verify_music_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:music-drawer-navigation-browser'));
assert(FULL_SCRIPTS.includes('verify:music-drawer-navigation-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-drawer-navigation-browser'));
assert.deepEqual(selectScripts(['tests/verify_novel_adjacent_navigation.mjs']).scripts, ['verify:novel-adjacent-navigation-browser', 'verify:imports']);
for (const file of ["public/modules/novels/novel-page.js","tests/verify_novel_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:novel-adjacent-navigation-browser'));
assert(FULL_SCRIPTS.includes('verify:novel-adjacent-navigation-browser'));
assert(!DAILY_SCRIPTS.includes('verify:novel-adjacent-navigation-browser'));
assert.deepEqual(selectScripts(['tests/verify_fanhao_prefix_search.mjs']).scripts, ['verify:fanhao-prefix-search-browser', 'verify:imports']);
for (const file of ["public/modules/fanhao/code-prefix-page.js","public/modules/fanhao/styles.css"]) assert(selectScripts([file]).scripts.includes('verify:fanhao-prefix-search-browser'));
assert(FULL_SCRIPTS.includes('verify:fanhao-prefix-search-browser'));
assert(!DAILY_SCRIPTS.includes('verify:fanhao-prefix-search-browser'));
assert.deepEqual(selectScripts(['tests/verify_gallery_keyboard_pan.mjs']).scripts, ['verify:gallery-keyboard-pan-browser', 'verify:imports']);
for (const file of ["public/modules/content-index/gallery-renderer.js","tests/verify_web_gallery_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:gallery-keyboard-pan-browser'));
assert(FULL_SCRIPTS.includes('verify:gallery-keyboard-pan-browser'));
assert(!DAILY_SCRIPTS.includes('verify:gallery-keyboard-pan-browser'));
assert.deepEqual(selectScripts(['tests/verify_music_sort_keyboard.mjs']).scripts, ['verify:music-sort-keyboard-browser', 'verify:imports']);
for (const file of ["public/modules/music/music-page.js","tests/verify_music_reader_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:music-sort-keyboard-browser'));
assert(FULL_SCRIPTS.includes('verify:music-sort-keyboard-browser'));
assert(!DAILY_SCRIPTS.includes('verify:music-sort-keyboard-browser'));
assert.deepEqual(selectScripts(['tests/verify_novel_lan_http.mjs']).scripts, ['verify:novel-lan-http-browser', 'verify:imports']);
for (const file of ["public/modules/novels/novel-page.js","tests/verify_novel_reader_requests.mjs","tests/verify_novel_progress_requests.mjs"]) assert(selectScripts([file]).scripts.includes('verify:novel-lan-http-browser'));
assert(FULL_SCRIPTS.includes('verify:novel-lan-http-browser'));
assert(!DAILY_SCRIPTS.includes('verify:novel-lan-http-browser'));
assert.deepEqual(selectScripts(['tests/verify_fanhao_sort_controls.mjs']).scripts, ['verify:fanhao-sort-controls-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_gallery_fullscreen.mjs']).scripts, ['verify:gallery-fullscreen-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_web_player_file_list.mjs']).scripts, ['verify:web-player-file-list', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_gallery_catalog_recovery.mjs']).scripts, ['verify:gallery-catalog-recovery-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_gallery_summary_recovery.mjs']).scripts, ['verify:gallery-summary-recovery-browser', 'verify:imports']);
for (const file of ['public/modules/content-index/gallery-page.js', 'public/modules/content-index/gallery-renderer.js', 'public/modules/content-index/styles.css', 'public/modules/content-index/catalog.css', 'tests/verify_web_gallery_requests.mjs', 'tests/diagnose_web_gallery_navigation.mjs']) {
  assert(selectScripts([file]).scripts.includes('verify:gallery-summary-recovery-browser'));
}
assert.equal(webPackageScripts['verify:gallery-summary-recovery-browser'], 'node tests/verify_gallery_summary_recovery.mjs');
assert(FULL_SCRIPTS.includes('verify:gallery-summary-recovery-browser'));
assert(!DAILY_SCRIPTS.includes('verify:gallery-summary-recovery-browser'));
assert(!WEB_SCRIPTS.includes('verify:gallery-summary-recovery-browser'), 'the full gallery parent includes summary recovery positives');
assert.deepEqual(selectScripts(['tests/verify_music_playlist_dialog_keyboard.mjs']).scripts, ['verify:music-playlist-dialog-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_manga_library_input.mjs']).scripts, ['verify:manga-library-input-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_manga_reader_position.mjs']).scripts, ['verify:manga-reader-position', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_manga_page_navigation.mjs']).scripts, ['verify:manga-page-navigation-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_reader_fullscreen.mjs']).scripts, ['verify:novel-reader-fullscreen', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_upload_encoding.mjs']).scripts, ['verify:novel-upload-encoding', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_book_recovery.mjs']).scripts, ['verify:novel-book-recovery-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_bookmarks.mjs']).scripts, ['verify:novel-bookmarks-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_author_browser.mjs']).scripts, ['verify:novel-author-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_volume_controls.mjs']).scripts, ['verify:music-volume-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_browse_navigation.mjs']).scripts, ['verify:music-browse-navigation-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_library_recovery.mjs']).scripts, ['verify:music-library-recovery-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_track_context.mjs']).scripts, ['verify:music-track-context-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/novels/list-return.js']).scripts, ['verify:novels', 'verify:novel-summary-cache', 'verify:novel-list-return-browser', 'verify:novel-reader-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_channel_rendering.mjs']).scripts, ['verify:android-channel-rendering', 'verify:photo-search', 'verify:imports']);
for (const name of ['image_cache', 'cache_stats']) {
  assert.deepEqual(selectScripts([`tests/verify_android_${name}.mjs`]).scripts, ['verify:android-cache', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/fixtures/image-library-channel-server.mjs']).scripts, ['verify:image-query', 'verify:image-query-cache', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/fixtures/android-gallery-navigation-harness.mjs']).scripts, ['verify:android-media', 'verify:photo-search', 'verify:imports']);
const channelScripts = selectScripts(['android-client/www/platform/content-index/channel-views.js']).scripts;
for (const script of ['verify:android-media', 'verify:android-photos', 'verify:android-channel-rendering', 'verify:photo-search', 'verify:browser-behavior']) assert(channelScripts.includes(script));
for (const file of ['src/modules/content-index/server/image-library-service.js', 'src/modules/content-index/server/image-library-index-service.js', 'src/modules/content-index/server/image-query-cache.js', 'src/modules/content-index/server/image-gallery-db-service.js', 'lib/gallery-metadata-revision.js', 'src/modules/media/server/gallery-metadata-service.js', 'server.js']) {
  for (const script of ['verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering']) assert(selectScripts([file]).scripts.includes(script));
}
for (const file of ['public/modules/content-index/catalog.css', 'public/modules/content-index/styles.css']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:gallery-rendering', 'verify:gallery-control-construction', 'verify:gallery-search-input', 'verify:photo-reader', 'verify:photo-reader-browser', 'verify:gallery-image-retry', 'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:gallery-image-pan', 'verify:gallery-fullscreen-browser', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:gallery-list-return', 'verify:photo-search', 'verify:browser-behavior', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_short_video_quality_queries.mjs']).scripts, ['verify:short-video-quality', 'verify:short-video-store', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_short_video_store.mjs']).scripts, ['verify:short-video-store', 'verify:imports']);
for (const file of ['sources', 'lifecycle']) {
  assert.deepEqual(selectScripts([`tests/verify_short_video_image_${file}.mjs`]).scripts, ['verify:short-video-images', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_short_video_product_lifecycle.mjs']).scripts, ['verify:short-video-images', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']);
for (const file of ['actor_avatar_import', 'actor_profile_atomicity', 'actor_profile_reservation_guards', 'core_image_store']) {
  assert.deepEqual(selectScripts([`tests/verify_${file}.mjs`]).scripts, ['verify:actor-avatar-import', 'verify:core-images', 'verify:imports']);
}
for (const file of ['src/modules/fanhao/server/people/actor-avatar-service.js', 'src/modules/fanhao/server/admin/admin-actor-avatar-service.js', 'src/modules/system/server/admin/routes.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:actor-avatar-import', 'verify:core-images', 'verify:fanhao', 'verify:settings', 'verify:auth', 'verify:mutation-auth', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_static_file_lifecycle.mjs']).scripts, ['verify:static-files', 'verify:auth', 'verify:mutation-auth', 'verify:imports']);
for (const file of ['src/platform/server/static-files.js', 'src/platform/server/http-app.js', 'src/apps/short-video-server.js', 'tests/verify_file_workflows_ui.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:static-files', 'verify:shutdown', 'verify:products', 'verify:auth', 'verify:accounts', 'verify:mutation-auth', 'verify:startup', 'verify:file-workflows-ui', 'verify:imports']);
}
for (const file of ['tests/verify_module_lifecycle.mjs', 'tests/verify_server_shutdown_lifecycle.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:shutdown', 'verify:imports']);
}
for (const file of ['src/fanhao/module-registry.js', 'src/platform/server/server-host.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:modules', 'verify:shutdown', 'verify:products', 'verify:startup', 'verify:imports']);
}
for (const script of ['verify:shutdown', 'verify:static-files', 'verify:android-update-streams', 'verify:manga-streams']) assert(selectScripts(['server.js']).scripts.includes(script));
const actualScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
for (const file of ['file_stream_lifecycle', 'file_server_async', 'file_server_conditional']) {
  assert.deepEqual(selectScripts([`tests/verify_${file}.mjs`]).scripts, ['verify:file-streams', 'verify:imports']);
}
const sharedFileScripts = selectScripts(['src/platform/server/file-server.js']).scripts;
for (const script of ['verify:archive-images', 'verify:short-video-actions', 'verify:products', 'verify:android-update-streams', 'verify:manga-streams']) {
  assert(sharedFileScripts.includes(script), `shared file server changes must cover ${script}`);
}
const fullCommands = expandCommands(FULL_SCRIPTS, actualScripts);
assert(FULL_SCRIPTS.includes('verify:android-novel-layout'));
assert(ANDROID_SCRIPTS.includes('verify:android-novel-layout'));
for (const entries of [FULL_SCRIPTS, ANDROID_SCRIPTS, ['verify:android-client'], ['verify:android-novels'], ['verify:android-novel-layout'],
  selectScripts(['android-client/www/modules/novels/styles.css']).scripts,
  selectScripts(['tests/verify_android_novel_mobile_layout.mjs']).scripts]) {
  assert.equal(expandCommands(entries, actualScripts).filter(command => command === 'node tests/verify_android_novel_mobile_layout.mjs').length, 1,
    'novel full-shell layout must run exactly once in aggregate and focused verification plans');
}
assert.equal(fullCommands.filter(command => command === 'node tests/verify_android_manga_mobile_layout.mjs').length, 1, 'manga full-shell readability and touch checks must run once in full verification');
assert.equal(fullCommands.filter(command => command === 'node tests/verify_android_manga_mobile_layout.mjs --recovery-only').length, 1, 'manga recovery must run once in a separate bounded fixture process');
assert.equal(fullCommands.filter(command => command === 'node tests/verify_android_gallery_mobile_layout.mjs').length, 1, 'gallery full-shell layout must run once in full verification');
for (const file of ['verify_android_bottom_layout', 'verify_android_bottom_layout_metrics']) {
  assert.equal(fullCommands.filter(command => command === `node tests/${file}.mjs`).length, 1, 'bottom navigation layout behavior must run once in full verification');
}
for (const file of ['verify_gallery_search_input', 'verify_music_playback_recovery', 'verify_tools_txt_browser', 'verify_gallery_control_construction', 'verify_music_queue_move_performance', 'verify_web_player_time_links', 'verify_gallery_page_jump', 'verify_novel_reader_position', 'verify_music_lyric_find']) {
  assert.equal(fullCommands.filter(command => command === `node tests/${file}.mjs`).length, 1, 'new Web input and recovery checks must run once in full verification');
}
assert.equal(fullCommands.filter(command => command === 'node tests/verify_browser_behavior.mjs --web-only').length, 1);
for (const file of ['verify_gallery_search_focus', 'verify_tools_gomoku_lifecycle', 'verify_novel_reader_panels']) {
  assert.equal(fullCommands.filter(command => command === `node tests/${file}.mjs`).length, 1);
}
const jsonResponseCommand = 'node tests/verify_json_responses.mjs';
for (const scripts of [DAILY_SCRIPTS, FULL_SCRIPTS]) {
  assert.equal(expandCommands(scripts, actualScripts).filter(command => command === jsonResponseCommand).length, 1, 'JSON response behavior must run once in daily and full verification');
}
const responsePlan = selectScripts(['src/platform/server/responses.js']);
for (const script of ['verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:imports']) assert(responsePlan.scripts.includes(script), 'response changes must retain existing verification');
for (const files of [['src/platform/server/responses.js'], ['tests/verify_json_responses.mjs'], ['src/platform/server/responses.js', 'tests/verify_json_responses.mjs']]) {
  const plan = selectScripts(files);
  assert.deepEqual(plan.unknownSourceFiles, []);
  assert.equal(expandCommands(plan.scripts, actualScripts).filter(command => command === jsonResponseCommand).length, 1, 'response and fixture changes must select JSON behavior once');
}
const musicM3uCommand = 'node tests/verify_music_m3u.mjs';
assert.equal(fullCommands.filter(command => command === musicM3uCommand).length, 1, 'full verification must cover M3U import identity once');
for (const file of ['src/modules/music/server/m3u.js', 'tests/verify_music_m3u.mjs']) {
  const plan = selectScripts([file]);
  assert.deepEqual(plan.scripts, ['verify:music-m3u', 'verify:imports']);
  assert.deepEqual(plan.unknownSourceFiles, []);
  assert.equal(expandCommands(plan.scripts, actualScripts).filter(command => command === musicM3uCommand).length, 1);
}
const playlistOrderCommand = 'node tests/verify_music_playlist_order.mjs';
assert.equal(fullCommands.filter(command => command === playlistOrderCommand).length, 1, 'full verification must cover playlist ordering once');
assert.deepEqual(selectScripts(['tests/verify_music_playlist_order.mjs']).scripts, ['verify:music-playlist-order', 'verify:imports']);
assert.equal(expandCommands(selectScripts(['src/modules/music/server/store.js']).scripts, actualScripts).filter(command => command === playlistOrderCommand).length, 1, 'music store changes must cover playlist ordering');
const fileWorkflowCommand = 'node tests/verify_file_workflows.mjs';
assert.equal(fullCommands.filter(command => command === fileWorkflowCommand).length, 1, 'file workflows must run once in full verification');
const fileWorkflowUiCommand = 'node tests/verify_file_workflows_ui.mjs';
assert.equal(fullCommands.filter(command => command === fileWorkflowUiCommand).length, 1, 'full verification must exercise the workflow confirmation UI');
const fileWorkflowUiFiles = ['app.js', 'index.html', 'styles.css'].map(name => `public/modules/fanhao/file-workflows/${name}`);
for (const file of fileWorkflowUiFiles) {
  const plan = selectScripts([file]);
  assert.deepEqual(plan.unknownSourceFiles, []);
  assert.equal(expandCommands(plan.scripts, actualScripts).filter(command => command === fileWorkflowUiCommand).length, 1, `${file} must exercise the real workflow UI`);
}
assert.equal(expandCommands(selectScripts([...fileWorkflowUiFiles, 'tests/verify_file_workflows_ui.mjs']).scripts, actualScripts).filter(command => command === fileWorkflowUiCommand).length, 1, 'related workflow UI changes must share one browser run');
const fileWorkflowFiles = [
  'src/modules/fanhao/server/workflows/file-workflow-service.js',
  'src/modules/fanhao/server/workflows/routes.js',
  'tools/fanhao_file_workflows.mjs',
  'tests/verify_file_workflows.mjs',
];
for (const file of fileWorkflowFiles) {
  const plan = selectScripts([file]);
  assert.deepEqual(plan.scripts, ['verify:file-workflows', 'verify:imports'], `${file} must select file workflow behavior`);
  assert.deepEqual(plan.unknownSourceFiles, []);
  const selectedCommands = expandCommands(plan.scripts, actualScripts);
  assert.equal(selectedCommands.filter(command => command === fileWorkflowCommand).length, 1, `${file} must run file workflow behavior once`);
}
const combinedFileWorkflowCommands = expandCommands(selectScripts(fileWorkflowFiles).scripts, actualScripts);
assert.equal(combinedFileWorkflowCommands.filter(command => command === fileWorkflowCommand).length, 1, 'related workflow changes must share one behavior check');
assert.equal(fullCommands.filter(command => command === 'node tests/verify_work_search_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_android_novel_style_reuse.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_android_novel_paging_alignment.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_work_search_index_retention.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_work_search_postings.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_music_track_projection.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_music_artist_projection.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_music_report_projection.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_video_probe_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_code_prefix_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_actor_movie_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_actor_movie_info_cache_recovery.mjs').length, 1);
assert.equal(fullCommands.filter(command => command === 'node tests/verify_access_analytics_close.mjs').length, 1);
for (const file of ['cache_recovery', 'derived_cache_recovery', 'catalog_cache_recovery', 'prefix_cache_recovery']) {
  assert.equal(fullCommands.filter(command => command === `node tests/verify_work_info_${file}.mjs`).length, 1);
}
for (const file of ['verify_android_update_streams', 'verify_manga_file_streams', 'verify_stored_zip_stream_lifecycle', 'verify_manga_image_dimensions', 'verify_music_metadata_smart_counts', 'verify_person_identity_statement_reuse', 'verify_novel_empty_pages', 'verify_media_detail_projection', 'verify_work_info_detail_cache', 'verify_work_info_summary_projection', 'verify_person_page_cache_keys', 'verify_person_page_cache_budget', 'verify_work_page_cache_keys', 'verify_work_detail_cache', 'verify_ranking_cache_recovery']) {
  assert.equal(fullCommands.filter(command => command === `node tests/${file}.mjs`).length, 1);
}
for (const command of ['node tests/verify_android_image_cache.mjs', 'node tests/verify_android_cache_stats.mjs']) {
  assert.equal(fullCommands.filter((entry) => entry === command).length, 1, 'Android cache checks must run once in full verification');
  const sharedCacheCommands = expandCommands(selectScripts(['android-client/www/js/cache.js']).scripts, actualScripts);
  assert.equal(sharedCacheCommands.filter((entry) => entry === command).length, 1, 'shared cache changes must include cache behavior');
}
for (const file of ['verify_static_file_lifecycle', 'verify_module_lifecycle', 'verify_server_shutdown_lifecycle', 'verify_gallery_list_rendering', 'verify_android_channel_rendering', 'verify_short_video_quality_queries', 'verify_short_video_image_sources', 'verify_short_video_image_lifecycle', 'verify_actor_avatar_import', 'verify_file_server_async', 'verify_short_video_product_lifecycle']) {
  assert.equal(fullCommands.filter((command) => command === `node tests/${file}.mjs`).length, 1, `${file} must run once in full verification`);
}
for (const file of ['public/js/standalone-host.js', 'public/standalone-app.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:photo-reader-browser', 'verify:manga-reader-browser', 'verify:music-reader-browser', 'verify:novel-reader-browser', 'verify:photo-reader', 'verify:tools-txt-browser', 'verify:browser-behavior', 'verify:imports']);
}
assert.deepEqual(selectScripts(['public/modules/photos/manga-page.js']).scripts, ['verify:manga-reader-browser', 'verify:manga-image-layout', 'verify:manga-image-retry', 'verify:manga-chapter-navigation', 'verify:manga-library-input-browser', 'verify:manga-reader-position', 'verify:manga-page-navigation-browser', 'verify:manga', 'verify:manga-add-draft-browser', 'verify:manga-directory-return-browser', 'verify:manga-directory-search-browser', 'verify:manga-library-cards-browser', 'verify:manga-library-covers-browser', 'verify:manga-fit-position-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_manga_reader_requests.mjs']).scripts, ['verify:manga-reader-browser', 'verify:manga-chapter-navigation', 'verify:manga-library-input-browser', 'verify:manga-reader-position', 'verify:manga-page-navigation-browser', 'verify:manga', 'verify:manga-add-draft-browser', 'verify:manga-directory-return-browser', 'verify:manga-directory-search-browser', 'verify:manga-library-cards-browser', 'verify:manga-library-covers-browser', 'verify:manga-fit-position-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_manga_chapter_navigation.mjs']).scripts, ['verify:manga-chapter-navigation', 'verify:imports']);
for (const file of ['verify_web_player_lifecycle', 'verify_web_player_plyr', 'verify_photo_pager_keyboard', 'verify_manga_image_layout', 'verify_manga_image_retry', 'verify_novel_catalog', 'verify_novel_navigation_recovery', 'verify_person_profile_lifecycle', 'verify_novel_search_input', 'verify_gallery_image_retry', 'verify_music_queue_context']) {
  assert.equal(fullCommands.filter(command => command === `node tests/${file}.mjs`).length, 1, 'focused Web browser checks must run once in full verification');
}
assert.deepEqual(selectScripts(['tests/verify_manga_lookup_performance.mjs']).scripts, ['verify:manga-lookup', 'verify:manga', 'verify:imports']);
for (const file of ['src/modules/photos/server/manga-service.js', 'src/modules/photos/server/manga-database.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:manga', 'verify:manga-lookup', 'verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_music_facet_cache.mjs']).scripts, ['verify:music-facet-cache', 'verify:music-scale', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_lyric_search.mjs']).scripts, ['verify:music-lyric-search', 'verify:imports']);
for (const file of ['store', 'lyrics-search']) {
  const selected = expandCommands(selectScripts([`src/modules/music/server/${file}.js`]).scripts, actualScripts);
  assert.equal(selected.filter(command => command === 'node tests/verify_music_lyric_search.mjs').length, 1, 'music search changes must include focused behavior');
}
assert.equal(fullCommands.filter(command => command === 'node tests/verify_music_lyric_search.mjs').length, 1, 'music search must run once in full verification');
for (const file of ['tests/verify_music_summary_reuse.mjs', 'tests/verify_music_active_catalogue.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:music-summary-cache', 'verify:music-scale', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_studio_cache_dependencies.mjs']).scripts, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_music_list_rendering.mjs']).scripts, ['verify:android-music-rendering', 'verify:android-music', 'verify:imports']);
for (const name of ['catalogue', 'playback', 'transition', 'history', 'playlist']) {
  assert.deepEqual(selectScripts([`tests/verify_android_music_${name}_requests.mjs`]).scripts, ['verify:android-music', 'verify:android-music-rendering', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_android_media_viewer.mjs']).scripts, ['verify:android-media-viewer', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_info_preview.mjs']).scripts, ['verify:android-info-preview', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_storage_metrics.mjs']).scripts, ['verify:android-storage-metrics', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_photo_categories.mjs']).scripts, ['verify:android-photo-categories', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_novel_categories.mjs']).scripts, ['verify:android-novel-categories', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_novel_mobile_layout.mjs']).scripts, ['verify:android-novel-layout', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_music_search_filters.mjs']).scripts, ['verify:android-music-search-filters', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_android_fanhao_search_suggestions.mjs']).scripts, ['verify:android-fanhao-suggestions', 'verify:imports']);
for (const file of ['tests/verify_android_photo_viewer_requests.mjs', 'tests/fixtures/android-photo-viewer-requests-before-fix.json']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:android-photo-viewer', 'verify:imports']);
}
for (const file of ['tests/verify_android_manga_task_requests.mjs', 'tests/fixtures/android-manga-task-ownership-before-fix.json', 'tests/fixtures/android-manga-delete-navigation-before-fix.json']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:android-manga-tasks', 'verify:imports']);
}
for (const file of ['src/modules/fanhao/server/library/cache-contracts.js', 'src/modules/fanhao/server/library/table-stamp-query.js', 'src/modules/fanhao/server/catalog/studio-service.js', 'src/modules/fanhao/server/catalog/code-prefix-service.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']);
}
assert(selectScripts(['server.js']).scripts.includes('verify:studio-cache'));
assert(selectScripts(['src/modules/music/server/store.js']).scripts.includes('verify:music-summary-cache'));
for (const name of ['facet-cache', 'facets', 'constants', 'store', 'scan']) {
  assert(selectScripts([`src/modules/music/server/${name}.js`]).scripts.includes('verify:music-facet-cache'));
}
assert.deepEqual(selectScripts(['tests/verify_music_playback_lifecycle.mjs']).scripts, ['verify:music-playback', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/player/engine.js']).scripts, ['verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-reader-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/music-page.js']).scripts, ['verify:music-reader-browser', 'verify:music-lyric-find-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-search-suggestions-browser', 'verify:music-playlist-dialog-browser', 'verify:music-volume-browser', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-requests', 'verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:music-sort-keyboard-browser', 'verify:music-drawer-navigation-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/views/components.js']).scripts, ['verify:music-reader-browser', 'verify:music-lyric-find-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-search-suggestions-browser', 'verify:music-playlist-dialog-browser', 'verify:music-volume-browser', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-requests', 'verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:music-sort-keyboard-browser', 'verify:music-drawer-navigation-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/music/actions.js']).scripts, ['verify:music-requests', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']);
for (const name of ['music-progress-writer', 'progress-session']) {
  assert.deepEqual(selectScripts([`public/modules/music/${name}.js`]).scripts, ['verify:music-progress', 'verify:music-progress-browser', 'verify:music-rescan-worker', 'verify:music-scale', 'verify:imports']);
}
const musicApiPlan = selectScripts(['public/modules/music/api.js']);
for (const script of ['verify:music-progress', 'verify:music-progress-browser', 'verify:music-rescan-worker', 'verify:music-scale', 'verify:imports']) assert(musicApiPlan.scripts.includes(script), 'music API changes must retain existing verification');
assert.equal(expandCommands(musicApiPlan.scripts, actualScripts).filter(command => command === 'node tests/verify_music_reader_requests.mjs').length, 1, 'music API changes must exercise playlist mutation HTTP contracts');
assert.deepEqual(selectScripts(['tests/verify_api_error_boundary.mjs']).scripts, ['verify:mutation-auth', 'verify:imports']);
for (const name of ['writer', 'clients', 'order']) {
  assert.deepEqual(selectScripts([`tests/verify_music_progress_${name}.mjs`]).scripts, ['verify:music-progress', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_music_progress_requests.mjs']).scripts, ['verify:music-progress-browser', 'verify:music-progress', 'verify:imports']);
for (const name of ['progress-receipts', 'routes', 'store']) {
  assert(selectScripts([`src/modules/music/server/${name}.js`]).scripts.includes('verify:music-progress'));
}
for (const name of ['music-views', 'music-progress-writer', 'progress-session', 'progress-transport', 'music-catalogue-requests', 'music-catalogue-refresh']) {
  assert.deepEqual(selectScripts([`android-client/www/modules/music/${name}.js`]).scripts, ['verify:android-security', 'verify:auth', 'verify:mutation-auth', 'verify:imports', 'verify:android-music', 'verify:music-progress', 'verify:android-music-rendering', 'verify:android-bottom-layout']);
}
assert.deepEqual(selectScripts(['tests/verify_music_request_ownership.mjs']).scripts, ['verify:music-requests', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_music_reader_requests.mjs']).scripts, ['verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:music-lyric-find-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-search-suggestions-browser', 'verify:music-playlist-dialog-browser', 'verify:music-volume-browser', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-requests', 'verify:music-sort-keyboard-browser', 'verify:music-drawer-navigation-browser', 'verify:music-compact-rows-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_reader_requests.mjs']).scripts, ['verify:novel-reader-browser', 'verify:novel-reader-position', 'verify:novel-ranking-recovery', 'verify:novel-book-mutation', 'verify:novel-reader-keyboard', 'verify:novel-list-return-browser', 'verify:novel-reader-fullscreen', 'verify:novel-upload-encoding', 'verify:novel-book-recovery-browser', 'verify:novel-bookmarks-browser', 'verify:novel-author-browser', 'verify:novel-search-input', 'verify:novel-reader', 'verify:novel-lan-http-browser', 'verify:novel-adjacent-navigation-browser', 'verify:novel-import-navigation-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_web_novel_chapter_identity.mjs']).scripts, ['verify:novel-reader', 'verify:imports']);
for (const file of ['public/modules/novels/novel-page.js', 'public/modules/novels/collection-admin.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:novel-collection-refresh', 'verify:novel-catalog', 'verify:novel-navigation-recovery', 'verify:novel-reader-panels', 'verify:novel-reader-position', 'verify:novel-ranking-recovery', 'verify:novel-book-mutation', 'verify:novel-reader-keyboard', 'verify:novel-list-return-browser', 'verify:novel-reader-fullscreen', 'verify:novel-upload-encoding', 'verify:novel-book-recovery-browser', 'verify:novel-bookmarks-browser', 'verify:novel-author-browser', 'verify:novel-search-input', 'verify:novel-reader-browser', 'verify:novel-reader', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:browser-behavior', 'verify:novel-lan-http-browser', 'verify:novel-adjacent-navigation-browser', 'verify:novel-import-navigation-browser', 'verify:imports']);
}
for (const file of ['tests/verify_novel_progress_writer.mjs', 'tests/verify_novel_progress_order.mjs']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:novel-progress', 'verify:imports']);
}
assert.deepEqual(selectScripts(['tests/verify_novel_progress_requests.mjs']).scripts, ['verify:novel-progress-browser', 'verify:novel-progress', 'verify:novel-lan-http-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['public/modules/novels/progress-writer.js']).scripts, ['verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-reader', 'verify:novel-reader-browser', 'verify:imports']);
for (const file of ['src/modules/novels/server/store.js', 'src/modules/novels/server/routes.js']) {
  assert.deepEqual(selectScripts([file]).scripts, ['verify:novels', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-summary-cache', 'verify:imports']);
}
assert(selectScripts(['src/platform/server/archive-task-pool.js']).scripts.includes('verify:archive-images'));
assert(selectScripts(['src/platform/server/image-reader-cache-service.js']).scripts.includes('verify:archive-images'));
assert.deepEqual(selectScripts(['tests/verify_archive_reader_lifecycle.mjs']).scripts, ['verify:archive-images', 'verify:gallery-db', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/fixtures/archive_image_helper_fixture.mjs']).scripts, ['verify:archive-images', 'verify:gallery-db', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_web_gallery_requests.mjs']).scripts, ['verify:photo-reader-browser', 'verify:gallery-image-retry', 'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:gallery-image-pan', 'verify:gallery-fullscreen-browser', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:photo-reader', 'verify:gallery-keyboard-pan-browser', 'verify:gallery-zoom-anchor-browser', 'verify:gallery-range-metadata-browser', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/diagnose_web_gallery_navigation.mjs']).scripts, ['verify:photo-reader-browser', 'verify:gallery-image-retry', 'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:gallery-image-pan', 'verify:gallery-fullscreen-browser', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:photo-reader', 'verify:gallery-keyboard-pan-browser', 'verify:gallery-zoom-anchor-browser', 'verify:gallery-range-metadata-browser', 'verify:imports']);
assert(selectScripts(['src/modules/media/server/runtime.js']).scripts.includes('verify:gallery-cover-async'));
assert(selectScripts(['src/platform/server/video-probe-service.js']).scripts.includes('verify:video-probe-cache'));
assert.deepEqual(selectScripts(['tests/verify_novel_write_worker.mjs']).scripts, ['verify:novel-write-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/fixtures/novel-write-worker-fault.mjs']).scripts, ['verify:novel-write-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_credentials_async.mjs']).scripts, ['verify:novel-credentials-async', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_collection_worker.mjs']).scripts, ['verify:novel-collection-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/fixtures/novel-collection-worker-fault.mjs']).scripts, ['verify:novel-collection-worker', 'verify:imports']);
assert.deepEqual(selectScripts(['tests/verify_novel_reimport_async.mjs']).scripts, ['verify:novel-reimport-async', 'verify:imports']);
assert.deepEqual(selectScripts(['tools/rescan_novel_library.py']).scripts, ['verify:novels', 'verify:novel-summary-cache', 'verify:imports']);

const docs = selectScripts(['docs/site/reference/verification.md']);
assert.deepEqual(docs.scripts, ['command:npm --prefix docs test', 'command:npm --prefix docs run build']);

const unknown = selectScripts(['tools/new_unclassified_source.mjs']);
assert(unknown.scripts.includes('verify:startup'));
assert.deepEqual(unknown.unknownSourceFiles, ['tools/new_unclassified_source.mjs']);

console.log('Verification runner fixtures passed.');
