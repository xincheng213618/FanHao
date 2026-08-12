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
assert.match(source, /Mode "drip"[\s\S]*ElapsedMilliseconds -ge 4500[\s\S]*ElapsedMilliseconds -lt 6500/);
assert.match(source, /Remove-Item -LiteralPath \$resolvedFixtureRoot -Recurse -Force/);
assert.doesNotMatch(source, /29998|8765/);
console.log("fanhao-startup-gate-structure: ok");

const candidates = process.platform === "win32"
  ? ["powershell.exe", "pwsh.exe"]
  : ["pwsh"];

async function runPowerShell(executable) {
  return await new Promise((resolve, reject) => {
    let settled = false;
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
      if (settled) return;
      settled = true;
      reject(new Error(`required PowerShell runtime ${executable} could not start: ${error.message}`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`${executable} startup verifier failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

if (process.platform === "win32") {
  await assert.rejects(
    runPowerShell("fanhao-required-powershell-runtime-missing.exe"),
    /required PowerShell runtime .* could not start/
  );
}

let runtimes = 0;
for (const executable of candidates) {
  await runPowerShell(executable);
  runtimes += 1;
}
assert.equal(runtimes, process.platform === "win32" ? 2 : 1, "every required PowerShell runtime must execute the startup behavior gate");
console.log(`fanhao-startup-runtimes: ${runtimes} passed`);
