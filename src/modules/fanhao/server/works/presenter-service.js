const PERSON_FALLBACK_AVATAR_BATCH_SIZE = 48;

export function createWorkPresenterService({
  actorProfileRow,
  dbBoolOrNull,
  displayPersonForWork,
  displayWorkTitle,
  favoriteStateService,
  firstPresentValue,
  getLibrary,
  getPersonFallbackAvatarStamp = () => "",
  isGPerson,
  isCompilationWork = () => false,
  localWorkMarkers,
  manualCoverStateService,
  playbackProgressService,
  prewarmCoreWorkCovers = () => {},
  prewarmWorkInfoDetails = () => {},
  preferredPersonDisplayName,
  proxiedRemoteImageUrl,
  publicActorProfile,
  publicActorProfileSnapshot,
  publicCoreWorkCover,
  publicWorkInfoMetadata,
  publicWorkInfoSummary,
  uniqueTextArray,
  workInfoDetailRow
}) {
  const personFallbackAvatarCache = new Map();
  let personFallbackAvatarCacheStamp = "";

  function publicPersonFallbackAvatar(person) {
    const library = getLibrary();
    const stamp = getPersonFallbackAvatarStamp();
    if (personFallbackAvatarCacheStamp !== stamp) {
      personFallbackAvatarCacheStamp = stamp;
      personFallbackAvatarCache.clear();
    }
    const cacheKey = String(person?.id || "");
    if (cacheKey && personFallbackAvatarCache.has(cacheKey)) return personFallbackAvatarCache.get(cacheKey);

    const works = (person?.works || [])
      .map((workId) => library.worksById.get(workId))
      .filter((work) => work && !work.missingLocal);
    for (let offset = 0; offset < works.length; offset += PERSON_FALLBACK_AVATAR_BATCH_SIZE) {
      const batch = works.slice(offset, offset + PERSON_FALLBACK_AVATAR_BATCH_SIZE);
      prewarmCoreWorkCovers(batch);
      prewarmWorkInfoDetails(batch);
      for (const work of batch) {
        const cover = publicWorkCoverAvatar(work, person.id);
        if (!cover) continue;
        const fallback = { ...cover, fallbackWorkId: String(work.id || "") };
        if (cacheKey) personFallbackAvatarCache.set(cacheKey, fallback);
        return fallback;
      }
    }
    if (cacheKey) personFallbackAvatarCache.set(cacheKey, null);
    return null;
  }

  function publicWorkCoverAvatar(work, personId, source = "work_cover") {
    if (!work || work.missingLocal) return null;

    const manualCover = manualCoverStateService.manualCoverForWork(work);
    if (manualCover?.image?.id) {
      return {
        personId: String(personId || ""),
        avatarUrl: `/media/image/${encodeURIComponent(manualCover.image.id)}`,
        sourceAvatarUrl: manualCover.image.relativePath || manualCover.image.path || "",
        source: "manual_work_cover",
        updatedAt: manualCover.record?.updatedAt || manualCover.image.modifiedAt || "",
        coverWorkId: String(work.id || "")
      };
    }

    const coreCover = publicCoreWorkCover(work.id);
    if (coreCover?.coverUrl) {
      return {
        personId: String(personId || ""),
        avatarUrl: coreCover.coverUrl,
        sourceAvatarUrl: coreCover.sourceCoverUrl || "",
        source: coreCover.source || source,
        updatedAt: coreCover.updatedAt || "",
        coverWorkId: String(work.id || "")
      };
    }

    if (work.coverId) {
      return {
        personId: String(personId || ""),
        avatarUrl: `/media/image/${encodeURIComponent(work.coverId)}`,
        sourceAvatarUrl: work.relativePath || "",
        source,
        updatedAt: work.modifiedAt || "",
        coverWorkId: String(work.id || "")
      };
    }

    const infoSummary = publicWorkInfoSummary(workInfoDetailRow(work.id), work.infoSummary);
    const remoteUrl = proxiedRemoteImageUrl(work.remoteCoverUrl) || work.remoteCoverUrl || infoSummary?.imageUrl || "";
    if (!remoteUrl) return null;
    return {
      personId: String(personId || ""),
      avatarUrl: remoteUrl,
      sourceAvatarUrl: work.remoteCoverUrl || infoSummary?.imageUrl || "",
      source,
      updatedAt: work.modifiedAt || "",
      coverWorkId: String(work.id || "")
    };
  }

  function publicPerson(person, options = {}) {
    const profileRow = actorProfileRow(person.id);
    const snapshot = publicActorProfileSnapshot(profileRow);
    const actorProfile = snapshot.profile;
    const avatar = snapshot.avatar;
    const fallbackAvatar = avatar?.avatarUrl || actorProfile?.avatarUrl || options.skipFallbackAvatar ? null : publicPersonFallbackAvatar(person);
    const isGSource = isGPerson(person);
    return {
      id: person.id,
      name: person.name,
      relativePath: person.relativePath,
      sourcePaths: person.sourcePaths,
      sourceCount: person.sourceCount,
      coverId: person.coverId,
      workCount: person.workCount,
      videoCount: person.videoCount,
      playableCount: person.playableCount,
      imageCount: person.imageCount,
      infoCount: person.infoCount,
      modifiedAt: person.modifiedAt,
      isGSource,
      actorMovieCount: options.actorMovieCount ?? null,
      missingLocalWorkCount: options.missingLocalWorkCount ?? null,
      avatarUrl: avatar?.avatarUrl || actorProfile?.avatarUrl || fallbackAvatar?.avatarUrl || "",
      avatarImage: avatar || fallbackAvatar,
      manualCoverWorkId: avatar?.source === "manual_person_cover" ? avatar.coverWorkId || "" : "",
      actorProfile
    };
  }

  function publicWorkAvailability(work, infoSummary = null) {
    const summary = infoSummary || work?.infoSummary || {};
    const tags = uniqueTextArray([...(summary.javdbTags || []), ...(work?.javdbTags || [])], { maxLength: 40, maxItems: 16 });
    return {
      hasMagnet: firstPresentValue(summary.hasMagnet, work?.hasMagnet, dbBoolOrNull(work?.has_magnet)),
      hasSubtitles: firstPresentValue(summary.hasSubtitles, work?.hasSubtitles, dbBoolOrNull(work?.has_subtitles)),
      isStreamable: firstPresentValue(summary.isStreamable, work?.isStreamable, dbBoolOrNull(work?.is_streamable)),
      tags
    };
  }

  function publicMediaFile(file, work = null) {
    return {
      id: file.id,
      type: file.type,
      name: file.name,
      title: file.title,
      ext: file.ext,
      relativePath: file.relativePath,
      sourcePath: file.path,
      size: file.size,
      modifiedAt: file.modifiedAt,
      playable: file.playable,
      progress: file.type === "video" ? playbackProgressService.getVideoProgress(file.id, work) : null
    };
  }

  function publicWork(work, includeFiles = false, options = {}) {
    const markers = localWorkMarkers(work);
    if (work.missingLocal) {
      // Missing-local works have no filesystem fallback. Their cached SQL cover is
      // list-critical data, even when the rest of the person page stays lightweight.
      const coreCover = work.cachedCover?.coverUrl ? work.cachedCover : publicCoreWorkCover(work.id);
      const person = options.lightweightInfo
        ? getLibrary().peopleById.get(String(work.personId || "")) || null
        : displayPersonForWork(work.personId);
      const profileRow = person && !options.lightweightInfo ? actorProfileRow(person.id) : null;
      const infoSummary = work.infoSummary || null;
      const base = {
        id: work.id,
        personId: person?.id || work.personId || "",
        personName: work.personName || "",
        personDisplayName: profileRow ? preferredPersonDisplayName(profileRow, person?.name || work.personName || "") : work.personName || "",
        personAliases: publicActorProfile(profileRow)?.aliases || [],
        title: displayWorkTitle(work.title || work.directoryName || "未下载作品"),
        directoryName: displayWorkTitle(work.directoryName || ""),
        relativePath: work.relativePath || "",
        localMarkers: markers,
        compilation: isCompilationWork(work),
        coverId: null,
        manualCoverId: "",
        autoCoverId: "",
        cachedCover: coreCover,
        remoteCoverUrl: coreCover?.coverUrl || proxiedRemoteImageUrl(work.remoteCoverUrl) || work.remoteCoverUrl || "",
        videoCount: 0,
        playableCount: 0,
        imageCount: 0,
        infoCount: 0,
        videoSize: 0,
        canGenerateCover: false,
        modifiedAt: work.modifiedAt || "",
        infoSummary,
        availability: publicWorkAvailability(work, infoSummary),
        favorite: false,
        progress: null,
        missingLocal: true,
        javdbUrl: work.javdbUrl || "",
        actorUrl: work.actorUrl || "",
        ranking: work.ranking || null
      };

      if (includeFiles) {
        base.videos = [];
        base.images = [];
        base.infos = [];
        base.infoMetadata = null;
      }

      return base;
    }

    const person = options.lightweightInfo
      ? getLibrary().peopleById.get(String(work.personId || "")) || null
      : displayPersonForWork(work.personId);
    const profileRow = person && !options.lightweightInfo ? actorProfileRow(person.id) : null;
    const coreCover = options.lightweightInfo ? null : publicCoreWorkCover(work.id);
    const manualCover = manualCoverStateService.manualCoverForWork(work);
    const cachedCover = manualCover ? null : coreCover;
    const infoRow = options.lightweightInfo ? null : workInfoDetailRow(work.id);
    const infoSummary = publicWorkInfoSummary(infoRow, work.infoSummary);
    const videos = work.videos || [];
    const favorite = favoriteStateService.publicFavoriteForWork(work.id);
    const personName = person?.name || work.personName || "";
    const base = {
      id: work.id,
      personId: person?.id || work.personId,
      personName,
      personDisplayName: profileRow ? preferredPersonDisplayName(profileRow, personName) : personName,
      personAliases: publicActorProfile(profileRow)?.aliases || [],
      title: displayWorkTitle(work.title || work.directoryName || ""),
      directoryName: displayWorkTitle(work.directoryName),
      relativePath: work.relativePath,
      localMarkers: markers,
      compilation: isCompilationWork(work),
      coverId: manualCover?.image.id || (coreCover ? null : work.coverId),
      manualCoverId: manualCover?.image.id || "",
      autoCoverId: work.coverId || "",
      cachedCover,
      videoCount: work.videoCount,
      playableCount: work.playableCount,
      imageCount: work.imageCount,
      infoCount: work.infoCount,
      videoSize: videos.reduce((sum, video) => sum + Number(video.size || 0), 0),
      canGenerateCover: !manualCover && !work.coverId && !cachedCover && videos.length > 0,
      modifiedAt: work.modifiedAt,
      infoSummary,
      availability: publicWorkAvailability(work, infoSummary),
      favorite: Boolean(favorite),
      favoriteFolderId: favorite?.folderId || "",
      favoriteFolderName: favorite?.folderName || "",
      progress: playbackProgressService.getWorkProgress(work)
    };
    if (work.ranking) base.ranking = work.ranking;

    if (includeFiles) {
      base.videos = videos.map((video) => publicMediaFile(video, work));
      base.images = (work.images || []).map((image) => publicMediaFile(image, work));
      base.infos = (work.infos || []).map((infoFile) => publicMediaFile(infoFile, work));
      base.infoMetadata = publicWorkInfoMetadata(infoRow);
    }

    return base;
  }

  return {
    publicMediaFile,
    publicPerson,
    publicPersonFallbackAvatar,
    publicWork,
    publicWorkAvailability,
    publicWorkCoverAvatar
  };
}
