import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_DIRECTORY = fileURLToPath(new URL("../public/assets/studio-marks/", import.meta.url));
const MANIFEST_PATH = path.join(ASSET_DIRECTORY, "manifest.json");
const VARIANT_ORDER = { logo: 0, "": 1, icon: 2 };
// Whole, known brand names only, including the observed bilingual Prestige
// spelling. Commas, brackets and subsidiary names are never split or guessed.
const KNOWN_ALIAS_GROUPS = [
  ["S1 NO.1 STYLE", "S1_NO_1_STYLE", "エスワン ナンバーワンスタイル", "エスワンナンバーワンスタイル"],
  ["MOODYZ", "ムーディーズ"],
  ["SOD Create", "SODクリエイト"],
  ["Idea Pocket", "アイデアポケット", "アイディアポケット"],
  ["Prestige", "プレステージ", "PRESTIGE,プレステージ"],
  ["K_M_Produce", "ケイ・エム・プロデュース"],
  ["Wanz Factory", "ワンズファクトリー"],
  ["ダスッ_", "ダスッ！", "ダスッ!"],
  ["Planet Plus", "プラネットプラス"],
  ["Natural High", "ナチュラルハイ"],
  ["Alice JAPAN", "アリスJAPAN"],
  ["山と空_妄想族", "山と空"]
];

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/[\s_.-]+/gu, " ");
}

const aliases = new Map(KNOWN_ALIAS_GROUPS.flatMap(group => group.map(name => [normalizeName(name), normalizeName(group[0])])));
function identity(value) {
  const name = normalizeName(value);
  return aliases.get(name) || name;
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")); } catch { return { marks: [] }; }
}

// The manifest and file inventory are read once per lookup instance. This only
// resolves display assets; it never changes makers, links or catalog identities.
export function createStudioMarkLookup({ manifest = readManifest(), assetDirectory = ASSET_DIRECTORY } = {}) {
  const marks = new Map();
  const candidates = Array.isArray(manifest?.marks) ? manifest.marks : [];
  const ordered = [...candidates].sort((a, b) =>
    (VARIANT_ORDER[a?.variant || ""] ?? 3) - (VARIANT_ORDER[b?.variant || ""] ?? 3)
    || Number(b?.bytes || 0) - Number(a?.bytes || 0)
    || (String(a?.file || "") < String(b?.file || "") ? -1 : String(a?.file || "") > String(b?.file || "") ? 1 : 0));
  for (const entry of ordered) {
    const file = String(entry?.file || "");
    const key = identity(entry?.studio);
    if (!key || marks.has(key) || !file || /[\\/\x00-\x1f]/u.test(file)
      || file === "." || file === ".." || path.basename(file) !== file
      || !/\.(?:png|jpe?g|webp|gif|svg|ico)$/iu.test(file)) continue;
    try {
      // Symlinks are not resources in this imported bundle.
      if (!fs.lstatSync(path.join(assetDirectory, file)).isFile()) continue;
    } catch { continue; }
    marks.set(key, Object.freeze({
      url: `/assets/studio-marks/${encodeURIComponent(file)}`,
      file,
      studio: String(entry.studio),
      variant: String(entry.variant || ""),
      source: String(entry.source || ""),
      sourceUrl: String(entry.source_url || ""),
      sha256: String(entry.sha256 || "")
    }));
  }
  return name => marks.get(identity(name)) || null;
}

export const studioMarkForName = createStudioMarkLookup();

export function studioMarkFields(name) {
  const mark = studioMarkForName(name);
  return {
    logoUrl: mark?.url || "",
    logoSource: mark ? { project: "peach", file: mark.file, source: mark.source,
      sourceUrl: mark.sourceUrl, sha256: mark.sha256 } : null
  };
}
