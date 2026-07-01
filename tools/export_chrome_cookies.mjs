import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const DEFAULT_DOMAIN = "douban.com";
const DEFAULT_OUTPUT = path.join(DATA_DIR, "douban-cookie.txt");
const CHROME_USER_DATA_DIR = path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");

function parseArgs(argv) {
  const options = {
    domain: DEFAULT_DOMAIN,
    output: DEFAULT_OUTPUT,
    userDataDir: CHROME_USER_DATA_DIR,
    profile: "Default",
    profilePath: "",
    includeExpired: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--domain") options.domain = String(argv[++index] || DEFAULT_DOMAIN).trim();
    else if (arg === "--output") options.output = String(argv[++index] || DEFAULT_OUTPUT).trim();
    else if (arg === "--user-data-dir") options.userDataDir = String(argv[++index] || CHROME_USER_DATA_DIR).trim();
    else if (arg === "--profile") options.profile = String(argv[++index] || "Default").trim();
    else if (arg === "--profile-path") options.profilePath = String(argv[++index] || "").trim();
    else if (arg === "--include-expired") options.includeExpired = true;
  }
  options.domain = options.domain.replace(/^\.+/, "").toLowerCase();
  return options;
}

function resolveRepoPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.resolve(REPO_ROOT, text);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function chromeEpochToUnixMs(value) {
  const number = Number(value || 0);
  if (!number) return 0;
  return Math.floor(number / 1000 - 11644473600000);
}

function unprotectDpapiBase64(base64Value) {
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($env:CHROME_DPAPI_BLOB)
if ($bytes.Length -gt 5) {
  $prefix = [Text.Encoding]::ASCII.GetString($bytes, 0, 5)
  if ($prefix -eq 'DPAPI') {
    $next = New-Object byte[] ($bytes.Length - 5)
    [Array]::Copy($bytes, 5, $next, 0, $next.Length)
    $bytes = $next
  }
}
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
`.trim();
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, CHROME_DPAPI_BLOB: base64Value },
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`DPAPI 解密失败：${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  return Buffer.from(String(result.stdout || "").trim(), "base64");
}

function chromeMasterKey(userDataDir) {
  const localState = readJson(path.join(userDataDir, "Local State"));
  const encryptedKey = localState?.os_crypt?.encrypted_key;
  if (!encryptedKey) throw new Error("Chrome Local State 中没有 os_crypt.encrypted_key");
  return unprotectDpapiBase64(encryptedKey);
}

function decryptChromeCookie(encryptedValue, masterKey) {
  const encrypted = Buffer.from(encryptedValue || []);
  if (!encrypted.length) return "";
  const version = encrypted.subarray(0, 3).toString("utf8");
  if (version === "v10" || version === "v11" || version === "v20") {
    const nonce = encrypted.subarray(3, 15);
    const tag = encrypted.subarray(encrypted.length - 16);
    const ciphertext = encrypted.subarray(15, encrypted.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
  return unprotectDpapiBase64(encrypted.toString("base64")).toString("utf8");
}

function cookieDbPath(profilePath) {
  const candidates = [path.join(profilePath, "Network", "Cookies"), path.join(profilePath, "Cookies")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`没有找到 Chrome Cookies 数据库：${profilePath}`);
  return found;
}

function copyCookieDb(sourcePath) {
  const targetPath = path.join(os.tmpdir(), `fanhao-chrome-cookies-${process.pid}-${Date.now()}.sqlite`);
  try {
    fs.copyFileSync(sourcePath, targetPath);
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "EPERM") {
      throw new Error(`Chrome Cookie 数据库正在被占用，请先关闭 Chrome 后重试：${sourcePath}`);
    }
    throw error;
  }
  return targetPath;
}

function hostMatchesDomain(host, domain) {
  const normalized = String(host || "").replace(/^\./, "").toLowerCase();
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

function exportCookies(options) {
  const profilePath = options.profilePath ? resolveRepoPath(options.profilePath) : path.join(resolveRepoPath(options.userDataDir), options.profile);
  const userDataDir = options.profilePath ? path.dirname(profilePath) : resolveRepoPath(options.userDataDir);
  if (!fs.existsSync(profilePath)) throw new Error(`Chrome profile 不存在：${profilePath}`);
  const key = chromeMasterKey(userDataDir);
  const dbCopy = copyCookieDb(cookieDbPath(profilePath));
  const rows = [];
  try {
    const db = new DatabaseSync(dbCopy, { readOnly: true });
    const query = db.prepare("SELECT host_key, name, value, encrypted_value, expires_utc FROM cookies");
    for (const row of query.all()) {
      if (!hostMatchesDomain(row.host_key, options.domain)) continue;
      const expiresMs = chromeEpochToUnixMs(row.expires_utc);
      if (!options.includeExpired && expiresMs && expiresMs < Date.now()) continue;
      const value = row.value || decryptChromeCookie(row.encrypted_value, key);
      if (!row.name || !value) continue;
      rows.push({ host: row.host_key, name: row.name, value });
    }
    db.close();
  } finally {
    fs.rmSync(dbCopy, { force: true });
  }

  const seen = new Set();
  const parts = [];
  for (const row of rows.sort((a, b) => String(a.host).localeCompare(String(b.host)) || String(a.name).localeCompare(String(b.name)))) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    parts.push(`${row.name}=${row.value}`);
  }
  if (!parts.length) throw new Error(`没有导出 ${options.domain} 的有效 Chrome Cookie`);

  const outputPath = resolveRepoPath(options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, parts.join("; "), "utf8");
  return { outputPath, count: parts.length, profilePath };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = exportCookies(options);
  console.log(`已导出 ${result.count} 个 ${options.domain} Cookie`);
  console.log(`输出文件：${result.outputPath}`);
  console.log(`Chrome Profile：${result.profilePath}`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
