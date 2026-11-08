import path from "node:path";

export function photoCoverHintScore(member, hints, fileBase = name => path.parse(name).name) {
  const base = String(member || "").split(/[\\/]/u).filter(Boolean).at(-1) || "";
  const stem = fileBase(base).toLowerCase();
  const tokens = stem.split(/[\s._\-()[\]{}【】]+/u).filter(Boolean);
  if (!stem) return 0;
  if (stem === "cover" || stem === "封面") return 1000;
  if (tokens.includes("cover") || tokens.includes("封面")) return 940;
  if (stem.includes("cover") || stem.includes("封面")) return 880;
  if (hints.has(stem)) return 760;
  if (tokens.some(token => hints.has(token))) return 700;
  return 0;
}

export function officialPhotoCoverRevision(row) {
  if (row?.member_path != null || (row?.status && row.status !== "ok")) return "";
  return readOfficialCoverRevision(row?.official_source);
}

export function readOfficialCoverRevision(source) {
  if (!source) return "";
  try {
    const revision = JSON.parse(source)?.revision;
    return typeof revision === "string" ? revision : "";
  } catch { return ""; }
}
