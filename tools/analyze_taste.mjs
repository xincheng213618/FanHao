import fs from "node:fs";
import path from "node:path";
import { analyzeTasteDatabase } from "../src/modules/fanhao/server/taste/source.js";

const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--db") || !value("--db") || args.some((arg) => arg.startsWith("--") && !["--db", "--output"].includes(arg))) {
  throw new Error("用法：node tools/analyze_taste.mjs --db <馆藏数据库> [--output <JSON 文件>]");
}
const profile = analyzeTasteDatabase(path.resolve(value("--db")));
if (args.includes("--output")) {
  if (!value("--output") || value("--output").startsWith("--")) throw new Error("请指定输出 JSON 文件");
  fs.writeFileSync(path.resolve(value("--output")), `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx" });
}
console.log(JSON.stringify({ summary: profile.summary, dimensions: profile.dimensions.map((dimension) => ({
  key: dimension.key, known: dimension.known, markedKnown: dimension.markedKnown,
  distinctive: dimension.distinctive.slice(0, 6).map(({ name, total, marked, lift, adjustedLift }) => ({ name, total, marked, lift, adjustedLift })),
  favorites: dimension.favorites.slice(0, 6).map(({ name, total, marked }) => ({ name, total, marked }))
})) }, null, 2));
