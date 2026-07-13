const VERSION_KINDS = [
  { kind: "acoustic", label: "不插电", pattern: /\b(?:acoustic|unplugged)\b|不插电/iu },
  { kind: "live", label: "现场版", pattern: /\b(?:live|concert)\b|现场|演唱会/iu },
  { kind: "remix", label: "Remix", pattern: /\b(?:remix|mix)\b|混音/iu },
  { kind: "dj", label: "DJ 版", pattern: /\bdj\b|电音版/iu },
  { kind: "instrumental", label: "伴奏", pattern: /\b(?:instrumental|karaoke)\b|伴奏|纯音乐/iu },
  { kind: "demo", label: "Demo", pattern: /\bdemo\b|小样/iu },
  { kind: "cover", label: "翻唱版", pattern: /\bcover\b|翻唱/iu },
  { kind: "remaster", label: "重制版", pattern: /\bremaster(?:ed)?\b|重制/iu },
  { kind: "edit", label: "剪辑版", pattern: /\b(?:radio\s+edit|edit|short\s+version)\b|剪辑版|电台版/iu },
  { kind: "piano", label: "钢琴版", pattern: /\bpiano\b|钢琴版/iu },
  { kind: "extended", label: "加长版", pattern: /\bextended\b|加长版/iu }
];

const VERSION_KIND_ORDER = new Map([
  ["original", 0],
  ["acoustic", 1],
  ["live", 2],
  ["remix", 3],
  ["dj", 4],
  ["instrumental", 5],
  ["piano", 6],
  ["demo", 7],
  ["cover", 8],
  ["remaster", 9],
  ["edit", 10],
  ["extended", 11]
]);

export function getTrackVersionInfo(track = {}) {
  const title = String(track.title || track.fileName || "").normalize("NFKC").trim();
  const artist = String(track.artist || "").normalize("NFKC").trim();
  const peeled = peelTrackVersion(title);
  const kind = peeled.version?.kind || "original";
  const label = peeled.version?.label || "原版";
  const baseTitle = peeled.baseTitle || title;
  const normalizedArtist = normalizeVersionText(artist);
  const safeArtist = normalizedArtist && !["未知歌手", "待识别"].includes(artist) ? normalizedArtist : "";
  const normalizedTitle = normalizeVersionText(baseTitle);
  return {
    baseTitle,
    descriptor: peeled.descriptor,
    kind,
    label,
    key: normalizedTitle && safeArtist ? `${normalizedTitle}|${safeArtist}` : `id:${track.id || title}`
  };
}

export function buildTrackVersionGroups(tracks = []) {
  const groups = new Map();
  const ordered = [];
  for (const [index, track] of (Array.isArray(tracks) ? tracks : []).entries()) {
    if (!track?.id) continue;
    const info = getTrackVersionInfo(track);
    let group = groups.get(info.key);
    if (!group) {
      group = {
        key: info.key,
        baseTitle: info.baseTitle,
        artist: track.artist || "",
        versions: []
      };
      groups.set(info.key, group);
      ordered.push(group);
    }
    group.versions.push({ track, info, index });
  }

  return ordered.map((group) => {
    const versions = [...group.versions].sort((left, right) => {
      const kindOrder = (VERSION_KIND_ORDER.get(left.info.kind) ?? 99) - (VERSION_KIND_ORDER.get(right.info.kind) ?? 99);
      return kindOrder || left.index - right.index;
    });
    const tracksInOrder = versions.map((item) => item.track);
    return {
      ...group,
      versions,
      tracks: tracksInOrder,
      primary: tracksInOrder[0] || null
    };
  });
}

export function findTrackVersionGroup(groups = [], trackId = "") {
  const id = String(trackId || "").trim();
  if (!id) return null;
  return (Array.isArray(groups) ? groups : []).find((group) => group.tracks?.some((track) => track.id === id)) || null;
}

function peelTrackVersion(title) {
  let baseTitle = String(title || "").trim();
  const descriptors = [];
  for (let attempt = 0; attempt < 3 && baseTitle; attempt += 1) {
    const bracketed = baseTitle.match(/^(.*?)\s*[\(\[（【]\s*([^()\[\]（）【】]{1,48})\s*[\)\]）】]\s*$/u);
    if (bracketed) {
      const version = versionKind(bracketed[2]);
      if (version && bracketed[1].trim()) {
        descriptors.push({ ...version, descriptor: bracketed[2].trim() });
        baseTitle = bracketed[1].trim();
        continue;
      }
    }
    const suffixed = baseTitle.match(/^(.*?)\s*[-–—·]\s*([^()\[\]（）【】]{1,48})\s*$/u);
    if (suffixed) {
      const version = versionKind(suffixed[2]);
      if (version && suffixed[1].trim()) {
        descriptors.push({ ...version, descriptor: suffixed[2].trim() });
        baseTitle = suffixed[1].trim();
        continue;
      }
    }
    break;
  }
  const version = descriptors[0] || null;
  return {
    baseTitle,
    descriptor: descriptors.map((item) => item.descriptor).join(" · "),
    version
  };
}

function versionKind(value) {
  const descriptor = String(value || "").normalize("NFKC").trim();
  if (!descriptor) return null;
  return VERSION_KINDS.find((item) => item.pattern.test(descriptor)) || null;
}

function normalizeVersionText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s·•_]+/gu, "")
    .trim();
}
