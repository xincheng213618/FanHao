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
        people: facetCounts(photoSets, "personName"),
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
    const manga = mangaService.cacheDirs().map(mangaService.publicSummary);
    const cache = imageReaderCacheStatus();
    return {
      schemaVersion: 1,
      scannedAt: index.scannedAt || "",
      mangaRoot: mangaService.rootStatus(),
      photoRoots: index.roots || photoSetRootStatuses(),
      mediaRoots: index.mediaRoots || galleryMediaRootStatuses(),
      cache: {
        root: cache.root,
        exists: cache.exists,
        maxBytes: cache.maxBytes,
        currentBytes: cache.currentBytes,
        overBytes: cache.overBytes,
        fileCount: cache.fileCount,
        cleanupIntervalMs: cache.cleanupIntervalMs
      },
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
        categories: facetCounts(photoSets, "category").slice(0, 12),
        people: facetCounts(photoSets, "personName").slice(0, 12),
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
    const sort = String(url.searchParams.get("sort") || "updated").trim();
    const photoView = normalizePhotoLibraryView(url.searchParams.get("photoView") || url.searchParams.get("view"));
    const tvView = normalizeTvLibraryView(url.searchParams.get("tvView") || url.searchParams.get("view"));
    const category = String(url.searchParams.get("category") || "all").trim() || "all";
    const person = String(url.searchParams.get("person") || "all").trim() || "all";
    const collection = String(url.searchParams.get("collection") || "").trim();
    const seriesKey = String(url.searchParams.get("seriesKey") || "").trim();
    const index = getImageLibraryIndex(options);
    const tvMetadataByKey = metadataService.tvSeriesRowsMap();
    const movieMetadataById = metadataService.movieRowsMap();
    const mediaItems = (Array.isArray(index.mediaItems) ? index.mediaItems : []).map((item) => publicGalleryMediaItem(item, tvMetadataByKey, movieMetadataById));

    let source = [];
    let facetsSource = [];
    let collectionSummary = null;
    let seriesSummary = null;
    if (mode === "photo") {
      const photoSets = Array.isArray(index.photoSets) ? index.photoSets : [];
      const filteredPhotoSets = filterPhotoSetsForList(photoSets, { category, person, collection });
      facetsSource = collection ? filteredPhotoSets : filterPhotoSetsForList(photoSets, { collection: "", category: "all", person: "all" });
      if (collection) collectionSummary = photoCollectionSummary(filteredPhotoSets, collection);
      source = photoView === "collections" && !collection
        ? photoCollectionGroups(filteredPhotoSets).map(publicPhotoCollectionListItem)
        : filteredPhotoSets.map((item) => publicImageLibraryListItem(item, "photo"));
    } else if (mode === "manga") {
      source = mangaService.cacheDirs().map((cacheDir) => publicImageLibraryListItem(mangaService.publicSummary(cacheDir), "manga"));
    } else if (mode === "media") {
      const movieSource = mediaItemsByKind(mediaItems, "movie").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const tvSource = mediaItemsByKind(mediaItems, "tv").map((item) => publicImageLibraryListItem(item, item.mediaKind));
      const tvSeriesSource = tvSeriesGroups(tvSource).map(publicTvSeriesListItem).filter(Boolean);
      const screenWorksSource = [...movieSource, ...tvSeriesSource];
      facetsSource = screenWorksSource;
      if (seriesKey) {
        const categorySource = filterMediaItemsForList(tvSource, { category });
        source = categorySource.filter((item) => item.seriesKey === seriesKey);
        seriesSummary = publicTvSeriesListItem(tvSeriesGroups(tvSource).find((group) => group.seriesKey === seriesKey) || null);
      } else {
        source = filterMediaItemsForList(screenWorksSource, { category });
      }
    } else if (["western", "movie", "tv"].includes(mode)) {
      const mediaSource = mediaItemsByKind(mediaItems, mode).map((item) => publicImageLibraryListItem(item, mode));
      const categorySource = filterMediaItemsForList(mediaSource, { category });
      if (mode === "tv") {
        const tvSeriesSource = tvSeriesGroups(mediaSource).map(publicTvSeriesListItem);
        facetsSource = tvSeriesSource;
        if (seriesKey) {
          source = categorySource.filter((item) => item.seriesKey === seriesKey);
          seriesSummary = publicTvSeriesListItem(tvSeriesGroups(mediaSource).find((group) => group.seriesKey === seriesKey) || null);
        } else if (tvView === "episodes") {
          source = categorySource;
        } else {
          source = tvSeriesGroups(categorySource).map(publicTvSeriesListItem);
        }
      } else {
        facetsSource = mediaSource;
        source = categorySource;
      }
    }

    const filtered = filterImageLibraryItems(source, query);
    const sorted = sortImageLibraryItems(filtered, sort);
    const items = sorted.slice(offset, offset + limit);
    return {
      schemaVersion: 1,
      mode,
      query,
      sort,
      photoView: mode === "photo" ? (collection ? "albums" : photoView) : "",
      tvView: mode === "tv" ? (seriesKey || tvView === "episodes" ? "episodes" : "series") : mode === "media" && seriesKey ? "episodes" : "",
      category: ["photo", "western", "movie", "tv", "media"].includes(mode) ? category : "",
      person: mode === "photo" ? person : "",
      collection: mode === "photo" ? collection : "",
      collectionSummary,
      seriesKey: ["tv", "media"].includes(mode) ? seriesKey : "",
      seriesSummary,
      facets: mode === "photo" ? photoLibraryFacets(facetsSource) : mediaLibraryFacets(facetsSource),
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

  function publicImageLibraryListItem(item, mode) {
    const normalizedMode = normalizeImageLibraryMode(mode || item?.mediaKind || item?.type);
    const movieMetadata = item?.movieMetadata || null;
    const movieTitle = normalizedMode === "movie" ? moviePrimaryDisplayTitle(item, movieMetadata) : "";
    const displayTitle =
      normalizedMode === "movie" && movieTitle
        ? [movieTitle, movieMetadata?.year ? `(${movieMetadata.year})` : ""].filter(Boolean).join(" ")
        : String(item?.title || item?.dirName || "").trim();
    return {
      id: String(item?.id || ""),
      type: normalizedMode,
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
      imageCount: item?.imageCount === null || item?.imageCount === undefined ? null : Number(item.imageCount || 0),
      chapterCount: item?.chapterCount === undefined ? null : Number(item.chapterCount || 0),
      doneChapterCount: item?.doneChapterCount === undefined ? null : Number(item.doneChapterCount || 0),
      downloadedCount: item?.downloadedCount === undefined ? null : Number(item.downloadedCount || 0),
      failedCount: item?.failedCount === undefined ? null : Number(item.failedCount || 0),
      albumCount: item?.albumCount === undefined ? null : Number(item.albumCount || 0),
      collectionId: normalizedMode === "photo" ? photoCollectionValue(item) : "",
      collectionTitle: normalizedMode === "photo" ? photoCollectionDisplayName(photoCollectionDir(item)) : "",
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
      type: "tvSeries",
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

  function filterImageLibraryItems(items, query) {
    const needle = query.toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [
        item.title,
        item.category,
        item.subCategory,
        item.personName,
        item.seriesName,
        item.rootLabel,
        item.ext,
        item.movieMetadata?.title,
        item.movieMetadata?.originalTitle,
        item.movieMetadata?.imdbId,
        ...(item.movieMetadata?.aliases || []),
        ...(item.movieMetadata?.directors || []),
        ...(item.movieMetadata?.writers || []),
        ...(item.movieMetadata?.actors || []),
        ...(item.movieMetadata?.genres || []),
        item.tvSeries?.title,
        item.tvSeries?.originalTitle,
        item.tvSeries?.imdbId,
        ...(item.tvSeries?.aliases || []),
        ...(item.tvSeries?.directors || []),
        ...(item.tvSeries?.writers || []),
        ...(item.tvSeries?.actors || []),
        ...(item.tvSeries?.genres || [])
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }

  function filterPhotoSetsForList(items, filters = {}) {
    return (items || []).filter((item) => {
      if (filters.category && filters.category !== "all" && item.category !== filters.category) return false;
      if (filters.person && filters.person !== "all" && item.personName !== filters.person) return false;
      if (filters.collection && photoCollectionValue(item) !== filters.collection) return false;
      return true;
    });
  }

  function photoLibraryFacets(items = []) {
    return {
      categories: facetCounts(items, "category"),
      people: facetCounts(items, "personName").slice(0, 20)
    };
  }

  function mediaLibraryFacets(items = []) {
    return {
      categories: facetCounts(items, "category").slice(0, 24),
      people: facetCounts(items, "personName").slice(0, 20),
      roots: facetCounts(items, "rootLabel").slice(0, 12)
    };
  }

  function filterMediaItemsForList(items, filters = {}) {
    return (items || []).filter((item) => {
      if (filters.category && filters.category !== "all" && item.category !== filters.category) return false;
      return true;
    });
  }

  function photoCollectionDir(item) {
    const relativePath = String(item?.relativePath || "").replace(/[\\/]+/g, "/");
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length <= 1) return photoCollectionRootValue;
    return parts.slice(0, -1).join("/");
  }

  function photoCollectionValue(item) {
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
          title: photoCollectionDisplayName(dir),
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

  function photoCollectionSummary(items = [], collectionValue = "") {
    if (!collectionValue) return null;
    const first = items[0] || {};
    return {
      id: collectionValue,
      title: photoCollectionDisplayName(photoCollectionDir(first)),
      rootLabel: first.rootLabel || "",
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
