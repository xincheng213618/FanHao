import { parseArgs, run } from "./backfill_douban_tv_metadata.mjs";

if (import.meta.main) {
  const result = await run({ ...parseArgs(process.argv.slice(2)), kind: "movie" });
  if (result.blocked) process.exitCode = 2;
}
