import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const verifier = path.join(root, "tools", "verify_fanhao_startup.ps1");
assert.equal(fs.existsSync(verifier), true, "missing isolated FanHao startup verifier");
const source = fs.readFileSync(verifier, "utf8").replaceAll("\r\n", "\n");
assert.match(source, /Get-DynamicPort/);
assert.match(source, /FANHAO_STARTUP_FIXTURE_MODE/);
assert.match(source, /Remove-Item -LiteralPath \$resolvedFixtureRoot -Recurse -Force/);
assert.doesNotMatch(source, /29998|8765/);
console.log("fanhao-startup-gate-structure: ok");

const candidates = process.platform === "win32"
  ? ["powershell.exe", "pwsh.exe"]
  : ["pwsh"];

async function runPowerShell(executable) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", verifier,
      "-ProjectRoot", root
    ], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", (error) => {
      if (error.code === "ENOENT") resolve(false);
      else reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(true);
      else reject(new Error(`${executable} startup verifier failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

let runtimes = 0;
for (const executable of candidates) {
  if (await runPowerShell(executable)) runtimes += 1;
}
assert.ok(runtimes > 0, "no supported PowerShell runtime was found");
console.log(`fanhao-startup-runtimes: ${runtimes} passed`);
