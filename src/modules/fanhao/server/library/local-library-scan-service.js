import fs from "node:fs";
import path from "node:path";

export function createLocalLibraryScanService({
  compareNaturalName,
  compareNaturalTitle,
  coverHints,
  createId,
  emptyLibrary,
  excludedDirs,
  fileBase,
  isExcludedDirName,
  isImage,
  isInfo,
  isPlayableVideo,
  isVideo,
  libraryRoots,
  linkScannedWork = (personId, work) => work,
  normalizeExt,
  relativeFromRoot,
  safeStat
}) {
  function walkFiles(rootDir) {
    const results = [];
    const stack = [rootDir];

    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!isExcludedDirName(entry.name)) {
            stack.push(path.join(current, entry.name));
          }
          continue;
        }

        if (entry.isFile()) {
          results.push(path.join(current, entry.name));
        }
      }
    }

    return results;
  }

  function directChildDirectories(rootDir) {
    try {
      return fs
        .readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !isExcludedDirName(entry.name))
        .map((entry) => path.join(rootDir, entry.name));
    } catch {
      return [];
    }
  }

  function directFiles(rootDir) {
    try {
      return fs
        .readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(rootDir, entry.name));
    } catch {
      return [];
    }
  }

  function toMediaFile(fullPath, type) {
    const stat = safeStat(fullPath);
    return {
      id: createId(type[0], fullPath),
      type,
      name: path.basename(fullPath),
      title: fileBase(path.basename(fullPath)),
      ext: normalizeExt(fullPath),
      path: fullPath,
      relativePath: relativeFromRoot(fullPath),
      size: stat?.size || 0,
      modifiedAt: stat?.mtime?.toISOString() || null,
      playable: type === "video" ? isPlayableVideo(fullPath) : undefined
    };
  }

  function chooseCover(images, preferredBaseName, workDir) {
    if (!images.length) {
      return null;
    }

    const preferred = preferredBaseName.toLowerCase();
    const scored = images.map((image, index) => {
      const base = fileBase(image.name).toLowerCase();
      const depth = path.relative(workDir, image.path).split(path.sep).filter(Boolean).length;
      let score = 0;

      if (coverHints.has(base)) score += 120;
      if (base === preferred) score += 100;
      if (base.includes(preferred) || preferred.includes(base)) score += 30;
      if (depth <= 1) score += 20;
      if ([".jpg", ".jpeg", ".webp", ".png"].includes(image.ext)) score += 5;

      return { image, score, index };
    });

    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored[0].image;
  }

  function collectMediaFiles(files) {
    const videos = [];
    const images = [];
    const infos = [];

    for (const fullPath of files) {
      const name = path.basename(fullPath);
      if (isVideo(name)) {
        videos.push(toMediaFile(fullPath, "video"));
      } else if (isImage(name)) {
        images.push(toMediaFile(fullPath, "image"));
      } else if (isInfo(name)) {
        infos.push(toMediaFile(fullPath, "info"));
      }
    }

    videos.sort(compareNaturalName);
    images.sort(compareNaturalName);
    infos.sort(compareNaturalName);

    return { videos, images, infos };
  }

  function registerFiles(index, files) {
    if (!(index.fileRefCounts instanceof Map)) index.fileRefCounts = new Map();
    for (const file of files) {
      index.filesById.set(file.id, file);
      index.fileRefCounts.set(file.id, Number(index.fileRefCounts.get(file.id) || 0) + 1);
    }
  }

  function createWork(personId, title, workDir, files, fallbackVideo = null) {
    const { videos, images, infos } = collectMediaFiles(files);
    if (!videos.length && fallbackVideo) {
      videos.push(fallbackVideo);
    }

    if (!videos.length) {
      return null;
    }

    const preferredBaseName = fallbackVideo ? fileBase(fallbackVideo.name) : path.basename(workDir);
    const cover = chooseCover(images, preferredBaseName, workDir);
    const playableCount = videos.filter((video) => video.playable).length;
    const modifiedAt = videos
      .map((video) => video.modifiedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    return {
      id: createId("w", `${personId}|${workDir}|${title}`),
      personId,
      title,
      directoryName: path.basename(workDir),
      relativePath: relativeFromRoot(workDir),
      coverId: cover?.id || null,
      videoCount: videos.length,
      playableCount,
      imageCount: images.length,
      infoCount: infos.length,
      modifiedAt,
      videos,
      images,
      infos
    };
  }

  function scanPersonDirectory(personId, personDir) {
    const works = [];

    const childDirs = directChildDirectories(personDir);
    for (const childDir of childDirs) {
      const childFiles = walkFiles(childDir);
      const work = createWork(personId, path.basename(childDir), childDir, childFiles);
      if (work) {
        works.push(linkScannedWork(personId, work));
      }
    }

    const rootFiles = directFiles(personDir);
    const rootMedia = collectMediaFiles(rootFiles);
    for (const video of rootMedia.videos) {
      const matchingFiles = rootFiles.filter((fullPath) => {
        const base = fileBase(path.basename(fullPath));
        return fullPath === video.path || (base === fileBase(video.name) && (isImage(fullPath) || isInfo(fullPath)));
      });
      const work = createWork(personId, video.name, personDir, matchingFiles, video);
      if (work) {
        works.push(linkScannedWork(personId, work));
      }
    }

    return works;
  }

  function scanLibrary() {
    const index = emptyLibrary();
    const personBuckets = new Map();

    for (const rootPath of libraryRoots) {
      if (!fs.existsSync(rootPath)) {
        index.missingRoots.push(rootPath);
        continue;
      }

      index.availableRoots.push(rootPath);
      const personDirs = directChildDirectories(rootPath)
        .filter((dir) => !excludedDirs.has(path.basename(dir)))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" }));

      for (const personDir of personDirs) {
        const personName = path.basename(personDir);
        const personId = personName;
        let bucket = personBuckets.get(personName);

        if (!bucket) {
          bucket = {
            id: personId,
            name: personName,
            sourcePaths: [],
            works: []
          };
          personBuckets.set(personName, bucket);
        }

        bucket.sourcePaths.push(relativeFromRoot(personDir));
        bucket.works.push(...scanPersonDirectory(bucket.id, personDir));
      }
    }

    if (!index.availableRoots.length) {
      throw new Error(`资料库路径不存在：${libraryRoots.join("; ")}`);
    }

    const buckets = [...personBuckets.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );

    for (const bucket of buckets) {
      const works = bucket.works.sort(compareNaturalTitle);

      for (const work of works) {
        registerFiles(index, [...work.videos, ...work.images, ...work.infos]);
        index.worksById.set(work.id, work);
      }

      const coverId = works.find((work) => work.coverId)?.coverId || null;
      const videoCount = works.reduce((sum, work) => sum + work.videoCount, 0);
      const playableCount = works.reduce((sum, work) => sum + work.playableCount, 0);
      const infoCount = works.reduce((sum, work) => sum + work.infoCount, 0);
      const imageCount = works.reduce((sum, work) => sum + work.imageCount, 0);
      const modifiedAt = works
        .map((work) => work.modifiedAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null;

      const person = {
        id: bucket.id,
        name: bucket.name,
        relativePath: bucket.sourcePaths[0] || "",
        sourcePaths: bucket.sourcePaths,
        sourceCount: bucket.sourcePaths.length,
        coverId,
        workCount: works.length,
        videoCount,
        playableCount,
        imageCount,
        infoCount,
        modifiedAt,
        works: works.map((work) => work.id)
      };

      index.people.push(person);
      index.peopleById.set(person.id, person);
    }

    index.scannedAt = new Date().toISOString();
    index.totals.people = index.people.length;
    index.totals.works = index.worksById.size;
    index.totals.videos = [...index.filesById.values()].filter((file) => file.type === "video").length;
    index.totals.playableVideos = [...index.filesById.values()].filter((file) => file.type === "video" && file.playable).length;
    index.totals.images = [...index.filesById.values()].filter((file) => file.type === "image").length;
    index.totals.infoFiles = [...index.filesById.values()].filter((file) => file.type === "info").length;

    return index;
  }

  return {
    chooseCover,
    collectMediaFiles,
    registerFiles,
    scanLibrary,
    scanPersonDirectory
  };
}
