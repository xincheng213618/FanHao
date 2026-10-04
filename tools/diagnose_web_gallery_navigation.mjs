import { runGalleryReaderFixture } from "./verify_web_gallery_requests.mjs";

// --legacy uses the same browser/response fixture with HEAD's two reader files.
// --case=<name> limits a diagnostic reproduction without weakening the gate.
await runGalleryReaderFixture({
  timings: true,
  legacy: process.argv.includes("--legacy"),
  legacyHost: process.argv.includes("--legacy-host"),
  casePattern: process.argv.find(value => value.startsWith("--case="))?.slice(7) || ""
});
