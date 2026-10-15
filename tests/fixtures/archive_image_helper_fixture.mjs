import fs from "node:fs";
import path from "node:path";

const [command, archivePath, memberPath, cachePath] = process.argv.slice(2);
const counterPath = `${archivePath}.${command}.count`;
fs.appendFileSync(counterPath, "1\n");
await new Promise((resolve) => setTimeout(resolve, 120));

if (command === "list") {
  process.stdout.write(JSON.stringify({
    ok: true,
    imageCount: 1,
    images: [{ path: "cover.jpg", name: "cover.jpg", bytes: 7 }]
  }));
} else if (command === "extract") {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${memberPath}:${path.basename(archivePath)}`);
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: `unsupported fixture command: ${command}` }));
  process.exitCode = 2;
}
