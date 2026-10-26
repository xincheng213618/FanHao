import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseInfoMetadata } from "../../../../../lib/info-metadata.js";
import { buildTasteProfile } from "./profile.js";
import { workCodePrefix } from "../works/work-code-prefix.js";

const TECH_TAG = /^(?:含.*磁[链鏈]|.*磁[链鏈]|.*可播放|有字幕|中文字幕|高清|HD|FHD|[248]K|\d{3,4}p|無碼破解|无码破解|單體作品|单体作品|合集)$/iu;
const parseArray = (value) => { try { const rows = JSON.parse(value || "[]"); return Array.isArray(rows) ? rows : []; } catch { return []; } };
const unique = (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
const baseName = (value) => path.win32.basename(String(value || "").replaceAll("/", "\\"));

export function readTasteWorks(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(works)").all().map((row) => row.name));
  const optional = (name) => columns.has(name) ? `w.${name}` : `'' AS ${name}`;
  const rows = db.prepare(`SELECT w.id, w.code, w.title, ${optional("raw_text")}, ${optional("fields_json")}, ${optional("javdb_tags_json")},
    lw.id AS local_id, lw.local_path
    FROM works w JOIN local_works lw ON lw.work_id = w.id
    WHERE EXISTS (SELECT 1 FROM local_files f WHERE f.local_work_id = lw.id AND f.file_type = 'video')
    ORDER BY w.id, lw.id`).all();
  const wanted = new Set(rows.map((row) => Number(row.id)));
  const makers = new Map(), series = new Map(), prefixes = new Map();
  const add = (map, id, feature) => { if (!map.has(id)) map.set(id, []); map.get(id).push(feature); };
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const redirects = tables.has("person_redirects") ? new Map(db.prepare("SELECT source_id,target_id FROM person_redirects").all().map((row) => [Number(row.source_id), Number(row.target_id)])) : new Map();
  const canonical = (id) => { const visited = new Set(); while (redirects.has(id) && !visited.has(id)) { visited.add(id); id = redirects.get(id); } return id; };
  const names = new Map(db.prepare("SELECT id, name, display_name, folder_path FROM people").all().map((row) => [Number(row.id), row]));
  const pathKey = (value) => path.win32.normalize(String(value || "").replaceAll("/", "\\")).replace(/[\\]+$/, "").toLowerCase();
  const locations = new Map();
  const addLocation = (id, location) => {
    if (!location) return;
    const key = pathKey(location);
    if (!locations.has(key)) locations.set(key, new Set());
    locations.get(key).add(canonical(Number(id)));
  };
  for (const person of names.values()) addLocation(person.id, person.folder_path);
  if (tables.has("person_library_locations")) {
    for (const location of db.prepare("SELECT person_id,path FROM person_library_locations").all()) addLocation(location.person_id, location.path);
  }
  const personFeature = (id) => {
    const person = names.get(id);
    const name = person?.display_name || person?.name || "";
    if (!person || /^(?:\[.*\]|noactor|unknown|未知|合集|动漫|動畫)$/iu.test(name)) return null;
    return { id: `person:${id}`, name };
  };
  const directoryNames = new Map();
  const directoryKey = (name) => String(name || "").normalize("NFKC").replace(/^\[A\][.\s_-]*/iu, "").trim().toLowerCase();
  for (const person of names.values()) {
    if (!person.folder_path || !personFeature(canonical(Number(person.id)))) continue;
    for (const name of unique([person.name, person.display_name, baseName(person.folder_path)])) {
      const key = directoryKey(name);
      if (!directoryNames.has(key)) directoryNames.set(key, new Set());
      directoryNames.get(key).add(canonical(Number(person.id)));
    }
  }
  const owners = (location) => {
    let current = pathKey(location);
    while (current && current !== ".") {
      if (locations.has(current)) return [...locations.get(current)].map(personFeature).filter(Boolean);
      const candidates = directoryNames.get(directoryKey(baseName(current)));
      if (candidates?.size === 1) return [...candidates].map(personFeature).filter(Boolean);
      const parent = pathKey(path.win32.dirname(current));
      if (parent === current) break;
      current = parent;
    }
    return [];
  };
  const makerNames = new Map();
  if (tables.has("work_makers") && tables.has("makers")) {
    for (const row of db.prepare("SELECT wm.work_id, m.id, m.name FROM work_makers wm JOIN makers m ON m.id = wm.maker_id").all()) {
      makerNames.set(row.name.normalize("NFKC").trim().toLowerCase(), { id: `maker:${row.id}`, name: row.name });
      if (wanted.has(Number(row.work_id))) add(makers, Number(row.work_id), { id: `maker:${row.id}`, name: row.name });
    }
  }
  if (tables.has("work_series") && tables.has("series")) {
    for (const row of db.prepare("SELECT ws.work_id, s.id, s.name, s.kind FROM work_series ws JOIN series s ON s.id = ws.series_id").all()) {
      if (!wanted.has(Number(row.work_id))) continue;
      if (row.kind === "prefix") add(prefixes, Number(row.work_id), { id: `prefix:${row.id}`, name: row.name });
      else if (row.kind === "series") add(series, Number(row.work_id), { id: `series:${row.id}`, name: row.name });
    }
  }
  const metadata = new Map();
  return rows.map((row) => {
    const id = Number(row.id);
    if (!metadata.has(id)) {
      const fields = parseArray(row.fields_json).filter((item) => item && typeof item === "object");
      const text = [row.raw_text || "", ...fields.map((item) => `${item.label}: ${item.value}`)].join("\n");
      const info = parseInfoMetadata(text, { title: row.title || "" });
      const prefix = workCodePrefix(row.code || info.code);
      const tags = unique([...(info.tags || []), ...parseArray(row.javdb_tags_json)]).filter((tag) => !TECH_TAG.test(tag));
      metadata.set(id, { id, code: row.code || info.code, title: row.title,
        tags, makers: makers.get(id) || unique([info.maker, info.label]).map((name) => makerNames.get(name.normalize("NFKC").toLowerCase()) || name),
        series: series.get(id) || unique([info.series]),
        prefixes: prefix ? [{ id: `prefix:${prefix}`, name: prefix }] : prefixes.get(id) || [] });
    }
    // Only the work directory prefix is a rating; an ancestor named [A] may be a storage root.
    return { ...metadata.get(id), people: owners(row.local_path), marked: /^\[A\]/iu.test(baseName(row.local_path)) };
  });
}

export function analyzeTasteDatabase(dbPath, options = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 3000; BEGIN");
    const works = readTasteWorks(db);
    const result = buildTasteProfile(works, options);
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}
