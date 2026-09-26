import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAndroidCacheVersion, syncAndroidCacheVersion } from "./android-cache-version.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check") || args.length > 1) {
  throw new Error("Usage: node scripts/sync-cache-version.mjs [--check]");
}
const wwwDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../www");
const check = args.includes("--check");
const plan = check ? assertAndroidCacheVersion(wwwDir) : syncAndroidCacheVersion(wwwDir);
console.log(`android-cache: ${plan.version}, ${plan.sourceCount} source files, ${check ? "verified" : `${plan.changes.length} files synchronized`}`);
