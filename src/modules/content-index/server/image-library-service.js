export function createImageLibraryService({
  clampInteger,
  galleryMediaRootStatuses,
  getImageLibraryIndex,
  imageReaderCacheStatus,
  mangaService,
  maxItemLimit,
  metadataService,
  photoCollectionRootValue,
  photoSetRootStatuses,
  photoSetService
}) {
  let cachedPhotoCatalog = null;
  let imageSearchDocumentCache = new WeakMap();

  function facetCounts(items, fieldName) {
    const counts = new Map();
    for (const item of items) {
      const value = String(item[fieldName] || "").trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }));
  }

  function mediaItemsByKind(items, kind) {
    return items.filter((item) => item.mediaKind === kind);
  }

  function mediaItemsByKinds(items, kinds = []) {
    const selected = new Set(kinds);
    return items.filter((item) => selected.has(item.mediaKind));
  }

  function galleryMediaSeriesKey(item) {
    if (!item || item.mediaKind !== "tv") return "";
    return metadataService.tvSeriesKey(item.category || "", item.seriesName || item.personName || item.subCategory || item.title || "");
  }

  function galleryMediaCoverUrl(mediaId, updatedAt = "") {
    if (!mediaId) return "";
    const suffix = updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : "";
    return `/media/gallery-media-cover/${encodeURIComponent(mediaId)}${suffix}`;
  }

  function publicGalleryMediaItem(item, tvMetadataByKey = null, movieMetadataById = null) {
    const seriesKey = galleryMediaSeriesKey(item);
    const tvSeries = seriesKey ? metadataService.publicTvSeries(tvMetadataByKey?.get(seriesKey) || metadataService.tvSeriesRow(seriesKey)) : null;
    const movieMetadata = item?.mediaKind === "movie" ? metadataService.publicMovie(movieMetadataById?.get(item.id) || metadataService.movieRow(item.id)) : null;
    const movieCoverUrl = movieMetadata?.coverUrl || "";
    const fallbackCoverUrl = item.mediaKind === "tv" || item.mediaKind === "movie" ? galleryMediaCoverUrl(item.id, item.updatedAt || "") : "";
    return {
      ...item,
      seriesKey,
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

  function payload(options = {}) {
    const index = getImageLibraryIndex(options);
    const photoSets = (index.photoSets || []).map((item) => ({
      ...item,
      coverUrl: item.coverUrl || photoSetService.coverUrl(item.id, item.updatedAt || "")
    }));
    const tvMetadataByKey = metadataService.tvSeriesRowsMap();
    const movieMetadataById = metadataService.movieRowsMap();
    const mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById));
    const westernItems = mediaItemsByKind(mediaItems, "western");
    const movieItems = mediaItemsByKind(mediaItems, "movie");
    const tvItems = mediaItemsByKind(mediaItems, "tv");
    const screenItems = mediaItemsByKinds(mediaItems, ["movie", "tv"]);
    const manga = mangaService.cacheDirs().map(mangaService.publicSummary);
    return {
      schemaVersion: 2,
      scannedAt: index.scannedAt || "",
      mangaRoot: mangaService.rootStatus(),
      photoRoots: index.roots || photoSetRootStatuses(),
      mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
      cache: imageReaderCacheStatus(),
      totals: {
        manga: manga.length,
        photoSets: photoSets.length,
        western: westernItems.length,
        movies: movieItems.length,
        tv: tvItems.length,
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
        media: mediaFacets(screenItems)
      },
      manga,
      photoSets,
      mediaItems
    };
  }

  function summaryPayload(options = {}) {
    const index = getImageLibraryIndex(options);
    const photoSets = Array.isArray(index.photoSets) ? index.photoSets : [];
    const mediaItems = Array.isArray(index.mediaItems) ? index.mediaItems : [];
    const westernItems = mediaItemsByKind(mediaItems, "western");
    const movieItems = mediaItemsByKind(mediaItems, "movie");
    const tvItems = mediaItemsByKind(mediaItems, "tv");
    const screenItems = mediaItemsByKinds(mediaItems, ["movie", "tv"]);
    const mangaCount = mangaService.cacheDirs().length;
    const cache = options.includeCache === false ? null : imageReaderCacheStatus();
    return {
      schemaVersion: 1,
      scannedAt: index.scannedAt || "",
      mangaRoot: mangaService.rootStatus(),
      photoRoots: index.roots || photoSetRootStatuses(),
      mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
      cache: cache ? {
        root: cache.root,
        exists: cache.exists,
        maxBytes: cache.maxBytes,
        currentBytes: cache.currentBytes,
        overBytes: cache.overBytes,
        fileCount: cache.fileCount,
        cleanupIntervalMs: cache.cleanupIntervalMs
      } : null,
      totals: {
        manga: mangaCount,
        photoSets: photoSets.length,
        western: westernItems.length,
        movies: movieItems.length,
        tv: tvItems.length,
        media: mediaItems.length,
        photoBytes: photoSets.reduce((sum, item) => sum + Number(item.size || 0), 0),
        mediaBytes: mediaItems.reduce((sum, item) => sum + Number(item.size || 0), 0)
      },
      facets: {
        categories: facetCounts(photoSets, "category").slice(0, 12),
        people: photoPersonFacets(photoSets, 12),
        western: mediaFacets(westernItems),
        movie: mediaFacets(movieItems),
        tv: mediaFacets(tvItems),
        media: mediaFacets(screenItems)
      }
    };
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
    const index = getImageLibraryIndex(options);
    let mediaItems = [];
    if (!["photo", "manga"].includes(mode)) {
      const tvMetadataByKey = metadataService.tvSeriesRowsMap();
      const movieMetadataById = metadataService.movieRowsMap();
      mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById));
    }

    let source = [];
    let facetsSource = [];
    let photoSubCategoryFacetsSource = [];
    let photoFacets = null;
    let collectionSummary = null;
    let seriesSummary = null;
    if (mode === "photo") {
      const catalog = preparedPhotoCatalog(index);
      const filteredPhotoSets = filterPhotoSetsForList(catalog.items, { category, subCategory, person, date, collection });
      photoFacets = preparedPhotoFacets(catalog, category);
      if (collection) {
        const collectionItems = filterPhotoSetsForList(catalog.items, { collection, category: "all", subCategory: "all", person: "all", date: "all" });
        collectionSummary = photoCollectionSummary(collectionItems, collection);
        photoFacets = photoLibraryFacets(collectionItems, collectionItems, { peopleLimit: 500, includeDates: true });
      }
      source = photoView === "collections" && !collection
        ? photoFiltersAreDefault({ category, subCategory, person, date })
          ? catalog.collectionCategories
          : photoCollectionCategoryGroups(filteredPhotoSets).map(publicPhotoCollectionCategoryListItem)
        : filteredPhotoSets;
    } else if (mode === "manga") {
      source = mangaService.cacheDirs().map((cacheDir) => publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga"));
    } else if (mode === "media") {
      const movieSource = mediaItemsByKind(mediaItems, "movie").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const tvSource = mediaItemsByKind(mediaItems, "tv").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const tvSeriesSource = tvSeriesGroups(tvSource).map(publicTvSeriesListItem).filter(Boolean);
      const screenWorksSource = [...movieSource, ...tvSeriesSource];
      facetsSource = screenWorksSource;
      if (seriesKey) {
        const categorySource = filterMediaItemsForList(tvSource, { category, person, mediaKind: "tv" });
        source = categorySource.filter((item) => item.seriesKey === seriesKey);
        seriesSummary = publicTvSeriesListItem(tvSeriesGroups(tvSource).find((group) => group.seriesKey === seriesKey) || null);
      } else if (person !== "all") {
        source = filterMediaItemsForList(tvSource, { category, person, mediaKind: "tv" });
        seriesSummary = publicTvSeriesListItem(tvSeriesGroups(tvSource).find((group) => group.seriesName === person) || null);
      } else {
        source = filterMediaItemsForList(screenWorksSource, { category, person, mediaKind });
      }
    } else if (["western", "movie", "tv"].includes(mode)) {
      const mediaSource = mediaItemsByKind(mediaItems, mode).map((item) => publicImageLibraryListItem(item, mode));
      const categorySource = filterMediaItemsForList(mediaSource, { category, person });
      if (mode === "tv") {
        const tvSeriesSource = tvSeriesGroups(mediaSource).map(publicTvSeriesListItem);
        facetsSource = tvSeriesSource;
        if (seriesKey) {
          source = categorySource.filter((item) => item.seriesKey === seriesKey);
          seriesSummary = publicTvSeriesListItem(tvSeriesGroups(mediaSource).find((group) => group.seriesKey === seriesKey) || null);
        } else if (person !== "all") {
          source = categorySource;
          seriesSummary = publicTvSeriesListItem(tvSeriesGroups(mediaSource).find((group) => group.seriesName === person) || null);
        } else if (tvView === "episodes") {
          source = categorySource;
        } else {
          source = tvSeriesGroups(categorySource).map(publicTvSeriesListItem);
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
      : sortImageLibraryItems(filtered, sort);
    const searchResultsByItem = searchResults ? new Map(searchResults.map((result) => [result.item, result])) : null;
    const items = sorted.slice(offset, offset + limit).map((item) => {
      const match = searchResultsByItem?.get(item);
      return match ? { ...item, matchFields: match.matchFields } : item;
    });
    return {
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
        totalBytes: sorted.reduce((sum, item) => sum + Number(item?.size || 0), 0)
      },
      count: items.length,
      total: sorted.length,
      limit,
      offset,
      scannedAt: index.scannedAt || "",
      items
    };
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
    if (["photo", "manga", "western", "movie", "tv"].includes(mode)) return mode;
    return "photo";
  }

  function normalizeMediaKindFilter(value) {
    const kind = String(value || "").trim().toLowerCase();
    return ["movie", "tv"].includes(kind) ? kind : "all";
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

  function photoArchiveMonth(value) {
    return photoArchiveDate(value).slice(0, 7);
  }

  function photoAlbumNumber(value) {
    const match = String(value || "").match(/\b(VOL|N[O0])\.?\s*(\d+)\b/i);
    if (!match) return "";
    const prefix = /^VOL$/i.test(match[1]) ? "VOL." : "NO.";
    return `${prefix}${match[2]}`;
  }

  function escapePhotoAlbumPattern(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripPhotoAlbumStats(value) {
    return String(value || "")
      .replace(/\s*\[[^\]]*(?:\d+\s*[PV]|(?:MB|GB)\b|\d+(?:\.\d+)?\s*M\b)[^\]]*\]\s*$/iu, "")
      .trim();
  }

  function photoAlbumSubject(value, item = {}) {
    const text = stripPhotoAlbumStats(value);
    const match = text.match(/\b(?:VOL|N[O0])\.?\s*\d+\b/i);
    const personName = String(item?.personName || "").trim();
    const structuralLabels = [
      item?.collectionTitle,
      item?.subCategory,
      photoCollectionDisplayName(photoCollectionDir(item))
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
        .replace(/^\s*[-–—:]\s*/u, "")
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
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, limit);
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

  function publicImageLibraryListItem(item, mode) {
    const normalizedMode = normalizeImageLibraryMode(mode || item?.mediaKind || item?.type);
    const movieMetadata = item?.movieMetadata || null;
    const movieTitle = normalizedMode === "movie" ? moviePrimaryDisplayTitle(item, movieMetadata) : "";
    const photoTitle = String(item?.title || item?.dirName || "").trim();
    const collectionTitle = normalizedMode === "photo" ? photoCollectionDisplayName(photoCollectionDir(item)) : "";
    const displayTitle =
      normalizedMode === "movie" && movieTitle
        ? [movieTitle, movieMetadata?.year ? `(${movieMetadata.year})` : ""].filter(Boolean).join(" ")
        : photoTitle;
    return {
      id: String(item?.id || ""),
      type: normalizedMode,
      mediaKind: String(item?.mediaKind || (["western", "movie", "tv"].includes(normalizedMode) ? normalizedMode : "")).trim(),
      title: displayTitle,
      category: String(item?.category || item?.site || item?.kindLabel || "").trim(),
      subCategory: String(item?.subCategory || "").trim(),
      personName: String(item?.personName || "").trim(),
      seriesName: String(item?.seriesName || "").trim(),
      seriesKey: String(item?.seriesKey || "").trim(),
      tvSeries: item?.tvSeries || null,
      movieMetadata,
      rootLabel: String(item?.rootLabel || item?.kindLabel || "").trim(),
      ext: String(item?.archiveExt || item?.ext || "").trim(),
      size: Number(item?.size || 0),
      updatedAt: String(item?.updatedAt || "").trim(),
      archiveDate: normalizedMode === "photo" ? photoArchiveDate(photoTitle) : "",
      archiveMonth: normalizedMode === "photo" ? photoArchiveMonth(photoTitle) : "",
      albumNumber: normalizedMode === "photo" ? photoAlbumNumber(photoTitle) : "",
      albumSubject: normalizedMode === "photo" ? photoAlbumSubject(photoTitle, { ...item, collectionTitle }) : "",
      imageCount: item?.imageCount === null || item?.imageCount === undefined ? null : Number(item.imageCount || 0),
      chapterCount: item?.chapterCount === undefined ? null : Number(item.chapterCount || 0),
      doneChapterCount: item?.doneChapterCount === undefined ? null : Number(item.doneChapterCount || 0),
      downloadedCount: item?.downloadedCount === undefined ? null : Number(item.downloadedCount || 0),
      failedCount: item?.failedCount === undefined ? null : Number(item.failedCount || 0),
      albumCount: item?.albumCount === undefined ? null : Number(item.albumCount || 0),
      collectionId: normalizedMode === "photo" ? photoCollectionValue(item) : "",
      collectionTitle,
      playable: Boolean(item?.playable),
      coverUrl: String(item?.coverUrl || (normalizedMode === "photo" ? photoSetService.coverUrl(item?.id, item?.updatedAt || "") : "")).trim(),
      rating: item?.movieMetadata?.rating === null || item?.movieMetadata?.rating === undefined ? item?.rating ?? null : Number(item.movieMetadata.rating || 0),
      ratingCount: item?.movieMetadata?.ratingCount === null || item?.movieMetadata?.ratingCount === undefined ? item?.ratingCount ?? null : Number(item.movieMetadata.ratingCount || 0),
      year: String(item?.movieMetadata?.year || item?.year || "").trim(),
      genres: Array.isArray(item?.movieMetadata?.genres) ? item.movieMetadata.genres : Array.isArray(item?.genres) ? item.genres : [],
      routePath: imageLibraryItemRoutePath(normalizedMode, item?.id)
    };
  }

  function publicPhotoCollectionListItem(group) {
    return {
      id: group.value,
      type: "photoCollection",
      title: group.title,
      category: group.categories.slice(0, 3).join(" · "),
      subCategory: group.subCategories.slice(0, 3).join(" · "),
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
          title: item?.tvSeries?.title || item?.seriesName || item?.personName || item?.subCategory || item?.title || "电视剧",
          seriesName: item?.seriesName || item?.personName || item?.subCategory || "",
          category: item?.category || "",
          rootLabel: item?.rootLabel || "",
          tvSeries: item?.tvSeries || null,
          coverUrl: item?.tvSeries?.coverUrl || "",
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
      mediaKind: "tv",
      title: String(meta.title || group.title || group.seriesName || "电视剧").trim(),
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
      routePath: `/tv?seriesKey=${encodeURIComponent(String(group.seriesKey || ""))}`
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
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }))
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
    return "/";
  }

  function preparedPhotoCatalog(index) {
    if (cachedPhotoCatalog?.index === index) return cachedPhotoCatalog;
    imageSearchDocumentCache = new WeakMap();
    const rawItems = Array.isArray(index?.photoSets) ? index.photoSets : [];
    const items = rawItems.map((item) => publicImageLibraryListItem(item, "photo"));
    cachedPhotoCatalog = {
      index,
      items,
      collections: photoCollectionGroups(items).map(publicPhotoCollectionListItem),
      collectionCategories: photoCollectionCategoryGroups(items).map(publicPhotoCollectionCategoryListItem),
      categories: facetCounts(items, "category"),
      people: photoPersonFacets(items, 20),
      subCategories: new Map()
    };
    return cachedPhotoCatalog;
  }

  function preparedPhotoFacets(catalog, category = "all") {
    const key = category && category !== "all" ? category : "all";
    let subCategories = catalog.subCategories.get(key);
    if (!subCategories) {
      const source = key === "all" ? catalog.items : catalog.items.filter((item) => item.category === key);
      subCategories = facetCounts(source, "subCategory").slice(0, 500);
      catalog.subCategories.set(key, subCategories);
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
      const entries = Object.entries(document.compactFields);
      if (!searchSpec.terms.every((term) => entries.some(([, value]) => value.includes(term)))) continue;

      const matchFields = entries.filter(([, value]) => searchSpec.terms.some((term) => value.includes(term))).map(([field]) => field);
      const { compactFields } = document;
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
    const timeDiff = new Date(b.item?.updatedAt || 0).getTime() - new Date(a.item?.updatedAt || 0).getTime();
    return timeDiff || String(a.item?.title || "").localeCompare(String(b.item?.title || ""), undefined, { numeric: true, sensitivity: "base" });
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
        __fanhao_media_kind_tv__: "tv"
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

  function photoCollectionValue(item) {
    if (item?.collectionId) return String(item.collectionId);
    return [item?.sourceRoot || item?.rootLabel || "", photoCollectionDir(item)].join("|");
  }

  function photoCollectionDisplayName(dirValue) {
    const dir = String(dirValue || "").trim();
    if (!dir || dir === photoCollectionRootValue) return "根目录合集";
    const last = dir.split("/").filter(Boolean).pop() || dir;
    const bracketOnly = last.match(/^\[([^\]]+)\]$/);
    return bracketOnly ? bracketOnly[1].trim() || last : last;
  }

  function photoCollectionGroups(items = []) {
    const groups = new Map();
    for (const item of items) {
      const dir = photoCollectionDir(item);
      const value = photoCollectionValue(item);
      let group = groups.get(value);
      if (!group) {
        group = {
          value,
          title: item.collectionTitle || photoCollectionDisplayName(dir),
          dir,
          rootLabel: item.rootLabel || "",
          count: 0,
          size: 0,
          imageCount: 0,
          updatedAt: "",
          coverUrl: item.coverUrl || photoSetService.coverUrl(item.id, item.updatedAt || ""),
          categories: new Set(),
          subCategories: new Set()
        };
        groups.set(value, group);
      }
      group.count += 1;
      group.size += Number(item.size || 0);
      group.imageCount += Number(item.imageCount || 0);
      if (!group.coverUrl && item.coverUrl) group.coverUrl = item.coverUrl;
      if (item.category) group.categories.add(item.category);
      if (item.subCategory) group.subCategories.add(item.subCategory);
      const itemTime = new Date(item.updatedAt || 0).getTime();
      const groupTime = new Date(group.updatedAt || 0).getTime();
      if (itemTime > groupTime) group.updatedAt = item.updatedAt || group.updatedAt;
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        categories: [...group.categories],
        subCategories: [...group.subCategories]
      }))
      .sort((a, b) => b.count - a.count || new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime() || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
  }

  function photoCollectionCategoryGroups(items = []) {
    const groups = new Map();
    for (const item of items) {
      const source = String(photoCollectionValue(item)).split("|")[0] || item.rootLabel || "图库";
      const category = String(item.category || "未分类").trim() || "未分类";
      const value = `${source}|${category}`;
      let group = groups.get(value);
      if (!group) {
        group = {
          value,
          title: [item.rootLabel, category].filter(Boolean).join(" / ") || category,
          category,
          rootLabel: item.rootLabel || "",
          items: [],
          size: 0,
          imageCount: 0,
          albumCount: 0,
          updatedAt: "",
          coverUrl: item.coverUrl || photoSetService.coverUrl(item.id, item.updatedAt || "")
        };
        groups.set(value, group);
      }
      group.items.push(item);
      group.size += Number(item.size || 0);
      group.imageCount += Number(item.imageCount || 0);
      group.albumCount += 1;
      const itemTime = new Date(item.updatedAt || 0).getTime();
      const groupTime = new Date(group.updatedAt || 0).getTime();
      if (itemTime > groupTime) group.updatedAt = item.updatedAt || group.updatedAt;
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        collections: photoCollectionGroups(group.items)
      }))
      .sort((a, b) => b.albumCount - a.albumCount || Number(b.size || 0) - Number(a.size || 0) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
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
      return list.sort((a, b) => Number(b.albumCount || 0) - Number(a.albumCount || 0) || Number(b.size || 0) - Number(a.size || 0) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
    }
    if (sort === "title") {
      return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
    }
    if (sort === "size") {
      return list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
    }
    if (sort === "rating") {
      return list.sort((a, b) => {
        const aRating = Number(a.rating || a.tvSeries?.rating || 0);
        const bRating = Number(b.rating || b.tvSeries?.rating || 0);
        const aHasRating = aRating > 0;
        const bHasRating = bRating > 0;
        if (aHasRating !== bHasRating) return aHasRating ? -1 : 1;
        if (aRating !== bRating) return bRating - aRating;
        return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
      });
    }
    if (sort === "year") {
      return list.sort((a, b) => {
        const aYear = Number.parseInt(String(a?.year || a?.movieMetadata?.year || a?.tvSeries?.year || "").match(/\d{4}/)?.[0] || "", 10) || 0;
        const bYear = Number.parseInt(String(b?.year || b?.movieMetadata?.year || b?.tvSeries?.year || "").match(/\d{4}/)?.[0] || "", 10) || 0;
        return bYear - aYear || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
      });
    }
    return list.sort((a, b) => {
      const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  return {
    itemsPayload,
    payload,
    publicGalleryMediaItem,
    summaryPayload
  };
}
