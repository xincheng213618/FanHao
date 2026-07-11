import fs from "node:fs";

const DEFAULT_CONFIG = {
  compilationPrefixes: ["OFJE", "THN", "THU"],
  compilationKeywords: ["合集", "総集編", "総集", "コンプリート", "全タイトル", "ベスト盤"],
  actorAvatarDataPath: "",
  imageReaderCacheMaxBytes: 0
};

function uniqueTrimmedStrings(values, options = {}) {
  const seen = new Set();
  const result = [];
  const maxLength = options.maxLength || 40;
  const transform = options.transform || ((value) => value);
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = transform(String(value || "").trim());
    if (!normalized || normalized.length > maxLength || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.slice(0, options.maxItems || 100);
}

function normalizeCompilationPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[-_\s]+$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function createAppConfigService({
  configPath,
  defaultImageReaderCacheMaxBytes,
  ensureDataDir,
  maxImageReaderCacheMaxBytes,
  minImageReaderCacheMaxBytes,
  warn = console.warn
}) {
  const defaults = {
    ...DEFAULT_CONFIG,
    imageReaderCacheMaxBytes: defaultImageReaderCacheMaxBytes
  };
  let config = defaultConfig();

  function defaultConfig() {
    return {
      compilationPrefixes: [...defaults.compilationPrefixes],
      compilationKeywords: [...defaults.compilationKeywords],
      actorAvatarDataPath: defaults.actorAvatarDataPath,
      imageReaderCacheMaxBytes: defaults.imageReaderCacheMaxBytes
    };
  }

  function normalizeImageReaderCacheLimit(value, fallback = defaultImageReaderCacheMaxBytes) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed <= 0) return 0;
    return Math.min(maxImageReaderCacheMaxBytes, Math.max(minImageReaderCacheMaxBytes, Math.floor(parsed)));
  }

  function normalize(value = {}) {
    const fallback = defaultConfig();
    const input = value && typeof value === "object" ? value : {};
    const prefixes = uniqueTrimmedStrings(input.compilationPrefixes, {
      maxLength: 16,
      maxItems: 80,
      transform: normalizeCompilationPrefix
    });
    const keywords = uniqueTrimmedStrings(input.compilationKeywords, {
      maxLength: 40,
      maxItems: 120
    });

    return {
      compilationPrefixes: prefixes.length ? prefixes : fallback.compilationPrefixes,
      compilationKeywords: keywords.length ? keywords : fallback.compilationKeywords,
      actorAvatarDataPath: String(input.actorAvatarDataPath || "").trim().slice(0, 1000),
      imageReaderCacheMaxBytes: normalizeImageReaderCacheLimit(
        input.imageReaderCacheMaxBytes ?? input.mangaImageCacheMaxBytes,
        fallback.imageReaderCacheMaxBytes
      )
    };
  }

  function load() {
    config = defaultConfig();
    if (!fs.existsSync(configPath)) return config;

    try {
      config = normalize(JSON.parse(fs.readFileSync(configPath, "utf8")));
    } catch (error) {
      warn(`[config] failed to load app config: ${error.message}`);
      config = defaultConfig();
    }
    return config;
  }

  function save() {
    ensureDataDir();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    return config;
  }

  function set(value) {
    config = normalize(value);
    save();
    return config;
  }

  function patch(value = {}) {
    const input = value && typeof value === "object" ? value : {};
    const next = { ...config };
    for (const [key, raw] of Object.entries(input)) {
      if (raw !== undefined) next[key] = raw;
    }
    return set(next);
  }

  function current() {
    return config;
  }

  function publicConfig() {
    return {
      compilationPrefixes: [...config.compilationPrefixes],
      compilationKeywords: [...config.compilationKeywords],
      actorAvatarDataPath: config.actorAvatarDataPath || "",
      imageReaderCacheMaxBytes: normalizeImageReaderCacheLimit(config.imageReaderCacheMaxBytes)
    };
  }

  function imageReaderCacheMaxBytes() {
    return normalizeImageReaderCacheLimit(config.imageReaderCacheMaxBytes);
  }

  return {
    current,
    defaultConfig,
    imageReaderCacheMaxBytes,
    load,
    normalize,
    patch,
    publicConfig,
    save,
    set
  };
}
