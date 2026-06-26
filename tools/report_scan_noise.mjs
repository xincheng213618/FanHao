import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INDEX_PATH = path.join(PROJECT_ROOT, "data", "library-index.json");
const DEFAULT_PATTERNS = [
  "sample",
  "trailer",
  "preview",
  "teaser",
  "予告",
  "サンプル",
  "样片",
  "樣片",
  "预览",
  "預覽"
];

const options = parseArgs(process.argv.slice(2));
const indexPath = path.resolve(options.index || DEFAULT_INDEX_PATH);
const minBytes = Math.max(0, Number(options["min-video-mb"] || 50) || 0) * 1024 * 1024;
const limit = positiveInteger(options.limit) ?? 20;
const jsonOutput = Boolean(options.json);
const patterns = collectPatterns(options.pattern).map((pattern) => new RegExp(pattern, "i"));

const index = readJson(indexPath);
const rows = collectVideoRows(index);
const smallVideos = minBytes > 0 ? rows.filter((row) => row.video.size > 0 && row.video.size < minBytes) : [];
const nameMatches = patterns.length ? rows.filter((row) => matchesAnyPattern(row, patterns)) : [];
const likelyNoise = rows.filter((row) => {
  const small = minBytes > 0 && row.video.size > 0 && row.video.size < minBytes;
  const matched = patterns.length && matchesAnyPattern(row, patterns);
  return small && matched;
});

const report = {
  indexPath,
  minVideoMb: Math.round((minBytes / 1024 / 1024) * 100) / 100,
  patterns: patterns.map((pattern) => pattern.source),
  totals: {
    works: Array.isArray(index.works) ? index.works.length : 0,
    videos: rows.length,
    smallVideos: smallVideos.length,
    nameMatches: nameMatches.length,
    likelyNoise: likelyNoise.length
  },
  samples: {
    likelyNoise: sampleRows(likelyNoise, limit),
    smallVideos: sampleRows(smallVideos, limit),
    nameMatches: sampleRows(nameMatches, limit)
  }
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "json") {
      result[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = "";
      continue;
    }
    if (result[key] === undefined) {
      result[key] = value;
    } else if (Array.isArray(result[key])) {
      result[key].push(value);
    } else {
      result[key] = [result[key], value];
    }
    index += 1;
  }
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`读取 JSON 失败: ${filePath}\n${error.message}`);
  }
}

function collectPatterns(value) {
  const raw = value === undefined ? DEFAULT_PATTERNS : Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => String(item || "").split(/[,\n]/))
    .map((item) => item.trim())
    .filter(Boolean)
    .map(escapeLoosePattern);
}

function escapeLoosePattern(value) {
  if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
    return value.slice(1, value.lastIndexOf("/"));
  }
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectVideoRows(index) {
  const rows = [];
  for (const work of index.works || []) {
    for (const video of work.videos || []) {
      rows.push({ work, video });
    }
  }
  return rows;
}

function matchesAnyPattern(row, patterns) {
  const text = videoNameText(row.video);
  return patterns.some((pattern) => pattern.test(text));
}

function videoNameText(video) {
  const relativeName = video.relativePath ? path.basename(video.relativePath) : "";
  return [
    video.name,
    video.title,
    relativeName
  ].filter(Boolean).join("\n");
}

function sampleRows(rows, limit) {
  return rows.slice(0, Math.max(0, limit)).map((row) => ({
    workId: row.work.id,
    title: row.work.title || row.work.directoryName || "",
    videoId: row.video.id,
    name: row.video.name,
    size: row.video.size || 0,
    sizeMb: Math.round(((row.video.size || 0) / 1024 / 1024) * 10) / 10,
    relativePath: row.video.relativePath || ""
  }));
}

function positiveInteger(value) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function printReport(report) {
  console.log(`library-index: ${report.indexPath}`);
  console.log(`min-video-mb: ${report.minVideoMb}`);
  console.log(`patterns: ${report.patterns.join(", ") || "(none)"}`);
  console.log("");
  console.log(`works: ${report.totals.works}`);
  console.log(`videos: ${report.totals.videos}`);
  console.log(`small videos: ${report.totals.smallVideos}`);
  console.log(`name matches: ${report.totals.nameMatches}`);
  console.log(`likely noise: ${report.totals.likelyNoise}`);
  console.log("");

  if (!report.totals.likelyNoise) {
    console.log("No obvious scan noise found. Review small/name-match samples before adding any scanner exclusion.");
  } else {
    printSample("Likely noise", report.samples.likelyNoise);
  }
  printSample("Small video samples", report.samples.smallVideos);
  printSample("Name match samples", report.samples.nameMatches);
}

function printSample(title, rows) {
  if (!rows.length) return;
  console.log("");
  console.log(`${title}:`);
  for (const row of rows) {
    console.log(`- ${row.sizeMb} MB | ${row.title} | ${row.name}`);
    console.log(`  ${row.relativePath}`);
  }
}
