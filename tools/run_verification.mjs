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
  'verify:modules',
  'verify:imports',
  'verify:verification-runner',
  'verify:fanhao-requests',
  'verify:work-sorting',
  'verify:work-facets',
  'verify:work-cache-budget',
];

export const FULL_SCRIPTS = [
  'verify:repo-hygiene', 'verify:auth', 'verify:accounts', 'verify:mutation-auth',
  'verify:android-security', 'verify:android-gradle-config', 'verify:android-client',
  'verify:android-system-control', 'verify:codes', 'verify:metadata',
  'verify:javdb-card-facts', 'verify:library-merge', 'verify:core-images',
  'verify:gallery-db', 'verify:image-library', 'verify:photo-reader', 'verify:manga',
  'verify:archive-images', 'verify:photo-search', 'verify:music-rescan-worker',
  'verify:music-scale', 'verify:video-playback', 'verify:person-work-associations',
  'verify:person-identity',
  'verify:work-move-jobs', 'verify:android-work-move', 'verify:access-log',
  'verify:access-analytics', 'verify:novels', 'verify:short-video-collections',
  'verify:short-video-delete-jobs', 'verify:short-video-store',
  'verify:short-video-actions', 'verify:short-video-watch-write',
  'verify:short-video-runtime', 'verify:short-video-stats-performance',
  'verify:short-video-like-distribution-worker', 'verify:short-video-build',
  'verify:short-video-client', 'verify:browser-behavior', 'verify:douyin-manager',
  'verify:settings', 'verify:system-control', 'verify:market-dashboard',
  'verify:gomoku', 'verify:jump', 'verify:modules', 'verify:disk-usage',
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
  'verify:music-requests', 'verify:music-reader-browser',
  'verify:novel-reader', 'verify:novel-reader-browser',
  'verify:novel-progress', 'verify:novel-progress-browser',
  'verify:manga-lookup', 'verify:music-facet-cache',
  'verify:music-progress', 'verify:music-progress-browser',
  'verify:music-summary-cache', 'verify:studio-cache', 'verify:android-music-rendering',
  'verify:static-files', 'verify:shutdown', 'verify:gallery-rendering', 'verify:short-video-images', 'verify:actor-avatar-import',
  'verify:android-channel-rendering',
];

export const ANDROID_SCRIPTS = [
  'verify:android-security', 'verify:android-gradle-config', 'verify:android-client',
  'verify:android-system-control', 'verify:android-work-move', 'verify:android-novel-ui',
  'verify:short-video-client', 'verify:auth', 'verify:mutation-auth', 'verify:imports',
  'verify:android-music-rendering',
  'verify:android-channel-rendering',
];

const ANDROID_DOMAIN_BASE = ['verify:android-security', 'verify:auth', 'verify:mutation-auth', 'verify:imports'];

const RULES = [
  [/^(\.codex-artifacts|\.codex-remote-attachments|data\/design-audits)\//, []],
  [/^docs\//, ['command:npm --prefix docs test', 'command:npm --prefix docs run build']],
  [/^android-client\/www\/platform\/content-index\/channel-views\.js$/, [...ANDROID_DOMAIN_BASE, 'verify:android-media', 'verify:android-photos', 'verify:android-channel-rendering', 'verify:photo-search', 'verify:browser-behavior']],
  [/^android-client\/www\/modules\/novels\//, [...ANDROID_DOMAIN_BASE, 'verify:android-novels']],
  [/^android-client\/www\/modules\/music\//, [...ANDROID_DOMAIN_BASE, 'verify:android-music', 'verify:music-progress', 'verify:android-music-rendering']],
  [/^android-client\/www\/modules\/(media|anime)\//, [...ANDROID_DOMAIN_BASE, 'verify:android-media']],
  [/^android-client\/www\/modules\/(photos|vision)\//, [...ANDROID_DOMAIN_BASE, 'verify:android-photos']],
  [/^android-client\/www\/modules\/short-videos\//, [...ANDROID_DOMAIN_BASE, 'verify:short-video-client']],
  [/^android-client\/android\/app\/src\/main\/java\/.*Novel/i, [...ANDROID_DOMAIN_BASE, 'verify:android-novels']],
  [/^android-client\/android\/app\/src\/main\/java\/.*Music/i, [...ANDROID_DOMAIN_BASE, 'verify:android-music']],
  [/^android-client\/android\/app\/src\/main\/java\/.*ShortVideo/i, [...ANDROID_DOMAIN_BASE, 'verify:short-video-client']],
  [/^android-client\/android\/app\/src\/main\/java\/.*(Media|Video|Anime)/i, [...ANDROID_DOMAIN_BASE, 'verify:android-media']],
  [/^android-client\/android\/app\/src\/main\/java\/.*(Photo|Gallery|Vision|Camera)/i, [...ANDROID_DOMAIN_BASE, 'verify:android-photos']],
  [/^android-client\//, ANDROID_SCRIPTS],
  [/^(src\/modules\/short-videos\/download-manager\/|tools\/verify_douyin_(?:download_manager|manager)_.*\.(?:mjs|ps1)$)/, ['verify:douyin-manager', 'verify:imports']],
  [/^tools\/verify_(?:fanhao_requests|work_sorting|code_prefix_catalog)\.mjs$/, ['verify:fanhao-requests', 'verify:work-sorting', 'verify:code-prefixes', 'verify:imports']],
  [/^tools\/verify_code_prefix_cache_budget\.mjs$/, ['verify:code-prefixes', 'verify:work-cache-budget', 'verify:imports']],
  [/^tools\/verify_music_cover_async\.mjs$/, ['verify:music-cover-async', 'verify:imports']],
  [/^tools\/verify_music_facet_cache\.mjs$/, ['verify:music-facet-cache', 'verify:music-scale', 'verify:imports']],
  [/^tools\/verify_music_(?:summary_reuse|active_catalogue)\.mjs$/, ['verify:music-summary-cache', 'verify:music-scale', 'verify:imports']],
  [/^tools\/verify_studio_cache_dependencies\.mjs$/, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']],
  [/^tools\/verify_android_music_list_rendering\.mjs$/, ['verify:android-music-rendering', 'verify:android-music', 'verify:imports']],
  [/^tools\/verify_android_music_(?:catalogue|playback|transition)_requests\.mjs$/, ['verify:android-music', 'verify:android-music-rendering', 'verify:imports']],
  [/^tools\/verify_music_progress_(?:writer|clients|order)\.mjs$/, ['verify:music-progress', 'verify:imports']],
  [/^tools\/verify_music_progress_requests\.mjs$/, ['verify:music-progress-browser', 'verify:music-progress', 'verify:imports']],
  [/^tools\/verify_manga_lookup_performance\.mjs$/, ['verify:manga-lookup', 'verify:manga', 'verify:imports']],
  [/^tools\/verify_music_playback_lifecycle\.mjs$/, ['verify:music-playback', 'verify:imports']],
  [/^tools\/verify_music_request_ownership\.mjs$/, ['verify:music-requests', 'verify:imports']],
  [/^tools\/verify_music_reader_requests\.mjs$/, ['verify:music-reader-browser', 'verify:music-requests', 'verify:imports']],
  [/^tools\/verify_novel_reader_requests\.mjs$/, ['verify:novel-reader-browser', 'verify:novel-reader', 'verify:imports']],
  [/^tools\/verify_novel_progress_(?:writer|order)\.mjs$/, ['verify:novel-progress', 'verify:imports']],
  [/^tools\/verify_novel_progress_requests\.mjs$/, ['verify:novel-progress-browser', 'verify:novel-progress', 'verify:imports']],
  [/^tools\/verify_web_novel_chapter_identity\.mjs$/, ['verify:novel-reader', 'verify:imports']],
  [/^public\/modules\/novels\/progress-writer\.js$/, ['verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-reader', 'verify:novel-reader-browser', 'verify:imports']],
  [/^public\/modules\/novels\/(?:novel-page|collection-admin)\.js$/, ['verify:novel-reader-browser', 'verify:novel-reader', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^tools\/verify_manga_reader_requests\.mjs$/, ['verify:manga-reader-browser', 'verify:manga', 'verify:imports']],
  [/^public\/modules\/photos\/manga-page\.js$/, ['verify:manga-reader-browser', 'verify:manga', 'verify:imports']],
  [/^public\/modules\/music\/(?:music-progress-writer|progress-session|api)\.js$/, ['verify:music-progress', 'verify:music-progress-browser', 'verify:music-rescan-worker', 'verify:music-scale', 'verify:imports']],
  [/^public\/modules\/music\/music-page\.js$/, ['verify:music-reader-browser', 'verify:music-requests', 'verify:music-playback', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^public\/modules\/music\/actions\.js$/, ['verify:music-requests', 'verify:music-reader-browser', 'verify:music-playback', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^public\/modules\/music\/player\/engine\.js$/, ['verify:music-playback', 'verify:music-reader-browser', 'verify:music-progress', 'verify:music-progress-browser', 'verify:browser-behavior', 'verify:imports']],
  [/^tools\/verify_work_cover_async\.mjs$/, ['verify:work-cover-async', 'verify:imports']],
  [/^tools\/verify_gallery_cover_async\.mjs$/, ['verify:gallery-cover-async', 'verify:imports']],
  [/^tools\/(?:verify_image_query_correctness|diagnose_image_query_cpu)\.mjs$/, ['verify:image-query', 'verify:imports']],
  [/^tools\/verify_video_probe_(?:cache|lifecycle)\.mjs$/, ['verify:video-probe-cache', 'verify:imports']],
  [/^tools\/verify_(?:media_blob_worker|remote_image_lifecycle)\.mjs$/, ['verify:media-images', 'verify:imports']],
  [/^tools\/verify_media_stream_lifecycle\.mjs$/, ['verify:media-streams', 'verify:imports']],
  [/^tools\/(?:verify_web_gallery_requests|diagnose_web_gallery_navigation)\.mjs$/, ['verify:photo-reader-browser', 'verify:photo-reader', 'verify:imports']],
  [/^tools\/(?:verify_archive_(?:image_service|reader_lifecycle)\.mjs|fixtures\/archive_image_helper_fixture\.mjs)$/, ['verify:archive-images', 'verify:gallery-db', 'verify:imports']],
  [/^tools\/verify_gallery_list_rendering\.mjs$/, ['verify:gallery-rendering', 'verify:photo-reader-browser', 'verify:imports']],
  [/^tools\/verify_android_channel_rendering\.mjs$/, ['verify:android-channel-rendering', 'verify:photo-search', 'verify:imports']],
  [/^tools\/fixtures\/image-library-channel-server\.mjs$/, ['verify:image-query', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^public\/modules\/content-index\/(?:catalog|styles)\.css$/, ['verify:gallery-rendering', 'verify:photo-reader', 'verify:photo-reader-browser', 'verify:photo-search', 'verify:browser-behavior', 'verify:imports']],
  [/^public\/modules\/content-index\/gallery-(?:page|renderer)\.js$/, ['verify:gallery-rendering', 'verify:photo-reader', 'verify:photo-reader-browser', 'verify:photo-search', 'verify:browser-behavior', 'verify:imports']],
  [/^public\/(?:js\/standalone-host|standalone-app)\.js$/, ['verify:photo-reader-browser', 'verify:manga-reader-browser', 'verify:music-reader-browser', 'verify:novel-reader-browser', 'verify:photo-reader', 'verify:browser-behavior', 'verify:imports']],
  [/^lib\/cover-frame\.js$/, ['verify:work-cover-async', 'verify:gallery-cover-async', 'verify:image-library', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']],
  [/^tools\/verify_novel_summary_cache\.mjs$/, ['verify:novel-summary-cache', 'verify:imports']],
  [/^tools\/(verify_novel_write_worker\.mjs|fixtures\/novel-write-worker-fault\.mjs)$/, ['verify:novel-write-worker', 'verify:imports']],
  [/^tools\/verify_novel_credentials_async\.mjs$/, ['verify:novel-credentials-async', 'verify:imports']],
  [/^tools\/(verify_novel_collection_worker\.mjs|fixtures\/novel-collection-worker-fault\.mjs)$/, ['verify:novel-collection-worker', 'verify:imports']],
  [/^tools\/verify_novel_reimport_async\.mjs$/, ['verify:novel-reimport-async', 'verify:imports']],
  [/^tools\/rescan_novel_library\.py$/, ['verify:novels', 'verify:novel-summary-cache', 'verify:imports']],
  [/^src\/modules\/novels\/server\/(?:store|routes)\.js$/, ['verify:novels', 'verify:novel-progress', 'verify:novel-progress-browser', 'verify:novel-summary-cache', 'verify:imports']],
  [/^tools\/verify_work_facets\.mjs$/, ['verify:work-facets', 'verify:imports']],
  [/^tools\/(verify_work_cache_budget|diagnose_work_cache_heap)\.mjs$/, ['verify:work-cache-budget', 'verify:work-facets', 'verify:code-prefixes', 'verify:imports']],
  [/^tools\/verify_(?:file_stream_lifecycle|file_server_async)\.mjs$/, ['verify:file-streams', 'verify:imports']],
  [/^tools\/verify_short_video_quality_queries\.mjs$/, ['verify:short-video-quality', 'verify:short-video-store', 'verify:imports']],
  [/^tools\/verify_short_video_store\.mjs$/, ['verify:short-video-store', 'verify:imports']],
  [/^tools\/verify_short_video_(?:image_sources|image_lifecycle|product_lifecycle)\.mjs$/, ['verify:short-video-images', 'verify:short-video-store', 'verify:short-video-runtime', 'verify:imports']],
  [/^tools\/verify_(?:actor_avatar_import|actor_profile_atomicity|actor_profile_reservation_guards|core_image_store)\.mjs$/, ['verify:actor-avatar-import', 'verify:core-images', 'verify:imports']],
  [/^src\/modules\/(?:fanhao\/server\/(?:people\/actor-avatar-service|admin\/admin-actor-avatar-service)|system\/server\/admin\/routes)\.js$/, ['verify:actor-avatar-import', 'verify:core-images', 'verify:fanhao', 'verify:settings', 'verify:auth', 'verify:mutation-auth', 'verify:imports']],
  [/^tools\/verify_static_file_lifecycle\.mjs$/, ['verify:static-files', 'verify:auth', 'verify:mutation-auth', 'verify:imports']],
  [/^tools\/verify_(?:module_lifecycle|server_shutdown_lifecycle)\.mjs$/, ['verify:shutdown', 'verify:imports']],
  [/^(?:src\/fanhao\/module-registry|src\/platform\/server\/server-host)\.js$/, ['verify:modules', 'verify:shutdown', 'verify:products', 'verify:startup', 'verify:imports']],
  [/^(?:src\/platform\/server\/(?:static-files|http-app)\.js|src\/apps\/short-video-server\.js|tools\/verify_file_workflows_ui\.mjs)$/, ['verify:static-files', 'verify:shutdown', 'verify:products', 'verify:auth', 'verify:accounts', 'verify:mutation-auth', 'verify:startup', 'verify:file-workflows-ui', 'verify:imports']],
  [/^(src\/modules\/short-videos\/|public\/modules\/short-videos\/)/, [
    'verify:short-video-collections', 'verify:short-video-delete-jobs',
    'verify:short-video-store', 'verify:short-video-actions',
    'verify:short-video-watch-write', 'verify:short-video-runtime',
    'verify:short-video-images',
    'verify:short-video-stats-performance', 'verify:short-video-like-distribution-worker',
    'verify:short-video-build', 'verify:short-video-client', 'verify:douyin-manager',
    'verify:imports',
  ]],
  [/^(src\/modules\/novels\/|public\/modules\/novels\/)/, ['verify:novels', 'verify:novel-summary-cache', 'verify:imports']],
  [/^(src\/modules\/music\/|public\/modules\/music\/)/, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:music-facet-cache', 'verify:music-summary-cache', 'verify:music-progress', 'verify:music-cover-async', 'verify:imports']],
  [/^src\/modules\/photos\/server\/manga-(?:service|database)\.js$/, ['verify:manga', 'verify:manga-lookup', 'verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^src\/modules\/content-index\/server\/image-library(?:-index)?-service\.js$/, ['verify:image-library', 'verify:gallery-db', 'verify:archive-images', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:photo-reader', 'verify:photo-search', 'verify:imports']],
  [/^(?:src\/modules\/content-index\/server\/image-gallery-db-service|lib\/gallery-metadata-revision)\.js$/, ['verify:image-library', 'verify:gallery-db', 'verify:gallery-cover-async', 'verify:archive-images', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:photo-reader', 'verify:photo-search', 'verify:imports']],
  [/^src\/modules\/media\/server\/gallery-metadata-service\.js$/, ['verify:image-library', 'verify:gallery-cover-async', 'verify:video-playback', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^(src\/modules\/media\/|public\/modules\/media\/)/, ['verify:image-library', 'verify:gallery-cover-async', 'verify:video-playback', 'verify:imports']],
  [/^(src\/modules\/(photos|content-index)\/|public\/modules\/(photos|content-index)\/)/, [
    'verify:image-library', 'verify:gallery-db', 'verify:archive-images', 'verify:photo-reader', 'verify:photo-search', 'verify:imports',
  ]],
  [/^src\/modules\/fanhao\/server\/library\/(?:cache-contracts|table-stamp-query)\.js$/, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']],
  [/^src\/modules\/fanhao\/server\/catalog\/(?:studio|code-prefix)-service\.js$/, ['verify:studio-cache', 'verify:fanhao', 'verify:imports']],
  [/^(src\/modules\/fanhao\/|public\/modules\/fanhao\/)/, [
    'verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs',
    'verify:fanhao-requests-browser', 'verify:works-performance', 'verify:imports',
  ]],
  [/^(src\/modules\/market-dashboard\/|public\/modules\/market-dashboard\/)/, ['verify:market-dashboard', 'verify:imports']],
  [/^public\/games\/gomoku\//, ['verify:gomoku', 'verify:imports']],
  [/^public\/games\/jump\//, ['verify:jump', 'verify:imports']],
  [/^src\/modules\/system\/server\/android-update\//, [
    'verify:android-release-workflow', 'verify:android-security', 'verify:auth',
    'verify:mutation-auth', 'verify:system-control', 'verify:imports',
  ]],
  [/^(src\/modules\/system\/|public\/modules\/system\/)/, ['verify:system-control', 'verify:settings', 'verify:imports']],
  [/^src\/platform\/server\/file-server\.js$/, [
    'verify:auth', 'verify:mutation-auth', 'verify:image-library', 'verify:video-playback',
    'verify:music-scale', 'verify:music-cover-async', 'verify:short-video-images', 'verify:short-video-actions',
    'verify:archive-images', 'verify:products', 'verify:imports',
  ]],
  [/^src\/platform\/server\/(?:media-response-service|local-image-read-queue|remote-image-warm-queue|media-stream-service|media-blob-worker(?:-client)?)\.js$/, [
    'verify:auth', 'verify:mutation-auth', 'verify:image-library', 'verify:video-playback',
    'verify:music-scale', 'verify:music-cover-async', 'verify:short-video-images', 'verify:media-images', 'verify:media-streams', 'verify:cover-cache-status', 'verify:imports',
  ]],
  [/^server\.js$/, ['verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:shutdown', 'verify:static-files', 'verify:fanhao', 'verify:studio-cache', 'verify:works-performance', 'verify:video-probe-cache', 'verify:music-cover-async', 'verify:gallery-cover-async', 'verify:media-images', 'verify:media-streams', 'verify:file-streams', 'verify:archive-images', 'verify:products', 'verify:image-library', 'verify:gallery-rendering', 'verify:android-channel-rendering', 'verify:imports']],
  [/^src\/platform\/server\/video-probe(?:(?:-cache)?-service|-task-pool)\.js$/, ['verify:video-probe-cache', 'verify:video-playback', 'verify:fanhao', 'verify:imports']],
  [/^src\/platform\/server\/(?:archive-image-service|archive-task-pool|image-reader-cache-service)\.js$/, ['verify:archive-images', 'verify:gallery-db', 'verify:photo-reader', 'verify:imports']],
  [/^(src\/platform\/server\/|server\.js$)/, ['verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:imports']],
  [/^(package(-lock)?\.json|tools\/run_verification\.mjs|tools\/verify_verification_runner\.mjs)$/, FULL_SCRIPTS],
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
      if (/^(src|public|android-client|tools)\//.test(file) || /\.(mjs|js|cjs|ts|java|py|ps1)$/.test(file)) {
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
