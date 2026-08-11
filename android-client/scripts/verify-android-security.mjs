import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(projectDir, "..");
const javaSourceDir = path.join(
  projectDir,
  "android",
  "app",
  "src",
  "main",
  "java",
  "local",
  "fanhao",
  "library"
);

const config = JSON.parse(read("capacitor.config.json"));
assert.equal(
  config.server?.androidScheme,
  "http",
  "the packaged WebView origin must stay on HTTP until Web Storage and IndexedDB data have an explicit origin migration"
);
assert.equal(config.server?.cleartext, true, "LAN API fetches currently require cleartext support");
assert.equal(config.android?.allowMixedContent, true, "trusted LAN API and media access currently requires mixed-content support");
assert(
  !Object.prototype.hasOwnProperty.call(config.server || {}, "allowNavigation"),
  "production WebView navigation must not grant remote pages access to the Capacitor bridge"
);
const generatedConfigPath = path.join(projectDir, "android", "app", "src", "main", "assets", "capacitor.config.json");
if (fs.existsSync(generatedConfigPath)) {
  const generatedConfig = JSON.parse(fs.readFileSync(generatedConfigPath, "utf8"));
  assert.equal(generatedConfig.server?.androidScheme, "http", "run Capacitor sync before packaging: generated scheme is stale");
  assert(
    !Object.prototype.hasOwnProperty.call(generatedConfig.server || {}, "allowNavigation"),
    "run Capacitor sync before packaging: generated navigation rules are stale"
  );
}

const manifest = read("android/app/src/main/AndroidManifest.xml");
const nativeShortVideoActivity = manifest.match(
  /<activity\b(?=[^>]*android:name="\.NativeShortVideoActivity")[^>]*\/>/s
)?.[0];
assert(nativeShortVideoActivity, "NativeShortVideoActivity manifest entry is missing");
assert(
  /android:exported="false"/.test(nativeShortVideoActivity),
  "NativeShortVideoActivity must not be callable by other apps"
);

const updater = read("android/app/src/main/java/local/fanhao/library/FanHaoUpdaterPlugin.java");
assert(updater.includes("AndroidUpdatePolicy.requireTrustedDownloadUrl(rawUrl, rawServiceBase)"), "updater must enforce trusted update URLs");
assert(updater.includes('call.getString("serviceBase")'), "updater must require the explicit active service base");
assert(updater.includes("AndroidUpdatePolicy.requireSha256"), "updater must require a valid SHA-256");
assert(updater.includes("connection.setInstanceFollowRedirects(false)"), "updater must not follow unchecked redirects");
assert(!updater.includes("normalizeSha256"), "updater must not normalize an invalid SHA-256 to an empty optional value");
assert(!updater.includes("!expectedSha256.isEmpty()"), "SHA-256 verification must never be optional");

const mainActivity = read("android/app/src/main/java/local/fanhao/library/MainActivity.java");
assert(mainActivity.includes("if (!isSupportedWebDownloadUri(uri))"), "WebView downloads must be validated before enqueueing");
assert(mainActivity.includes('"http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)'), "WebView downloads must reject non-HTTP schemes");
assert(mainActivity.includes("uri.getUserInfo() == null"), "WebView downloads must reject credential-bearing hosts");

const webApp = read("www/app.js");
assert(webApp.includes("serviceBase: activeUrl"), "the WebView updater call must bind downloads to the active service origin");

const androidIndex = read("www/index.html");
assert(
  !androidIndex.toLowerCase().includes("xc213618.ddns.me"),
  "the Android server picker must not advertise an unsupported public DDNS endpoint"
);

const androidGuide = readRepo("docs/android-client.md");
assert(
  androidGuide.includes("当前 Android 客户端仅支持本机、局域网或可信私网服务"),
  "the Android guide must state the trusted-network support boundary"
);
assert(
  androidGuide.includes("不要通过手工复制浏览器 / App Cookie"),
  "the Android guide must not present copied cookies as a supported remote login flow"
);
assert(
  androidGuide.includes("HTTPS 与正式的配对 / bearer token 流程"),
  "the Android guide must reserve remote access for an authenticated HTTPS pairing flow"
);

const androidReadme = read("README.md");
assert(
  androidReadme.includes("Android 客户端目前没有可用的远程登录或配对通道"),
  "the Android README must not imply that remote access currently works"
);

const configurationGuide = readRepo("docs/configuration.md");
assert(
  configurationGuide.includes("在可信代理机制实现并验证前，禁止把 29998 放到 loopback / LAN 反向代理后再对公网暴露"),
  "the configuration guide must explicitly forbid unsafe public reverse proxying"
);
assert(
  configurationGuide.includes("公网请求会被误判为 `local` / `lan` 并绕过远程登录"),
  "the reverse-proxy warning must explain the authentication bypass"
);

verifyJavaPolicy();
console.log("android-security: origin compatibility, trusted-network boundary, native bridge, and update policy verified");

function read(relativePath) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoDir, relativePath), "utf8");
}

function verifyJavaPolicy() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-android-security-"));
  try {
    const javac = javaTool("javac");
    const java = javaTool("java");
    run(javac, [
      "-encoding",
      "UTF-8",
      "-d",
      tempDir,
      path.join(javaSourceDir, "AndroidUpdatePolicy.java"),
      path.join(projectDir, "scripts", "AndroidUpdatePolicyVerifier.java")
    ]);
    run(java, ["-cp", tempDir, "local.fanhao.library.AndroidUpdatePolicyVerifier"]);
  } finally {
    removeVerifiedTempDir(tempDir);
  }
}

function removeVerifiedTempDir(tempDir) {
  if (!fs.existsSync(tempDir)) return;
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const target = fs.realpathSync.native(tempDir);
  const normalizeForComparison = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedRoot = normalizeForComparison(tempRoot);
  const normalizedTarget = normalizeForComparison(target);
  assert.notEqual(normalizedTarget, normalizedRoot, "refusing to remove the temp root");
  assert(
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`),
    `refusing to remove a directory outside the temp root: ${target}`
  );
  fs.rmSync(target, { recursive: true, force: true });
}

function javaTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", executable) : "",
    process.platform === "win32" ? path.join("C:\\Program Files\\Android\\openjdk\\jdk-21.0.8", "bin", executable) : "",
    executable
  ].filter(Boolean);
  return candidates.find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate)) || executable;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectDir, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed with exit code ${result.status}`);
}
