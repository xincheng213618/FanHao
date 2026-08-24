import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  root: "D:\\Media\\ShortVideos",
  managerDb: path.join(
    projectRoot,
    "src",
    "modules",
    "short-videos",
    "download-manager",
    "data",
    "douyin_downloads.sqlite",
  ),
  fanhaoDb: path.join(projectRoot, "data", "short-videos.sqlite"),
  batchSize: 500,
};

const managerTables = [
  {
    table: "download_files",
    columns: [
      { name: "file_path", kind: "path" },
      { name: "absolute_path", kind: "path" },
    ],
  },
  {
    table: "link_files",
    columns: [
      { name: "file_path", kind: "path" },
      { name: "absolute_path", kind: "path" },
    ],
  },
  {
    table: "download_records",
    columns: [{ name: "record_json", kind: "json" }],
    downloadRecord: true,
  },
  {
    table: "links",
    columns: [
      { name: "local_file_paths", kind: "json" },
      { name: "preview_path", kind: "path" },
      { name: "local_cover_path", kind: "path" },
      { name: "local_music_path", kind: "path" },
      { name: "metadata_json", kind: "json" },
    ],
  },
  {
    table: "video_quality_audit_items",
    columns: [
      { name: "source_path", kind: "path" },
      { name: "raw_json", kind: "qualityRawJson" },
    ],
  },
];

const fanhaoTables = [
  {
    table: "short_video_assets",
    columns: [{ name: "local_path", kind: "path" }],
  },
  {
    table: "short_video_import_items",
    columns: [
      { name: "source_path", kind: "path" },
      { name: "data_path", kind: "path" },
    ],
  },
  {
    table: "short_videos",
    columns: [
      { name: "source_path", kind: "path" },
      { name: "cover_path", kind: "path" },
      { name: "music_path", kind: "path" },
      { name: "data_path", kind: "path" },
      { name: "relative_path", kind: "path" },
      { name: "metadata_json", kind: "json" },
    ],
  },
];

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.mapping) throw new Error("必须提供 --mapping <json>");

  const apply = Boolean(args.apply);
  if (apply && !args["offline-confirmed"]) {
    throw new Error("写入前必须停止 FanHao 与下载器，并同时传入 --apply --offline-confirmed");
  }

  const root = path.resolve(args.root || defaults.root);
  const manifest = path.resolve(args.manifest || path.join(root, "download_manifest.jsonl"));
  const managerDb = path.resolve(args["manager-db"] || defaults.managerDb);
  const fanhaoDb = path.resolve(args["fanhao-db"] || defaults.fanhaoDb);
  const batchSize = positiveInteger(args["batch-size"] || defaults.batchSize, "--batch-size");
  const mappingPath = path.resolve(args.mapping);

  assertFile(mappingPath, "映射 JSON");
  assertFile(manifest, "download manifest");
  assertFile(managerDb, "下载管理器数据库");
  assertFile(fanhaoDb, "FanHao 短视频数据库");
  const loadedMapping = loadMapping(mappingPath);
  const mapping = loadedMapping.mapping;
  if (loadedMapping.declaredRoot && !samePath(loadedMapping.declaredRoot, root)) {
    throw new Error(
      `映射报告的 root 与 --root 不一致：${loadedMapping.declaredRoot} != ${root}`,
    );
  }
  const rewriter = createPathRewriter(root, mapping);

  console.log(`${apply ? "写入迁移" : "只读预检"}：${mapping.size} 个旧目录名 -> sec_uid`);
  if (loadedMapping.skippedUnresolved) {
    console.log(`映射报告另有 ${loadedMapping.skippedUnresolved} 个未解析目录，保持不变。`);
  }
  console.log(`媒体根目录：${root}`);
  console.log("此工具只处理 manifest/SQLite 元数据，不移动媒体目录。");

  const manifestResult = await migrateManifest({ manifest, rewriter, apply });
  printManifestSummary(manifestResult, apply);

  const managerResult = migrateDatabase({
    kind: "manager",
    file: managerDb,
    specs: managerTables,
    rewriter,
    apply,
    batchSize,
    manifestResult,
  });
  const fanhaoResult = migrateDatabase({
    kind: "fanhao",
    file: fanhaoDb,
    specs: fanhaoTables,
    rewriter,
    apply,
    batchSize,
    manifestResult,
  });

  printDatabaseSummary(managerResult);
  printDatabaseSummary(fanhaoResult);
  const summary = {
    mode: apply ? "apply" : "dry-run",
    mappingPath,
    mappingCount: mapping.size,
    skippedUnresolvedMappings: loadedMapping.skippedUnresolved,
    root,
    manifest: manifestResult,
    databases: [managerResult, fanhaoResult],
  };
  console.log("MIGRATION_SUMMARY_JSON=" + JSON.stringify(summary));
  if (!apply) {
    console.log("未写入任何文件；确认服务离线后，使用 --apply --offline-confirmed 执行。");
  } else if (manifestResult.backupPath) {
    console.log(`校验全部通过后可清理 manifest 临时备份：${manifestResult.backupPath}`);
  }
}

async function migrateManifest({ manifest, rewriter, apply }) {
  const sourceStat = fs.statSync(manifest);
  const stamp = timestampForFile();
  const directory = path.dirname(manifest);
  const base = path.basename(manifest);
  const tempPath = apply
    ? uniqueSibling(directory, `.${base}.author-metadata-${stamp}.tmp`)
    : null;
  const backupPath = apply
    ? uniqueSibling(directory, `${base}.before-author-metadata-${stamp}.bak`)
    : null;
  const badDigest = crypto.createHash("sha256");
  let output = null;
  let outputFd = null;
  const stats = {
    path: manifest,
    sourceBytes: sourceStat.size,
    outputBytes: 0,
    lines: 0,
    validRecords: 0,
    badLines: 0,
    badLineBytes: 0,
    badLinesSha256: "",
    recordsChanged: 0,
    pathStringsChanged: 0,
    tempPath,
    backupPath: null,
    replaced: false,
    fileSize: sourceStat.size,
    fileMtimeNs: fs.statSync(manifest, { bigint: true }).mtimeNs.toString(),
  };

  try {
    if (apply) {
      outputFd = fs.openSync(tempPath, "wx", sourceStat.mode);
      output = fs.createWriteStream(tempPath, { fd: outputFd, autoClose: false });
    }
    for await (const rawLine of rawLines(manifest)) {
      stats.lines += 1;
      const { body, ending } = splitLineEnding(rawLine);
      let record;
      let bad = false;
      try {
        record = parseJsonLossless(body.toString("utf8"));
        bad = !record || typeof record !== "object" || Array.isArray(record)
          || !jsonScalarText(record.aweme_id).trim();
      } catch {
        bad = true;
      }

      let rendered = rawLine;
      if (bad) {
        stats.badLines += 1;
        stats.badLineBytes += rawLine.length;
        badDigest.update(rawLine);
      } else {
        stats.validRecords += 1;
        const rewritten = rewriteJsonValue(record, rewriter);
        if (rewritten.changed) {
          stats.recordsChanged += 1;
          stats.pathStringsChanged += rewritten.pathStringsChanged;
          rendered = Buffer.concat([
            Buffer.from(JSON.stringify(rewritten.value), "utf8"),
            ending,
          ]);
        }
      }
      stats.outputBytes += rendered.length;
      if (output && !output.write(rendered)) await onceDrain(output);
    }
    stats.badLinesSha256 = badDigest.digest("hex");

    if (!apply) return stats;
    await finishWriteStream(output);
    fs.fsyncSync(outputFd);
    fs.closeSync(outputFd);
    outputFd = null;
    output = null;

    const tempStat = fs.statSync(tempPath);
    if (tempStat.size !== stats.outputBytes) {
      throw new Error(`manifest 临时文件长度校验失败：${tempStat.size} != ${stats.outputBytes}`);
    }
    if (stats.recordsChanged === 0) {
      fs.unlinkSync(tempPath);
      stats.tempPath = null;
      stats.backupPath = null;
      return stats;
    }

    let originalMoved = false;
    try {
      fs.renameSync(manifest, backupPath);
      originalMoved = true;
      fs.renameSync(tempPath, manifest);
    } catch (error) {
      if (originalMoved && !fs.existsSync(manifest) && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, manifest);
      }
      throw error;
    }
    stats.tempPath = null;
    stats.backupPath = backupPath;
    stats.replaced = true;
    const finalStat = fs.statSync(manifest, { bigint: true });
    stats.fileSize = Number(finalStat.size);
    stats.fileMtimeNs = finalStat.mtimeNs.toString();
    console.log(`manifest 已原子切换；保留校验备份：${backupPath}`);
    return stats;
  } catch (error) {
    if (output) output.destroy();
    if (outputFd !== null) {
      try {
        fs.closeSync(outputFd);
      } catch {}
    }
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
    throw error;
  }
}

function migrateDatabase({
  kind,
  file,
  specs,
  rewriter,
  apply,
  batchSize,
  manifestResult,
}) {
  const db = new DatabaseSync(file, { readOnly: !apply });
  const result = {
    kind,
    path: file,
    rowsScanned: 0,
    rowsChanged: 0,
    valuesChanged: 0,
    invalidJsonValues: 0,
    batchesCommitted: 0,
    manifestStateRowsChanged: 0,
    manifestOffsetsCleared: 0,
    projectionChecked: false,
    projectionBaselineMismatches: 0,
    projectionRebuilt: false,
    tombstoneAliases: null,
    tables: [],
  };
  try {
    db.exec("PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = ON;");
    let tombstonePlan = null;
    if (kind === "fanhao") {
      assertDeleteProtocolIdle(db);
      assertReferenceTriggers(db);
      result.projectionBaselineMismatches = shortVideoReferenceProjectionMismatchCount(db);
      if (apply && result.projectionBaselineMismatches) {
        rebuildShortVideoReferenceProjection(db);
        result.projectionRebuilt = true;
        checkpoint(db, "PASSIVE");
        assertShortVideoReferenceProjection(db);
      }
      tombstonePlan = planActiveTombstoneAliases(db, rewriter);
      result.tombstoneAliases = tombstonePlan.summary;
    }

    for (const spec of specs) {
      const tableResult = migrateTable({
        db,
        spec,
        rewriter,
        apply,
        batchSize,
      });
      result.tables.push(tableResult);
      result.rowsScanned += tableResult.rowsScanned;
      result.rowsChanged += tableResult.rowsChanged;
      result.valuesChanged += tableResult.valuesChanged;
      result.invalidJsonValues += tableResult.invalidJsonValues;
      result.batchesCommitted += tableResult.batchesCommitted;
      if (apply && tableResult.batchesCommitted) checkpoint(db, "PASSIVE");
    }

    if (kind === "manager" && apply) {
      result.manifestOffsetsCleared = clearRewrittenManifestOffsets({
        db,
        manifestResult,
        batchSize,
      });
      result.manifestStateRowsChanged = updateManifestImportState(db, manifestResult);
    }
    if (kind === "fanhao") {
      if (apply || result.projectionBaselineMismatches === 0) {
        assertShortVideoReferenceProjection(db);
        result.projectionChecked = true;
      }
      if (apply && tombstonePlan.aliases.length) {
        result.tombstoneAliases.inserted = insertActiveTombstoneAliases(
          db,
          tombstonePlan.aliases,
          batchSize,
        );
        checkpoint(db, "PASSIVE");
      }
    }
    if (apply) checkpoint(db, "TRUNCATE");
    return result;
  } finally {
    db.close();
  }
}

function migrateTable({ db, spec, rewriter, apply, batchSize }) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  if (!tables.has(spec.table)) {
    return {
      table: spec.table,
      skipped: "table missing",
      rowsScanned: 0,
      rowsChanged: 0,
      valuesChanged: 0,
      invalidJsonValues: 0,
      batchesCommitted: 0,
    };
  }
  const available = new Set(
    db.prepare(`PRAGMA table_info(${quoteIdentifier(spec.table)})`).all().map((row) => row.name),
  );
  const columns = spec.columns.filter((column) => available.has(column.name));
  if (!columns.length) {
    return {
      table: spec.table,
      skipped: "columns missing",
      rowsScanned: 0,
      rowsChanged: 0,
      valuesChanged: 0,
      invalidJsonValues: 0,
      batchesCommitted: 0,
    };
  }
  if (spec.downloadRecord && (!available.has("content_hash") || !available.has("manifest_offset"))) {
    throw new Error("download_records 缺少 content_hash 或 manifest_offset，拒绝不完整迁移");
  }

  const table = quoteIdentifier(spec.table);
  const selectColumns = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const select = db.prepare(`
    SELECT rowid AS __migration_rowid, ${selectColumns}
    FROM ${table}
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  const updateStatements = new Map();
  const tableResult = {
    table: spec.table,
    columns: columns.map((column) => column.name),
    rowsScanned: 0,
    rowsChanged: 0,
    valuesChanged: 0,
    invalidJsonValues: 0,
    batchesCommitted: 0,
  };
  let lastRowid = 0;
  while (true) {
    const rows = select.all(lastRowid, batchSize);
    if (!rows.length) break;
    const updates = [];
    for (const row of rows) {
      lastRowid = Number(row.__migration_rowid);
      tableResult.rowsScanned += 1;
      const values = new Map();
      for (const column of columns) {
        if (typeof row[column.name] !== "string" || !row[column.name]) continue;
        const rewritten = column.kind === "json"
          ? rewriteJsonText(row[column.name], rewriter)
          : column.kind === "qualityRawJson"
            ? rewriteQualityAuditRawJson(row[column.name], rewriter)
            : rewritePathText(row[column.name], rewriter);
        if (rewritten.invalidJson) tableResult.invalidJsonValues += 1;
        if (!rewritten.changed) continue;
        values.set(column.name, rewritten.value);
        tableResult.valuesChanged += 1;
      }
      if (!values.size) continue;
      if (spec.downloadRecord) {
        const recordJson = values.get("record_json");
        let parsed;
        try {
          parsed = parseJsonLossless(recordJson);
        } catch {
          throw new Error(`download_records rowid=${lastRowid} 的 record_json 不是有效 JSON`);
        }
        values.set("content_hash", hashDownloadRecord(parsed));
        values.set("manifest_offset", null);
      }
      tableResult.rowsChanged += 1;
      updates.push({ rowid: lastRowid, values });
    }

    if (apply && updates.length) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const update of updates) {
          const names = [...update.values.keys()].sort();
          const key = names.join("\u0000");
          let statement = updateStatements.get(key);
          if (!statement) {
            const assignments = names.map((name) => `${quoteIdentifier(name)} = ?`).join(", ");
            statement = db.prepare(`UPDATE ${table} SET ${assignments} WHERE rowid = ?`);
            updateStatements.set(key, statement);
          }
          statement.run(...names.map((name) => update.values.get(name)), update.rowid);
        }
        db.exec("COMMIT");
        tableResult.batchesCommitted += 1;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }
  }
  return tableResult;
}

function clearRewrittenManifestOffsets({ db, manifestResult, batchSize }) {
  if (!manifestResult.replaced) return 0;
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  if (!tables.has("download_records")) return 0;
  const manifestPaths = db.prepare(`
    SELECT DISTINCT manifest_path
    FROM download_records
    WHERE COALESCE(manifest_path, '') <> '' AND manifest_offset IS NOT NULL
  `).all()
    .map((row) => String(row.manifest_path || ""))
    .filter((candidate) => samePath(candidate, manifestResult.path));
  if (!manifestPaths.length) return 0;

  let cleared = 0;
  let batches = 0;
  for (const manifestPath of manifestPaths) {
    const select = db.prepare(`
      SELECT rowid AS migration_rowid
      FROM download_records
      WHERE manifest_path = ? AND manifest_offset IS NOT NULL
      ORDER BY rowid
      LIMIT ?
    `);
    while (true) {
      const rowids = select.all(manifestPath, batchSize).map((row) => Number(row.migration_rowid));
      if (!rowids.length) break;
      const placeholders = rowids.map(() => "?").join(", ");
      db.exec("BEGIN IMMEDIATE");
      try {
        cleared += Number(db.prepare(`
          UPDATE download_records
          SET manifest_offset = NULL
          WHERE rowid IN (${placeholders}) AND manifest_offset IS NOT NULL
        `).run(...rowids).changes);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      batches += 1;
      if (batches % 20 === 0) checkpoint(db, "PASSIVE");
    }
  }
  return cleared;
}

function updateManifestImportState(db, manifestResult) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  if (!tables.has("manifest_import_state")) return 0;
  const manifestPath = path.resolve(manifestResult.path);
  const rows = db.prepare("SELECT manifest_path FROM manifest_import_state").all();
  const matching = rows.filter((row) => samePath(row.manifest_path, manifestPath));
  const now = new Date().toISOString();
  const mtimeNs = BigInt(manifestResult.fileMtimeNs);
  let changes = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (matching.length) {
      const statement = db.prepare(`
        UPDATE manifest_import_state
        SET byte_offset = ?, file_size = ?, file_mtime_ns = ?, bad_lines = ?, updated_at = ?
        WHERE manifest_path = ?
      `);
      for (const row of matching) {
        changes += Number(statement.run(
          manifestResult.fileSize,
          manifestResult.fileSize,
          mtimeNs,
          manifestResult.badLines,
          now,
          row.manifest_path,
        ).changes);
      }
    } else {
      changes += Number(db.prepare(`
        INSERT INTO manifest_import_state(
          manifest_path, byte_offset, file_size, file_mtime_ns,
          imported_records, bad_lines, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        manifestPath,
        manifestResult.fileSize,
        manifestResult.fileSize,
        mtimeNs,
        manifestResult.validRecords,
        manifestResult.badLines,
        now,
      ).changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return changes;
}

function rewriteJsonText(text, rewriter) {
  let parsed;
  try {
    parsed = parseJsonLossless(text);
  } catch {
    return { value: text, changed: false, invalidJson: true, pathStringsChanged: 0 };
  }
  const rewritten = rewriteJsonValue(parsed, rewriter);
  return {
    value: rewritten.changed ? JSON.stringify(rewritten.value) : text,
    changed: rewritten.changed,
    invalidJson: false,
    pathStringsChanged: rewritten.pathStringsChanged,
  };
}

function rewriteQualityAuditRawJson(text, rewriter) {
  let parsed;
  try {
    parsed = parseJsonLossless(text);
  } catch {
    return { value: text, changed: false, invalidJson: true, pathStringsChanged: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || typeof parsed.source_path !== "string") {
    return { value: text, changed: false, invalidJson: false, pathStringsChanged: 0 };
  }
  const rewritten = rewriter(parsed.source_path);
  if (!rewritten.changed) {
    return { value: text, changed: false, invalidJson: false, pathStringsChanged: 0 };
  }
  parsed.source_path = rewritten.value;
  return {
    value: JSON.stringify(parsed),
    changed: true,
    invalidJson: false,
    pathStringsChanged: 1,
  };
}

function rewriteJsonValue(value, rewriter, depth = 0) {
  if (depth > 64) return { value, changed: false, pathStringsChanged: 0 };
  if (typeof value === "string") {
    const direct = rewriter(value);
    if (direct.changed) {
      return { value: direct.value, changed: true, pathStringsChanged: 1 };
    }
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const nested = parseJsonLossless(value);
        const rewritten = rewriteJsonValue(nested, rewriter, depth + 1);
        if (rewritten.changed) {
          return {
            value: JSON.stringify(rewritten.value),
            changed: true,
            pathStringsChanged: rewritten.pathStringsChanged,
          };
        }
      } catch {}
    }
    return { value, changed: false, pathStringsChanged: 0 };
  }
  if (Array.isArray(value)) {
    let changed = false;
    let pathStringsChanged = 0;
    for (let index = 0; index < value.length; index += 1) {
      const rewritten = rewriteJsonValue(value[index], rewriter, depth + 1);
      if (rewritten.changed) {
        value[index] = rewritten.value;
        changed = true;
        pathStringsChanged += rewritten.pathStringsChanged;
      }
    }
    return { value, changed, pathStringsChanged };
  }
  if (value && typeof value === "object") {
    if (JSON.isRawJSON(value)) {
      return { value, changed: false, pathStringsChanged: 0 };
    }
    let changed = false;
    let pathStringsChanged = 0;
    for (const key of Object.keys(value)) {
      const rewritten = rewriteJsonValue(value[key], rewriter, depth + 1);
      if (rewritten.changed) {
        value[key] = rewritten.value;
        changed = true;
        pathStringsChanged += rewritten.pathStringsChanged;
      }
    }
    return { value, changed, pathStringsChanged };
  }
  return { value, changed: false, pathStringsChanged: 0 };
}

function rewritePathText(text, rewriter) {
  const rewritten = rewriter(text);
  return {
    value: rewritten.value,
    changed: rewritten.changed,
    invalidJson: false,
    pathStringsChanged: rewritten.changed ? 1 : 0,
  };
}

function createPathRewriter(root, mapping) {
  const folded = new Map();
  for (const [oldName, secUid] of mapping) folded.set(foldPathSegment(oldName), secUid);
  const rootSegments = path.resolve(root).split(/[\\/]+/u).filter(Boolean);
  const rootPattern = rootSegments.map(escapeRegExp).join("[\\\\/]+");
  const absolute = new RegExp(
    `^${rootPattern}[\\\\/]+([^\\\\/]+)(?=[\\\\/]|$)`,
    "iu",
  );
  const relative = /^(?:\.[\\/]+)?([^\\/]+)(?=[\\/]|$)/u;

  return (value) => {
    if (typeof value !== "string" || !value) return { value, changed: false };
    let match = absolute.exec(value);
    if (!match) match = relative.exec(value);
    if (!match) return { value, changed: false };
    const replacement = folded.get(foldPathSegment(match[1]));
    if (!replacement || replacement === match[1]) return { value, changed: false };
    const segmentStart = match[0].length - match[1].length;
    return {
      value: value.slice(0, segmentStart) + replacement + value.slice(segmentStart + match[1].length),
      changed: true,
      oldName: match[1],
      secUid: replacement,
    };
  };
}

function loadMapping(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取映射 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("映射 JSON 必须是 { oldName: sec_uid } 或审计报告对象");
  }
  let entries;
  let declaredRoot = "";
  let skippedUnresolved = 0;
  if (Array.isArray(parsed.mappings)) {
    declaredRoot = String(parsed.root || "").trim();
    entries = [];
    for (const item of parsed.mappings) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("映射报告 mappings 中存在非对象条目");
      }
      const sourceName = String(item.source_name || "");
      const secUid = String(item.sec_uid || "").trim();
      if (!sourceName) throw new Error("映射报告条目缺少 source_name");
      if (!secUid) {
        skippedUnresolved += 1;
        continue;
      }
      entries.push([sourceName, secUid]);
    }
  } else {
    entries = Object.entries(parsed);
  }
  const result = new Map();
  const foldedTargets = new Map();
  for (const [rawOldName, rawSecUid] of entries) {
    const oldName = String(rawOldName || "");
    const secUid = String(rawSecUid || "").trim();
    assertSafeSegment(oldName, "旧目录名");
    assertSafeSegment(secUid, "sec_uid");
    if (!/^MS4wLjAB[A-Za-z0-9_-]+$/u.test(secUid)) {
      throw new Error(`不是完整、可安全用作目录名的 sec_uid：${secUid}`);
    }
    const foldedOld = foldPathSegment(oldName);
    const prior = foldedTargets.get(foldedOld);
    if (prior && prior !== secUid) {
      throw new Error(`Windows 路径大小写冲突：${oldName} 同时映射到 ${prior} / ${secUid}`);
    }
    foldedTargets.set(foldedOld, secUid);
    if (oldName !== secUid) result.set(oldName, secUid);
  }
  if (!result.size) throw new Error("映射中没有需要迁移的目录名");
  return { mapping: result, declaredRoot, skippedUnresolved };
}

function planActiveTombstoneAliases(db, rewriter) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  const result = {
    matched: 0,
    planned: 0,
    inserted: 0,
    alreadyPresent: 0,
    realPathPolicy: "empty; identity_key preserved",
  };
  if (!tables.has("short_video_path_tombstones")) return { summary: result, aliases: [] };

  const rows = db.prepare(`
    SELECT path_key, job_id, original_path, real_path_key, identity_key,
           state, created_at, updated_at
    FROM short_video_path_tombstones
    WHERE state = 'active'
    ORDER BY path_key
  `).all();
  const byPathKey = new Map(rows.map((row) => [String(row.path_key), row]));
  const plannedByPathKey = new Map();
  for (const row of rows) {
    const original = rewriter(String(row.original_path || ""));
    const lexical = rewriter(String(row.path_key || ""));
    if (!original.changed && !lexical.changed) continue;
    result.matched += 1;
    const newOriginalPath = original.changed ? original.value : lexical.value;
    const newPathKey = normalizedPathKey(newOriginalPath);
    if (!newPathKey || newPathKey === String(row.path_key)) continue;

    const existing = byPathKey.get(newPathKey) || plannedByPathKey.get(newPathKey);
    if (existing) {
      if (String(existing.state || "") !== "active"
          || String(existing.identity_key || "") !== String(row.identity_key || "")) {
        throw new Error(
          `活动路径墓碑别名冲突：${row.path_key} -> ${newPathKey}（identity 不一致）`,
        );
      }
      result.alreadyPresent += 1;
      continue;
    }
    const alias = {
      path_key: newPathKey,
      job_id: row.job_id,
      original_path: newOriginalPath,
      // 旧 real_path_key 仍由不可变原墓碑保存。新目录别名使用精确 lexical key；
      // 空 real key 避免把已不存在的旧物理路径错误地绑定到新目录，identity 仍保留。
      real_path_key: "",
      identity_key: row.identity_key,
      state: "active",
      created_at: row.created_at,
      updated_at: new Date().toISOString(),
    };
    plannedByPathKey.set(newPathKey, alias);
  }
  const planned = [...plannedByPathKey.values()];
  result.planned = planned.length;
  return { summary: result, aliases: planned };
}

function insertActiveTombstoneAliases(db, planned, batchSize) {
  let inserted = 0;
  const insert = db.prepare(`
    INSERT INTO short_video_path_tombstones(
      path_key, job_id, original_path, real_path_key, identity_key,
      state, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let start = 0; start < planned.length; start += batchSize) {
    const batch = planned.slice(start, start + batchSize);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const alias of batch) {
        inserted += Number(insert.run(
          alias.path_key,
          alias.job_id,
          alias.original_path,
          alias.real_path_key,
          alias.identity_key,
          alias.state,
          alias.created_at,
          alias.updated_at,
        ).changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  return inserted;
}

function assertDeleteProtocolIdle(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  if (!tables.has("short_video_delete_jobs")) return;
  const active = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM short_video_delete_jobs
    WHERE status IN ('running', 'rollback_pending', 'cleanup_pending')
       OR COALESCE(owner_id, '') <> ''
  `).get()?.count || 0);
  if (active) throw new Error(`检测到 ${active} 个活动短视频删除作业，拒绝迁移路径元数据`);
}

function assertReferenceTriggers(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  if (!tables.has("short_video_path_references")) return;
  const expected = new Set([
    "trg_short_video_path_ref_video_source_update_v2",
    "trg_short_video_path_ref_video_cover_update_v2",
    "trg_short_video_path_ref_video_music_update_v2",
    "trg_short_video_path_ref_video_data_update_v2",
    "trg_short_video_path_ref_asset_update_v2",
  ]);
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name),
  );
  const missing = [...expected].filter((name) => !existing.has(name));
  if (missing.length) throw new Error(`路径引用 owner triggers 缺失：${missing.join(", ")}`);
}

function shortVideoReferenceProjectionMismatchCount(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
  );
  if (!tables.has("short_video_path_references")) return 0;
  return Number(db.prepare(`
    WITH expected AS (
      SELECT 'short_videos' owner_table, id owner_key, id owner_video_id,
             'source_path' path_column, trim(source_path) raw_path,
             lower(replace(trim(source_path), char(92), '/')) path_key
      FROM short_videos WHERE trim(source_path) <> ''
      UNION ALL
      SELECT 'short_videos', id, id, 'cover_path', trim(cover_path),
             lower(replace(trim(cover_path), char(92), '/'))
      FROM short_videos WHERE trim(cover_path) <> ''
      UNION ALL
      SELECT 'short_videos', id, id, 'music_path', trim(music_path),
             lower(replace(trim(music_path), char(92), '/'))
      FROM short_videos WHERE trim(music_path) <> ''
      UNION ALL
      SELECT 'short_videos', id, id, 'data_path', trim(data_path),
             lower(replace(trim(data_path), char(92), '/'))
      FROM short_videos WHERE trim(data_path) <> ''
      UNION ALL
      SELECT 'short_video_assets', id, video_id, 'local_path', trim(local_path),
             lower(replace(trim(local_path), char(92), '/'))
      FROM short_video_assets WHERE trim(local_path) <> ''
    )
    SELECT COUNT(*) AS count FROM (
      SELECT * FROM (
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
        EXCEPT
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key
        FROM short_video_path_references
      )
      UNION ALL
      SELECT * FROM (
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key
        FROM short_video_path_references
        EXCEPT
        SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key FROM expected
      )
    )
  `).get()?.count || 0);
}

function rebuildShortVideoReferenceProjection(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM short_video_path_references");
    db.prepare(`
      INSERT INTO short_video_path_references(
        owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
        real_path_key, identity_key, root_group_key, probe_state, updated_at
      )
      WITH expected AS (
        SELECT 'short_videos' owner_table, id owner_key, id owner_video_id,
               'source_path' path_column, trim(source_path) raw_path,
               lower(replace(trim(source_path), char(92), '/')) path_key
        FROM short_videos WHERE trim(source_path) <> ''
        UNION ALL
        SELECT 'short_videos', id, id, 'cover_path', trim(cover_path),
               lower(replace(trim(cover_path), char(92), '/'))
        FROM short_videos WHERE trim(cover_path) <> ''
        UNION ALL
        SELECT 'short_videos', id, id, 'music_path', trim(music_path),
               lower(replace(trim(music_path), char(92), '/'))
        FROM short_videos WHERE trim(music_path) <> ''
        UNION ALL
        SELECT 'short_videos', id, id, 'data_path', trim(data_path),
               lower(replace(trim(data_path), char(92), '/'))
        FROM short_videos WHERE trim(data_path) <> ''
        UNION ALL
        SELECT 'short_video_assets', id, video_id, 'local_path', trim(local_path),
               lower(replace(trim(local_path), char(92), '/'))
        FROM short_video_assets WHERE trim(local_path) <> ''
      )
      SELECT owner_table, owner_key, owner_video_id, path_column, raw_path, path_key,
             '', '', '', 'unverified', ?
      FROM expected
    `).run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function assertShortVideoReferenceProjection(db) {
  const mismatch = shortVideoReferenceProjectionMismatchCount(db);
  if (mismatch) throw new Error(`短视频路径引用投影对账失败：${mismatch} 条差异`);
}

function hashDownloadRecord(record) {
  return crypto.createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (JSON.isRawJSON(value)) return value.rawJSON;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("download record 包含非有限数值");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new Error(`download record 包含无法序列化的值：${typeof value}`);
}

function parseJsonLossless(text) {
  return JSON.parse(text, (_key, value, context) => {
    const source = String(context?.source || "");
    if (typeof value === "number"
        && Number.isInteger(value)
        && !Number.isSafeInteger(value)
        && /^-?(?:0|[1-9]\d*)$/u.test(source)) {
      return JSON.rawJSON(source);
    }
    return value;
  });
}

function jsonScalarText(value) {
  if (JSON.isRawJSON(value)) return value.rawJSON;
  return value === null || value === undefined ? "" : String(value);
}

async function* rawLines(file) {
  let carry = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    while (true) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline < 0) break;
      yield buffer.subarray(start, newline + 1);
      start = newline + 1;
    }
    carry = start < buffer.length ? Buffer.from(buffer.subarray(start)) : Buffer.alloc(0);
  }
  if (carry.length) yield carry;
}

function splitLineEnding(line) {
  let end = line.length;
  if (end && line[end - 1] === 0x0a) end -= 1;
  if (end && line[end - 1] === 0x0d) end -= 1;
  return { body: line.subarray(0, end), ending: line.subarray(end) };
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function finishWriteStream(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("finish", onFinish);
      stream.off("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });
}

function checkpoint(db, mode) {
  const rows = db.prepare(`PRAGMA wal_checkpoint(${mode})`).all();
  if (mode === "TRUNCATE") {
    const busy = rows.reduce((total, row) => total + Number(row.busy || 0), 0);
    if (busy) throw new Error(`SQLite WAL TRUNCATE checkpoint 仍 busy=${busy}`);
  }
  return rows;
}

function samePath(left, right) {
  try {
    return path.resolve(String(left || "")).toLowerCase() === path.resolve(right).toLowerCase();
  } catch {
    return false;
  }
}

function normalizedPathKey(value) {
  const normalized = path.resolve(String(value || "")).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertFile(file, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} 不存在：${file}`);
  }
  if (!stat.isFile()) throw new Error(`${label} 不是文件：${file}`);
}

function assertSafeSegment(value, label) {
  if (!value || value === "." || value === ".." || /[\\/:*?"<>|\u0000-\u001f]/u.test(value)
      || /[ .]$/u.test(value)) {
    throw new Error(`${label}不是安全的 Windows 单级目录名：${JSON.stringify(value)}`);
  }
}

function foldPathSegment(value) {
  return String(value).toLowerCase();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

function uniqueSibling(directory, name) {
  const parsed = path.parse(name);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index}` : "";
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`无法分配临时文件名：${directory}`);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function printManifestSummary(result, apply) {
  console.log(
    `manifest: ${result.lines} 行，${result.validRecords} 条有效记录，`
      + `${result.badLines} 条坏行原样${apply ? "保留" : "可保留"}，`
      + `${result.recordsChanged} 条记录需改写`,
  );
}

function printDatabaseSummary(result) {
  console.log(
    `${result.kind}: 扫描 ${result.rowsScanned} 行，`
      + `${result.rowsChanged} 行 / ${result.valuesChanged} 个值${result.kind === "fanhao" && result.projectionChecked ? "；投影对账通过" : ""}`,
  );
  for (const table of result.tables) {
    if (table.skipped) console.log(`  ${table.table}: 跳过（${table.skipped}）`);
    else if (table.rowsChanged) console.log(`  ${table.table}: ${table.rowsChanged} 行`);
  }
  if (result.manifestOffsetsCleared) {
    console.log(`  download_records: 另清空 ${result.manifestOffsetsCleared} 个旧 manifest offset`);
  }
  if (result.projectionBaselineMismatches) {
    console.log(
      `  path projection: 迁移前 ${result.projectionBaselineMismatches} 条差异`
        + `${result.projectionRebuilt ? "，已按 owner 表重建" : "，apply 时将按 owner 表重建"}`,
    );
  }
  if (result.tombstoneAliases?.matched) {
    console.log(
      `  active path tombstones: 命中 ${result.tombstoneAliases.matched}，`
        + `${result.tombstoneAliases.inserted || result.tombstoneAliases.planned} 个新路径别名`
        + `，${result.tombstoneAliases.alreadyPresent} 个已存在`,
    );
  }
}

function parseArgs(values) {
  const parsed = {};
  const flags = new Set(["apply", "offline-confirmed", "help"]);
  const options = new Set([
    "mapping",
    "root",
    "manifest",
    "manager-db",
    "fanhao-db",
    "batch-size",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2);
    if (flags.has(key)) {
      parsed[key] = true;
      continue;
    }
    if (!options.has(key)) throw new Error(`无法识别参数：--${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node tools/migrate_short_video_author_metadata.mjs --mapping <json> [options]

默认只读预检。写入必须同时提供：--apply --offline-confirmed

Options:
  --mapping <json>       { oldName: sec_uid } 或含 mappings[] 的审计报告（必填）
  --root <path>          媒体根目录，默认 D:\\Media\\ShortVideos
  --manifest <path>      manifest 路径
  --manager-db <path>    下载管理器 SQLite
  --fanhao-db <path>     FanHao short-videos.sqlite
  --batch-size <number>  每次 SQLite 小事务的最大行数，默认 500
  --apply                执行写入
  --offline-confirmed    确认 FanHao/下载器已离线
  --help                 显示帮助`);
}
