#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_LOCAL_DB = path.join(REPO_ROOT, "data", "short-videos.sqlite");
const DEFAULT_MANAGER_DB = path.resolve(
  REPO_ROOT,
  "..",
  "Tool",
  "douyin-download-manager",
  "data",
  "douyin_downloads.sqlite"
);
const DEFAULT_MIN_PREFIX_LENGTH = 48;

const USER_COLUMNS = [
  "id",
  "platform",
  "sec_uid",
  "uid",
  "nickname",
  "avatar_url",
  "signature",
  "follower_count",
  "following_count",
  "raw_json",
  "created_at",
  "updated_at",
  "profile_url",
  "unique_id",
  "short_id",
  "ip_location",
  "total_favorited",
  "aweme_count",
  "favoriting_count",
  "gender",
  "age",
  "verification",
  "profile_collected_at"
];

function printHelp() {
  console.log(`Usage:
  node tools/cleanup_short_video_author_aliases.mjs [options]

Options:
  --apply                    Apply repairs. Without this flag the script is read-only.
  --author <text>            Only inspect aliases matching an author name or sec_uid.
  --local-db <path>          FanHao short-video database.
  --manager-db <path>        Douyin download-manager database.
  --min-prefix-length <n>    Minimum trusted sec_uid prefix length (default: 48).
  --no-backup                Skip the safety backup (only for disposable test copies).
  --json                     Print the complete report as JSON.
  --help                     Show this help.

The script only accepts an alias when its sec_uid is a strict prefix of exactly
one complete sec_uid in download-manager profiles. It reassigns referenced videos,
merges follow state, and deletes the now-unreferenced alias user. It never deletes
video records.`);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    author: "",
    json: false,
    backup: true,
    localDb: process.env.FANHAO_SHORT_VIDEO_DB || DEFAULT_LOCAL_DB,
    managerDb: process.env.DOUYIN_DOWNLOAD_MANAGER_DB || DEFAULT_MANAGER_DB,
    minPrefixLength: DEFAULT_MIN_PREFIX_LENGTH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-backup") options.backup = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--author") options.author = requireValue(argv, ++index, arg);
    else if (arg === "--local-db") options.localDb = requireValue(argv, ++index, arg);
    else if (arg === "--manager-db") options.managerDb = requireValue(argv, ++index, arg);
    else if (arg === "--min-prefix-length") {
      options.minPrefixLength = Number(requireValue(argv, ++index, arg));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.minPrefixLength) || options.minPrefixLength < 24) {
    throw new Error("--min-prefix-length must be an integer greater than or equal to 24");
  }
  options.localDb = path.resolve(options.localDb);
  options.managerDb = path.resolve(options.managerDb);
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function assertDatabase(dbPath, label) {
  if (!fs.existsSync(dbPath)) throw new Error(`${label} does not exist: ${dbPath}`);
  if (!fs.statSync(dbPath).isFile()) throw new Error(`${label} is not a file: ${dbPath}`);
}

function text(value) {
  return String(value || "").trim();
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function profileScore(profile) {
  const populated = [
    profile.uid,
    profile.nickname,
    profile.avatar_url,
    profile.unique_id,
    profile.short_id,
    profile.signature,
    profile.profile_raw_json
  ].filter((value) => text(value)).length;
  const timestamp = Date.parse(profile.profile_collected_at || profile.updated_at || "");
  return populated * 1_000_000 + (Number.isFinite(timestamp) ? timestamp : 0);
}

function loadCanonicalProfiles(managerDb) {
  const rows = managerDb.prepare(`
    SELECT id, url, title, created_at, updated_at, sec_uid, uid, nickname,
           avatar_url, unique_id, short_id, signature, ip_location,
           following_count, follower_count, total_favorited, aweme_count,
           favoriting_count, gender, age, verification, profile_raw_json,
           profile_collected_at
    FROM profiles
    WHERE COALESCE(sec_uid, '') <> ''
  `).all();
  const bySecUid = new Map();
  for (const row of rows) {
    const secUid = text(row.sec_uid);
    const current = bySecUid.get(secUid);
    if (!current || profileScore(row) > profileScore(current)) bySecUid.set(secUid, row);
  }
  return [...bySecUid.values()];
}

function buildUniquePrefixMap(profiles, minPrefixLength) {
  const prefixMap = new Map();
  for (const profile of profiles) {
    const secUid = text(profile.sec_uid);
    for (let length = minPrefixLength; length < secUid.length; length += 1) {
      const prefix = secUid.slice(0, length);
      let matches = prefixMap.get(prefix);
      if (!matches) {
        matches = new Map();
        prefixMap.set(prefix, matches);
      }
      matches.set(secUid, profile);
    }
  }
  return prefixMap;
}

function collectAnalysis(localDb, managerDb, options) {
  const users = localDb.prepare(`SELECT ${USER_COLUMNS.join(", ")} FROM short_video_users`).all();
  const profiles = loadCanonicalProfiles(managerDb);
  const prefixMap = buildUniquePrefixMap(profiles, options.minPrefixLength);
  const localUserBySecUid = new Map(users.map((user) => [text(user.sec_uid), user]));
  const countVideos = localDb.prepare(`
    SELECT COUNT(*) AS count
    FROM short_videos
    WHERE author_sec_uid = ? OR owner_user_id = ?
  `);
  const countFollows = localDb.prepare(`
    SELECT COUNT(*) AS count FROM short_video_follows WHERE target_user_id = ?
  `);
  const filter = options.author.toLocaleLowerCase();
  const aliases = [];

  for (const alias of users) {
    const aliasSecUid = text(alias.sec_uid);
    if (aliasSecUid.length < options.minPrefixLength) continue;
    const matches = prefixMap.get(aliasSecUid);
    if (!matches || matches.size !== 1) continue;
    const profile = [...matches.values()][0];
    const canonicalSecUid = text(profile.sec_uid);
    if (!canonicalSecUid || canonicalSecUid === aliasSecUid) continue;
    const canonicalUser = localUserBySecUid.get(canonicalSecUid) || null;
    const searchable = [aliasSecUid, alias.nickname, canonicalSecUid, profile.nickname]
      .map((value) => text(value).toLocaleLowerCase())
      .join("\n");
    if (filter && !searchable.includes(filter)) continue;
    const videoCount = Number(countVideos.get(aliasSecUid, alias.id)?.count || 0);
    const followCount = Number(countFollows.get(alias.id)?.count || 0);
    aliases.push({
      alias,
      profile,
      canonicalUser,
      targetUserId: canonicalUser?.id || `douyin:${canonicalSecUid}`,
      videoCount,
      followCount
    });
  }

  aliases.sort((left, right) =>
    right.videoCount - left.videoCount
      || text(left.alias.nickname).localeCompare(text(right.alias.nickname), "zh-CN")
  );

  return {
    aliases,
    summary: {
      aliases: aliases.length,
      aliasesWithVideos: aliases.filter((item) => item.videoCount > 0).length,
      videosToReassign: aliases.reduce((total, item) => total + item.videoCount, 0),
      followRowsToMerge: aliases.reduce((total, item) => total + item.followCount, 0),
      canonicalUsersToCreate: aliases.filter((item) => !item.canonicalUser).length
    }
  };
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function canonicalUserValues(item, now) {
  const { alias, canonicalUser, profile, targetUserId } = item;
  const existing = canonicalUser || {};
  const secUid = text(profile.sec_uid);
  return {
    id: targetUserId,
    platform: text(existing.platform) || "douyin",
    sec_uid: secUid,
    uid: text(profile.uid) || text(existing.uid) || text(alias.uid),
    nickname: text(profile.nickname) || text(existing.nickname) || text(alias.nickname) || "未知作者",
    avatar_url: text(profile.avatar_url) || text(existing.avatar_url) || text(alias.avatar_url),
    signature: text(profile.signature) || text(existing.signature) || text(alias.signature),
    follower_count: numericOrNull(profile.follower_count) ?? numericOrNull(existing.follower_count),
    following_count: numericOrNull(profile.following_count) ?? numericOrNull(existing.following_count),
    raw_json: text(profile.profile_raw_json) || text(existing.raw_json) || text(alias.raw_json) || "{}",
    created_at: text(existing.created_at) || text(profile.created_at) || text(alias.created_at) || now,
    updated_at: now,
    profile_url: text(profile.url) || text(existing.profile_url) || `https://www.douyin.com/user/${secUid}`,
    unique_id: text(profile.unique_id) || text(existing.unique_id),
    short_id: text(profile.short_id) || text(existing.short_id),
    ip_location: text(profile.ip_location) || text(existing.ip_location),
    total_favorited: numericOrNull(profile.total_favorited) ?? numericOrNull(existing.total_favorited),
    aweme_count: numericOrNull(profile.aweme_count) ?? numericOrNull(existing.aweme_count),
    favoriting_count: numericOrNull(profile.favoriting_count) ?? numericOrNull(existing.favoriting_count),
    gender: numericOrNull(profile.gender) ?? numericOrNull(existing.gender),
    age: numericOrNull(profile.age) ?? numericOrNull(existing.age),
    verification: text(profile.verification) || text(existing.verification),
    profile_collected_at: text(profile.profile_collected_at) || text(existing.profile_collected_at)
  };
}

function createStatements(db) {
  const placeholders = USER_COLUMNS.map(() => "?").join(", ");
  return {
    upsertUser: db.prepare(`
      INSERT INTO short_video_users (${USER_COLUMNS.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        sec_uid = excluded.sec_uid,
        uid = excluded.uid,
        nickname = excluded.nickname,
        avatar_url = excluded.avatar_url,
        signature = excluded.signature,
        follower_count = COALESCE(excluded.follower_count, short_video_users.follower_count),
        following_count = COALESCE(excluded.following_count, short_video_users.following_count),
        raw_json = CASE WHEN excluded.raw_json <> '{}' THEN excluded.raw_json ELSE short_video_users.raw_json END,
        updated_at = excluded.updated_at,
        profile_url = excluded.profile_url,
        unique_id = excluded.unique_id,
        short_id = excluded.short_id,
        ip_location = excluded.ip_location,
        total_favorited = COALESCE(excluded.total_favorited, short_video_users.total_favorited),
        aweme_count = COALESCE(excluded.aweme_count, short_video_users.aweme_count),
        favoriting_count = COALESCE(excluded.favoriting_count, short_video_users.favoriting_count),
        gender = COALESCE(excluded.gender, short_video_users.gender),
        age = COALESCE(excluded.age, short_video_users.age),
        verification = excluded.verification,
        profile_collected_at = excluded.profile_collected_at
    `),
    updateVideos: db.prepare(`
      UPDATE short_videos
      SET owner_user_id = ?,
          author_sec_uid = ?,
          author_uid = CASE WHEN ? <> '' THEN ? ELSE author_uid END,
          author_name = CASE WHEN ? <> '' THEN ? ELSE author_name END,
          author_avatar_url = CASE WHEN ? <> '' THEN ? ELSE author_avatar_url END,
          updated_at = ?
      WHERE author_sec_uid = ? OR owner_user_id = ?
    `),
    copyFollows: db.prepare(`
      INSERT INTO short_video_follows (
        local_user_id, target_user_id, active, followed_at, updated_at
      )
      SELECT local_user_id, ?, active, followed_at, ?
      FROM short_video_follows
      WHERE target_user_id = ?
      ON CONFLICT(local_user_id, target_user_id) DO UPDATE SET
        active = MAX(short_video_follows.active, excluded.active),
        followed_at = CASE
          WHEN short_video_follows.followed_at = '' THEN excluded.followed_at
          ELSE short_video_follows.followed_at
        END,
        updated_at = excluded.updated_at
    `),
    deleteAliasFollows: db.prepare(`DELETE FROM short_video_follows WHERE target_user_id = ?`),
    deleteAliasUser: db.prepare(`
      DELETE FROM short_video_users
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM short_videos WHERE owner_user_id = ?)
        AND NOT EXISTS (SELECT 1 FROM short_videos WHERE author_sec_uid = ?)
        AND NOT EXISTS (SELECT 1 FROM short_video_follows WHERE target_user_id = ?)
    `)
  };
}

async function applyAnalysis(options, analysis) {
  const backupDir = path.join(path.dirname(options.localDb), "backups");
  const db = new DatabaseSync(options.localDb);
  db.exec("PRAGMA busy_timeout = 10000");
  let backupPath = "";
  if (options.backup) {
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(
      backupDir,
      `short-videos-before-author-alias-cleanup-${timestampForFile()}.sqlite`
    );
    await backup(db, backupPath);
  }
  const statements = createStatements(db);
  const now = new Date().toISOString();
  const result = {
    backupPath,
    aliasesProcessed: 0,
    videosReassigned: 0,
    followRowsDeleted: 0,
    aliasUsersDeleted: 0
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of analysis.aliases) {
      const canonical = canonicalUserValues(item, now);
      statements.upsertUser.run(...USER_COLUMNS.map((column) => canonical[column] ?? null));
      result.videosReassigned += Number(statements.updateVideos.run(
        canonical.id,
        canonical.sec_uid,
        canonical.uid,
        canonical.uid,
        canonical.nickname,
        canonical.nickname,
        canonical.avatar_url,
        canonical.avatar_url,
        now,
        item.alias.sec_uid,
        item.alias.id
      ).changes || 0);
      statements.copyFollows.run(canonical.id, now, item.alias.id);
      result.followRowsDeleted += Number(statements.deleteAliasFollows.run(item.alias.id).changes || 0);
      result.aliasUsersDeleted += Number(statements.deleteAliasUser.run(
        item.alias.id,
        item.alias.id,
        item.alias.sec_uid,
        item.alias.id
      ).changes || 0);
      result.aliasesProcessed += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  db.close();
  return result;
}

function publicAlias(item) {
  return {
    aliasSecUid: item.alias.sec_uid,
    aliasName: item.alias.nickname,
    canonicalSecUid: item.profile.sec_uid,
    canonicalName: item.profile.nickname,
    videoCount: item.videoCount,
    followCount: item.followCount,
    createsCanonicalUser: !item.canonicalUser
  };
}

function printHumanReport(options, analysis, applied) {
  console.log(options.apply ? "Short-video author alias cleanup" : "Short-video author alias check (dry run)");
  console.log(`Local DB:   ${options.localDb}`);
  console.log(`Manager DB: ${options.managerDb}`);
  console.log(`Trusted prefix length: ${options.minPrefixLength}+`);
  if (options.author) console.log(`Author filter: ${options.author}`);
  console.log("");
  console.log(`Aliases:                  ${analysis.summary.aliases}`);
  console.log(`Aliases with videos:      ${analysis.summary.aliasesWithVideos}`);
  console.log(`Videos to reassign:       ${analysis.summary.videosToReassign}`);
  console.log(`Follow rows to merge:     ${analysis.summary.followRowsToMerge}`);
  console.log(`Canonical users to create:${String(analysis.summary.canonicalUsersToCreate).padStart(7)}`);

  const visible = analysis.aliases.slice(0, 25);
  if (visible.length) {
    console.log("\nSample:");
    for (const item of visible) {
      console.log(`- ${item.alias.nickname} (${item.videoCount} videos)`);
      console.log(`  ${item.alias.sec_uid}`);
      console.log(`  -> ${item.profile.sec_uid} [${item.profile.nickname || "未知作者"}]`);
    }
    if (analysis.aliases.length > visible.length) {
      console.log(`  ... ${analysis.aliases.length - visible.length} more aliases`);
    }
  }

  if (applied) {
    console.log("\nApplied:");
    console.log(`- Backup: ${applied.backupPath || "skipped by --no-backup"}`);
    console.log(`- Aliases processed: ${applied.aliasesProcessed}`);
    console.log(`- Videos reassigned: ${applied.videosReassigned}`);
    console.log(`- Alias users deleted: ${applied.aliasUsersDeleted}`);
  } else if (analysis.aliases.length) {
    console.log("\nNo data was changed. Re-run with --apply after reviewing this report.");
  } else {
    console.log("\nNo trusted truncated aliases were found.");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  assertDatabase(options.localDb, "FanHao database");
  assertDatabase(options.managerDb, "Download-manager database");
  if (path.resolve(options.localDb) === path.resolve(options.managerDb)) {
    throw new Error("Local and manager database paths must be different");
  }

  const localDb = new DatabaseSync(options.localDb, { readOnly: true });
  const managerDb = new DatabaseSync(options.managerDb, { readOnly: true });
  let analysis;
  try {
    if (options.apply) {
      const integrity = localDb.prepare("PRAGMA quick_check(1)").get();
      const status = text(integrity?.quick_check);
      if (status !== "ok") {
        throw new Error(
          `FanHao database integrity check failed; repair the database before bulk cleanup. ${status}`
        );
      }
    }
    analysis = collectAnalysis(localDb, managerDb, options);
  } finally {
    localDb.close();
    managerDb.close();
  }
  const applied = options.apply && analysis.aliases.length
    ? await applyAnalysis(options, analysis)
    : null;

  if (options.json) {
    console.log(JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      localDb: options.localDb,
      managerDb: options.managerDb,
      minPrefixLength: options.minPrefixLength,
      summary: analysis.summary,
      aliases: analysis.aliases.map(publicAlias),
      applied
    }, null, 2));
  } else {
    printHumanReport(options, analysis, applied);
  }
}

try {
  await main();
} catch (error) {
  console.error(`Author alias cleanup failed: ${error?.message || error}`);
  process.exitCode = 1;
}
