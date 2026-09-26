import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalPersonId, hasIdentityTable, personPathKey } from "../src/modules/fanhao/server/people/person-identity.js";

const key = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");

// Evidence only: shared credits alone do not identify a person (co-stars share credits).
export function auditPersonIdentities(db) {
  const rows = db.prepare("SELECT id,name,display_name,folder_path,source FROM people ORDER BY id").all();
  const active = new Map(rows.filter((p) => canonicalPersonId(db, p.id) === String(p.id)).map((p) => [p.id, {
    ...p, names: new Set([key(p.name), key(p.display_name)].filter(Boolean)), hints: new Set(),
    aliases: [], refs: [], works: new Set(), locations: new Set(p.folder_path ? [p.folder_path] : [])
  }]));
  for (const p of active.values()) {
    for (const name of [p.name, p.display_name]) {
      const match = String(name || "").match(/^\[([^\]]+)\]\s*(.*)$/);
      if (match) for (const part of match.slice(1)) if (key(part)) p.hints.add(key(part));
    }
  }
  for (const a of db.prepare("SELECT person_id,alias FROM person_aliases").all()) {
    const p = active.get(a.person_id);
    if (p && key(a.alias)) { p.names.add(key(a.alias)); p.aliases.push(a.alias); }
  }
  for (const r of db.prepare("SELECT person_id,provider,external_key,url FROM person_external_refs").all()) active.get(r.person_id)?.refs.push(r);
  for (const r of db.prepare("SELECT work_id,person_id FROM work_people WHERE role='actor'").all()) active.get(r.person_id)?.works.add(r.work_id);
  if (hasIdentityTable(db, "person_library_locations")) {
    for (const r of db.prepare("SELECT person_id,path FROM person_library_locations").all()) active.get(r.person_id)?.locations.add(r.path);
  }
  const names = new Map(), paths = new Map();
  for (const p of active.values()) {
    for (const name of new Set([...p.names, ...p.hints])) {
      if (!names.has(name)) names.set(name, new Set());
      names.get(name).add(p.id);
    }
    for (const location of p.locations) {
      const normalized = personPathKey(location);
      if (!paths.has(normalized)) paths.set(normalized, new Set());
      paths.get(normalized).add(p.id);
    }
  }
  const candidates = new Map();
  const addPair = (a, b, name = "", location = "") => {
    const ids = [a,b].sort((x,y) => x-y), pairKey = ids.join(":");
    if (!candidates.has(pairKey)) candidates.set(pairKey, { ids, matchedNames: [], sharedPaths: [] });
    const pair = candidates.get(pairKey);
    if (name) pair.matchedNames.push(name);
    if (location) pair.sharedPaths.push(location);
  };
  for (const [name, ids] of names) for (const a of ids) for (const b of ids) if (a < b) addPair(a, b, name);
  for (const [location, ids] of paths) for (const a of ids) for (const b of ids) if (a < b) addPair(a, b, "", location);
  const publicPerson = (p) => ({ id:p.id, name:p.name, displayName:p.display_name, source:p.source,
    aliases:p.aliases, refs:p.refs, locations:[...p.locations], workCount:p.works.size });
  const pairs = [...candidates.values()].map((pair) => {
    const [a,b] = pair.ids.map((id) => active.get(id));
    const keys = new Set([...a.refs,...b.refs].filter((r) => r.provider === "javdb-actor").map((r) => r.external_key));
    const externalConflict = keys.size > 1;
    const sharedWorkIds = [...a.works].filter((id) => b.works.has(id));
    const exactNameMatch = pair.matchedNames.some((name) => a.names.has(name) && b.names.has(name));
    const confidence = externalConflict ? "external-conflict" : pair.sharedPaths.length || (exactNameMatch && sharedWorkIds.length >= 2)
      ? "strong-candidate" : "review-needed";
    return {...pair, people:[publicPerson(a),publicPerson(b)], externalConflict, sharedWorkIds, exactNameMatch, confidence};
  }).sort((a,b) => ({"external-conflict":0,"strong-candidate":1,"review-needed":2}[a.confidence] - {"external-conflict":0,"strong-candidate":1,"review-needed":2}[b.confidence]) || b.sharedWorkIds.length-a.sharedWorkIds.length || a.ids[0]-b.ids[0]);
  return { generatedAt:new Date().toISOString(), mode:"read-only", totalPeople:rows.length,
    activePeople:active.size, archivedPeople:rows.length-active.size,
    summary: { candidatePairs:pairs.length, strongCandidatePairs:pairs.filter((p)=>p.confidence==="strong-candidate").length,
      reviewPairs:pairs.filter((p)=>p.confidence==="review-needed").length, externalConflictPairs:pairs.filter((p)=>p.externalConflict).length },
    directoryConflicts:[...paths].filter(([,ids])=>ids.size>1).map(([path,ids])=>({path,personIds:[...ids]})),
    foreignKeyIssues:db.prepare("PRAGMA foreign_key_check").all(), pairs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = (name,fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
  const dbPath = path.resolve(option("--db", "data/fanhao-core-v2.sqlite"));
  const output = path.resolve(option("--output", ".codex-artifacts/person-identity-audit"));
  const db = new DatabaseSync(dbPath, { readOnly:true });
  db.exec("BEGIN");
  let report;
  try { report = auditPersonIdentities(db); } finally { db.exec("ROLLBACK"); db.close(); }
  fs.mkdirSync(output, {recursive:true});
  fs.writeFileSync(path.join(output,"report.json"), JSON.stringify(report,null,2));
  const escape = (value) => String(value || "").replaceAll("|","\\|").replace(/[\r\n]+/g," ");
  const labels = {"external-conflict":"外部身份冲突","strong-candidate":"较强候选（仍须确认）","review-needed":"待核对"};
  fs.writeFileSync(path.join(output,"report.md"), ["# 人物重复身份检查", "", `时间：${report.generatedAt}。只读扫描；没有自动合并候选，也没有扫描或修改媒体文件。`, "",
    `有效人物 ${report.activePeople}，已归档 ${report.archivedPeople}。候选对 ${report.summary.candidatePairs}：较强 ${report.summary.strongCandidatePairs}，待核对 ${report.summary.reviewPairs}，外部身份冲突 ${report.summary.externalConflictPairs}。`,
    "", "同一候选人物可能出现在多对中，候选对数不是重复人数。同名或共同出演作品不代表同一个人；不同 JavDB 身份需人工核验。", "",
    `目录归属冲突 ${report.directoryConflicts.length}；外键问题 ${report.foreignKeyIssues.length}。完整证据见同目录 report.json。`, "",
    "|分类|人物 A|人物 B|共同名字/别名|共同作品数|", "|---|---|---|---|---:|",
    ...report.pairs.map((p)=>`|${labels[p.confidence]}|[${escape(p.people[0].displayName || p.people[0].name)} #${p.ids[0]}](http://127.0.0.1:29998/fanhao?personId=${p.ids[0]})|[${escape(p.people[1].displayName || p.people[1].name)} #${p.ids[1]}](http://127.0.0.1:29998/fanhao?personId=${p.ids[1]})|${escape(p.matchedNames.join("、"))}|${p.sharedWorkIds.length}|`), ""].join("\n"));
  console.log(JSON.stringify({output,...report.summary,activePeople:report.activePeople,archivedPeople:report.archivedPeople,directoryConflicts:report.directoryConflicts.length,foreignKeyIssues:report.foreignKeyIssues.length}));
}
