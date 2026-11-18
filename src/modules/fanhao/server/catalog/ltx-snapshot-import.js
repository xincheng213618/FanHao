import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ITEMS_URL = "https://ltxlib.dpdns.org/api/items";
export const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const ITEM_FIELDS = ["code", "title", "title_zh", "actors", "maker", "cover", "url", "subtitle", "added_at",
  "date", "score", "votes", "genres", "pending", "waiting", "missing"];

export function ltxSyncError(message, statusCode = 503) {
  return Object.assign(new Error(message), { publicMessage: message, statusCode });
}

export async function importLtxSnapshot(snapshotPath, response, { signal } = {}) {
  const catalog = response?.data ?? response;
  const invalid = () => ltxSyncError("没有识别到有效的 Jasna-LTX 目录。请复制官网的目录响应正文。", 422);
  if (!Array.isArray(catalog?.items) || !catalog.items.length) throw invalid();
  const items = catalog.items.map((item) => {
    if (typeof item?.code !== "string" || !item.code.trim() || !Array.isArray(item.links)
      || (item.pending_links != null && !Array.isArray(item.pending_links))
      || item.links.some((link) => typeof link !== "string" || /[\r\n]/.test(link)
        || !/^(?:ed2k:\/\/\|file\||magnet:\?)/i.test(link))) throw invalid();
    const pending = new Set(item.pending_links);
    return { ...Object.fromEntries(ITEM_FIELDS.map((key) => [key, item[key]])),
      links: item.links.filter((link) => !pending.has(link)) };
  });
  if (!items.some((item) => item.links.length)) throw invalid();
  const snapshot = { schema_version: 1, source: ITEMS_URL, fetched_at: new Date().toISOString(), updated_at: catalog.updated_at,
    avatars: catalog.avatars, genres: catalog.genres, items };
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const temporary = path.join(path.dirname(snapshotPath), `.ltx-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot), { flag: "wx", signal });
    signal?.throwIfAborted();
    await fs.rename(temporary, snapshotPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
