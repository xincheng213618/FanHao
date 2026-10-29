import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeAndroidCacheSource } from '../android-client/scripts/android-cache-version.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const DAILY_SCRIPTS = [
  'verify:repo-hygiene',
  'verify:auth',
  'verify:mutation-auth',
  'verify:json-responses',
  'verify:modules',
  'verify:imports',
  'verify:verification-runner',
  'verify:fanhao-requests',
  'verify:work-sorting',
  'verify:work-facets',
  'verify:work-traits',
  'verify:work-cache-budget',
];

// Main-library Web flows, using private fixtures and a shared command dedupe.
// Keep the combined FULL/Android entry points independent of this selection.
export const WEB_SCRIPTS = [
  'command:node tests/verify_verification_runner.mjs',
  'verify:imports',
  'verify:web-browser-behavior',
  'verify:web-bootstrap-browser',
  'verify:fanhao-requests',
  'verify:fanhao-startup-recovery-browser',
  'verify:fanhao-people-index-browser',
  'verify:fanhao-prefix-search-browser',
  'verify:web-player-browser',
  'verify:web-player-plyr',
  'verify:photo-reader-browser',
  'verify:manga-reader-browser',
  'verify:novel-reader-browser',
  'verify:music-reader-browser',
  'verify:tools-txt-browser',
  'verify:tools-gomoku-browser',
  'verify:tools-2048-browser',
  'verify:person-profile-browser',
];

export const FULL_SCRIPTS = [
  'verify:subtitle-cleanup',
  'verify:subtitles',
  'verify:work-traits', 'verify:studio-marks',
  'verify:taste',
  'verify:duplicates',
  'verify:repo-hygiene', 'verify:auth', 'verify:accounts', 'verify:mutation-auth', 'verify:json-responses',
  'verify:android-security', 'verify:android-gradle-config', 'verify:android-client',
  'verify:android-system-control', 'verify:codes', 'verify:metadata',
  'verify:javdb-card-facts', 'verify:library-merge', 'verify:core-images',
  'verify:gallery-db', 'verify:image-library', 'verify:photo-reader', 'verify:manga',
  'verify:archive-images', 'verify:photo-search', 'verify:music-rescan-worker',
  'verify:music-scale', 'verify:video-playback', 'verify:person-work-associations',
  'verify:person-identity',
  'verify:movefile',
  'verify:person-organization',
  'verify:file-workflows',
  'verify:file-workflows-ui',
  'verify:work-move-jobs', 'verify:android-work-move', 'verify:access-log',
  'verify:access-analytics', 'verify:novels', 'verify:short-video-collections',
  'verify:short-video-delete-jobs', 'verify:short-video-store', 'verify:short-video-sync',
  'verify:short-video-actions', 'verify:short-video-watch-write',
  'verify:short-video-runtime', 'verify:short-video-stats-performance',
  'verify:short-video-like-distribution-worker', 'verify:short-video-build',
  'verify:short-video-client', 'verify:short-video-playback', 'verify:web-browser-behavior', 'verify:web-bootstrap-browser', 'verify:browser-behavior', 'verify:douyin-manager',
  'verify:settings', 'verify:web-settings-browser', 'verify:system-control', 'verify:market-dashboard',
  'verify:gomoku', 'verify:tools-gomoku-browser', 'verify:tools-2048-browser', 'verify:jump', 'verify:modules', 'verify:disk-usage',
  'verify:code-prefixes', 'verify:startup', 'verify:fanhao',
  'verify:works-performance', 'verify:cover-cache-status', 'verify:imports',
  'verify:android-novel-ui', 'verify:verification-runner',
  'verify:music-cover-async', 'verify:work-cover-async', 'verify:novel-summary-cache', 'verify:file-streams',
  'verify:novel-write-worker', 'verify:novel-credentials-async', 'verify:novel-collection-worker',
  'verify:video-probe-cache', 'verify:gallery-cover-async', 'verify:work-cache-budget',
  'verify:novel-reimport-async',
  'verify:image-query',
  'verify:media-images', 'verify:media-streams',
  'verify:photo-reader-browser', 'verify:manga-reader-browser', 'verify:music-playback',
  'verify:photo-pager-keyboard', 'verify:manga-image-layout', 'verify:novel-catalog', 'verify:web-player-browser', 'verify:web-player-plyr',
  'verify:manga-image-retry', 'verify:manga-chapter-navigation', 'verify:manga-library-input-browser', 'verify:novel-navigation-recovery', 'verify:novel-reader-panels', 'verify:person-profile-browser',
  'verify:novel-search-input', 'verify:gallery-image-retry', 'verify:manga-library-cards-browser', 'verify:manga-library-covers-browser', 'verify:manga-fit-position-browser',
  'verify:gallery-image-pan', 'verify:gallery-list-return', 'verify:novel-reader-keyboard', 'verify:novel-list-return-browser', 'verify:novel-reader-fullscreen', 'verify:fanhao-favorite-browser', 'verify:fanhao-collection-recovery-browser',
  'verify:gallery-search-input', 'verify:music-playback-recovery-browser', 'verify:tools-txt-browser',
  'verify:gallery-control-construction', 'verify:music-queue-move-browser', 'verify:music-rating-browser', 'verify:music-search-suggestions-browser', 'verify:music-playlist-dialog-browser',
  'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:music-lyric-find-browser', 'verify:web-player-time-links', 'verify:novel-reader-position', 'verify:novel-ranking-recovery', 'verify:novel-book-mutation',
  'verify:music-requests', 'verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:music-queue-context-browser', 'verify:music-queue-search-browser',
  'verify:novel-reader', 'verify:novel-reader-browser', 'verify:novel-collection-refresh',
  'verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-upload-encoding', 'verify:novel-book-recovery-browser', 'verify:music-volume-browser', 'verify:manga-reader-position', 'verify:fanhao-startup-recovery-browser',
  'verify:manga-lookup', 'verify:music-facet-cache',
  'verify:music-progress', 'verify:music-progress-browser', 'verify:music-browse-navigation-browser', 'verify:manga-page-navigation-browser', 'verify:fanhao-sort-controls-browser', 'verify:gallery-fullscreen-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:novel-bookmarks-browser', 'verify:web-player-file-list', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:novel-author-browser',
  'verify:music-summary-cache', 'verify:studio-cache', 'verify:android-music-rendering',
  'verify:static-files', 'verify:shutdown', 'verify:gallery-rendering', 'verify:short-video-images', 'verify:actor-avatar-import', 'verify:android-update-streams',
  'verify:android-channel-rendering', 'verify:android-bottom-layout', 'verify:android-gallery-layout', 'verify:android-manga-layout', 'verify:android-novel-layout',
  'verify:gallery-search-focus',
  'verify:fanhao-prefix-search-browser', 'verify:gallery-keyboard-pan-browser', 'verify:music-sort-keyboard-browser', 'verify:novel-lan-http-browser',
  'verify:web-player-adjacent-files', 'verify:gallery-zoom-anchor-browser', 'verify:music-drawer-navigation-browser', 'verify:novel-adjacent-navigation-browser',
  'verify:fanhao-people-index-browser', 'verify:music-compact-rows-browser', 'verify:gallery-range-metadata-browser', 'verify:novel-import-navigation-browser',
  'verify:music-alphabet-browser', 'verify:manga-add-draft-browser', 'verify:manga-directory-return-browser', 'verify:manga-directory-search-browser', 'verify:music-load-more-keyboard-browser',
];

export const ANDROID_SCRIPTS = [
  'verify:android-security', 'verify:android-gradle-config', 'verify:android-client',
  'verify:android-system-control', 'verify:android-work-move', 'verify:android-novel-ui',
  'verify:short-video-client', 'verify:auth', 'verify:mutation-auth', 'verify:imports',
  'verify:android-music-rendering',
  'verify:android-channel-rendering', 'verify:android-bottom-layout', 'verify:android-gallery-layout', 'verify:android-manga-layout', 'verify:android-novel-layout',
];

const ANDROID_DOMAIN_BASE = ['verify:android-security', 'verify:auth', 'verify:mutation-auth', 'verify:imports'];

const RULES = [
  [/^tests\/verify_web_settings_drafts\.mjs$/, ['verify:web-settings-browser', 'verify:imports']],
  [/^public\/modules\/system\/(?:settings-controller\.js|admin\.css)$/, ['verify:system-control', 'verify:settings', 'verify:web-settings-browser', 'verify:imports']],
  [/^(?:src\/modules\/fanhao\/server\/duplicates\/|public\/modules\/fanhao\/duplicates\/|tests\/verify_duplicate(?:_model|_identity|s|s_browser)\.mjs$)/, ['verify:duplicates', 'verify:imports']],
  [/^(?:tools\/clean\.py|tests\/verify_subtitle_cleanup\.py)$/, ['verify:subtitle-cleanup', 'verify:imports']],
  [/^(?:lib\/subtitle-batch-policy\.js|tools\/(?:subtitles_batch|check_subtitle_batch)\.mjs|tests\/verify_subtitle_(?:sidecars|batch|batch_policy)\.mjs)$/, ['verify:subtitles', 'verify:imports']],
  [/^(?:tools\/(?:movefile\.py|movefile_plan\.py|import_movefile_plan\.py|execute_movefile_plan\.ps1|relink_movefile_plan\.mjs)|tests\/verify_movefile_(?:identity|plan|import)\.py)$/, ['verify:movefile', 'verify:imports']],
  [/^(?:lib\/subtitles\.js|src\/modules\/fanhao\/server\/playback\/|public\/modules\/fanhao\/subtitle-controls\.js|tests\/verify_subtitle(?:s|cat_provider|_service|s_browser)\.mjs$)/, ['verify:subtitles', 'verify:mutation-auth', 'verify:imports']],
  [/^(?:public\/js\/(?:player-page|player-time-link|player-time-jump)\.js|public\/player\.html|public\/modules\/fanhao\/work-detail-page\.js)$/, ['verify:subtitles', 'verify:video-playback', 'verify:web-player-browser', 'verify:web-player-plyr', 'verify:web-player-time-links', 'verify:web-player-file-list', 'verify:fanhao-requests', 'verify:web-player-adjacent-files', 'verify:imports']],
  [/^(?:src\/modules\/fanhao\/server\/taste\/|public\/modules\/fanhao\/taste\/|tools\/analyze_taste\.mjs$|tests\/verify_taste(?:_browser)?\.mjs$|tests\/fixtures\/taste-library\.mjs$)/, ['verify:taste', 'verify:imports']],
  [/^android-client\/scripts\/verify-android-security\.mjs$/, ['verify:android-security', 'verify:android-update-streams', 'verify:imports']],
  [/^tests\/verify_access_analytics_close\.mjs$/, ['verify:access-analytics-close', 'verify:imports']],
  [/^tests\/verify_api_error_boundary\.mjs$/, ['verify:mutation-auth', 'verify:imports']],
  [/^tests\/verify_json_responses\.mjs$/, ['verify:json-responses', 'verify:imports']],
  [/^src\/platform\/server\/responses\.js$/, ['verify:json-responses', 'verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:imports']],
  [/^src\/modules\/system\/server\/access-analytics-service\.js$/, ['verify:access-analytics', 'verify:shutdown', 'verify:imports']],
  [/^(\.codex-artifacts|\.codex-remote-attachments|data\/design-audits)\//, []],
  [/^docs\//, ['command:npm --prefix docs test', 'command:npm --prefix docs run build']],
  [/^android-client\/www\/platform\/content-index\/channel-views\.js$/, [...ANDROID_DOMAIN_BASE, 'verify:android-media', 'verify:android-photos', 'verify:android-channel-rendering', 'verify:android-manga-layout', 'verify:photo-search', 'verify:browser-behavior']],
  [/^android-client\/www\/modules\/novels\//, [...ANDROID_DOMAIN_BASE, 'verify:android-novels', 'verify:android-novel-layout']],
  [/^android-client\/www\/modules\/music\//, [...ANDROID_DOMAIN_BASE, 'verify:android-music', 'verify:music-progress', 'verify:android-music-rendering', 'verify:android-bottom-layout']],
  [/^android-client\/www\/modules\/(media|anime)\//, [...ANDROID_DOMAIN_BASE, 'verify:android-media', 'verify:android-gallery-layout']],
  [/^android-client\/www\/modules\/(photos|vision)\//, [...ANDROID_DOMAIN_BASE, 'verify:android-photos', 'verify:android-gallery-layout', 'verify:android-manga-layout']],
  [/^android-client\/www\/modules\/short-videos\//, [...ANDROID_DOMAIN_BASE, 'verify:short-video-client', 'verify:android-bottom-layout']],
  [/^android-client\/android\/app\/src\/main\/java\/.*Novel/i, [...ANDROID_DOMAIN_BASE, 'verify:android-novels']],
  [/^android-client\/android\/app\/src\/main\/java\/.*Music/i, [...ANDROID_DOMAIN_BASE, 'verify:android-music']],
  [/^android-client\/android\/app\/src\/main\/java\/.*ShortVideo/i, [...ANDROID_DOMAIN_BASE, 'verify:short-video-client']],
  [/^android-client\/android\/app\/src\/main\/java\/.*(Media|Video|Anime)/i, [...ANDROID_DOMAIN_BASE, 'verify:android-media']],
  [/^android-client\/android\/app\/src\/main\/java\/.*(Photo|Gallery|Vision|Camera)/i, [...ANDROID_DOMAIN_BASE, 'verify:android-photos']],
  [/^android-client\//, ANDROID_SCRIPTS],
  [/^src\/modules\/short-videos\/download-manager\/(?:manager_core\/(?:database|library_sync)\.py|tests\/test_manager_library_sync\.py)$/, ['verify:douyin-manager', 'verify:short-video-sync', 'verify:imports']],
  [/^(src\/modules\/short-videos\/download-manager\/|tests\/verify_douyin_(?:download_manager|manager)_.*\.(?:mjs|ps1)$)/, ['verify:douyin-manager', 'verify:imports']],
  [/^tests\/verify_fanhao_local_marker_updates\.mjs$/, ['verify:fanhao-requests', 'verify:fanhao-favorite-browser', 'verify:imports']],
  [/^tests\/verify_(?:fanhao_requests|fanhao_collection_paging|fanhao_person_delete_refresh|work_sorting|code_prefix_catalog)\.mjs$/, ['verify:fanhao-requests', 'verify:work-sorting', 'verify:code-prefixes', 'verify:imports']],
  [/^tests\/verify_code_prefix_cache_budget\.mjs$/, ['verify:code-prefixes', 'verify:work-cache-budget', 'verify:imports']],
  [/^tests\/verify_code_prefix_cache_recovery\.mjs$/, ['verify:code-prefix-cache-recovery', 'verify:imports']],
  [/^tests\/verify_music_cover_async\.mjs$/, ['verify:music-cover-async', 'verify:imports']],
  [/^tests\/verify_music_facet_cache\.mjs$/, ['verify:music-facet-cache', 'verify:music-scale', 'verify:imports']],
  [/^tests\/verify_music_lyric_search\.mjs$/, ['verify:music-lyric-search', 'verify:imports']],
  [/^tests\/verify_music_artist_projection\.mjs$/, ['verify:music-artist-projection', 'verify:imports']],
  [/^tests\/verify_music_track_projection\.mjs$/, ['verify:music-track-projection', 'verify:imports']],
  [/^tests\/fixtures\/music-track-projection-(?:store|lyrics)-legacy\.txt$/, ['verify:music-track-projection', 'verify:imports']],
  [/^tests\/verify_music_report_projection\.mjs$/, ['verify:music-report-projection', 'verify:imports']],
  [/^tests\/verify_android_(?:mobile_action_sheet|settings_focus)\.mjs$/, ['verify:android-mobile-sheets', 'verify:imports']],
  [/^tests\/verify_android_music_back\.mjs$/, ['verify:android-music', 'verify:imports']],
  [/^tests\/verify_android_bottom_layout(?:_metrics)?\.mjs$/, ['verify:android-bottom-layout', 'verify:imports']],
  [/^tests\/verify_android_gallery_mobile_layout\.mjs$/, ['verify:android-gallery-layout', 'verify:imports']],
  [/^tests\/verify_android_manga_mobile_layout\.mjs$/, ['verify:android-manga-layout', 'verify:imports']],
  [/^tests\/verify_android_novel_mobile_layout\.mjs$/, ['verify:android-novel-layout', 'verify:imports']],
  [/^tests\/(?:serve_android_gallery_navigation_fixture\.mjs|fixtures\/android-gallery-navigation-browser\.(?:html|mjs))$/, ['verify:android-gallery-layout', 'verify:android-bottom-layout', 'verify:android-manga-layout', 'verify:android-novel-layout', 'verify:imports']],
  [/^tests\/verify_android_fanhao_player_(?:requests|lifecycle)\.mjs$/, ['verify:android-fanhao-player', 'verify:imports']],
  [/^tests\/verify_android_novel_style_reuse\.mjs$/, ['verify:android-novel-styles', 'verify:imports']],
  [/^tests\/verify_android_novel_mobile_ui\.mjs$/, ['verify:android-novel-ui', 'verify:imports']],
  [/^tests\/verify_android_novel_source_identity\.mjs$/, ['verify:android-novels', 'verify:imports']],
  [/^tests\/verify_android_novel_paging_alignment\.mjs$/, ['verify:android-novel-paging', 'verify:imports']],
  [/^tests\/verify_android_novel_categories\.mjs$/, ['verify:android-novel-categories', 'verify:imports']],
  [/^tests\/verify_android_music_search_filters\.mjs$/, ['verify:android-music-search-filters', 'verify:imports']],
  [/^tests\/verify_work_search_index_retention\.mjs$/, ['verify:work-search-retention', 'verify:imports']],
  [/^tests\/fixtures\/work-search-index-retention-legacy\.txt$/, ['verify:work-search-retention', 'verify:imports']],
  [/^tests\/verify_work_search_postings\.mjs$/, ['verify:work-search-postings', 'verify:imports']],
  [/^tests\/fixtures\/work-search-postings-legacy\.txt$/, ['verify:work-search-postings', 'verify:imports']],
  [/^tests\/verify_work_search_cache_recovery\.mjs$/, ['verify:work-search-cache', 'verify:imports']],
  [/^tests\/fixtures\/(?:work-search-cache-recovery\.mjs|(?:work-search|missing-code-search)-cache-legacy\.txt)$/, ['verify:work-search-cache', 'verify:imports']],
  [/^tests\/verify_music_played_sort\.mjs$/, ['verify:music-scale', 'verify:imports']],
  [/^(?:src\/modules\/music\/server\/m3u\.js|tests\/verify_music_m3u\.mjs)$/, ['verify:music-m3u', 'verify:imports']],
  [/^tests\/verify_music_playlist_order\.mjs$/, ['verify:music-playlist-order', 'verify:imports']],
  [/^tests\/verify_music_metadata_smart_counts\.mjs$/, ['verify:music-smart-counts', 'verify:imports']],
  [/^tests\/verify_person_identity_statement_reuse\.mjs$/, ['verify:person-identity-statements', 'verify:imports']],
  [/^tests\/verify_music_(?:summary_reuse|active_catalogue)\.mjs$/, ['verify:music-summary-cache', 'verify:music-scale', 'verify:imports']],
  [/^tests\/verify_studio_cache_dependencies\.mjs$/, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']],
  [/^tests\/verify_android_music_list_rendering\.mjs$/, ['verify:android-music-rendering', 'verify:android-music', 'verify:imports']],
  [/^tests\/verify_android_music_(?:catalogue|playback|transition|history|playlist)_requests\.mjs$/, ['verify:android-music', 'verify:android-music-rendering', 'verify:imports']],
  [/^tests\/verify_android_media_viewer\.mjs$/, ['verify:android-media-viewer', 'verify:imports']],
  [/^tests\/verify_android_info_preview\.mjs$/, ['verify:android-info-preview', 'verify:imports']],
  [/^tests\/verify_android_storage_metrics\.mjs$/, ['verify:android-storage-metrics', 'verify:imports']],
  [/^tests\/verify_android_photo_categories\.mjs$/, ['verify:android-photo-categories', 'verify:imports']],
  [/^tests\/verify_android_fanhao_search_suggestions\.mjs$/, ['verify:android-fanhao-suggestions', 'verify:imports']],
  [/^tests\/(?:verify_android_photo_viewer_requests\.mjs|fixtures\/android-photo-viewer-requests-before-fix\.json)$/, ['verify:android-photo-viewer', 'verify:imports']],
  [/^tests\/(?:verify_android_manga_task_requests\.mjs|fixtures\/android-manga-(?:task-ownership|delete-navigation)-before-fix\.json)$/, ['verify:android-manga-tasks', 'verify:imports']],
  [/^tests\/verify_music_progress_(?:writer|clients|order)\.mjs$/, ['verify:music-progress', 'verify:imports']],
  [/^tests\/verify_music_progress_requests\.mjs$/, ['verify:music-progress-browser', 'verify:music-progress', 'verify:imports']],
  [/^tests\/verify_manga_lookup_performance\.mjs$/, ['verify:manga-lookup', 'verify:manga', 'verify:imports']],
  [/^tests\/verify_manga_download_metadata\.mjs$/, ['verify:manga-download', 'verify:imports']],
  [/^tests\/verify_manga_image_dimensions\.mjs$/, ['verify:manga-image-dimensions', 'verify:imports']],
  [/^tests\/verify_(?:manga_file_streams|stored_zip_stream_lifecycle)\.mjs$/, ['verify:manga-streams', 'verify:imports']],
  [/^tests\/verify_android_update_streams\.mjs$/, ['verify:android-update-streams', 'verify:file-streams', 'verify:imports']],
  [/^tests\/verify_music_playback_lifecycle\.mjs$/, ['verify:music-playback', 'verify:imports']],
  [/^tests\/verify_music_playback_recovery\.mjs$/, ['verify:music-playback-recovery-browser', 'verify:imports']],
  [/^tests\/verify_music_request_ownership\.mjs$/, ['verify:music-requests', 'verify:imports']],
  [/^tests\/verify_music_search_deduplication\.mjs$/, ['verify:music-search-dedup-browser', 'verify:imports']],
  [/^tests\/verify_music_reader_requests\.mjs$/, ['verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:music-lyric-find-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-search-suggestions-browser', 'verify:music-playlist-dialog-browser', 'verify:music-volume-browser', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-requests', 'verify:music-sort-keyboard-browser', 'verify:music-drawer-navigation-browser', 'verify:music-compact-rows-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']],
  [/^tests\/verify_music_queue_context\.mjs$/, ['verify:music-queue-context-browser', 'verify:imports']],
  [/^tests\/verify_music_queue_move_performance\.mjs$/, ['verify:music-queue-move-browser', 'verify:imports']],
  [/^tests\/verify_music_queue_search\.mjs$/, ['verify:music-queue-search-browser', 'verify:imports']],
  [/^tests\/verify_music_rating_writes\.mjs$/, ['verify:music-rating-browser', 'verify:imports']],
  [/^tests\/verify_music_search_suggestions\.mjs$/, ['verify:music-search-suggestions-browser', 'verify:imports']],
  [/^tests\/verify_music_playlist_dialog_keyboard\.mjs$/, ['verify:music-playlist-dialog-browser', 'verify:imports']],
  [/^tests\/verify_music_volume_controls\.mjs$/, ['verify:music-volume-browser', 'verify:imports']],
  [/^tests\/verify_music_browse_navigation\.mjs$/, ['verify:music-browse-navigation-browser', 'verify:imports']],
  [/^tests\/verify_music_library_recovery\.mjs$/, ['verify:music-library-recovery-browser', 'verify:imports']],
  [/^tests\/verify_music_track_context\.mjs$/, ['verify:music-track-context-browser', 'verify:imports']],
  [/^tests\/verify_music_lyric_find\.mjs$/, ['verify:music-lyric-find-browser', 'verify:imports']],
  [/^tests\/verify_browser_behavior\.mjs$/, ['verify:web-browser-behavior', 'verify:browser-behavior', 'verify:imports']],
  [/^tests\/verify_web_bootstrap_recovery\.mjs$/, ['verify:web-bootstrap-browser', 'verify:imports']],
  [/^tests\/verify_gallery_search_focus\.mjs$/, ['verify:gallery-search-focus', 'verify:imports']],
  [/^tests\/verify_gallery_image_retry\.mjs$/, ['verify:gallery-image-retry', 'verify:imports']],
  [/^tests\/verify_gallery_search_input\.mjs$/, ['verify:gallery-search-input', 'verify:imports']],
  [/^tests\/verify_gallery_control_construction\.mjs$/, ['verify:gallery-control-construction', 'verify:imports']],
  [/^tests\/verify_gallery_page_jump\.mjs$/, ['verify:gallery-page-jump', 'verify:imports']],
  [/^tests\/verify_gallery_reader_width\.mjs$/, ['verify:gallery-reader-width', 'verify:imports']],
  [/^tests\/verify_gallery_visible_loading\.mjs$/, ['verify:gallery-visible-loading', 'verify:imports']],
  [/^tests\/verify_gallery_image_pan\.mjs$/, ['verify:gallery-image-pan', 'verify:imports']],
  [/^tests\/verify_gallery_fullscreen\.mjs$/, ['verify:gallery-fullscreen-browser', 'verify:imports']],
  [/^tests\/verify_gallery_catalog_recovery\.mjs$/, ['verify:gallery-catalog-recovery-browser', 'verify:imports']],
  [/^tests\/verify_gallery_summary_recovery\.mjs$/, ['verify:gallery-summary-recovery-browser', 'verify:imports']],
  [/^tests\/verify_gallery_list_return\.mjs$/, ['verify:gallery-list-return', 'verify:imports']],
  [/^tests\/verify_tools_gomoku_lifecycle\.mjs$/, ['verify:tools-gomoku-browser', 'verify:imports']],
  [/^tests\/verify_tools_2048_lifecycle\.mjs$/, ['verify:tools-2048-browser', 'verify:imports']],
  [/^tests\/verify_tools_txt_browser\.mjs$/, ['verify:tools-txt-browser', 'verify:imports']],
  [/^public\/modules\/tools\//, ['verify:tools-txt-browser', 'verify:modules', 'verify:web-browser-behavior', 'verify:imports']],
  [/^tests\/verify_web_player_lifecycle\.mjs$/, ['verify:web-player-browser', 'verify:web-player-plyr', 'verify:web-player-time-links', 'verify:web-player-file-list', 'verify:web-player-adjacent-files', 'verify:imports']],
  [/^tests\/verify_web_player_plyr\.mjs$/, ['verify:web-player-plyr', 'verify:imports']],
  [/^tests\/verify_web_player_time_links\.mjs$/, ['verify:web-player-time-links', 'verify:imports']],
  [/^tests\/verify_web_player_file_list\.mjs$/, ['verify:web-player-file-list', 'verify:imports']],
  [/^tests\/verify_photo_pager_keyboard\.mjs$/, ['verify:photo-pager-keyboard', 'verify:imports']],
  [/^tests\/verify_manga_image_layout\.mjs$/, ['verify:manga-image-layout', 'verify:imports']],
  [/^tests\/verify_manga_image_retry\.mjs$/, ['verify:manga-image-retry', 'verify:imports']],
  [/^tests\/verify_manga_chapter_navigation\.mjs$/, ['verify:manga-chapter-navigation', 'verify:imports']],
  [/^tests\/verify_manga_library_input\.mjs$/, ['verify:manga-library-input-browser', 'verify:imports']],
  [/^tests\/verify_manga_library_cards\.mjs$/, ['verify:manga-library-cards-browser', 'verify:imports']],
  [/^tests\/verify_manga_library_covers\.mjs$/, ['verify:manga-library-covers-browser', 'verify:imports']],
  [/^tests\/verify_manga_fit_position\.mjs$/, ['verify:manga-fit-position-browser', 'verify:imports']],
  [/^tests\/verify_manga_reader_position\.mjs$/, ['verify:manga-reader-position', 'verify:imports']],
  [/^tests\/verify_manga_page_navigation\.mjs$/, ['verify:manga-page-navigation-browser', 'verify:imports']],
  [/^tests\/verify_manga_directory_return\.mjs$/, ['verify:manga-directory-return-browser', 'verify:imports']],
  [/^tests\/verify_manga_directory_search\.mjs$/, ['verify:manga-directory-search-browser', 'verify:imports']],
  [/^public\/modules\/photos\/manga\.css$/, ['verify:image-library', 'verify:gallery-db', 'verify:archive-images', 'verify:photo-reader', 'verify:photo-search', 'verify:manga-reader-browser', 'verify:manga-image-layout', 'verify:manga-image-retry', 'verify:manga-reader-position', 'verify:manga-page-navigation-browser', 'verify:manga-directory-return-browser', 'verify:manga-directory-search-browser', 'verify:manga-library-cards-browser', 'verify:manga-library-covers-browser', 'verify:manga-fit-position-browser', 'verify:imports']],
  [/^tests\/verify_novel_navigation_recovery\.mjs$/, ['verify:novel-navigation-recovery', 'verify:imports']],
  [/^tests\/verify_novel_reader_panels\.mjs$/, ['verify:novel-reader-panels', 'verify:imports']],
  [/^tests\/verify_novel_reader_position\.mjs$/, ['verify:novel-reader-position', 'verify:imports']],
  [/^tests\/verify_novel_ranking_recovery\.mjs$/, ['verify:novel-ranking-recovery', 'verify:imports']],
  [/^tests\/verify_novel_book_mutation\.mjs$/, ['verify:novel-book-mutation', 'verify:imports']],
  [/^tests\/verify_novel_reader_keyboard\.mjs$/, ['verify:novel-reader-keyboard', 'verify:imports']],
  [/^tests\/verify_novel_list_return\.mjs$/, ['verify:novel-list-return-browser', 'verify:imports']],
  [/^tests\/verify_novel_reader_fullscreen\.mjs$/, ['verify:novel-reader-fullscreen', 'verify:imports']],
  [/^tests\/verify_novel_upload_encoding\.mjs$/, ['verify:novel-upload-encoding', 'verify:imports']],
  [/^tests\/verify_novel_book_recovery\.mjs$/, ['verify:novel-book-recovery-browser', 'verify:imports']],
  [/^tests\/verify_novel_bookmarks\.mjs$/, ['verify:novel-bookmarks-browser', 'verify:imports']],
  [/^tests\/verify_novel_author_browser\.mjs$/, ['verify:novel-author-browser', 'verify:imports']],
  [/^public\/modules\/novels\/author-browser\.js$/, ['verify:novels', 'verify:novel-summary-cache', 'verify:novel-author-browser', 'verify:novel-reader', 'verify:imports']],
  [/^public\/modules\/novels\/bookmarks\.js$/, ['verify:novels', 'verify:novel-summary-cache', 'verify:novel-bookmarks-browser', 'verify:novel-reader-browser', 'verify:novel-reader', 'verify:imports']],
  [/^public\/modules\/novels\/reader-fullscreen\.js$/, ['verify:novels', 'verify:novel-summary-cache', 'verify:novel-reader-fullscreen', 'verify:novel-reader', 'verify:imports']],
  [/^public\/modules\/novels\/list-return\.js$/, ['verify:novels', 'verify:novel-summary-cache', 'verify:novel-list-return-browser', 'verify:novel-reader-browser', 'verify:imports']],
  [/^tests\/verify_fanhao_favorite_updates\.mjs$/, ['verify:fanhao-favorite-browser', 'verify:imports']],
  [/^tests\/verify_fanhao_collection_recovery\.mjs$/, ['verify:fanhao-collection-recovery-browser', 'verify:imports']],
  [/^tests\/verify_fanhao_startup_recovery\.mjs$/, ['verify:fanhao-startup-recovery-browser', 'verify:imports']],
  [/^tests\/verify_music_alphabet_browsing\.mjs$/, ['verify:music-alphabet-browser', 'verify:imports']],
  [/^tests\/verify_manga_add_draft\.mjs$/, ['verify:manga-add-draft-browser', 'verify:imports']],
  [/^tests\/verify_fanhao_people_index_snapshot\.mjs$/, ['verify:fanhao-people-index-browser', 'verify:imports']],
  [/^tests\/verify_music_compact_rows\.mjs$/, ['verify:music-compact-rows-browser', 'verify:imports']],
  [/^tests\/verify_gallery_range_metadata\.mjs$/, ['verify:gallery-range-metadata-browser', 'verify:imports']],
  [/^tests\/verify_novel_import_navigation\.mjs$/, ['verify:novel-import-navigation-browser', 'verify:imports']],
  [/^tests\/verify_web_player_adjacent_files\.mjs$/, ['verify:web-player-adjacent-files', 'verify:imports']],
  [/^tests\/verify_gallery_zoom_anchor\.mjs$/, ['verify:gallery-zoom-anchor-browser', 'verify:imports']],
  [/^tests\/verify_music_drawer_navigation\.mjs$/, ['verify:music-drawer-navigation-browser', 'verify:imports']],
  [/^tests\/verify_novel_adjacent_navigation\.mjs$/, ['verify:novel-adjacent-navigation-browser', 'verify:imports']],
  [/^tests\/verify_fanhao_prefix_search\.mjs$/, ['verify:fanhao-prefix-search-browser', 'verify:imports']],
  [/^tests\/verify_gallery_keyboard_pan\.mjs$/, ['verify:gallery-keyboard-pan-browser', 'verify:imports']],
  [/^tests\/verify_music_sort_keyboard\.mjs$/, ['verify:music-sort-keyboard-browser', 'verify:imports']],
  [/^tests\/verify_music_load_more_keyboard\.mjs$/, ['verify:music-load-more-keyboard-browser', 'verify:imports']],
  [/^tests\/verify_novel_lan_http\.mjs$/, ['verify:novel-lan-http-browser', 'verify:imports']],
  [/^tests\/verify_fanhao_sort_controls\.mjs$/, ['verify:fanhao-sort-controls-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/people-page\.js$/, ['verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs', 'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:fanhao-sort-controls-browser', 'verify:fanhao-people-index-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/code-prefix-page\.js$/, ['verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs', 'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:fanhao-requests', 'verify:fanhao-startup-recovery-browser', 'verify:fanhao-prefix-search-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/(?:features\/works\/work-actions|features\/collections\/collection-page)\.js$/, ['verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs', 'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:fanhao-favorite-browser', 'verify:fanhao-collection-recovery-browser', 'verify:fanhao-sort-controls-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/styles\.css$/, ['verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs', 'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:fanhao-favorite-browser', 'verify:fanhao-collection-recovery-browser', 'verify:fanhao-startup-recovery-browser', 'verify:fanhao-sort-controls-browser', 'verify:fanhao-prefix-search-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/features\/works\/work-page-state\.js$/, ['verify:fanhao-requests', 'verify:fanhao-requests-browser', 'verify:work-sorting', 'verify:imports']],
  [/^public\/modules\/fanhao\/search-recovery\.js$/, ['verify:fanhao-requests', 'verify:fanhao-requests-browser', 'verify:fanhao-collection-recovery-browser', 'verify:fanhao-startup-recovery-browser', 'verify:imports']],
  [/^tests\/verify_novel_search_input\.mjs$/, ['verify:novel-search-input', 'verify:imports']],
  [/^tests\/verify_person_profile_lifecycle\.mjs$/, ['verify:person-profile-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/person-profile\.js$/, ['verify:person-organization', 'verify:person-profile-browser', 'verify:imports']],
  [/^public\/modules\/fanhao\/lazy-person-profile\.js$/, ['verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs', 'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:person-profile-browser', 'verify:imports']],
  [/^tests\/verify_novel_catalog\.mjs$/, ['verify:novel-catalog', 'verify:imports']],
  [/^public\/modules\/novels\/(?:styles|reader-refinements)\.css$/, ['verify:novel-catalog', 'verify:novel-navigation-recovery', 'verify:novel-reader-panels', 'verify:novel-reader-position', 'verify:novel-ranking-recovery', 'verify:novel-book-mutation', 'verify:novel-reader-keyboard', 'verify:novel-list-return-browser', 'verify:novel-reader-fullscreen', 'verify:novel-book-recovery-browser', 'verify:novel-bookmarks-browser', 'verify:novel-author-browser', 'verify:novel-search-input', 'verify:novel-reader-browser', 'verify:imports']],
  [/^tests\/verify_novel_reader_requests\.mjs$/, ['verify:novel-reader-browser', 'verify:novel-reader-position', 'verify:novel-ranking-recovery', 'verify:novel-book-mutation', 'verify:novel-reader-keyboard', 'verify:novel-list-return-browser', 'verify:novel-reader-fullscreen', 'verify:novel-upload-encoding', 'verify:novel-book-recovery-browser', 'verify:novel-bookmarks-browser', 'verify:novel-author-browser', 'verify:novel-search-input', 'verify:novel-reader', 'verify:novel-lan-http-browser', 'verify:novel-adjacent-navigation-browser', 'verify:novel-import-navigation-browser', 'verify:imports']],
  [/^tests\/verify_novel_collection_refresh\.mjs$/, ['verify:novel-collection-refresh', 'verify:imports']],
  [/^tests\/verify_novel_progress_(?:writer|order)\.mjs$/, ['verify:novel-progress', 'verify:imports']],
  [/^tests\/verify_novel_progress_requests\.mjs$/, ['verify:novel-progress-browser', 'verify:novel-progress', 'verify:novel-lan-http-browser', 'verify:imports']],
  [/^tests\/verify_web_novel_chapter_identity\.mjs$/, ['verify:novel-reader', 'verify:imports']],
  [/^public\/modules\/novels\/progress-writer\.js$/, ['verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-reader', 'verify:novel-reader-browser', 'verify:imports']],
  [/^public\/modules\/novels\/(?:novel-page|collection-admin)\.js$/, ['verify:novel-collection-refresh', 'verify:novel-catalog', 'verify:novel-navigation-recovery', 'verify:novel-reader-panels', 'verify:novel-reader-position', 'verify:novel-ranking-recovery', 'verify:novel-book-mutation', 'verify:novel-reader-keyboard', 'verify:novel-list-return-browser', 'verify:novel-reader-fullscreen', 'verify:novel-upload-encoding', 'verify:novel-book-recovery-browser', 'verify:novel-bookmarks-browser', 'verify:novel-author-browser', 'verify:novel-search-input', 'verify:novel-reader-browser', 'verify:novel-reader', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:browser-behavior', 'verify:novel-lan-http-browser', 'verify:novel-adjacent-navigation-browser', 'verify:novel-import-navigation-browser', 'verify:imports']],
  [/^tests\/verify_manga_reader_requests\.mjs$/, ['verify:manga-reader-browser', 'verify:manga-chapter-navigation', 'verify:manga-library-input-browser', 'verify:manga-reader-position', 'verify:manga-page-navigation-browser', 'verify:manga', 'verify:manga-add-draft-browser', 'verify:manga-directory-return-browser', 'verify:manga-directory-search-browser', 'verify:manga-library-cards-browser', 'verify:manga-library-covers-browser', 'verify:manga-fit-position-browser', 'verify:imports']],
  [/^public\/modules\/photos\/manga-page\.js$/, ['verify:manga-reader-browser', 'verify:manga-image-layout', 'verify:manga-image-retry', 'verify:manga-chapter-navigation', 'verify:manga-library-input-browser', 'verify:manga-reader-position', 'verify:manga-page-navigation-browser', 'verify:manga', 'verify:manga-add-draft-browser', 'verify:manga-directory-return-browser', 'verify:manga-directory-search-browser', 'verify:manga-library-cards-browser', 'verify:manga-library-covers-browser', 'verify:manga-fit-position-browser', 'verify:imports']],
  [/^public\/modules\/music\/api\.js$/, ['verify:music-progress', 'verify:music-progress-browser', 'verify:music-rescan-worker', 'verify:music-scale', 'verify:music-reader-browser', 'verify:imports']],
  [/^public\/modules\/music\/(?:music-progress-writer|progress-session)\.js$/, ['verify:music-progress', 'verify:music-progress-browser', 'verify:music-rescan-worker', 'verify:music-scale', 'verify:imports']],
  [/^public\/modules\/music\/views\/lyric-finder\.js$/, ['verify:music-lyric-find-browser', 'verify:music-reader-browser', 'verify:music-progress-browser', 'verify:imports']],
  [/^public\/modules\/music\/(?:music-page|views\/components)\.js$/, ['verify:music-reader-browser', 'verify:music-lyric-find-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-search-suggestions-browser', 'verify:music-playlist-dialog-browser', 'verify:music-volume-browser', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-requests', 'verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:music-sort-keyboard-browser', 'verify:music-drawer-navigation-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']],
  [/^public\/modules\/music\/styles\/player\.css$/, ['verify:music-reader-browser', 'verify:music-lyric-find-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-volume-browser', 'verify:music-track-context-browser', 'verify:music-playback-recovery-browser', 'verify:imports']],
  [/^public\/modules\/music\/styles\/responsive\.css$/, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:music-facet-cache', 'verify:music-summary-cache', 'verify:music-progress', 'verify:music-cover-async', 'verify:music-reader-browser', 'verify:music-queue-search-browser', 'verify:music-compact-rows-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']],
  [/^public\/modules\/music\/styles\/library\.css$/, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:music-facet-cache', 'verify:music-summary-cache', 'verify:music-progress', 'verify:music-cover-async', 'verify:music-reader-browser', 'verify:music-library-recovery-browser', 'verify:music-alphabet-browser', 'verify:music-load-more-keyboard-browser', 'verify:imports']],
  [/^public\/modules\/music\/actions\.js$/, ['verify:music-requests', 'verify:music-browse-navigation-browser', 'verify:music-library-recovery-browser', 'verify:music-track-context-browser', 'verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:music-queue-context-browser', 'verify:music-queue-move-browser', 'verify:music-queue-search-browser', 'verify:music-rating-browser', 'verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^public\/modules\/music\/format\.js$/, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:music-facet-cache', 'verify:music-summary-cache', 'verify:music-progress', 'verify:music-cover-async', 'verify:music-reader-browser', 'verify:music-search-dedup-browser', 'verify:imports']],
  [/^public\/modules\/music\/player\/engine\.js$/, ['verify:music-playback', 'verify:music-playback-recovery-browser', 'verify:music-reader-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^tests\/verify_work_cover_async\.mjs$/, ['verify:work-cover-async', 'verify:imports']],
  [/^tests\/verify_gallery_cover_async\.mjs$/, ['verify:gallery-cover-async', 'verify:imports']],
  [/^tests\/(?:verify_image_query_correctness|diagnose_image_query_cpu)\.mjs$/, ['verify:image-query', 'verify:imports']],
  [/^tests\/verify_image_query_cache\.mjs$/, ['verify:image-query-cache', 'verify:image-query', 'verify:imports']],
  [/^tests\/verify_video_probe_(?:cache|lifecycle)\.mjs$/, ['verify:video-probe-cache', 'verify:imports']],
  [/^tests\/verify_video_probe_cache_recovery\.mjs$/, ['verify:video-probe-cache-recovery', 'verify:imports']],
  [/^tests\/verify_(?:media_blob_worker|remote_image_lifecycle)\.mjs$/, ['verify:media-images', 'verify:imports']],
  [/^tests\/verify_media_stream_lifecycle\.mjs$/, ['verify:media-streams', 'verify:imports']],
  [/^tests\/(?:verify_web_gallery_requests|diagnose_web_gallery_navigation)\.mjs$/, ['verify:photo-reader-browser', 'verify:gallery-image-retry', 'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:gallery-image-pan', 'verify:gallery-fullscreen-browser', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:photo-reader', 'verify:gallery-keyboard-pan-browser', 'verify:gallery-zoom-anchor-browser', 'verify:gallery-range-metadata-browser', 'verify:imports']],
  [/^tests\/(?:verify_archive_(?:image_service|reader_lifecycle)\.mjs|fixtures\/archive_image_helper_fixture\.mjs)$/, ['verify:archive-images', 'verify:gallery-db', 'verify:imports']],
  [/^tests\/verify_gallery_list_rendering\.mjs$/, ['verify:gallery-rendering', 'verify:gallery-control-construction', 'verify:gallery-search-input', 'verify:gallery-list-return', 'verify:photo-reader-browser', 'verify:imports']],
  [/^tests\/verify_android_channel_rendering\.mjs$/, ['verify:android-channel-rendering', 'verify:photo-search', 'verify:imports']],
  [/^tests\/verify_android_(?:image_cache|cache_stats)\.mjs$/, ['verify:android-cache', 'verify:imports']],
  [/^tests\/fixtures\/image-library-channel-server\.mjs$/, ['verify:image-query', 'verify:image-query-cache', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^tests\/fixtures\/android-gallery-navigation-harness\.mjs$/, ['verify:android-media', 'verify:photo-search', 'verify:imports']],
  [/^public\/modules\/content-index\/(?:catalog|styles)\.css$/, ['verify:gallery-rendering', 'verify:gallery-control-construction', 'verify:gallery-search-input', 'verify:photo-reader', 'verify:photo-reader-browser', 'verify:gallery-image-retry', 'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:gallery-image-pan', 'verify:gallery-fullscreen-browser', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:gallery-list-return', 'verify:photo-search', 'verify:browser-behavior', 'verify:imports']],
  [/^public\/modules\/content-index\/gallery-(?:page|renderer)\.js$/, ['verify:gallery-rendering', 'verify:gallery-control-construction', 'verify:gallery-search-focus', 'verify:gallery-search-input', 'verify:photo-reader', 'verify:photo-reader-browser', 'verify:photo-pager-keyboard', 'verify:gallery-image-retry', 'verify:gallery-page-jump', 'verify:gallery-reader-width', 'verify:gallery-visible-loading', 'verify:gallery-image-pan', 'verify:gallery-fullscreen-browser', 'verify:gallery-catalog-recovery-browser', 'verify:gallery-summary-recovery-browser', 'verify:gallery-list-return', 'verify:photo-search', 'verify:browser-behavior', 'verify:gallery-keyboard-pan-browser', 'verify:gallery-zoom-anchor-browser', 'verify:gallery-range-metadata-browser', 'verify:imports']],
  [/^public\/(?:js\/standalone-host|standalone-app)\.js$/, ['verify:photo-reader-browser', 'verify:manga-reader-browser', 'verify:music-reader-browser', 'verify:novel-reader-browser', 'verify:photo-reader', 'verify:tools-txt-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^lib\/cover-frame\.js$/, ['verify:work-cover-async', 'verify:gallery-cover-async', 'verify:image-library', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']],
  [/^tests\/verify_novel_summary_cache\.mjs$/, ['verify:novel-summary-cache', 'verify:imports']],
  [/^tests\/verify_novel_empty_pages\.mjs$/, ['verify:novel-empty-pages', 'verify:imports']],
  [/^tests\/verify_media_detail_projection\.mjs$/, ['verify:media-detail-projection', 'verify:imports']],
  [/^tests\/verify_work_info_(?:detail_cache|summary_projection)\.mjs$/, ['verify:work-info-cache', 'verify:imports']],
  [/^tests\/verify_work_info_(?:cache_recovery|derived_cache_recovery|catalog_cache_recovery|prefix_cache_recovery)\.mjs$/, ['verify:work-info-recovery', 'verify:imports']],
  [/^tests\/fixtures\/work-info-cache-recovery\.mjs$/, ['verify:work-info-recovery', 'verify:imports']],
  [/^tests\/verify_person_page_cache_(?:keys|budget)\.mjs$/, ['verify:person-page-cache', 'verify:imports']],
  [/^tests\/verify_work_page_cache_keys\.mjs$/, ['verify:work-page-cache', 'verify:imports']],
  [/^tests\/verify_ranking_cache_recovery\.mjs$/, ['verify:ranking-cache', 'verify:imports']],
  [/^tests\/verify_actor_movie_cache_recovery\.mjs$/, ['verify:actor-movie-cache', 'verify:imports']],
  [/^tests\/verify_actor_movie_info_cache_recovery\.mjs$/, ['verify:actor-movie-info-cache', 'verify:imports']],
  [/^tests\/verify_work_detail_cache\.mjs$/, ['verify:work-detail-cache', 'verify:imports']],
  [/^tests\/(verify_novel_write_worker\.mjs|fixtures\/novel-write-worker-fault\.mjs)$/, ['verify:novel-write-worker', 'verify:imports']],
  [/^tests\/verify_novel_credentials_async\.mjs$/, ['verify:novel-credentials-async', 'verify:imports']],
  [/^tests\/(verify_novel_collection_worker\.mjs|fixtures\/novel-collection-worker-fault\.mjs)$/, ['verify:novel-collection-worker', 'verify:imports']],
  [/^tests\/verify_novel_reimport_async\.mjs$/, ['verify:novel-reimport-async', 'verify:imports']],
  [/^tools\/rescan_novel_library\.py$/, ['verify:novels', 'verify:novel-summary-cache', 'verify:imports']],
  [/^src\/modules\/novels\/server\/(?:store|routes)\.js$/, ['verify:novels', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-summary-cache', 'verify:imports']],
  [/^tests\/verify_work_facets\.mjs$/, ['verify:work-facets', 'verify:imports']],
  [/^(?:lib\/work-traits\.js|public\/modules\/fanhao\/browse-traits\.js|tests\/verify_(?:work_traits|work_trait_projection|work_browse_traits|browse_traits_browser)\.mjs)$/, ['verify:work-traits', 'verify:fanhao', 'verify:imports']],
  [/^(?:lib\/studio-marks\.js|public\/assets\/studio-marks\/|tests\/verify_studio_marks\.mjs)/, ['verify:studio-marks', 'verify:studio-cache', 'verify:imports']],
  [/^tests\/(verify_work_cache_budget|diagnose_work_cache_heap)\.mjs$/, ['verify:work-cache-budget', 'verify:work-facets', 'verify:code-prefixes', 'verify:imports']],
  [/^tests\/verify_(?:file_stream_lifecycle|file_server_async|file_server_conditional)\.mjs$/, ['verify:file-streams', 'verify:imports']],
  [/^tests\/verify_short_video_(?:media_representation|startup_cache|transcode_source)\.mjs$/, ['verify:short-video-runtime', 'verify:imports']],
  [/^tests\/verify_native_short_video_(?:recovery|manual_retry|player_callbacks|playback_requests|gallery_continuation|gallery_readiness|gallery_recovery|gallery_image_recovery|gallery_sound|interruption_advance|gallery_rebind|gallery_segment_rebind|seek_rendering|checkpoint|session|screen_awake|first_frame|cover_ownership|frame_loading|bitmap_decode|author_requests|interaction|gestures|audio|overlay_playback|audio_focus|request_lifecycle|prefetch|cache_startup)\.mjs$/, ['verify:short-video-client', 'verify:imports']],
  [/^tests\/fixtures\/NativeShortVideo(?:Playback|Checkpoint|Session)Harness\.java$/, ['verify:short-video-client', 'verify:imports']],
  [/^tests\/verify_android_short_video_(?:list_lifecycle|back|suggestions)\.mjs$/, ['verify:short-video-client', 'verify:imports']],
  [/^tests\/verify_short_video_restored_actions\.mjs$/, ['verify:short-video-client', 'verify:imports']],
  [/^tests\/verify_short_video_quality_queries\.mjs$/, ['verify:short-video-quality', 'verify:short-video-store', 'verify:imports']],
  [/^tests\/verify_short_video_store\.mjs$/, ['verify:short-video-store', 'verify:imports']],
  [/^tests\/verify_short_video_(?:keyboard|playback_settings|playback_recovery|first_frame|switch|navigation|media_cache|seek|buffered_progress|hold_speed|gestures|wheel|auto_next|watch_resume|watch_queue|gallery_handoff|gallery_metadata|gallery_loading|author_handoff|playback_attempts|sound_preview|sound_focus|modal_playback|panel_loading|share_lifecycle|author_opening|fullscreen|picture_in_picture|picture_controls|seek_rendering|gallery_frames|progress_loop|caption|reel_metadata|interaction_state|tap_intent|page_lifecycle|adjacent_visibility|gallery_sound|author_disposal|author_lifecycle_async|comments_lifecycle|comments_loading|prewarm_budget|startup_preload|collection_restore|collection_lifecycle|list_lifecycle|delete_playback|transcode_page|transcode_lifecycle|read_request|detail_requests|detail_loading|retry_intent)\.mjs$/, ['verify:short-video-playback', 'verify:imports']],
  [/^tests\/(?:verify_short_video_incremental_sync|fixtures\/short-video-sync-journal)\.mjs$/, ['verify:short-video-sync', 'verify:imports']],
  [/^tests\/verify_short_video_(?:image_sources|image_lifecycle|product_lifecycle)\.mjs$/, ['verify:short-video-images', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']],
  [/^tests\/verify_(?:actor_avatar_import|actor_profile_atomicity|actor_profile_reservation_guards|core_image_store)\.mjs$/, ['verify:actor-avatar-import', 'verify:core-images', 'verify:imports']],
  [/^src\/modules\/(?:fanhao\/server\/(?:people\/actor-avatar-service|admin\/admin-actor-avatar-service)|system\/server\/admin\/routes)\.js$/, ['verify:actor-avatar-import', 'verify:core-images', 'verify:fanhao', 'verify:settings', 'verify:auth', 'verify:mutation-auth', 'verify:imports']],
  [/^tests\/verify_static_file_lifecycle\.mjs$/, ['verify:static-files', 'verify:auth', 'verify:mutation-auth', 'verify:imports']],
  [/^tests\/verify_(?:module_lifecycle|server_shutdown_lifecycle)\.mjs$/, ['verify:shutdown', 'verify:imports']],
  [/^(?:src\/modules\/fanhao\/server\/workflows\/(?:file-workflow-service|routes)\.js|tools\/fanhao_file_workflows\.mjs|tests\/verify_file_workflows\.mjs)$/, ['verify:file-workflows', 'verify:imports']],
  [/^public\/modules\/fanhao\/file-workflows\//, ['verify:file-workflows-ui', 'verify:imports']],
  [/^(?:src\/fanhao\/module-registry|src\/platform\/server\/server-host)\.js$/, ['verify:modules', 'verify:shutdown', 'verify:products', 'verify:startup', 'verify:imports']],
  [/^(?:src\/platform\/server\/(?:static-files|http-app)\.js|src\/apps\/short-video-server\.js|tests\/verify_file_workflows_ui\.mjs)$/, ['verify:static-files', 'verify:shutdown', 'verify:products', 'verify:auth', 'verify:accounts', 'verify:mutation-auth', 'verify:startup', 'verify:file-workflows-ui', 'verify:imports']],
  [/^(src\/modules\/short-videos\/|public\/modules\/short-videos\/)/, [
    'verify:short-video-collections', 'verify:short-video-delete-jobs',
    'verify:short-video-store', 'verify:short-video-sync', 'verify:short-video-actions',
    'verify:short-video-watch-write', 'verify:short-video-runtime',
    'verify:short-video-images',
    'verify:short-video-stats-performance', 'verify:short-video-like-distribution-worker',
    'verify:short-video-build', 'verify:short-video-client', 'verify:short-video-playback', 'verify:douyin-manager',
    'verify:imports',
  ]],
  [/^(src\/modules\/novels\/|public\/modules\/novels\/)/, ['verify:novels', 'verify:novel-summary-cache', 'verify:imports']],
  [/^(src\/modules\/music\/|public\/modules\/music\/)/, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:music-facet-cache', 'verify:music-summary-cache', 'verify:music-progress', 'verify:music-cover-async', 'verify:imports']],
  [/^src\/modules\/photos\/server\/manga-(?:service|database)\.js$/, ['verify:manga', 'verify:manga-lookup', 'verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^src\/modules\/photos\/server\/stored-zip-stream\.js$/, ['verify:manga-streams', 'verify:manga-download', 'verify:imports']],
  [/^src\/modules\/content-index\/server\/(?:image-library(?:-index)?-service|image-query-cache)\.js$/, ['verify:image-library', 'verify:gallery-db', 'verify:archive-images', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:photo-reader', 'verify:photo-search', 'verify:imports']],
  [/^(?:src\/modules\/content-index\/server\/image-gallery-db-service|lib\/gallery-metadata-revision)\.js$/, ['verify:image-library', 'verify:gallery-db', 'verify:gallery-cover-async', 'verify:archive-images', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:photo-reader', 'verify:photo-search', 'verify:imports']],
  [/^src\/modules\/media\/server\/gallery-metadata-service\.js$/, ['verify:image-library', 'verify:gallery-cover-async', 'verify:video-playback', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^(src\/modules\/media\/|public\/modules\/media\/)/, ['verify:image-library', 'verify:gallery-cover-async', 'verify:video-playback', 'verify:imports']],
  [/^(src\/modules\/(photos|content-index)\/|public\/modules\/(photos|content-index)\/)/, [
    'verify:image-library', 'verify:gallery-db', 'verify:archive-images', 'verify:photo-reader', 'verify:photo-search', 'verify:imports',
  ]],
  [/^src\/modules\/fanhao\/server\/library\/(?:cache-contracts|table-stamp-query)\.js$/, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']],
  [/^src\/modules\/fanhao\/server\/catalog\/(?:studio|code-prefix)-service\.js$/, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']],
  [/^(?:src\/modules\/fanhao\/server\/people\/person-organization-service\.js|public\/modules\/fanhao\/person-(?:profile|organization)\.js|tools\/(?:organize_person_library\.mjs|fetch_person_organization_metadata\.py)|tests\/verify_person_organization.*)$/, ['verify:person-organization', 'verify:imports']],
  [/^(src\/modules\/fanhao\/|public\/modules\/fanhao\/)/, [
    'verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs',
    'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:imports',
  ]],
  [/^(src\/modules\/market-dashboard\/|public\/modules\/market-dashboard\/)/, ['verify:market-dashboard', 'verify:imports']],
  [/^public\/games\/gomoku\//, ['verify:gomoku', 'verify:tools-gomoku-browser', 'verify:imports']],
  [/^public\/games\/2048\//, ['verify:tools-2048-browser', 'verify:imports']],
  [/^public\/games\/jump\//, ['verify:jump', 'verify:imports']],
  [/^src\/modules\/system\/server\/android-update\//, [
    'verify:android-release-workflow', 'verify:android-update-streams', 'verify:android-security', 'verify:auth',
    'verify:mutation-auth', 'verify:system-control', 'verify:imports',
  ]],
  [/^(src\/modules\/system\/|public\/modules\/system\/)/, ['verify:system-control', 'verify:settings', 'verify:imports']],
  [/^src\/platform\/server\/file-server\.js$/, [
    'verify:auth', 'verify:mutation-auth', 'verify:image-library', 'verify:video-playback', 'verify:android-update-streams', 'verify:manga-streams',
    'verify:music-scale', 'verify:music-cover-async', 'verify:short-video-images', 'verify:short-video-actions',
    'verify:archive-images', 'verify:products', 'verify:imports',
  ]],
  [/^src\/platform\/server\/(?:media-response-service|local-image-read-queue|remote-image-warm-queue|media-stream-service|media-blob-worker(?:-client)?)\.js$/, [
    'verify:auth', 'verify:mutation-auth', 'verify:image-library', 'verify:video-playback',
    'verify:music-scale', 'verify:music-cover-async', 'verify:short-video-images', 'verify:media-images', 'verify:media-streams', 'verify:cover-cache-status', 'verify:imports',
  ]],
  [/^server\.js$/, ['verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:shutdown', 'verify:static-files', 'verify:fanhao', 'verify:studio-cache', 'verify:works-performance', 'verify:video-probe-cache', 'verify:music-cover-async', 'verify:gallery-cover-async', 'verify:media-images', 'verify:media-streams', 'verify:file-streams', 'verify:android-update-streams', 'verify:manga-streams', 'verify:archive-images', 'verify:products', 'verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^src\/platform\/server\/video-probe(?:(?:-cache)?-service|-task-pool)\.js$/, ['verify:video-probe-cache', 'verify:video-playback', 'verify:fanhao', 'verify:imports']],
  [/^src\/platform\/server\/(?:archive-image-service|archive-task-pool|image-reader-cache-service)\.js$/, ['verify:archive-images', 'verify:gallery-db', 'verify:photo-reader', 'verify:imports']],
  [/^(src\/platform\/server\/|server\.js$)/, ['verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:imports']],
  [/^(package(-lock)?\.json|tests\/run_verification\.mjs|tests\/verify_verification_runner\.mjs)$/, FULL_SCRIPTS],
];

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function selectScripts(files) {
  const selected = new Set();
  const unknownSourceFiles = [];
  for (const rawFile of files) {
    const file = normalizePath(rawFile);
    const matching = RULES.find(([pattern]) => pattern.test(file));
    if (!matching) {
      if (/^(src|public|android-client|tools|tests)\//.test(file) || /\.(mjs|js|cjs|ts|java|py|ps1)$/.test(file)) {
        unknownSourceFiles.push(file);
        FULL_SCRIPTS.forEach((script) => selected.add(script));
      } else {
        DAILY_SCRIPTS.forEach((script) => selected.add(script));
      }
      continue;
    }
    matching[1].forEach((script) => selected.add(script));
  }
  if (files.length === 0) DAILY_SCRIPTS.forEach((script) => selected.add(script));
  return { scripts: [...selected], unknownSourceFiles };
}

function splitScript(command) {
  return command.split(/\s+&&\s+/).map((part) => part.trim()).filter(Boolean);
}

export function expandCommands(entries, scripts) {
  const commands = [];
  const seen = new Set();
  const active = new Set();
  function add(command) {
    const npmScript = command.match(/^npm run ([\w:-]+)$/);
    if (npmScript && scripts[npmScript[1]]) {
      expand(npmScript[1]);
      return;
    }
    if (!seen.has(command)) {
      seen.add(command);
      commands.push(command);
    }
  }
  function expand(name) {
    if (active.has(name)) throw new Error(`Circular npm script reference: ${name}`);
    const command = scripts[name];
    if (!command) throw new Error(`Missing npm script: ${name}`);
    active.add(name);
    if (scripts[`pre${name}`]) expand(`pre${name}`);
    splitScript(command).forEach(add);
    if (scripts[`post${name}`]) expand(`post${name}`);
    active.delete(name);
  }
  for (const entry of entries) {
    if (entry.startsWith('command:')) add(entry.slice('command:'.length));
    else expand(entry);
  }
  return commands;
}

export function parseNullTerminatedPaths(output) {
  return output.toString('utf8').split('\0').filter(Boolean).map(normalizePath);
}

export function isGeneratedCacheOnlyChange(file, before, after) {
  const prefix = 'android-client/www/';
  if (!file.startsWith(prefix) || !/\.(?:js|mjs|css|html)$/i.test(file) || before === after) return false;
  const relativePath = file.slice(prefix.length);
  const beforeLf = before.replace(/\r\n/g, '\n');
  const afterLf = after.replace(/\r\n/g, '\n');
  return beforeLf !== afterLf
    && normalizeAndroidCacheSource(relativePath, before) === normalizeAndroidCacheSource(relativePath, after);
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT });
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function gitFile(ref) {
  const result = spawnSync('git', ['show', ref], { cwd: REPO_ROOT });
  if (result.status !== 0) return null;
  return result.stdout.toString('utf8');
}

function gitChangedFiles() {
  const unstaged = parseNullTerminatedPaths(runGit(['diff', '--name-only', '-z']));
  const staged = parseNullTerminatedPaths(runGit(['diff', '--cached', '--name-only', '-z']));
  const untracked = parseNullTerminatedPaths(runGit(['ls-files', '--others', '--exclude-standard', '-z']));
  const unstagedModified = new Set(parseNullTerminatedPaths(runGit(['diff', '--name-only', '--diff-filter=M', '-z'])));
  const stagedModified = new Set(parseNullTerminatedPaths(runGit(['diff', '--cached', '--name-only', '--diff-filter=M', '-z'])));
  const files = new Set([...unstaged, ...staged, ...untracked]);
  const filteredCacheFiles = [];
  for (const file of files) {
    if (!file.startsWith('android-client/www/') || untracked.includes(file)) continue;
    let cacheOnly = true;
    if (unstaged.includes(file)) {
      if (!unstagedModified.has(file)) cacheOnly = false;
      else {
        const before = gitFile(`:${file}`);
        const after = readFileSync(path.join(REPO_ROOT, ...file.split('/')), 'utf8');
        cacheOnly &&= before !== null && isGeneratedCacheOnlyChange(file, before, after);
      }
    }
    if (staged.includes(file)) {
      if (!stagedModified.has(file)) cacheOnly = false;
      else {
        const before = gitFile(`HEAD:${file}`);
        const after = gitFile(`:${file}`);
        cacheOnly &&= before !== null && after !== null && isGeneratedCacheOnlyChange(file, before, after);
      }
    }
    if (cacheOnly) {
      files.delete(file);
      filteredCacheFiles.push(file);
    }
  }
  return { files: [...files], filteredCacheFiles };
}

function parseArgs(argv) {
  const mode = argv[0] || 'daily';
  let plan = false;
  let explicitFiles = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') plan = true;
    else if (argument === '--files') {
      explicitFiles = [];
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) explicitFiles.push(argv[++index]);
      if (explicitFiles.length === 0) throw new Error('--files requires at least one path');
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (explicitFiles && mode !== 'changed') throw new Error('--files is only valid in changed mode');
  return { mode, plan, explicitFiles };
}

function printPlan(mode, files, entries, commands, unknownSourceFiles, filteredCacheFiles = []) {
  console.log(`Verification mode: ${mode}`);
  if (files) {
    console.log(`Changed files (${files.length}):`);
    files.forEach((file) => console.log(`  - ${file}`));
  }
  if (filteredCacheFiles.length > 0) {
    console.log(`Filtered generated Android cache-version changes (${filteredCacheFiles.length}); explicit --files still includes them.`);
  }
  console.log(`Checks (${entries.length} entry points, ${commands.length} unique commands):`);
  entries.forEach((entry) => console.log(`  - ${entry.replace(/^command:/, '')}`));
  const cacheSync = commands.find((command) => command === 'npm --prefix android-client run sync:cache');
  if (cacheSync) console.log(`Planned generated-file write before Android checks: ${cacheSync}`);
  if (unknownSourceFiles.length > 0) {
    console.warn('Unknown source scope detected; the plan conservatively includes the full verification suite:');
    unknownSourceFiles.forEach((file) => console.warn(`  - ${file}`));
  }
}

export function main(argv = process.argv.slice(2)) {
  const { mode, plan, explicitFiles } = parseArgs(argv);
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let files = null;
  let entries;
  let unknownSourceFiles = [];
  let filteredCacheFiles = [];
  if (mode === 'daily') entries = DAILY_SCRIPTS;
  else if (mode === 'web') entries = WEB_SCRIPTS;
  else if (mode === 'android') entries = ANDROID_SCRIPTS;
  else if (mode === 'full') entries = FULL_SCRIPTS;
  else if (mode === 'changed') {
    if (explicitFiles) files = explicitFiles;
    else ({ files, filteredCacheFiles } = gitChangedFiles());
    ({ scripts: entries, unknownSourceFiles } = selectScripts(files));
  } else throw new Error(`Unknown verification mode: ${mode}`);

  const commands = expandCommands(entries, packageJson.scripts);
  printPlan(mode, files, entries, commands, unknownSourceFiles, filteredCacheFiles);
  if (plan) return;
  for (const command of commands) {
    console.log(`\n> ${command}`);
    const result = spawnSync(command, { cwd: REPO_ROOT, shell: true, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(`Verification passed: ${mode} (${commands.length} commands)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
