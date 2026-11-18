import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const legacyGamesDir = path.join(projectDir, "www", "games");

// The account form is shared by Web and Android; do not hand-edit its app copy.
const accountTarget = path.join(projectDir, "www", "platform", "accounts");
fs.mkdirSync(accountTarget, { recursive: true });
for (const file of ["account-ui.js", "account.css"]) {
  fs.copyFileSync(path.join(projectDir, "..", "public", "platform", "accounts", file), path.join(accountTarget, file));
}

// Older builds generated this folder before Capacitor copied the WebView assets.
const legacyGames = fs.lstatSync(legacyGamesDir, { throwIfNoEntry: false });
if (legacyGames) {
  if (!legacyGames.isDirectory() || fs.realpathSync(legacyGamesDir) !== legacyGamesDir) {
    throw new Error(`Unexpected generated asset path: ${legacyGamesDir}`);
  }
  fs.rmSync(legacyGamesDir, { recursive: true });
}

console.log("shared-assets: account form synchronized");
