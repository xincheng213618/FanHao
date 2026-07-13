// Music store sub-module: scan
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { AUDIO_EXTS, IMAGE_EXTS, KUWO_UTF16LE_PREFIX, MAX_INTRO_BYTES, MAX_LYRIC_BYTES, MUSIC_ARTIST_GENRE_HINTS, MUSIC_FACET_CACHE, MUSIC_GENRE_ALIASES, MUSIC_TITLE_GENRE_HINTS } from "./constants.js";
import { cleanAlbumTitle, cleanArtistName, cleanComparable, cleanTrackTitle, hashText, isJunkAssetName, normalizedPathKey, numberPrefix, safeReadDir, safeReadDirEntries, safeStat, sortKey, yearFromText } from "./helpers.js";
import { buildMusicIdentityKnowledge, isUnknownMusicArtist, resolveMusicTrackIdentity } from "./identity.js";
import { buildArtistLanguageConsensus, musicLanguageForArtist, musicLanguageFromPath } from "./language.js";
import { insertMusicPhoneticSearchRow, insertMusicShortSearchRow, MUSIC_PHONETIC_INDEX_VERSION } from "./search.js";

export function loadManagedMusicCatalogs(scanRoots = []) {
  const result = new Map();
  const candidates = [];
  for (const root of scanRoots) {
    candidates.push({ libraryRoot: root, dbPath: path.join(root, "_目录", "library.sqlite") });
    candidates.push({ libraryRoot: path.join(root, "媒体库"), dbPath: path.join(root, "媒体库", "_目录", "library.sqlite") });
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const dbPath = path.resolve(candidate.dbPath);
    if (seen.has(dbPath.toLowerCase()) || !safeStat(dbPath)?.isFile()) continue;
    seen.add(dbPath.toLowerCase());
    let catalog;
    try {
      catalog = new DatabaseSync(dbPath, { readOnly: true });
      const lyricByMediaId = new Map();
      for (const row of catalog
        .prepare("SELECT media_id,target_relative_path,is_primary FROM sidecars WHERE kind='lyrics' AND action='move' AND media_id IS NOT NULL ORDER BY is_primary DESC,sidecar_id")
        .all()) {
        if (!lyricByMediaId.has(row.media_id)) lyricByMediaId.set(row.media_id, row.target_relative_path || "");
      }
      const rows = catalog
        .prepare(
          `
          SELECT media_id,target_relative_path,artist,title,album,album_artist,
                 track_number,disc_number,duration_seconds,codec
          FROM media WHERE media_type='audio'
          `
        )
        .all();
      for (const row of rows) {
        const sourcePath = path.join(candidate.libraryRoot, row.target_relative_path || "");
        const lyricRelativePath = lyricByMediaId.get(row.media_id) || "";
        const lyricPath = lyricRelativePath ? path.join(candidate.libraryRoot, lyricRelativePath) : "";
        result.set(normalizedPathKey(sourcePath), {
          artist: row.artist || row.album_artist || "",
          title: row.title || "",
          album: row.album || "",
          language: musicLanguageFromPath(row.target_relative_path),
          lrcPath: lyricPath && safeStat(lyricPath)?.isFile() ? lyricPath : "",
          probe: {
            title: row.title || "",
            artist: row.artist || row.album_artist || "",
            album: row.album || "",
            genre: "",
            year: "",
            trackNo: Number(row.track_number || 0),
            discNo: Number(row.disc_number || 0),
            durationMs: Math.max(0, Math.round(Number(row.duration_seconds || 0) * 1000)),
            codec: row.codec || "",
            sampleRate: 0,
            bitDepth: 0,
            channels: 0,
            error: ""
          }
        });
      }
    } catch {
      // A managed catalog is an optimization; fall back to probing files when unavailable.
    } finally {
      try { catalog?.close(); } catch {}
    }
  }
  return result;
}


export function scanMusicRoots(scanRoots, options = {}) {
  const ffprobePath = options.ffprobePath || "ffprobe";
  const limit = Number(options.limit || 0);
  const catalogMetadata = loadManagedMusicCatalogs(scanRoots);
  const files = [];
  for (const root of scanRoots) {
    if (!safeStat(root)?.isDirectory()) continue;
    for (const filePath of walkFiles(root)) {
      if (!AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) continue;
      files.push({ root, filePath });
      if (limit > 0 && files.length >= limit) break;
    }
    if (limit > 0 && files.length >= limit) break;
  }
  files.sort((a, b) => a.filePath.localeCompare(b.filePath, undefined, { numeric: true, sensitivity: "base" }));

  const identitySeeds = files.map(({ root, filePath }) => {
    const relativePath = path.relative(root, filePath);
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    const artistFolder = parts.length >= 3 ? parts[parts.length - 3] : parts[0] || "未知歌手";
    const managed = catalogMetadata.get(normalizedPathKey(filePath));
    return {
      artist: cleanArtistName(managed?.artist || (!isUnknownMusicArtist(artistFolder) ? artistFolder : "")),
      title: cleanTrackTitle(managed?.title || path.basename(filePath, path.extname(filePath))),
      language: managed?.language || musicLanguageFromPath(relativePath)
    };
  });
  const identityKnowledge = buildMusicIdentityKnowledge(identitySeeds);
  const artistLanguageConsensus = buildArtistLanguageConsensus(identitySeeds);

  const now = new Date().toISOString();
  const dirCache = new Map();
  const artistMap = new Map();
  const albumMap = new Map();
  const tracks = [];
  const lyrics = [];

  for (const { root, filePath } of files) {
    const stat = safeStat(filePath);
    if (!stat?.isFile()) continue;
    const relativePath = path.relative(root, filePath);
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    const artistFolder = parts.length >= 3 ? parts[parts.length - 3] : parts[0] || "未知歌手";
    const albumFolder = parts.length > 2 ? parts[parts.length - 2] : "单曲";
    const albumDir = path.dirname(filePath);
    const managed = catalogMetadata.get(normalizedPathKey(filePath));
    const probe = managed?.probe || probeAudio(filePath, ffprobePath);
    const fileStem = path.basename(filePath, path.extname(filePath));
    const parsedName = parseTrackName(fileStem);
    const identity = resolveMusicTrackIdentity({
      artist: managed?.artist || probe.artist,
      title: managed?.title || probe.title,
      folderArtist: isUnknownMusicArtist(artistFolder) ? "" : artistFolder,
      parsedArtist: parsedName.artist,
      parsedTitle: parsedName.title,
      fileStem
    }, identityKnowledge);
    const artistName = cleanArtistName(identity.artist || artistFolder);
    const recoveredSingle = ["filename-reversed", "filename-suffix", "library-title"].includes(identity.source)
      && isUnknownMusicArtist(artistFolder)
      && !(managed?.album || probe.album);
    const albumTitle = cleanAlbumTitle(recoveredSingle ? "_单曲" : managed?.album || probe.album || albumFolder);
    const rawLanguage = managed?.language || musicLanguageFromPath(relativePath);
    const language = identity.source === "filename"
      ? rawLanguage
      : musicLanguageForArtist(artistName, rawLanguage, artistLanguageConsensus);
    const artistPath = path.dirname(albumDir);
    const artistId = hashText(`artist:${language}:${artistName.normalize("NFKC").toLocaleLowerCase()}`).slice(0, 20);
    const albumId = hashText(recoveredSingle ? `album:recovered:${artistId}:single` : `album:${albumDir.toLowerCase()}`).slice(0, 20);
    const trackId = hashText(`track:${path.resolve(filePath).toLowerCase()}`).slice(0, 24);
    const trackTitle = cleanTrackTitle(identity.title || parsedName.title || fileStem);
    const trackGenre = musicGenreForTrack({
      genre: probe.genre,
      artistName,
      albumTitle,
      title: trackTitle,
      fileName: path.basename(filePath),
      relativePath
    });
    const albumFiles = cachedDirEntries(dirCache, albumDir);
    const lrcPath = managed?.lrcPath || findCompanionLyric(albumFiles, albumDir, filePath);
    const lyricText = lrcPath ? readSmallText(lrcPath, MAX_LYRIC_BYTES) : "";
    const parsedLyrics = parseLrc(lyricText);

    if (!artistMap.has(artistId)) {
      artistMap.set(artistId, {
        id: artistId,
        name: artistName,
        sortName: sortKey(artistName),
        language,
        sourceRoot: root,
        sourcePath: artistPath,
        relativePath: path.relative(root, artistPath),
        albumIds: new Set(),
        trackCount: 0,
        durationMs: 0,
        sizeBytes: 0,
        updatedAt: now
      });
    }

    if (!albumMap.has(albumId)) {
      const coverPath = findAlbumCover(albumFiles, albumDir, albumTitle);
      const introPath = findAlbumIntro(albumFiles, albumDir, albumTitle);
      albumMap.set(albumId, {
        id: albumId,
        artistId,
        title: albumTitle,
        sortTitle: sortKey(albumTitle),
        year: probe.year || yearFromText(albumTitle),
        coverPath,
        introPath,
        introText: introPath ? readSmallText(introPath, MAX_INTRO_BYTES) : "",
        sourceRoot: root,
        sourcePath: albumDir,
        relativePath: path.relative(root, albumDir),
        trackCount: 0,
        durationMs: 0,
        sizeBytes: 0,
        updatedAt: now
      });
    }

    const artist = artistMap.get(artistId);
    const album = albumMap.get(albumId);
    const durationMs = Number(probe.durationMs || 0);
    artist.albumIds.add(albumId);
    artist.trackCount += 1;
    artist.durationMs += durationMs;
    artist.sizeBytes += stat.size;
    album.trackCount += 1;
    album.durationMs += durationMs;
    album.sizeBytes += stat.size;

    tracks.push({
      id: trackId,
      artistId,
      albumId,
      title: trackTitle,
      sortTitle: sortKey(trackTitle),
      displayArtist: artistName,
      albumTitle,
      trackNo: probe.trackNo || parsedName.trackNo || 0,
      discNo: probe.discNo || 0,
      genre: trackGenre,
      language,
      sourceRoot: root,
      sourcePath: path.resolve(filePath),
      relativePath,
      fileName: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs || 0),
      durationMs,
      codec: probe.codec || "",
      sampleRate: probe.sampleRate || 0,
      bitDepth: probe.bitDepth || 0,
      channels: probe.channels || 0,
      lrcPath,
      hasLrc: lrcPath ? 1 : 0,
      status: "ok",
      error: probe.error || "",
      updatedAt: now
    });

    if (lrcPath || lyricText) {
      lyrics.push({
        trackId,
        lrcPath,
        rawText: lyricText,
        parsedJson: JSON.stringify(parsedLyrics),
        updatedAt: now
      });
    }
  }

  return {
    artists: [...artistMap.values()].map((artist) => ({ ...artist, albumCount: artist.albumIds.size })),
    albums: [...albumMap.values()],
    tracks,
    lyrics
  };
}


export function writeScanRecords(db, records, scanRoots, scannedAt) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM music_search").run();
    db.prepare("DELETE FROM music_search_short").run();
    db.prepare("DELETE FROM music_search_phonetic").run();
    db.prepare("DELETE FROM music_lyrics").run();
    db.prepare("DELETE FROM music_tracks").run();
    db.prepare("DELETE FROM music_albums").run();
    db.prepare("DELETE FROM music_artists").run();

    const insertArtist = db.prepare(`
      INSERT INTO music_artists (
        id, name, sort_name, language, source_root, source_path, relative_path, album_count,
        track_count, duration_ms, size_bytes, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)
    `);
    for (const artist of records.artists) {
      insertArtist.run(
        artist.id,
        artist.name,
        artist.sortName,
        artist.language,
        artist.sourceRoot,
        artist.sourcePath,
        artist.relativePath,
        artist.albumCount,
        artist.trackCount,
        artist.durationMs,
        artist.sizeBytes,
        artist.updatedAt
      );
    }

    const insertAlbum = db.prepare(`
      INSERT INTO music_albums (
        id, artist_id, title, sort_title, year, cover_path, intro_path, intro_text,
        source_root, source_path, relative_path, track_count, duration_ms, size_bytes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const album of records.albums) {
      insertAlbum.run(
        album.id,
        album.artistId,
        album.title,
        album.sortTitle,
        album.year,
        album.coverPath,
        album.introPath,
        album.introText,
        album.sourceRoot,
        album.sourcePath,
        album.relativePath,
        album.trackCount,
        album.durationMs,
        album.sizeBytes,
        album.updatedAt
      );
    }

    const insertTrack = db.prepare(`
      INSERT INTO music_tracks (
        id, artist_id, album_id, title, sort_title, display_artist, album_title,
        track_no, disc_no, genre, language, source_root, source_path, relative_path, file_name,
        ext, size_bytes, mtime_ms, duration_ms, codec, sample_rate, bit_depth,
        channels, lrc_path, has_lrc, status, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSearch = db.prepare(`
      INSERT INTO music_search (track_id, title, artist, album, lyrics)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertShortSearch = db.prepare(`
      INSERT INTO music_search_short (track_id, title, artist, album, genre, file_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertPhoneticSearch = db.prepare(`
      INSERT INTO music_search_phonetic (track_id, artist_id, album_id, title, artist, album, file_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const phoneticDocumentCache = new Map();
    const lyricByTrack = new Map(records.lyrics.map((lyric) => [lyric.trackId, lyric]));
    for (const track of records.tracks) {
      insertTrack.run(
        track.id,
        track.artistId,
        track.albumId,
        track.title,
        track.sortTitle,
        track.displayArtist,
        track.albumTitle,
        track.trackNo,
        track.discNo,
        track.genre,
        track.language,
        track.sourceRoot,
        track.sourcePath,
        track.relativePath,
        track.fileName,
        track.ext,
        track.sizeBytes,
        track.mtimeMs,
        track.durationMs,
        track.codec,
        track.sampleRate,
        track.bitDepth,
        track.channels,
        track.lrcPath,
        track.hasLrc,
        track.status,
        track.error,
        track.updatedAt
      );
      insertSearch.run(track.id, track.title, track.displayArtist, track.albumTitle, lyricByTrack.get(track.id)?.rawText || "");
      insertMusicShortSearchRow(insertShortSearch, track);
      insertMusicPhoneticSearchRow(insertPhoneticSearch, track, phoneticDocumentCache);
    }

    const insertLyric = db.prepare(`
      INSERT INTO music_lyrics (track_id, lrc_path, raw_text, parsed_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const lyric of records.lyrics) {
      insertLyric.run(lyric.trackId, lyric.lrcPath, lyric.rawText, lyric.parsedJson, lyric.updatedAt);
    }

    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('schema_version', '1')").run();
    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('music_phonetic_index_version', ?)").run(MUSIC_PHONETIC_INDEX_VERSION);
    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('scanned_at', ?)").run(scannedAt);
    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('roots_json', ?)").run(JSON.stringify(scanRoots));
    db.prepare("INSERT OR REPLACE INTO music_meta (key, value) VALUES ('smart_static_counts_json', ?)").run(JSON.stringify({
      newest: records.tracks.length,
      hires: records.tracks.filter((track) => ["flac", "wav", "alac"].includes(String(track.codec || "").toLowerCase()) || [".flac", ".wav", ".aiff", ".ape", ".dff", ".dsf"].includes(String(track.ext || "").toLowerCase()) || Number(track.bitDepth || 0) >= 24 || Number(track.sampleRate || 0) >= 48000).length,
      lyrics: records.tracks.filter((track) => Number(track.hasLrc || 0) === 1).length,
      longform: records.tracks.filter((track) => Number(track.durationMs || 0) >= 300000).length
    }));
    db.prepare("DELETE FROM music_playlist_items WHERE track_id NOT IN (SELECT id FROM music_tracks)").run();
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    MUSIC_FACET_CACHE.delete(db);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}


export function scanSummary(records, scanRoots, dryRun) {
  const scannedAt = new Date().toISOString();
  return {
    ok: true,
    dryRun,
    roots: scanRoots.map(rootStatus),
    scannedAt,
    totals: {
      artists: records.artists.length,
      albums: records.albums.length,
      tracks: records.tracks.length,
      lyrics: records.lyrics.length,
      bytes: records.tracks.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0),
      durationMs: records.tracks.reduce((sum, item) => sum + Number(item.durationMs || 0), 0)
    }
  };
}


export function probeAudio(filePath, ffprobePath) {
  const result = {
    title: "",
    artist: "",
    album: "",
    genre: "",
    year: "",
    trackNo: 0,
    discNo: 0,
    durationMs: 0,
    codec: "",
    sampleRate: 0,
    bitDepth: 0,
    channels: 0,
    error: ""
  };
  try {
    const probe = spawnSync(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:format_tags=title,artist,album,genre,date,year,track,disc",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample",
        "-of",
        "json",
        filePath
      ],
      { encoding: "utf8", windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 }
    );
    if (probe.error) {
      result.error = probe.error.message || String(probe.error);
      return result;
    }
    if (probe.status !== 0 && probe.stderr) result.error = String(probe.stderr).trim().slice(0, 500);
    const data = JSON.parse(probe.stdout || "{}");
    const tags = normalizeTags(data?.format?.tags || {});
    const stream = Array.isArray(data?.streams) ? data.streams[0] || {} : {};
    result.title = tags.title || "";
    result.artist = tags.artist || "";
    result.album = tags.album || "";
    result.genre = tags.genre || "";
    result.year = yearFromText(tags.date || tags.year || "");
    result.trackNo = numberPrefix(tags.track);
    result.discNo = numberPrefix(tags.disc);
    result.durationMs = Math.round(Number(data?.format?.duration || 0) * 1000) || 0;
    result.codec = String(stream.codec_name || "").toUpperCase();
    result.sampleRate = Number(stream.sample_rate || 0) || 0;
    result.bitDepth = Number(stream.bits_per_raw_sample || stream.bits_per_sample || 0) || 0;
    result.channels = Number(stream.channels || 0) || 0;
  } catch (error) {
    result.error = error.message || String(error);
  }
  return result;
}


export function normalizeTags(tags = {}) {
  const result = {};
  for (const [key, value] of Object.entries(tags || {})) {
    result[String(key).toLowerCase()] = String(value || "").trim();
  }
  return result;
}


export function musicGenreForTrack(input = {}) {
  return cleanMusicGenre(input.genre) || inferMusicGenre(input);
}


export function cleanMusicGenre(value) {
  const raw = String(value || "")
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const first = raw.split(/[;,|、]/u).map((item) => item.trim()).find(Boolean) || "";
  const id3Number = /^\(?(\d{1,3})\)?$/u.exec(first);
  if (id3Number) {
    const mapped = id3GenreName(Number(id3Number[1]));
    if (mapped) return mapped;
  }
  const normalized = MUSIC_GENRE_ALIASES.get(first.toLowerCase()) || first;
  return normalized.slice(0, 32);
}


export function inferMusicGenre(input = {}) {
  const artistText = [input.artistName, input.displayArtist, input.artist].filter(Boolean).join(" ");
  const titleText = [input.title, input.albumTitle, input.album, input.fileName, input.relativePath].filter(Boolean).join(" ");
  for (const hint of MUSIC_TITLE_GENRE_HINTS) {
    if (hint.pattern.test(titleText)) return hint.genre;
  }
  for (const hint of MUSIC_ARTIST_GENRE_HINTS) {
    if (hint.pattern.test(artistText)) return hint.genre;
  }
  const combined = `${artistText} ${titleText}`;
  return /[\u4e00-\u9fff]/u.test(combined) ? "华语流行" : "其他";
}


export function id3GenreName(value) {
  const names = [
    "Blues",
    "Classic Rock",
    "Country",
    "Dance",
    "Disco",
    "Funk",
    "Grunge",
    "Hip-Hop",
    "Jazz",
    "Metal",
    "New Age",
    "Oldies",
    "Other",
    "流行",
    "R&B/嘻哈",
    "Rap",
    "Reggae",
    "摇滚",
    "Techno",
    "Industrial",
    "Alternative",
    "Ska",
    "Death Metal",
    "Pranks",
    "Soundtrack",
    "Euro-Techno",
    "Ambient",
    "Trip-Hop",
    "Vocal",
    "Jazz+Funk",
    "Fusion",
    "Trance",
    "Classical",
    "Instrumental",
    "Acid",
    "House",
    "Game",
    "Sound Clip",
    "Gospel",
    "Noise",
    "AlternRock",
    "Bass",
    "Soul",
    "Punk",
    "Space",
    "Meditative",
    "Instrumental Pop",
    "Instrumental Rock",
    "Ethnic",
    "Gothic",
    "Darkwave",
    "Techno-Industrial",
    "Electronic",
    "Pop-Folk",
    "Eurodance",
    "Dream",
    "Southern Rock",
    "Comedy",
    "Cult",
    "Gangsta",
    "Top 40",
    "Christian Rap",
    "流行/摇滚",
    "Jungle",
    "Native American",
    "Cabaret",
    "New Wave",
    "Psychadelic",
    "Rave",
    "Showtunes",
    "Trailer",
    "Lo-Fi",
    "Tribal",
    "Acid Punk",
    "Acid Jazz",
    "Polka",
    "Retro",
    "Musical",
    "摇滚",
    "Hard Rock"
  ];
  return cleanMusicGenre(names[value] || "");
}


export function parseTrackName(stem) {
  const clean = String(stem || "").trim();
  const trackNoMatch = /^(\d{1,4})[\s._-]+(.+)$/u.exec(clean);
  const withoutNo = trackNoMatch ? trackNoMatch[2].trim() : clean;
  const split = /^(.{1,80}?)[\s]*-[\s]*(.+)$/u.exec(withoutNo);
  return {
    trackNo: trackNoMatch ? Number(trackNoMatch[1]) || 0 : 0,
    artist: split ? split[1].trim() : "",
    title: split ? split[2].trim() : withoutNo
  };
}


export function findAlbumCover(files, dir, albumTitle) {
  const images = files.filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()) && !isJunkAssetName(name));
  if (!images.length) return "";
  const albumKey = cleanComparable(albumTitle);
  const exact = images.find((name) => cleanComparable(path.basename(name, path.extname(name))) === albumKey);
  const preferred =
    exact ||
    images.find((name) => /^(cover|folder|front|album|封面)$/iu.test(path.basename(name, path.extname(name)).trim())) ||
    images.find((name) => /cover|folder|front|album|封面/iu.test(name)) ||
    images[0];
  return preferred ? path.join(dir, preferred) : "";
}


export function findAlbumIntro(files, dir, albumTitle) {
  const txts = files.filter((name) => path.extname(name).toLowerCase() === ".txt" && !isJunkAssetName(name));
  if (!txts.length) return "";
  const albumKey = cleanComparable(albumTitle);
  const preferred =
    txts.find((name) => /简介|介绍|说明/u.test(name)) ||
    txts.find((name) => cleanComparable(path.basename(name, path.extname(name))).includes(albumKey)) ||
    txts[0];
  return preferred ? path.join(dir, preferred) : "";
}


export function findCompanionLyric(files, dir, audioPath) {
  const base = path.basename(audioPath, path.extname(audioPath)).toLowerCase();
  const exact = files.find((name) => path.extname(name).toLowerCase() === ".lrc" && path.basename(name, path.extname(name)).toLowerCase() === base);
  return exact ? path.join(dir, exact) : "";
}


export function parseLrc(text) {
  const lines = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    if (!content) continue;
    for (const stamp of stamps) {
      const minutes = Number(stamp[1] || 0);
      const seconds = Number(stamp[2] || 0);
      const fraction = String(stamp[3] || "0").padEnd(3, "0").slice(0, 3);
      lines.push({ timeMs: minutes * 60 * 1000 + seconds * 1000 + Number(fraction), text: content });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}


export function readSmallText(filePath, maxBytes) {
  const stat = safeStat(filePath);
  if (!stat?.isFile() || stat.size > maxBytes) return "";
  try {
    return decodeTextBuffer(fs.readFileSync(filePath)).replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}


export function decodeTextBuffer(buffer) {
  const source = Buffer.from(buffer);
  const hasKuwoPrefix = source.subarray(0, KUWO_UTF16LE_PREFIX.length).equals(KUWO_UTF16LE_PREFIX);
  const textBuffer = hasKuwoPrefix ? source.subarray(KUWO_UTF16LE_PREFIX.length) : source;
  for (const encoding of ["utf-8", "gb18030", "gbk", "big5"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(textBuffer);
      if (!text.includes("\uFFFD") || encoding !== "utf-8") return cleanDecodedText(text, hasKuwoPrefix);
    } catch {}
  }
  return cleanDecodedText(textBuffer.toString("utf8"), hasKuwoPrefix);
}


export function cleanDecodedText(text, stripKuwoPrefix) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "");
  return stripKuwoPrefix ? cleaned.replace(/^\s*-\s*/, "") : cleaned;
}


export function cachedDirEntries(cache, dir) {
  if (cache.has(dir)) return cache.get(dir);
  const entries = safeReadDir(dir);
  cache.set(dir, entries);
  return entries;
}

function* walkFiles(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of safeReadDirEntries(current)) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }
}


export function normalizeRoots(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((item) => String(item || "").trim()).filter(Boolean).map((item) => path.resolve(item)))];
}


export function rootStatus(root) {
  const stat = safeStat(root);
  return { path: root, exists: Boolean(stat?.isDirectory()) };
}


export function safeStoredFile(filePath, type, id = "") {
  const normalized = path.resolve(filePath);
  const stat = safeStat(normalized);
  if (!stat?.isFile()) return null;
  return {
    id: id || hashText(normalized).slice(0, 16),
    path: normalized,
    type,
    ext: path.extname(normalized).toLowerCase(),
    size: stat.size,
    modifiedAt: stat.mtime?.toISOString?.() || ""
  };
}


export function coverStampFor(filePath, updatedAt = "") {
  return filePath ? String(updatedAt || "") : "";
}
