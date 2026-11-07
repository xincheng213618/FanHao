import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { createImageQueryCache, IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS, IMAGE_QUERY_CACHE_MAX_ROWS } from "./image-query-cache.js";
import { parsePhotoAlbumNumber, photoCollectionHealth } from "./photo-album-number.js";

export const PHOTO_COLLECTION_SORTS = ["updated", "count", "size", "title"];

const imageNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const imageSearchFieldNames = ["title", "person", "collection", "category", "folder", "metadata"];
const emptyPhotoIndex = { scannedAt: "", roots: [], photoSets: [] };
const emptyPhotoOverview = { scannedAt: "", photoRoots: [], totals: { photoSets: 0, photoBytes: 0 }, facets: { categories: [], people: [] } };

function compareImageNames(left, right) {
  return imageNameCollator.compare(left, right);
}

export function createImageLibraryService({
  cachePreparedQueries = false,
  clampInteger,
  galleryMediaRootStatuses,
  getImageLibraryIndex,
  getImageLibraryRevision = null,
  imageReaderCacheStatus,
  mangaService,
  maxItemLimit,
  metadataService,
  photoLibraryStore,
  photoPublisherStore,
  photoCollectionRootValue,
  photoSetRootStatuses,
  photoSetService
}) {
  let cachedPhotoCatalog = null;
  let cachedSummaryStatic = null;
  let imageSearchDocumentCache = new WeakMap();
  const listRealm = randomUUID();
  const sourceIdentities = new WeakMap();
  let sourceSequence = 0;
  let unstableSequence = 0;
  const preparedQueries = createImageQueryCache();

  function sourceIdentity(value) {
    if (!value || typeof value !== "object") return "";
    let identity = sourceIdentities.get(value);
    if (!identity) { identity = ++sourceSequence; sourceIdentities.set(value, identity); }
    return identity;
  }

  function listSourceStamp(index, mode) {
    if (mode === "photo" && index?.revision) return JSON.stringify([index.revision, index.collectionId]);
    return JSON.stringify([
      sourceIdentity(index), getImageLibraryRevision?.() ?? "",
      sourceIdentity(index?.photoSets), index?.photoSets?.length || 0,
      sourceIdentity(index?.mediaItems), index?.mediaItems?.length || 0,
      index?.scannedAt || "", index?.cacheIdentity || "",
      ["movie", "tv", "anime", "media"].includes(mode) ? metadataService.listRevision?.(mode) ?? "" : ""
    ]);
  }

  function publicListRevision(before, after, mode, mangaSourceRevision) {
    const stamp = before === after ? [listRealm, mode, before, mangaSourceRevision] : [listRealm, "unstable", ++unstableSequence];
    return createHash("sha256").update(JSON.stringify(stamp)).digest("hex");
  }

  function facetCounts(items, fieldName) {
    const counts = new Map();
    for (const item of items) {
      const value = String(item[fieldName] || "").trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || compareImageNames(a.value, b.value));
  }

  function mediaItemsByKind(items, kind) {
    return items.filter((item) => item.mediaKind === kind);
  }

  function mediaItemsByKinds(items, kinds = []) {
    const selected = new Set(kinds);
    return items.filter((item) => selected.has(item.mediaKind));
  }

  function latestUpdatedAt(items = [], fallback = "") {
    return items.reduce((latest, item) => {
      const candidate = String(item?.updatedAt || "").trim();
      if (!candidate) return latest;
      const candidateTime = new Date(candidate).getTime();
      if (!Number.isFinite(candidateTime)) return latest;
      const latestTime = new Date(latest || 0).getTime();
      return !Number.isFinite(latestTime) || candidateTime > latestTime ? candidate : latest;
    }, String(fallback || "").trim());
  }

  function isEpisodicMediaKind(kind) {
    return kind === "tv" || kind === "anime";
  }

  function galleryMediaSourceSeriesKey(item) {
    if (!item || !isEpisodicMediaKind(item.mediaKind)) return "";
    const category = item.mediaKind === "anime" ? `动漫:${item.category || ""}` : item.category || "";
    return metadataService.tvSeriesKey(category, item.seriesName || item.personName || item.subCategory || item.title || "");
  }

  function trustedTvMetadataIdentity(tvSeries, titlesCache = null) {
    const doubanId = String(tvSeries?.doubanId || "").trim();
    const title = String(tvSeries?.title || "").trim();
    if (!/^\d{5,12}$/u.test(doubanId) || !title) return "";
    let normalizedTitle;
    if (titlesCache?.has(title)) normalizedTitle = titlesCache.get(title);
    else {
      normalizedTitle = title.normalize("NFKC").toLocaleLowerCase();
      titlesCache?.set(title, normalizedTitle);
    }
    return `${doubanId}|${normalizedTitle}`;
  }

  function normalizedTvEpisodeSeriesName(value, namesCache = null) {
    const input = String(value || "").trim();
    if (namesCache?.has(input)) return namesCache.get(input);
    const result = normalizedTvEpisodeSeriesNameFromString(input);
    namesCache?.set(input, result);
    return result;
  }

  function normalizedTvEpisodeSeriesNameFromString(input) {
    const source = input
      .replace(/\.(?:mp4|mkv|avi|mov|wmv|m4v|webm)$/iu, "")
      .replace(/[._]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!source) return "";

    const seasonEpisode = /^(?<title>.+?)\s*(?<season>s(?:eason)?\s*0?\d{1,2})\s*(?:e|ep(?:isode)?)\s*0?\d{1,3}(?:\s|$)/iu.exec(source);
    if (seasonEpisode?.groups?.title && seasonEpisode.groups.season) {
      const title = normalizedTvSeriesNamePart(seasonEpisode.groups.title);
      const season = Number.parseInt(seasonEpisode.groups.season.match(/\d+/u)?.[0] || "", 10);
      return title && Number.isFinite(season) ? `${title}|s${season}` : "";
    }

    const namedEpisode = /^(?<title>.+?)\s*(?:e|ep(?:isode)?)\s*0?\d{1,3}(?:\s|$)/iu.exec(source);
    if (namedEpisode?.groups?.title) return normalizedTvSeriesNamePart(namedEpisode.groups.title);

    const cjkEpisode = /^(?<title>.*[\u3400-\u9FFF])\s*0?\d{1,3}$/u.exec(source);
    return cjkEpisode?.groups?.title ? normalizedTvSeriesNamePart(cjkEpisode.groups.title) : "";
  }

  function normalizedTvSeriesNamePart(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .replace(/[._]+/gu, " ")
      .replace(/\s+/gu, " ")
      .replace(/[\s\-–—:：]+$/gu, "")
      .trim()
      .toLocaleLowerCase();
    return Array.from(normalized.replace(/\s+/gu, "")).length >= 2 ? normalized : "";
  }

  function galleryMediaSeriesKey(item, sourceSeriesKey, tvSeries, derivationCaches = null) {
    if (!item || !isEpisodicMediaKind(item.mediaKind)) return "";
    const trustedIdentity = trustedTvMetadataIdentity(tvSeries, derivationCaches?.titles);
    const localSeriesName = normalizedTvEpisodeSeriesName(item.seriesName || item.personName || item.subCategory || "", derivationCaches?.names);
    if (!trustedIdentity || !localSeriesName) return sourceSeriesKey;
    return metadataService.tvSeriesKey("trusted-tv", `${trustedIdentity}|${localSeriesName}`);
  }

  function galleryMediaCoverUrl(mediaId, updatedAt = "") {
    if (!mediaId) return "";
    const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return `/media/gallery-media-cover/${encodeURIComponent(mediaId)}${suffix}`;
  }

  function publicGalleryMediaItem(item, tvMetadataByKey = null, movieMetadataById = null, publicTvSeriesByKey = null, derivationState = null) {
    const sourceSeriesKey = galleryMediaSourceSeriesKey(item);
    let tvSeries = null;
    let derivationCaches = null;
    if (sourceSeriesKey) {
      if (publicTvSeriesByKey?.has(sourceSeriesKey)) {
        tvSeries = publicTvSeriesByKey.get(sourceSeriesKey);
        if (derivationState) derivationCaches = derivationState.caches ||= { titles: new Map(), names: new Map() };
      }
      else {
        tvSeries = metadataService.publicTvSeries(tvMetadataByKey ? tvMetadataByKey.get(sourceSeriesKey) : metadataService.tvSeriesRow(sourceSeriesKey, { forPublication: true }));
        publicTvSeriesByKey?.set(sourceSeriesKey, tvSeries);
      }
    }
    const seriesKey = galleryMediaSeriesKey(item, sourceSeriesKey, tvSeries, derivationCaches);
    let movieMetadata = null;
    if (item?.mediaKind === "movie") {
      const row = movieMetadataById ? movieMetadataById.get(item.id) : metadataService.movieRow(item.id, { forPublication: true });
      movieMetadata = derivationState?.movieListRead ? derivationState.movieListRead.publicHead(row) : metadataService.publicMovie(row);
    }
    const movieCoverUrl = movieMetadata?.coverUrl || "";
    const fallbackCoverUrl = item.mediaKind === "movie" || isEpisodicMediaKind(item.mediaKind) ? galleryMediaCoverUrl(item.id, item.updatedAt || "") : "";
    return {
      ...item,
      seriesKey,
      sourceSeriesKey,
      tvSeries,
      movieMetadata,
      coverUrl: movieCoverUrl || fallbackCoverUrl || item.coverUrl || ""
    };
  }

  function mediaFacets(items) {
    return {
      categories: facetCounts(items, "category"),
      subCategories: facetCounts(items, "subCategory"),
      people: facetCounts(items, "personName"),
      series: facetCounts(items, "seriesName"),
      roots: facetCounts(items, "rootLabel")
    };
  }

  function getPhotoIndex(options, collection = "") {
    return photoLibraryStore ? photoLibraryStore.index(collection) || emptyPhotoIndex : getImageLibraryIndex(options);
  }

  function payload(options = {}) {
    const index = getImageLibraryIndex(options);
    const photoIndex = photoLibraryStore ? getPhotoIndex(options) : index;
    const photoSets = (photoIndex.photoSets || []).map((item) => ({
      ...item,
      coverUrl: item.coverUrl || photoSetService.coverUrl(item.id, item.updatedAt || "")
    }));
    const tvMetadataByKey = metadataService.tvSeriesRowsMap({ forPublication: true });
    const movieMetadataById = metadataService.movieRowsMap();
    const publicTvSeriesByKey = new Map();
    const mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById, publicTvSeriesByKey));
    const westernItems = mediaItemsByKind(mediaItems, "western");
    const movieItems = mediaItemsByKind(mediaItems, "movie");
    const tvItems = mediaItemsByKind(mediaItems, "tv");
    const animeItems = mediaItemsByKind(mediaItems, "anime");
    const screenItems = mediaItemsByKinds(mediaItems, ["movie", "tv", "anime"]);
    const manga = mangaService.cacheDirs().map(mangaService.publicSummary);
    return {
      schemaVersion: 2,
      scannedAt: index.scannedAt || photoIndex.scannedAt || "",
      mangaRoot: mangaService.rootStatus(),
      photoRoots: photoIndex.roots || photoSetRootStatuses(),
      mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
      cache: imageReaderCacheStatus(),
      totals: {
        manga: manga.length,
        photoSets: photoSets.length,
        western: westernItems.length,
        movies: movieItems.length,
        tv: tvItems.length,
        anime: animeItems.length,
        media: mediaItems.length,
        photoBytes: photoSets.reduce((sum, item) => sum + Number(item.size || 0), 0),
        mediaBytes: mediaItems.reduce((sum, item) => sum + Number(item.size || 0), 0)
      },
      facets: {
        categories: facetCounts(photoSets, "category"),
        subCategories: facetCounts(photoSets, "subCategory"),
        people: photoPersonFacets(photoSets),
        roots: facetCounts(photoSets, "rootLabel"),
        western: mediaFacets(westernItems),
        movie: mediaFacets(movieItems),
        tv: mediaFacets(tvItems),
        anime: mediaFacets(animeItems),
        media: mediaFacets(screenItems)
      },
      manga,
      photoSets,
      mediaItems
    };
  }

  function summaryPayload(options = {}) {
    const photo = photoLibraryStore ? photoLibraryStore.summary() || emptyPhotoOverview : null;
    if (options.photoOnly && photo) {
      return {
        schemaVersion: 1,
        ...photo,
        cache: options.includeCache === false ? null : publicReaderCache()
      };
    }
    const index = getImageLibraryIndex(options);
    const summary = preparedSummaryStatic(index);
    const mangaCount = mangaService.cacheDirs().length;
    return {
      schemaVersion: 1,
      scannedAt: summary.scannedAt,
      mangaRoot: mangaService.rootStatus(),
      photoRoots: photo?.photoRoots || index.roots || photoSetRootStatuses(),
      mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
      cache: options.includeCache === false ? null : publicReaderCache(),
      totals: {
        manga: mangaCount,
        ...summary.totals,
        ...photo?.totals
      },
      facets: photo ? { ...summary.facets, ...photo.facets } : summary.facets
    };
  }

  function publicReaderCache() {
    const cache = imageReaderCacheStatus();
    if (!cache) return null;
    const { root, exists, maxBytes, currentBytes, overBytes, fileCount, cleanupIntervalMs } = cache;
    return { root, exists, maxBytes, currentBytes, overBytes, fileCount, cleanupIntervalMs };
  }

  function preparedSummaryStatic(index) {
    if (cachedSummaryStatic?.index === index) return cachedSummaryStatic.value;
    const photoSets = Array.isArray(index.photoSets) ? index.photoSets : [];
    const mediaItems = Array.isArray(index.mediaItems) ? index.mediaItems : [];
    const westernItems = mediaItemsByKind(mediaItems, "western");
    const movieItems = mediaItemsByKind(mediaItems, "movie");
    const tvItems = mediaItemsByKind(mediaItems, "tv");
    const animeItems = mediaItemsByKind(mediaItems, "anime");
    const screenItems = mediaItemsByKinds(mediaItems, ["movie", "tv", "anime"]);
    const value = {
      scannedAt: index.scannedAt || "",
      totals: {
        photoSets: photoSets.length,
        western: westernItems.length,
        movies: movieItems.length,
        tv: tvItems.length,
        anime: animeItems.length,
        media: screenItems.length,
        photoBytes: photoSets.reduce((sum, item) => sum + Number(item.size || 0), 0),
        mediaBytes: mediaItems.reduce((sum, item) => sum + Number(item.size || 0), 0)
      },
      facets: {
        categories: facetCounts(photoSets, "category").slice(0, 12),
        people: photoPersonFacets(photoSets, 12),
        western: mediaFacets(westernItems),
        movie: mediaFacets(movieItems),
        tv: mediaFacets(tvItems),
        anime: mediaFacets(animeItems),
        media: mediaFacets(screenItems)
      }
    };
    cachedSummaryStatic = { index, value };
    return value;
  }

  function itemsPayload(url, options = {}) {
    const mode = normalizeImageLibraryMode(url.searchParams.get("mode"));
    const limit = clampInteger(url.searchParams.get("limit"), 48, 1, maxItemLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const query = String(url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
    const requestedSort = String(url.searchParams.get("sort") || "updated").trim();
    const sort = query && ["photo", "manga"].includes(mode) ? "relevance" : requestedSort;
    const photoView = normalizePhotoLibraryView(url.searchParams.get("photoView") || url.searchParams.get("view"));
    const tvView = normalizeTvLibraryView(url.searchParams.get("tvView") || url.searchParams.get("view"));
    const category = String(url.searchParams.get("category") || "all").trim() || "all";
    const mediaKind = normalizeMediaKindFilter(url.searchParams.get("kind") || url.searchParams.get("mediaKind"));
    const subCategory = String(url.searchParams.get("subCategory") || "all").trim() || "all";
    const person = String(url.searchParams.get("person") || "all").trim() || "all";
    const date = String(url.searchParams.get("date") || "all").trim() || "all";
    const collection = String(url.searchParams.get("collection") || "").trim();
    const seriesKey = String(url.searchParams.get("seriesKey") || "").trim();
    const collectionPage = mode === "photo" && photoView === "collections" && !collection && !query
      && url.searchParams.get("collectionPage") === "1";
    const locale = collectionPage ? url.searchParams.get("collectionLocale") || "" : "";
    const collectionLocale = locale.length <= 64 ? locale : "";
    if (collectionPage && subCategory === "all" && person === "all" && date === "all") {
      const paging = { sort, locale: collectionLocale, limit, offset };
      const page = category.startsWith("publisher:")
        ? photoPublisherStore?.readPublisherPage(category.slice("publisher:".length), paging)
        : photoLibraryStore?.collectionPage({ category, ...paging });
      if (page) return {
        schemaVersion: 1, mode, mediaKind: "all", query, sort, photoView, tvView: "",
        category, subCategory, person, date, collection, collectionSummary: null, searchTerms: [],
        seriesKey: "", seriesSummary: null, ...page, count: page.items.length,
        limit, offset, nextOffset: offset + page.items.length, collectionPage: true
      };
    }
    const index = mode === "photo" ? getPhotoIndex(options, collection) : getImageLibraryIndex(options);
    const sourceStampBefore = listSourceStamp(index, mode);
    let mangaSourceRevision = "";
    const cacheEligible = cachePreparedQueries && ["photo", "western", "movie", "tv", "anime", "media"].includes(mode)
      && typeof getImageLibraryRevision === "function"
      && (["photo", "western"].includes(mode) || typeof metadataService.listRevision === "function");
    const queryCacheKey = JSON.stringify([mode, query, sort, photoView, tvView, category, mediaKind, subCategory, person, date, collection, seriesKey, collectionPage, collectionLocale]);
    if (options.refresh || !cacheEligible) preparedQueries.clear();
    const prepared = cacheEligible && !options.refresh ? preparedQueries.get(queryCacheKey, sourceStampBefore) : null;
    if (prepared) {
      const cachedItems = prepared.items.slice(offset, offset + limit);
      // Numbered photo subjects are display-only. The retained query keeps
      // them deferred, just as the uncached catalog does below.
      if (mode === "photo") cachedItems.forEach((item, pageIndex) => {
        if (prepared.compactAlbumRows) item = hydratePhotoCatalogRow(index, item);
        if (prepared.collectionLabels) item = publishPhotoCollectionPageItem(item, prepared.collectionLabels);
        if (item.type === "photo" && item.albumNumber) item = {
          ...item, albumSubject: photoAlbumSubject(item.title, item, item.collectionTitle)
        };
        if (prepared.matchMasks) {
          const mask = prepared.matchMasks[offset + pageIndex];
          item = { ...item, matchFields: imageSearchFieldNames.filter((_, field) => mask & (1 << field)) };
        }
        cachedItems[pageIndex] = item;
      });
      const response = structuredClone({ ...prepared.header, count: cachedItems.length, total: prepared.items.length,
        limit, offset, nextOffset: offset + cachedItems.length, listRevision: "", items: cachedItems });
      const sourceStampAfter = listSourceStamp(index, mode);
      if (sourceStampBefore !== sourceStampAfter) preparedQueries.clear();
      response.listRevision = publicListRevision(sourceStampBefore, sourceStampAfter, mode, "");
      return withCollectionPublisher(response);
    }
    const rawItems = !["photo", "manga"].includes(mode)
      ? mediaItemsByKinds(Array.isArray(index.mediaItems) ? index.mediaItems : [], mode === "media" ? ["movie", "tv", "anime"] : [mode]) : [];
    let movieListRead = null, optionalFailure = false;
    if (mode === "movie" && !query && movieListExceedsCache(rawItems, { category, person }, limit, offset)) {
      try { movieListRead = metadataService.beginMovieListRead?.() || null; } catch { /* Optional proof/read: retain the original bulk path. */ }
    }
    if (!movieListRead) return withCollectionPublisher(buildItems(null));
    let response, failure = null;
    try { response = buildItems(movieListRead); }
    catch (error) { failure = { error, optional: optionalFailure }; }
    finally {
      try { movieListRead.release(); }
      catch (error) { failure ||= { error, optional: true }; }
    }
    if (failure) {
      // Reuse this request's index, filters and refresh result. Only the new
      // read/hydration path is retried; ordinary item/conversion errors escape.
      if (failure.optional) return buildItems(null);
      throw failure.error;
    }
    // An external WAL writer may commit while our read snapshot is pinned.
    // Check after releasing it before authorizing the next page's revision.
    const sourceStampAfter = listSourceStamp(index, mode);
    if (sourceStampBefore !== sourceStampAfter) preparedQueries.clear();
    response.listRevision = publicListRevision(sourceStampBefore, sourceStampAfter, mode, mangaSourceRevision);
    return response;

    function withCollectionPublisher(response) {
      if (!response.collectionSummary) return response;
      const publisher = photoPublisherStore?.publisherForCollection(collection);
      if (publisher) response.collectionSummary = { ...response.collectionSummary, publisher };
      return response;
    }

    function buildItems(movieListRead) {
      let mediaItems = [];
      if (!["photo", "manga"].includes(mode)) {
        const tvMetadataByKey = rawItems.some((item) => isEpisodicMediaKind(item.mediaKind)) ? metadataService.tvSeriesRowsMap({ forPublication: true }) : new Map();
        const movieMetadataById = movieListRead ? movieListRead.rows : rawItems.some((item) => item.mediaKind === "movie") ? metadataService.movieRowsMap() : new Map();
        const publicTvSeriesByKey = new Map();
        // Only pure string derivations are shared within this list read. Field
        // conversion and metadata key generation still run for every item.
        const derivationState = { caches: null, movieListRead };
        mediaItems = rawItems.map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById, publicTvSeriesByKey, derivationState));
      }

      let source = [];
      let facetsSource = [];
      let photoSubCategoryFacetsSource = [];
      let photoFacets = null;
      let collectionSummary = null;
      let seriesSummary = null;
      let sourceIsSorted = false;
      let collectionLabels = null;
      let catalogOwnsCollectionItems = false;
      let compactAlbumRows = false;
      if (mode === "photo") {
        const compact = Boolean(collection) || date === "all" && (photoView === "collections" || !query);
        const catalog = preparedPhotoCatalog(index, compact);
        compactAlbumRows = catalog.compact && !collection && photoView === "albums";
        const defaultPhotoFilters = photoFiltersAreDefault({ category, subCategory, person, date });
        const collectionItems = collection ? preparedPhotoCollectionAlbums(catalog, collection) : null;
        const albums = collectionItems || catalog.items;
        const filteredPhotoSets = defaultPhotoFilters ? albums : filterPhotoSetsForList(albums, { category, subCategory, person, date });
        if (collectionItems) {
          collectionSummary = photoCollectionSummary(collectionItems, collection);
          photoFacets = photoLibraryFacets(collectionItems, collectionItems, { peopleLimit: 500, includeDates: true });
        } else photoFacets = preparedPhotoFacets(catalog, category);
        source = photoView === "collections" && !collection
          ? defaultPhotoFilters
            ? preparedPhotoCollectionCategories(catalog)
            : photoCollectionCategoryGroups(filteredPhotoSets).map(publicPhotoCollectionCategoryListItem)
          : defaultPhotoFilters && !collection && !query
            ? preparedPhotoSortedItems(catalog, sort)
            : filteredPhotoSets;
        sourceIsSorted = photoView === "albums" && defaultPhotoFilters && !collection && !query;
        if (collectionPage) {
          const page = photoCollectionPageItems(source, sort, collectionLocale);
          source = page.items;
          collectionLabels = page.labels;
          catalogOwnsCollectionItems = defaultPhotoFilters;
          sourceIsSorted = true;
        }
      } else if (mode === "manga") {
        const mangaSourceHash = createHash("sha256");
        source = mangaService.cacheDirs().map((cacheDir) => {
          const item = publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga");
          mangaSourceHash.update(JSON.stringify(item)).update("\0");
          return item;
        });
        mangaSourceRevision = mangaSourceHash.digest("hex");
      } else if (mode === "media") {
        const movieSource = mediaItemsByKind(mediaItems, "movie").map((item) => publicImageLibraryListItem(item, item.mediaKind));
        const tvSource = mediaItemsByKind(mediaItems, "tv").map((item) => publicImageLibraryListItem(item, item.mediaKind));
        const animeSource = mediaItemsByKind(mediaItems, "anime").map((item) => publicImageLibraryListItem(item, item.mediaKind));
        const episodicSource = [...tvSource, ...animeSource];
        const episodicGroups = tvSeriesGroups(episodicSource);
        const episodicSeriesSource = episodicGroups.map(publicTvSeriesListItem).filter(Boolean);
        const screenWorksSource = [...movieSource, ...episodicSeriesSource];
        facetsSource = screenWorksSource;
        if (seriesKey) {
          const categorySource = filterMediaItemsForList(episodicSource, { category, person, mediaKind });
          source = categorySource.filter((item) => item.seriesKey === seriesKey);
          seriesSummary = publicTvSeriesListItem(episodicGroups.find((group) => group.seriesKey === seriesKey) || null);
        } else if (person !== "all") {
          source = filterMediaItemsForList(episodicSource, { category, person, mediaKind });
          seriesSummary = publicTvSeriesListItem(episodicGroups.find((group) => group.seriesName === person && (mediaKind === "all" || group.mediaKind === mediaKind)) || null);
        } else {
          source = filterMediaItemsForList(screenWorksSource, { category, person, mediaKind });
        }
      } else if (["western", "movie", "tv"].includes(mode)) {
        const mediaSource = mediaItemsByKind(mediaItems, mode).map((item) => publicImageLibraryListItem(item, mode));
        const categorySource = filterMediaItemsForList(mediaSource, { category, person });
        if (mode === "tv") {
          const groups = tvSeriesGroups(mediaSource);
          const tvSeriesSource = groups.map(publicTvSeriesListItem);
          facetsSource = tvSeriesSource;
          if (seriesKey) {
            source = categorySource.filter((item) => item.seriesKey === seriesKey);
            seriesSummary = publicTvSeriesListItem(groups.find((group) => group.seriesKey === seriesKey) || null);
          } else if (person !== "all") {
            source = categorySource;
            seriesSummary = publicTvSeriesListItem(groups.find((group) => group.seriesName === person) || null);
          } else if (tvView === "episodes") {
            source = categorySource;
          } else {
            source = category === "all" ? tvSeriesSource : tvSeriesGroups(categorySource).map(publicTvSeriesListItem);
          }
        } else if (mode === "western") {
          facetsSource = mediaSource;
          source = person === "all" ? westernPersonGroups(categorySource).map(publicWesternPersonListItem) : categorySource;
        } else {
          facetsSource = mediaSource;
          source = categorySource;
        }
      }

      const searchSpec = createImageSearchQuery(query);
      const searchResults = searchSpec ? searchImageLibraryItems(source, searchSpec) : null;
      const filtered = searchResults ? searchResults.map((result) => result.item) : source;
      const sorted = sort === "relevance" && searchResults
        ? [...searchResults].sort(compareImageSearchResults).map((result) => result.item)
        : sourceIsSorted ? source : sortImageLibraryItems(filtered, sort);
      const searchResultsByItem = searchResults ? new Map(searchResults.map((result) => [result.item, result])) : null;
      const items = sorted.slice(offset, offset + limit).map((item) => {
        if (collectionLabels) return publishPhotoCollectionPageItem(item, collectionLabels);
        if (compactAlbumRows) item = hydratePhotoCatalogRow(index, item);
        const match = searchResultsByItem?.get(item);
        if (item.type === "photo" && item.albumNumber) {
          item = { ...item, albumSubject: photoAlbumSubject(item.title, item, item.collectionTitle) };
        }
        return match ? { ...item, matchFields: match.matchFields } : item;
      });
      if (movieListRead) {
        try {
          // A retained query must always contain complete metadata. The light
          // rows are only allowed on a plan already refused by the row budget.
          if (sorted.length <= IMAGE_QUERY_CACHE_MAX_ROWS) throw new Error("Movie list no longer exceeds the prepared-query budget");
          movieListRead.hydrate(items);
        } catch (error) { optionalFailure = true; throw error; }
      }
      const response = {
        schemaVersion: 1,
        mode,
        mediaKind: mode === "media" ? mediaKind : "all",
        query,
        sort,
        photoView: mode === "photo" ? (collection ? "albums" : photoView) : "",
        tvView: mode === "tv" ? (seriesKey || tvView === "episodes" ? "episodes" : "series") : mode === "media" && seriesKey ? "episodes" : "",
        category: ["photo", "western", "movie", "tv", "media"].includes(mode) ? category : "",
        subCategory: mode === "photo" ? subCategory : "",
        person: ["photo", "western", "media", "tv"].includes(mode) ? person : "",
        date: mode === "photo" ? date : "",
        collection: mode === "photo" ? collection : "",
        collectionSummary,
        searchTerms: searchSpec?.terms || [],
        seriesKey: ["tv", "media"].includes(mode) ? seriesKey : "",
        seriesSummary,
        facets: mode === "photo" ? photoFacets || photoLibraryFacets(facetsSource, photoSubCategoryFacetsSource) : mediaLibraryFacets(facetsSource),
        stats: {
          ratedCount: sorted.filter((item) => Number(item?.rating || item?.movieMetadata?.rating || item?.tvSeries?.rating || 0) > 0).length,
          totalBytes: sorted.reduce((sum, item) => sum + Number(item?.size || 0), 0),
          ...(collectionPage ? { albumCount: sorted.reduce((sum, item) => sum + Number(item.albumCount || 0), 0) } : {})
        },
        count: items.length,
        total: sorted.length,
        limit,
        offset,
        nextOffset: offset + items.length,
        listRevision: movieListRead ? "" : publicListRevision(sourceStampBefore, listSourceStamp(index, mode), mode, mangaSourceRevision),
        scannedAt: mode === "manga" ? latestUpdatedAt(source, index.scannedAt || "") : index.scannedAt || "",
        ...(collectionPage ? { collectionPage: true } : {}),
        items
      };
      if (!cacheEligible) return response;
      if (!options.refresh) {
        // Retain field insertion order when replacing the pagination values.
        const { items: _items, ...header } = response;
        if (catalogOwnsCollectionItems || compactAlbumRows) {
          preparedQueries.set(queryCacheKey, sourceStampBefore, { header, items: sorted, collectionLabels, compactAlbumRows });
        } else if (sorted.length <= IMAGE_QUERY_CACHE_MAX_ROWS) {
          let cachedItems = sorted;
          if (collectionLabels) cachedItems = sorted.map(item => publishPhotoCollectionPageItem(item, collectionLabels));
          else if (searchResultsByItem) cachedItems = sorted.map(item => ({ ...item, matchFields: searchResultsByItem.get(item).matchFields }));
          preparedQueries.set(queryCacheKey, sourceStampBefore, { header, items: cachedItems });
        } else if (mode === "photo" && response.photoView === "albums" && searchResultsByItem && imageSearchFieldNames.length <= 8
          && sorted.length <= IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS) {
          // Each bit preserves one of the ordered search fields on the catalog row.
          const matchMasks = Uint8Array.from(sorted, (item) => {
            let mask = 0;
            for (const field of searchResultsByItem.get(item).matchFields) mask |= 1 << imageSearchFieldNames.indexOf(field);
            return mask;
          });
          preparedQueries.set(queryCacheKey, sourceStampBefore, { header, items: sorted, matchMasks });
        }
      }
      const detached = structuredClone(response);
      if (!movieListRead) {
        const sourceStampAfter = listSourceStamp(index, mode);
        if (sourceStampBefore !== sourceStampAfter) preparedQueries.clear();
        detached.listRevision = publicListRevision(sourceStampBefore, sourceStampAfter, mode, mangaSourceRevision);
      }
      return detached;
    }
  }

  function movieListExceedsCache(rawItems, filters, limit, offset) {
    if (rawItems.length <= IMAGE_QUERY_CACHE_MAX_ROWS) return false;
    let count = 0;
    try {
      for (const item of rawItems) {
        if (!item || types.isProxy(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
        const values = {};
        for (const name of ["category", "site", "kindLabel", "personName", "seriesName"]) {
          const descriptor = Object.getOwnPropertyDescriptor(item, name);
          if (descriptor && (!Object.hasOwn(descriptor, "value") || descriptor.value !== null
            && !["undefined", "string", "number", "boolean"].includes(typeof descriptor.value))) return false;
          values[name] = descriptor?.value;
        }
        const category = String(values.category || values.site || values.kindLabel || "").trim();
        const person = String(values.personName || "").trim() || String(values.seriesName || "").trim();
        if (filters.category !== "all" && filters.category !== "__fanhao_media_kind_movie__" && category !== filters.category) continue;
        if (filters.person !== "all" && person !== filters.person) continue;
        count++;
      }
    } catch { return false; }
    // Reading almost the entire result twice costs more than the original
    // bulk publication. Small UI pages and large filtered categories qualify.
    return count > IMAGE_QUERY_CACHE_MAX_ROWS && Math.max(0, Math.min(limit, count - offset)) <= count / 2;
  }

  function normalizePhotoLibraryView(value) {
    const view = String(value || "").trim().toLowerCase();
    return view === "collections" || view === "collection" ? "collections" : "albums";
  }

  function normalizeTvLibraryView(value) {
    const view = String(value || "").trim().toLowerCase();
    return view === "episodes" || view === "episode" || view === "items" ? "episodes" : "series";
  }

  function normalizeImageLibraryMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "photos" || mode === "photo-set" || mode === "photo-sets") return "photo";
    if (mode === "movies") return "movie";
    if (["media", "video", "screen", "film", "films"].includes(mode)) return "media";
    if (["photo", "manga", "western", "movie", "tv", "anime"].includes(mode)) return mode;
    return "photo";
  }

  function normalizeMediaKindFilter(value) {
    const kind = String(value || "").trim().toLowerCase();
    return ["movie", "tv", "anime"].includes(kind) ? kind : "all";
  }

  function hasCjkText(value) {
    return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(value || ""));
  }

  function movieChineseTitle(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!hasCjkText(text)) return text;
    const parts = text.split(" ");
    const lastCjk = parts.reduce((last, part, index) => (hasCjkText(part) ? index : last), -1);
    return lastCjk >= 0 ? parts.slice(0, lastCjk + 1).join(" ").trim() : text;
  }

  function moviePrimaryDisplayTitle(item, metadata) {
    const aliases = Array.isArray(metadata?.aliases) ? metadata.aliases : [];
    const candidates = [
      metadata?.title,
      metadata?.movieTitle,
      ...aliases.filter(hasCjkText),
      item?.title,
      item?.dirName
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const title = candidates.find(hasCjkText) || candidates[0] || "";
    return movieChineseTitle(title);
  }

  function photoArchiveDate(value) {
    const match = String(value || "").match(/(?:^|[^\d])(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})(?:日|[^\d]|$)/u);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) return "";
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function photoAlbumNumber(value) {
    return parsePhotoAlbumNumber(value)?.label || "";
  }
  function escapePhotoAlbumPattern(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripPhotoAlbumStats(value) {
    return String(value || "")
      .replace(/\s*\[[^\]]*(?:\d+\s*[PV]|(?:MB|GB)\b|\d+(?:\.\d+)?\s*M\b)[^\]]*\]\s*$/iu, "")
      .trim();
  }

  function photoAlbumSubject(value, item = {}, collectionTitle = "") {
    const parsedNumber = parsePhotoAlbumNumber(value);
    const text = parsedNumber?.text ?? stripPhotoAlbumStats(value);
    const match = parsedNumber ? { index: parsedNumber.index, 0: text.slice(parsedNumber.index, parsedNumber.index + parsedNumber.length) } : null;
    const personName = String(item?.personName || "").trim();
    const structuralLabels = [
      collectionTitle || item?.collectionTitle,
      item?.subCategory,
      collectionTitle || item?.collectionTitle ? "" : photoCollectionDisplayName(photoCollectionDir(item))
    ]
      .map((label) => String(label || "").replace(/^\[|\]$/g, "").trim())
      .filter(Boolean);
    const clean = (candidate) => {
      let result = stripPhotoAlbumStats(candidate);
      for (const label of structuralLabels) {
        result = result.replace(new RegExp(`^\\[?${escapePhotoAlbumPattern(label)}\\]?\\s*(?:[-–—:]\\s*)?`, "iu"), "");
      }
      result = result
        .replace(/(?:^|\s)20\d{2}[.\-/年]\d{1,2}[.\-/月]\d{1,2}(?:日)?(?:\s|$)/u, " ")
        .replace(/\s*[-–—:]\s*Collection\s*$/iu, "")
        .replace(/\s+Collection\s*$/iu, "")
        .replace(/^\s*[-–—:.、#]\s*/u, "")
        .replace(/[\s._-]+$/u, "")
        .trim();
      if (personName) {
        const withoutPerson = result
          .replace(new RegExp(`[\\s._-]+${escapePhotoAlbumPattern(personName)}[\\s._-]*$`, "iu"), "")
          .trim();
        if (withoutPerson) result = withoutPerson;
      }
      return result;
    };
    if (!match) return clean(text);
    const after = clean(text.slice(Number(match.index || 0) + match[0].length));
    return after || clean(text.slice(0, Number(match.index || 0)));
  }

  function normalizedPhotoPersonValue(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function photoPersonFacetValue(item = {}) {
    const person = String(item?.personName || "").trim();
    if (!person) return "";
    const normalized = normalizedPhotoPersonValue(person);
    const structuralValues = [item?.subCategory, item?.collectionTitle, item?.albumNumber ? "" : item?.albumSubject]
      .map(normalizedPhotoPersonValue)
      .filter(Boolean);
    return structuralValues.includes(normalized) ? "" : person;
  }

  function photoPersonFacets(items = [], limit = Number.MAX_SAFE_INTEGER) {
    const counts = new Map();
    for (const item of items) {
      const value = photoPersonFacetValue(item);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const facets = [...counts.entries()].map(([value, count]) => ({ value, count }));
    const maxItems = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
    if (!maxItems || maxItems >= facets.length) {
      return facets
        .sort(comparePhotoPersonFacets)
        .slice(0, limit);
    }

    const valuesByCount = new Map();
    for (const facet of facets) {
      const values = valuesByCount.get(facet.count) || [];
      values.push(facet.value);
      valuesByCount.set(facet.count, values);
    }

    const selected = [];
    for (const count of [...valuesByCount.keys()].sort((a, b) => b - a)) {
      const values = valuesByCount.get(count);
      const remaining = maxItems - selected.length;
      if (values.length <= remaining) {
        selected.push(...values.sort(comparePhotoPersonFacetValues));
        continue;
      }
      selected.push(...selectTopPhotoPersonFacetValues(values, remaining));
      break;
    }
    return selected.map((value) => ({ value, count: counts.get(value) }));
  }

  function comparePhotoPersonFacets(a, b) {
    return b.count - a.count || comparePhotoPersonFacetValues(a.value, b.value);
  }

  function comparePhotoPersonFacetValues(a, b) {
    return compareImageNames(a, b);
  }

  function selectTopPhotoPersonFacetValues(values, limit) {
    const selected = [];
    for (const value of values) {
      if (selected.length === limit && comparePhotoPersonFacetValues(value, selected.at(-1)) >= 0) continue;
      let low = 0;
      let high = selected.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (comparePhotoPersonFacetValues(value, selected[middle]) >= 0) low = middle + 1;
        else high = middle;
      }
      selected.splice(low, 0, value);
      if (selected.length > limit) selected.pop();
    }
    return selected;
  }

  function photoDateFacets(items = []) {
    const counts = new Map();
    for (const item of items) {
      const value = String(item?.archiveMonth || "").trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count, label: `${value.slice(0, 4)} 年 ${Number(value.slice(5, 7))} 月` }))
      .sort((a, b) => b.value.localeCompare(a.value));
  }

  function publicImageLibraryListItem(item, mode, { deferPhotoSubject = false, compact = false } = {}, photoRow = null) {
    const normalizedMode = normalizeImageLibraryMode(mode || item?.mediaKind || item?.type);
    const movieMetadata = item?.movieMetadata || null;
    const movieTitle = normalizedMode === "movie" ? moviePrimaryDisplayTitle(item, movieMetadata) : "";
    const photoTitle = photoRow?.title ?? String(item?.title || item?.dirName || "").trim();
    const collectionDir = normalizedMode === "photo" && !photoRow ? photoCollectionDir(item) : "";
    const collectionTitle = photoRow?.collectionTitle ?? (normalizedMode === "photo" ? photoCollectionDisplayName(collectionDir) : "");
    const personName = photoRow?.personName ?? String(item?.personName || "").trim();
    const archiveDate = normalizedMode === "photo" && !compact ? photoArchiveDate(photoTitle) : "";
    const albumNumber = photoRow?.albumNumber ?? (normalizedMode === "photo" ? photoAlbumNumber(photoTitle) : "");
    // Unnumbered subjects participate in the person facet guard. Numbered
    // subjects are display-only and can be derived for the returned page.
    let albumSubject = "";
    if (normalizedMode === "photo" && (!deferPhotoSubject || !albumNumber) && (!compact || personName)) {
      albumSubject = photoRow?.personName && !albumNumber ? photoRow.albumSubject : photoAlbumSubject(photoTitle, item, collectionTitle);
    }
    const id = photoRow?.id ?? String(item?.id || "");
    const category = photoRow?.category ?? String(item?.category || item?.site || item?.kindLabel || "").trim();
    const subCategory = photoRow?.subCategory ?? String(item?.subCategory || "").trim();
    const rootLabel = photoRow?.rootLabel ?? String(item?.rootLabel || item?.kindLabel || "").trim();
    const size = photoRow?.size ?? Number(item?.size || 0);
    const updatedAt = photoRow?.updatedAt ?? String(item?.updatedAt || "").trim();
    let imageCount = photoRow?.imageCount;
    if (imageCount === undefined) imageCount = item?.imageCount == null ? null : Number(item.imageCount || 0);
    const collectionId = photoRow?.collectionId ?? (normalizedMode === "photo" ? photoCollectionValue(item, collectionDir) : "");
    const coverUrl = photoRow?.coverUrl ?? String(item?.coverUrl || (normalizedMode === "photo" ? photoSetService.coverUrl(item?.id, item?.updatedAt || "") : "")).trim();
    const tvSeries = item?.tvSeries || null;
    const albumCount = item?.albumCount === undefined ? null : Number(item.albumCount || 0);
    const rating = item?.movieMetadata?.rating == null ? item?.rating ?? null : Number(item.movieMetadata.rating || 0);
    const year = String(item?.movieMetadata?.year || item?.year || "").trim();
    if (compact) {
      return { id, title: photoTitle, category, subCategory, personName, rootLabel, size, updatedAt, albumNumber, albumSubject,
        imageCount, collectionId, collectionTitle, coverUrl, tvSeries, movieMetadata, albumCount, rating, year };
    }
    const displayTitle =
      normalizedMode === "movie" && movieTitle
        ? [movieTitle, movieMetadata?.year ? `(${movieMetadata.year})` : ""].filter(Boolean).join(" ")
        : photoTitle;
    return {
      id,
      type: normalizedMode,
      mediaKind: String(item?.mediaKind || (["western", "movie", "tv", "anime"].includes(normalizedMode) ? normalizedMode : "")).trim(),
      title: displayTitle,
      category,
      subCategory,
      personName,
      seriesName: String(item?.seriesName || "").trim(),
      seriesKey: String(item?.seriesKey || "").trim(),
      tvSeries,
      movieMetadata,
      rootLabel,
      ext: String(item?.archiveExt || item?.ext || "").trim(),
      size,
      updatedAt,
      archiveDate,
      archiveMonth: archiveDate.slice(0, 7),
      albumNumber,
      albumSubject,
      imageCount,
      chapterCount: item?.chapterCount === undefined ? null : Number(item.chapterCount || 0),
      doneChapterCount: item?.doneChapterCount === undefined ? null : Number(item.doneChapterCount || 0),
      downloadedCount: item?.downloadedCount === undefined ? null : Number(item.downloadedCount || 0),
      failedCount: item?.failedCount === undefined ? null : Number(item.failedCount || 0),
      albumCount,
      collectionId,
      collectionTitle,
      playable: Boolean(item?.playable),
      coverUrl,
      rating,
      ratingCount: item?.movieMetadata?.ratingCount === null || item?.movieMetadata?.ratingCount === undefined ? item?.ratingCount ?? null : Number(item.movieMetadata.ratingCount || 0),
      year,
      genres: Array.isArray(item?.movieMetadata?.genres) ? item.movieMetadata.genres : Array.isArray(item?.genres) ? item.genres : [],
      routePath: imageLibraryItemRoutePath(normalizedMode, item?.id)
    };
  }

  function publicPhotoCollectionListItem(group) {
    return {
      id: group.value,
      type: "photoCollection",
      title: group.title,
      category: [...group.categories].slice(0, 3).join(" · "),
      subCategory: [...group.subCategories].slice(0, 3).join(" · "),
      personName: "",
      seriesName: "",
      rootLabel: group.rootLabel,
      ext: "",
      size: group.size,
      updatedAt: group.updatedAt,
      imageCount: group.imageCount,
      albumCount: group.count,
      collectionId: group.value,
      collectionTitle: group.title,
      playable: false,
      coverUrl: group.coverUrl,
      routePath: `/photo/collection/${encodeURIComponent(group.value)}`
    };
  }

  function publicPhotoCollectionCategoryListItem(group) {
    const collections = group.collections.map(publicPhotoCollectionListItem);
    return {
      id: group.value,
      type: "photoCollectionCategory",
      title: group.title,
      category: group.category,
      subCategory: collections.map((item) => item.title).join(" · "),
      personName: "",
      seriesName: "",
      rootLabel: group.rootLabel,
      ext: "",
      size: group.size,
      updatedAt: group.updatedAt,
      imageCount: group.imageCount,
      albumCount: group.albumCount,
      collectionCount: collections.length,
      playable: false,
      coverUrl: group.coverUrl,
      collections,
      routePath: ""
    };
  }

  function photoCollectionPageItems(categories, sort, locale) {
    const unique = new Map();
    const labels = new Map();
    // Keep the first occurrence in the original category order when a
    // collection belongs to several categories.
    for (const category of sortImageLibraryItems(categories, sort)) {
      for (const collection of category.collections) {
        const id = collection.collectionId.trim();
        if (!id || unique.has(id)) continue;
        unique.set(id, collection);
        if (!collection.category || !collection.rootLabel) labels.set(collection, category);
      }
    }

    let compareTitles = compareImageNames;
    if (locale) {
      try { compareTitles = new Intl.Collator(locale, { numeric: true, sensitivity: "base" }).compare; }
      catch { /* Keep the default collation for an invalid locale. */ }
    }
    let items = [...unique.values()];
    const byTitle = (a, b) => compareTitles(a.title, b.title);
    const bySize = (a, b) => (b.size || 0) - (a.size || 0) || byTitle(a, b);
    if (sort === "count") items.sort((a, b) => b.albumCount - a.albumCount || bySize(a, b));
    else if (sort === "size") items.sort(bySize);
    else if (sort === "title") items.sort(byTitle);
    else {
      items = items
        .map(item => ({ item, time: item.updatedAt ? Date.parse(item.updatedAt) : 0 }))
        .sort((a, b) => b.time - a.time || byTitle(a.item, b.item))
        .map(({ item }) => item);
    }
    return { items, labels };
  }

  function publishPhotoCollectionPageItem(item, labels) {
    const parent = labels.get(item);
    return {
      ...item,
      catalogCategory: item.category || parent?.category || "",
      catalogRootLabel: item.rootLabel || parent?.rootLabel || ""
    };
  }

  function projectPhotoIndex(index, locales) {
    const photoSets = index.photoSets.map(album => {
      if (!album.archiveIdentity) return album;
      const url = album.coverUrl || photoSetService.coverUrl(album.id, album.updatedAt || "");
      const signature = createHash("sha256").update(album.archiveIdentity).digest("hex").slice(0, 16);
      return { ...album, coverUrl: `${url}${url.includes("?") ? "&" : "?"}sig=${signature}` };
    });
    const catalog = preparedPhotoCatalog({ ...index, photoSets }, true);
    const byCategory = new Map([["all", catalog.items]]);
    for (const item of catalog.items) {
      if (!item.category || item.category === "all") continue;
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item);
    }
    const scopes = [];
    const pages = [];
    for (const [category, rows] of byCategory) {
      const groups = photoCollectionCategoryGroups(rows).map(publicPhotoCollectionCategoryListItem);
      const counts = {};
      for (const sort of PHOTO_COLLECTION_SORTS) {
        for (const locale of locales) {
          const page = photoCollectionPageItems(groups, sort, locale);
          const items = page.items.map(item => publishPhotoCollectionPageItem(item, page.labels));
          pages.push({ category, sort, locale, items });
          counts[sort] = {
            total: items.length,
            totalBytes: items.reduce((sum, item) => sum + item.size, 0),
            albumCount: items.reduce((sum, item) => sum + item.albumCount, 0)
          };
        }
      }
      scopes.push([category, { counts, subCategories: facetCounts(rows, "subCategory").slice(0, 500) }]);
    }
    return {
      archives: photoSets.map((album, position) => ({ album, collectionId: catalog.items[position].collectionId })),
      facets: { categories: catalog.categories, people: catalog.people },
      overview: {
        totals: { photoSets: photoSets.length, photoBytes: photoSets.reduce((sum, album) => sum + Number(album.size || 0), 0) },
        facets: { categories: facetCounts(photoSets, "category").slice(0, 12), people: photoPersonFacets(photoSets, 12) }
      },
      pages,
      scopes: Object.fromEntries(scopes)
    };
  }

  function tvSeriesGroups(items = []) {
    const groups = new Map();
    for (const item of items) {
      const seriesKey = String(item?.seriesKey || "").trim() || metadataService.tvSeriesKey(item?.category || "", item?.seriesName || item?.personName || item?.subCategory || item?.title || "");
      if (!seriesKey) continue;
      let group = groups.get(seriesKey);
      if (!group) {
        group = {
          seriesKey,
          type: "tvSeries",
          mediaKind: item?.mediaKind || "tv",
          title: item?.tvSeries?.title || item?.seriesName || item?.personName || item?.subCategory || item?.title || (item?.mediaKind === "anime" ? "动漫" : "电视剧"),
          seriesName: item?.seriesName || item?.personName || item?.subCategory || "",
          category: item?.category || "",
          rootLabel: item?.rootLabel || "",
          tvSeries: item?.tvSeries || null,
          coverUrl: item?.tvSeries?.coverUrl || item?.coverUrl || "",
          size: 0,
          episodeCount: 0,
          playableCount: 0,
          updatedAt: "",
          firstEpisodeId: item?.id || ""
        };
        groups.set(seriesKey, group);
      }
      group.episodeCount += 1;
      if (item?.playable) group.playableCount += 1;
      group.size += Number(item?.size || 0);
      if (!group.coverUrl && item?.tvSeries?.coverUrl) group.coverUrl = item.tvSeries.coverUrl;
      if (!group.coverUrl && item?.coverUrl) group.coverUrl = item.coverUrl;
      if (!group.tvSeries && item?.tvSeries) group.tvSeries = item.tvSeries;
      if (!group.firstEpisodeId && item?.id) group.firstEpisodeId = item.id;
      if (String(item?.updatedAt || "") > String(group.updatedAt || "")) group.updatedAt = String(item.updatedAt || "");
    }
    return [...groups.values()];
  }

  function publicTvSeriesListItem(group) {
    if (!group) return null;
    const meta = group.tvSeries || {};
    return {
      id: group.seriesKey,
      type: "tvSeriesWork",
      mediaKind: String(group.mediaKind || "tv"),
      title: String(meta.title || group.title || group.seriesName || (group.mediaKind === "anime" ? "动漫" : "电视剧")).trim(),
      category: String(group.category || meta.category || "").trim(),
      subCategory: String(group.seriesName || "").trim(),
      personName: String(group.seriesName || group.title || "").trim(),
      seriesName: String(group.seriesName || group.title || "").trim(),
      seriesKey: String(group.seriesKey || "").trim(),
      tvSeries: group.tvSeries || null,
      rootLabel: String(group.rootLabel || "").trim(),
      ext: "",
      size: Number(group.size || 0),
      episodeCount: Number(group.episodeCount || 0),
      updatedAt: String(group.updatedAt || meta.updatedAt || "").trim(),
      imageCount: null,
      chapterCount: Number(group.episodeCount || 0),
      doneChapterCount: Number(group.playableCount || 0),
      downloadedCount: null,
      failedCount: null,
      albumCount: null,
      collectionId: "",
      collectionTitle: "",
      playable: Boolean(group.playableCount),
      coverUrl: String(group.coverUrl || meta.coverUrl || "").trim(),
      firstEpisodeId: String(group.firstEpisodeId || "").trim(),
      rating: meta.rating === null || meta.rating === undefined ? null : Number(meta.rating || 0),
      ratingCount: meta.ratingCount === null || meta.ratingCount === undefined ? null : Number(meta.ratingCount || 0),
      year: String(meta.year || "").trim(),
      genres: Array.isArray(meta.genres) ? meta.genres : [],
      routePath: group.mediaKind === "anime"
        ? `/media?kind=anime&seriesKey=${encodeURIComponent(String(group.seriesKey || ""))}`
        : `/tv?seriesKey=${encodeURIComponent(String(group.seriesKey || ""))}`
    };
  }

  function westernPersonGroups(items = []) {
    const groups = new Map();
    for (const item of items) {
      const personName = String(item?.personName || item?.subCategory || item?.category || "未归类").trim() || "未归类";
      let group = groups.get(personName);
      if (!group) {
        group = {
          personName,
          count: 0,
          playableCount: 0,
          size: 0,
          updatedAt: "",
          coverUrl: "",
          categories: new Map(),
          samples: []
        };
        groups.set(personName, group);
      }
      group.count += 1;
      if (item?.playable) group.playableCount += 1;
      group.size += Number(item?.size || 0);
      if (item?.category) group.categories.set(item.category, (group.categories.get(item.category) || 0) + 1);
      if (group.samples.length < 3 && item?.title) group.samples.push(item.title);
      if (String(item?.updatedAt || "") > group.updatedAt) {
        group.updatedAt = String(item.updatedAt || "");
        group.coverUrl = String(item?.coverUrl || group.coverUrl || "");
      } else if (!group.coverUrl && item?.coverUrl) {
        group.coverUrl = String(item.coverUrl);
      }
    }
    return [...groups.values()];
  }

  function publicWesternPersonListItem(group) {
    const categories = [...(group?.categories || new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || compareImageNames(a[0], b[0]))
      .map(([value, count]) => ({ value, count }));
    return {
      id: String(group?.personName || ""),
      type: "westernPerson",
      mediaKind: "western",
      title: String(group?.personName || "未归类"),
      category: "",
      subCategory: "",
      personName: String(group?.personName || "未归类"),
      size: Number(group?.size || 0),
      updatedAt: String(group?.updatedAt || ""),
      playable: Boolean(group?.playableCount),
      playableCount: Number(group?.playableCount || 0),
      videoCount: Number(group?.count || 0),
      coverUrl: String(group?.coverUrl || ""),
      categories,
      samples: Array.isArray(group?.samples) ? group.samples : []
    };
  }

  function imageLibraryItemRoutePath(mode, id) {
    const encoded = encodeURIComponent(String(id || ""));
    if (!encoded) return "/";
    if (mode === "photo") return `/photo/set/${encoded}`;
    if (mode === "manga") return `/manga/${encoded}`;
    if (mode === "western") return `/western/${encoded}`;
    if (mode === "movie") return `/movies/${encoded}`;
    if (mode === "tv") return `/tv/${encoded}`;
    if (mode === "anime") return `/media?kind=anime&mediaId=${encoded}`;
    return "/";
  }

  function preparedPhotoCatalog(index, compact) {
    const catalog = cachedPhotoCatalog?.index === index ? cachedPhotoCatalog : null;
    if (catalog && (!catalog.compact || compact)) return catalog;
    const rawItems = Array.isArray(index?.photoSets) ? index.photoSets : [];
    const options = { deferPhotoSubject: true, compact };
    const items = rawItems.map((item, index) => {
      const row = publicImageLibraryListItem(item, "photo", options, catalog?.items[index]);
      if (compact) row.sourceIndex = index;
      return row;
    });
    if (catalog) {
      // Full rows have the same sort keys, so preserve the existing orders.
      for (const [sort, sorted] of catalog.sortedItems) {
        catalog.sortedItems.set(sort, sorted.map(row => items[row.sourceIndex]));
      }
      catalog.items = items;
      catalog.compact = false;
      return catalog;
    }
    imageSearchDocumentCache = new WeakMap();
    cachedPhotoCatalog = {
      compact,
      index,
      items,
      categories: facetCounts(items, "category"),
      people: photoPersonFacets(items, 20),
      subCategories: new Map(),
      sortedItems: new Map()
    };
    return cachedPhotoCatalog;
  }

  function preparedPhotoCollectionCategories(catalog) {
    if (!catalog.collectionCategories) {
      catalog.collectionCategories = photoCollectionCategoryGroups(catalog.items).map(publicPhotoCollectionCategoryListItem);
    }
    return catalog.collectionCategories;
  }

  function preparedPhotoCollectionAlbums(catalog, collection) {
    if (!catalog.compact) return catalog.items.filter(item => item.collectionId === collection);
    // A collection detail only needs full rows for its own albums.
    const albums = [];
    for (const item of catalog.items) {
      if (item.collectionId === collection) albums.push(hydratePhotoCatalogRow(catalog.index, item));
    }
    return albums;
  }

  function hydratePhotoCatalogRow(index, row) {
    return publicImageLibraryListItem(index.photoSets[row.sourceIndex], "photo", { deferPhotoSubject: true }, row);
  }

  function canonicalPhotoSortKey(sort) {
    if (["count", "title", "size", "rating", "year"].includes(sort)) return sort;
    return "updated";
  }

  function preparedPhotoSortedItems(catalog, sort) {
    const cacheKey = canonicalPhotoSortKey(sort);
    let items = catalog.sortedItems.get(cacheKey);
    if (!items) {
      items = sortImageLibraryItems(catalog.items, cacheKey);
      catalog.sortedItems.set(cacheKey, items);
    }
    return items;
  }

  function preparedPhotoFacets(catalog, category = "all") {
    const key = category && category !== "all" ? category : "all";
    let subCategories = catalog.subCategories.get(key);
    if (!subCategories) {
      const source = key === "all" ? catalog.items : catalog.items.filter((item) => item.category === key);
      subCategories = facetCounts(source, "subCategory").slice(0, 500);
      // Request values are unbounded; only source categories belong in the
      // prepared catalog. Unknown categories still return their normal result.
      if (key === "all" || catalog.categories.some((category) => category.value === key)) {
        catalog.subCategories.set(key, subCategories);
      }
    }
    return {
      categories: catalog.categories,
      subCategories,
      people: catalog.people
    };
  }

  function photoFiltersAreDefault(filters = {}) {
    return (!filters.category || filters.category === "all")
      && (!filters.subCategory || filters.subCategory === "all")
      && (!filters.person || filters.person === "all")
      && (!filters.date || filters.date === "all");
  }

  function normalizeImageSearchValue(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\p{P}\p{S}\s]+/gu, " ")
      .trim();
  }

  function compactImageSearchValue(value) {
    return normalizeImageSearchValue(value).replace(/\s+/g, "");
  }

  function createImageSearchQuery(query) {
    const raw = String(query || "").trim();
    const normalized = normalizeImageSearchValue(query);
    if (!normalized) return null;
    const compact = compactImageSearchValue(normalized);
    const terms = /\s/u.test(raw)
      ? [...new Set(normalized.split(/\s+/).map(compactImageSearchValue).filter(Boolean))]
      : [compact];
    return {
      normalized,
      compact,
      terms
    };
  }

  function imageSearchDocument(item) {
    const cached = imageSearchDocumentCache.get(item);
    if (cached) return cached;
    const movieMetadata = item?.movieMetadata || {};
    const tvSeries = item?.tvSeries || {};
    const fields = {
      title: normalizeImageSearchValue(item?.title),
      person: normalizeImageSearchValue(item?.personName),
      collection: normalizeImageSearchValue(item?.collectionTitle),
      category: normalizeImageSearchValue(item?.category),
      folder: normalizeImageSearchValue(item?.subCategory),
      metadata: normalizeImageSearchValue([
        item?.seriesName,
        item?.rootLabel,
        item?.ext,
        movieMetadata.title,
        movieMetadata.originalTitle,
        movieMetadata.imdbId,
        ...(movieMetadata.aliases || []),
        ...(movieMetadata.directors || []),
        ...(movieMetadata.writers || []),
        ...(movieMetadata.actors || []),
        ...(movieMetadata.genres || []),
        tvSeries.title,
        tvSeries.originalTitle,
        tvSeries.imdbId,
        ...(tvSeries.aliases || []),
        ...(tvSeries.directors || []),
        ...(tvSeries.writers || []),
        ...(tvSeries.actors || []),
        ...(tvSeries.genres || [])
      ].filter(Boolean).join(" "))
    };
    const compactFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replace(/\s+/g, "")]));
    const document = { fields, compactFields };
    imageSearchDocumentCache.set(item, document);
    return document;
  }

  function searchImageLibraryItems(items, searchSpec) {
    const results = [];
    for (const item of items) {
      const document = imageSearchDocument(item);
      const { compactFields } = document;
      if (!searchSpec.terms.every((term) => imageSearchFieldNames.some((field) => compactFields[field].includes(term)))) continue;

      const matchFields = imageSearchFieldNames.filter((field) => searchSpec.terms.some((term) => compactFields[field].includes(term)));
      let score = 0;
      if (compactFields.title === searchSpec.compact) score += 1800;
      else if (compactFields.title.startsWith(searchSpec.compact)) score += 900;
      else if (compactFields.title.includes(searchSpec.compact)) score += 420;
      if (compactFields.person === searchSpec.compact) score += 1200;
      else if (compactFields.person.includes(searchSpec.compact)) score += 360;
      if (compactFields.collection === searchSpec.compact) score += 1000;
      else if (compactFields.collection.includes(searchSpec.compact)) score += 300;
      if (compactFields.category === searchSpec.compact || compactFields.folder === searchSpec.compact) score += 420;
      for (const term of searchSpec.terms) {
        if (compactFields.title.includes(term)) score += 140;
        if (compactFields.person.includes(term)) score += 110;
        if (compactFields.collection.includes(term)) score += 90;
        if (compactFields.category.includes(term) || compactFields.folder.includes(term)) score += 50;
        if (compactFields.metadata.includes(term)) score += 20;
      }
      results.push({ item, matchFields, score });
    }
    return results;
  }

  function compareImageSearchResults(a, b) {
    const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
    if (scoreDiff) return scoreDiff;
    // Search results live for this request. NaN stays cached and still falls
    // through to the existing title tie-breaker.
    const aTime = a.updatedAt ?? (a.updatedAt = new Date(a.item?.updatedAt || 0).getTime());
    const bTime = b.updatedAt ?? (b.updatedAt = new Date(b.item?.updatedAt || 0).getTime());
    const timeDiff = bTime - aTime;
    return timeDiff || compareImageNames(String(a.item?.title || ""), String(b.item?.title || ""));
  }

  function filterPhotoSetsForList(items, filters = {}) {
    return (items || []).filter((item) => {
      if (filters.category && filters.category !== "all" && item.category !== filters.category) return false;
      if (filters.subCategory && filters.subCategory !== "all" && item.subCategory !== filters.subCategory) return false;
      if (filters.person && filters.person !== "all" && item.personName !== filters.person) return false;
      if (filters.date && filters.date !== "all" && item.archiveMonth !== filters.date && item.archiveDate !== filters.date) return false;
      if (filters.collection && photoCollectionValue(item) !== filters.collection) return false;
      return true;
    });
  }

  function photoLibraryFacets(items = [], subCategoryItems = items, options = {}) {
    const facets = {
      categories: facetCounts(items, "category"),
      subCategories: facetCounts(subCategoryItems, "subCategory").slice(0, 500),
      people: photoPersonFacets(items, Number(options.peopleLimit || 20))
    };
    if (options.includeDates) facets.dates = photoDateFacets(items);
    return facets;
  }

  function mediaLibraryFacets(items = []) {
    return {
      categories: facetCounts(items, "category").slice(0, 24),
      mediaKinds: facetCounts(items, "mediaKind"),
      people: facetCounts(items, "personName").slice(0, 20),
      roots: facetCounts(items, "rootLabel").slice(0, 12)
    };
  }

  function filterMediaItemsForList(items, filters = {}) {
    return (items || []).filter((item) => {
      const categoryKind = {
        __fanhao_media_kind_movie__: "movie",
        __fanhao_media_kind_tv__: "tv",
        __fanhao_media_kind_anime__: "anime"
      }[filters.category];
      if (categoryKind ? item.mediaKind !== categoryKind : filters.category && filters.category !== "all" && item.category !== filters.category) return false;
      if (filters.mediaKind && filters.mediaKind !== "all" && item.mediaKind !== filters.mediaKind) return false;
      if (filters.person && filters.person !== "all") {
        const itemPerson = String(item?.personName || item?.seriesName || "").trim();
        if (itemPerson !== filters.person) return false;
      }
      return true;
    });
  }

  function photoCollectionDir(item) {
    const collectionId = String(item?.collectionId || "");
    const separatorIndex = collectionId.indexOf("|");
    if (separatorIndex >= 0) return collectionId.slice(separatorIndex + 1) || photoCollectionRootValue;
    const relativePath = String(item?.relativePath || "").replace(/[\\/]+/g, "/");
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length <= 1) return photoCollectionRootValue;
    return parts.slice(0, -1).join("/");
  }

  function photoCollectionValue(item, dir) {
    if (item?.collectionId) return String(item.collectionId);
    return [item?.sourceRoot || item?.rootLabel || "", dir ?? photoCollectionDir(item)].join("|");
  }

  function photoCollectionDisplayName(dirValue) {
    const dir = String(dirValue || "").trim();
    if (!dir || dir === photoCollectionRootValue) return "根目录合集";
    const last = dir.split("/").filter(Boolean).pop() || dir;
    const bracketOnly = last.match(/^\[([^\]]+)\]$/);
    return bracketOnly ? bracketOnly[1].trim() || last : last;
  }

  function photoCollectionCategoryGroups(items = []) {
    const groups = new Map();
    for (const item of items) {
      const collectionValue = photoCollectionValue(item);
      const separator = collectionValue.indexOf("|");
      const source = (separator < 0 ? collectionValue : collectionValue.slice(0, separator)) || item.rootLabel || "图库";
      const category = String(item.category || "未分类").trim() || "未分类";
      const value = `${source}|${category}`;
      let group = groups.get(value);
      if (!group) {
        group = {
          value,
          title: [item.rootLabel, category].filter(Boolean).join(" / ") || category,
          category,
          rootLabel: item.rootLabel || "",
          collections: new Map(),
          size: 0,
          imageCount: 0,
          albumCount: 0,
          updatedAt: "",
          updatedTime: 0,
          coverUrl: item.coverUrl || photoSetService.coverUrl(item.id, item.updatedAt || "")
        };
        groups.set(value, group);
      }
      let collection = group.collections.get(collectionValue);
      if (!collection) {
        collection = {
          value: collectionValue,
          title: item.collectionTitle || photoCollectionDisplayName(photoCollectionDir(item)),
          rootLabel: item.rootLabel || "",
          count: 0,
          size: 0,
          imageCount: 0,
          updatedAt: "",
          updatedTime: 0,
          coverUrl: item.coverUrl || photoSetService.coverUrl(item.id, item.updatedAt || ""),
          categories: new Set(),
          subCategories: new Set()
        };
        group.collections.set(collectionValue, collection);
      }
      const size = Number(item.size || 0);
      const imageCount = Number(item.imageCount || 0);
      const updatedTime = item.updatedAt ? Date.parse(item.updatedAt) : 0;
      group.size += size;
      group.imageCount += imageCount;
      group.albumCount += 1;
      if (updatedTime > group.updatedTime) {
        group.updatedTime = updatedTime;
        group.updatedAt = item.updatedAt;
      }
      collection.size += size;
      collection.imageCount += imageCount;
      collection.count += 1;
      if (updatedTime > collection.updatedTime) {
        collection.updatedTime = updatedTime;
        collection.updatedAt = item.updatedAt;
      }
      if (!collection.coverUrl && item.coverUrl) collection.coverUrl = item.coverUrl;
      if (item.category) collection.categories.add(item.category);
      if (item.subCategory) collection.subCategories.add(item.subCategory);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        collections: [...group.collections.values()]
          .sort((a, b) => b.count - a.count || b.updatedTime - a.updatedTime || compareImageNames(a.title, b.title))
      }))
      .sort((a, b) => b.albumCount - a.albumCount || Number(b.size || 0) - Number(a.size || 0) || compareImageNames(a.title, b.title));
  }

  function photoCollectionSummary(items = [], collectionValue = "") {
    if (!collectionValue) return null;
    const first = items[0] || {};
    return {
      id: collectionValue,
      title: first.collectionTitle || photoCollectionDisplayName(photoCollectionDir(first)),
      rootLabel: first.rootLabel || "",
      category: first.category || "",
      subCategory: first.subCategory || first.collectionTitle || "",
      largeCategoryTitle: [first.rootLabel, first.category].filter(Boolean).join(" / "),
      count: items.length,
      size: items.reduce((sum, item) => sum + Number(item.size || 0), 0),
      imageCount: items.reduce((sum, item) => sum + Number(item.imageCount || 0), 0),
      updatedAt: items.reduce((latest, item) => {
        const itemTime = new Date(item.updatedAt || 0).getTime();
        const latestTime = new Date(latest || 0).getTime();
        return itemTime > latestTime ? item.updatedAt : latest;
      }, "")
    };
  }

  function sortImageLibraryItems(items, sort) {
    const list = [...items];
    if (sort === "count") {
      return list.sort((a, b) => Number(b.albumCount || 0) - Number(a.albumCount || 0) || Number(b.size || 0) - Number(a.size || 0) || compareImageNames(a.title, b.title));
    }
    if (sort === "title") {
      return list.sort((a, b) => compareImageNames(a.title, b.title));
    }
    if (sort === "size") {
      return list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || compareImageNames(a.title, b.title));
    }
    if (sort === "rating") {
      return list.sort((a, b) => {
        const aRating = Number(a.rating || a.tvSeries?.rating || 0);
        const bRating = Number(b.rating || b.tvSeries?.rating || 0);
        const aHasRating = aRating > 0;
        const bHasRating = bRating > 0;
        if (aHasRating !== bHasRating) return aHasRating ? -1 : 1;
        if (aRating !== bRating) return bRating - aRating;
        return compareImageNames(a.title, b.title);
      });
    }
    if (sort === "year") {
      const years = new Map();
      const yearOf = item => {
        let year = years.get(item);
        if (year === undefined) {
          year = Number.parseInt(String(item?.year || item?.movieMetadata?.year || item?.tvSeries?.year || "").match(/\d{4}/)?.[0] || "", 10) || 0;
          years.set(item, year);
        }
        return year;
      };
      return list.sort((a, b) => {
        const aYear = yearOf(a);
        const bYear = yearOf(b);
        return bYear - aYear || compareImageNames(a.title, b.title);
      });
    }
    return list
      .map((item) => ({ item, updatedAt: new Date(item.updatedAt || 0).getTime() }))
      .sort((a, b) => {
        const timeDiff = b.updatedAt - a.updatedAt;
        return timeDiff || compareImageNames(a.item.title, b.item.title);
      })
      .map(({ item }) => item);
  }

  function photoCollectionHealthPayload(collection, options = {}) {
    const collectionId = String(collection || "").trim();
    if (!collectionId) throw Object.assign(new Error("缺少合集"), { statusCode: 400 });
    const index = getPhotoIndex(options, collectionId);
    const catalog = preparedPhotoCatalog(index, true);
    const albums = preparedPhotoCollectionAlbums(catalog, collectionId).map(item => ({
      ...item, archiveDate: item.archiveDate || photoArchiveDate(item.title),
      albumSubject: item.albumSubject || photoAlbumSubject(item.title, item, item.collectionTitle),
      routePath: imageLibraryItemRoutePath("photo", item.id)
    }));
    if (!albums.length) throw Object.assign(new Error("没有找到这个合集"), { statusCode: 404 });
    return { collection: collectionId, scannedAt: index?.scannedAt || "", ...photoCollectionHealth(albums) };
  }

  let cachedPhotoAnalysis = null;

  function photoLibraryAnalysisPayload(options = {}) {
    const index = getPhotoIndex(options);
    if (cachedPhotoAnalysis?.index === index) return cachedPhotoAnalysis.payload;
    const groups = new Map();
    for (const row of preparedPhotoCatalog(index, true).items) {
      if (!row.collectionId) continue;
      let group = groups.get(row.collectionId);
      if (!group) groups.set(row.collectionId, group = []);
      group.push(row);
    }
    const collections = [];
    const totals = { collections: 0, albums: 0, numbered: 0, missing: 0, duplicateGroups: 0, duplicateBytes: 0, size: 0 };
    for (const [id, rows] of groups) {
      const albums = rows.map(row => {
        const archiveDate = photoArchiveDate(row.title);
        return { id: row.id, title: row.title, size: row.size, imageCount: row.imageCount, archiveDate,
          albumSubject: archiveDate && !parsePhotoAlbumNumber(row.title) ? photoAlbumSubject(row.title, row, row.collectionTitle) : "" };
      });
      const health = photoCollectionHealth(albums);
      const family = health.numbering[0] || null;
      const size = rows.reduce((sum, row) => sum + Number(row.size || 0), 0);
      collections.push({
        id, title: rows[0].collectionTitle || id, category: rows[0].category || "", count: rows.length, size,
        numbered: health.numbered, prefix: family?.prefix || "", min: family?.min ?? null, max: family?.max ?? null,
        missing: family?.missing || 0, duplicateGroups: health.duplicateGroupCount, duplicateBytes: health.duplicateReclaimableBytes
      });
      totals.collections++; totals.albums += rows.length; totals.numbered += health.numbered; totals.size += size;
      totals.missing += family?.missing || 0; totals.duplicateGroups += health.duplicateGroupCount;
      totals.duplicateBytes += health.duplicateReclaimableBytes;
    }
    collections.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "zh-CN"));
    const payload = { scannedAt: index?.scannedAt || "", totals, collections };
    cachedPhotoAnalysis = { index, payload };
    return payload;
  }

  return {
    itemsPayload,
    photoCollectionHealthPayload,
    photoLibraryAnalysisPayload,
    projectPhotoIndex,
    clearPreparedQueries: preparedQueries.clear,
    payload,
    publicGalleryMediaItem,
    summaryPayload
  };
}
