# FanHao Server Architecture

FanHao is moving from a single large server file toward a reusable local-media app framework. The migration should stay incremental: keep behavior stable, extract shared infrastructure first, then move domain modules out one at a time.

## Runtime Roles

- `server.js` is the composition root. It wires configuration, stores, core services, route modules, and startup.
- `src/server/*` contains reusable server infrastructure and domain stores/routes.
- `tools/*` contains batch jobs and heavier maintenance scripts. Long-running scan/import/transcode work should continue moving out of the request path and into tools or workers.
- `data/*` owns local state and SQLite databases.
- `public/*` and `android-client/www/*` are client surfaces.

## Core Services

Current reusable services:

- `src/server/http-app.js`: common HTTP request shell, CORS, auth gate, API/media/static dispatch.
- `src/server/access-log.js`: JSON access log writer and request timing.
- `src/server/file-server.js`: inline file serving and Range-based media streaming.
- `src/server/video-probe-service.js`: ffprobe-backed media probing, LRU probe cache, and browser playback mode/playinfo decisions.
- `src/server/image-reader-cache-service.js`: image-reader cache status, touch throttling, cleanup scheduling, and size-based eviction.
- `src/server/library-paths.js`: root labels, root-relative paths, source-path resolution, open-root allowlist.
- `src/server/local-open-service.js`: safe local file/folder target resolution and OS-level open scheduling for trusted local/LAN requests.
- `src/server/root-config.js`: environment/default root parsing for library, gallery, photo sets, and short videos.
- `src/server/app-config-service.js`: app configuration defaults, normalization, load/save, public payloads, and image-reader cache limits.
- `src/server/user-state-service.js`: local user-state defaults, normalization, and JSON persistence for favorites, manual covers, and playback progress.
- `src/server/request-io.js`: request body parsing, JSON file reads, and safe child path resolution.
- `src/server/auth.js`: local/LAN/remote/app authentication.
- `src/server/static-files.js`: static asset serving.
- `src/server/responses.js`: response helpers.
- `src/server/admin-script-service.js`: reusable admin script registry facade with public script payloads, risk labels, option validation, and command construction.
- `src/server/admin-task-service.js`: reusable process-task runner with persisted history, log capture, stop handling, and public task summaries.
- `src/server/douban-cookie-service.js`: reusable Douban cookie storage, status, normalization, and access-test helper.
- `src/server/txt-format-tool-service.js`: reusable TXT formatter tool facade with upload validation, temporary download lifecycle, formatter subprocess execution, and download serving.
- `src/server/android-update-service.js`: reusable Android update manifest/page/APK serving facade for debug and release channels.

Core services should not know about AV works, novels, short videos, actor metadata, or gallery-specific tables.

## Domain Modules

Domain modules should own their routes, store, media lookup, and task hooks where practical.

Current/near-term modules:

- `modules/admin.js`: owns admin API route mounting and keeps request-time library access current via `getLibrary`.
- `modules/android-update.js`: owns Android update manifest/APK API route mounting.
- `modules/catalog.js`: owns ranking and studio catalog API route mounting.
- `modules/short-videos.js`: owns short-video store creation plus API and media route mounting.
- `modules/novels.js`: owns novel store creation, API route mounting, and invalidation.
- `modules/gallery.js`: owns gallery API/media route mounting.
- `modules/library.js`: owns library summary/root/rescan API route mounting and keeps request-time library access current via `getLibrary`.
- `modules/local-open.js`: owns trusted local file/folder open API route mounting.
- `modules/status.js`: owns health/status API route mounting and keeps request-time library access current via `getLibrary`.
- `modules/tools.js`: owns utility/tool API route mounting such as TXT formatting.
- `modules/user-state.js`: owns user-state API route mounting and keeps request-time library access current via `getLibrary`.
- `modules/video-library.js`: owns video-library API/media route mounting and keeps request-time library access current via `getLibrary`.
- `image-library-index-service.js`: owns image-library filesystem scans, root statuses, photo/media index cache loading/saving, and cache invalidation.
- `image-library-service.js`: owns image-library public payloads, channel list filtering/sorting/facets, photo collection grouping, and gallery media public item decoration.
- `gallery-metadata-service.js`: owns gallery TV/movie metadata table reads, public metadata payloads, stable metadata keys, and metadata cover media responses.
- `gallery-media-service.js`: owns gallery media lookup, detail payloads, gallery video streaming, and generated per-media cover cache.
- `manga-service.js`: owns cached manga discovery, public manga payloads, and manga image serving.
- `photo-set-service.js`: owns photo-set lookup, detail payloads, cover generation/cache, and archive image serving.
- `actor-avatar-service.js`: owns actor avatar Filetree parsing, candidate matching, avatar import/upsert, and profile cache invalidation hooks.
- `person-library-service.js`: owns local person source-path candidates and single-person library refresh/index repair.
- `work-query-service.js`: owns video-library work listing/search payload assembly, filtering, sorting, facets, and pagination.
- `work-detail-service.js`: owns video-library work detail payloads, playback info payloads, and info-file responses.
- `person-detail-service.js`: owns video-library actor profile/person detail payloads, person missing-work assembly, actor-row merging, person covers, merge actions, and person-local delete payloads.
- `work-mutation-service.js`: owns video-library work cover, local marker, actor correction, move-to-person, and local delete mutation payloads.
- `routes/android-update-api.js`: owns Android update manifest/APK HTTP routing.
- `routes/catalog-api.js`: owns ranking and studio catalog HTTP routing.
- `routes/library-api.js`: owns library summary, library roots, and rescan HTTP routing.
- `routes/local-open-api.js`: owns trusted local file/folder open HTTP routing.
- `routes/status-api.js`: owns health/status HTTP routing.
- `routes/user-state-api.js`: owns favorites, favorite-folder, watch-history, and playback-progress HTTP routing.
- `routes/video-library-api.js`: owns current work listing, search, work detail/actions, playback info, info-file reads, actor profile, and person-detail HTTP routing while video-library internals continue moving out of `server.js`.
- `routes/video-library-media.js`: owns actor avatar, work cover, core image, local image, and local video media routing.
- future video-library services for people, works, covers, progress, and playback metadata internals
- future `admin` module for script option normalization, admin-only workflows, and task-specific invalidation hooks

Route modules should receive dependencies explicitly instead of importing global state from `server.js`.

## Migration Order

1. Keep extracting low-risk core utilities from `server.js`.
2. Move small, already-isolated domains first: short videos and novels.
3. Split remaining gallery internals into metadata services and worker/tool boundaries.
4. Split video-library last; it currently owns the largest graph of people, works, covers, search, progress, and metadata.
5. Move slow operations to worker/tool boundaries: scans, image indexes, archive extraction, cover generation, ffprobe/ffmpeg probes, and metadata imports.

## Guardrails

- Preserve existing API responses unless a migration explicitly changes an endpoint.
- Keep request-time work fast; avoid recursive scans, large synchronous reads, and ffmpeg probes in hot paths.
- Prefer explicit dependency injection for modules.
- Add smoke checks for `/api/health` and representative module endpoints after each split.
- Do not mix unrelated UI behavior changes into server architecture changes.
