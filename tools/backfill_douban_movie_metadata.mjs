process.argv.splice(2, 0, "--kind", "movie");
await import("./backfill_douban_tv_metadata.mjs");
