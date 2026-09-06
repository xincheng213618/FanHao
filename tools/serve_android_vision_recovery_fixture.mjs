import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";

// No application server, real sessions, camera, persistent storage or device access.
const root = path.resolve(import.meta.dirname, "..");
const files = new Map([
  ["/preview", ["tools/fixtures/android-vision-recovery-preview.html", "text/html"]],
  ["/", ["tools/fixtures/android-vision-recovery-browser.html", "text/html"]],
  ["/tool-views.js", ["android-client/www/modules/tools/tool-views.js", "text/javascript"]],
  ["/tools.css", ["android-client/www/modules/tools/styles.css", "text/css"]],
  ["/base.css", ["android-client/www/css/base.css", "text/css"]]
]);
const server = createServer((request, response) => {
  const entry = files.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (request.method !== "GET" || !entry) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", `${entry[1]}; charset=utf-8`);
  response.setHeader("Cache-Control", "no-store");
  fs.createReadStream(path.join(root, entry[0])).pipe(response);
});
server.listen(0, "127.0.0.1", () => console.log(`Vision recovery fixture: http://127.0.0.1:${server.address().port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
