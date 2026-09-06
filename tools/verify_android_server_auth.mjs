import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { installServerAuthentication, loginToServer } from "../android-client/www/js/server-auth.js";

const nativeSessions = new Map();
globalThis.Capacitor = { Plugins: { FanHaoAuth: {
  async getSession({ serverUrl }) { return { token: nativeSessions.get(serverUrl) || "" }; },
  async login({ serverUrl, password }) {
    if (password !== "fixture-password") throw new Error("bad password");
    nativeSessions.set(serverUrl, "fixture-token");
    return { token: "fixture-token" };
  }
} } };
let currentServer = "http://app.example:29998";
const calls = [];
const host = { async fetch(input, options) { calls.push({ input, options }); return { ok: true }; } };
installServerAuthentication(() => currentServer, host);
await host.fetch(currentServer + "/api/auth/status");
assert.equal(calls.at(-1).options.headers, undefined, "unsigned requests must remain unsigned");
await assert.rejects(loginToServer(currentServer, "wrong"), /bad password/);
await loginToServer(currentServer, "fixture-password");
await host.fetch(currentServer + "/api/state", { method: "POST", body: "{}", headers: { "X-Test": "kept" } });
assert.equal(calls.at(-1).options.headers.get("Authorization"), "Bearer fixture-token");

currentServer = "http://pending.example";
globalThis.Capacitor.Plugins.FanHaoAuth.getSession = () => new Promise(() => {});
const abort = new AbortController();
const pendingRequest = host.fetch(currentServer + "/api/auth/status", { signal: abort.signal });
abort.abort();
await assert.rejects(pendingRequest, { name: "AbortError" }, "native session lookup must remain cancellable");
assert.equal(calls.at(-1).options.headers.get("X-Test"), "kept");
assert.equal(calls.at(-1).options.body, "{}");
assert.equal(calls.at(-1).options.redirect, "error", "credentialed requests must reject redirects");
for (const target of ["https://app.example:29998", "http://app.example:30000", "http://attacker.example"]) {
  await host.fetch(target + "/media/image");
  assert.equal(calls.at(-1).options.headers, undefined, "another origin must never receive the token");
}
currentServer = "http://new.example";
await loginToServer(currentServer, "fixture-password");
await host.fetch(currentServer + "/api/auth/status");
assert.equal(calls.at(-1).options.headers.get("Authorization"), "Bearer fixture-token");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-server-auth-"));
try {
  const compile = spawnSync("javac", [
    "--release", "8", "-d", root,
    "android-client/android/app/src/main/java/local/fanhao/library/ServerAuthSession.java",
    "android-client/android/app/src/main/java/local/fanhao/library/AuthenticatedResponseHeaders.java",
    "tools/fixtures/ServerAuthSessionHarness.java",
    "tools/fixtures/AuthenticatedResponseHeadersHarness.java"
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  for (const harness of ["ServerAuthSessionHarness", "AuthenticatedResponseHeadersHarness"]) {
    const run = spawnSync("java", ["-cp", root, `local.fanhao.library.${harness}`], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    console.log(run.stdout.trim());
  }
} finally {
  // Only the unique fixture created above, never application data.
  if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true });
}

const authenticatedWebViewClient = fs.readFileSync(
  new URL("../android-client/android/app/src/main/java/local/fanhao/library/AuthenticatedWebViewClient.java", import.meta.url),
  "utf8"
);
assert.match(
  authenticatedWebViewClient,
  /String token = sessions\.token\(address\);[\s\S]*setRequestProperty\("Authorization", "Bearer " \+ token\)/,
  "authenticated WebView media requests must send the matching native bearer session"
);
assert.match(
  authenticatedWebViewClient,
  /String encoding = responseCharacterEncoding\(contentType\);[\s\S]*new WebResourceResponse\(mime, encoding, status,/,
  "authenticated WebView responses must derive a character encoding from Content-Type"
);
assert.doesNotMatch(
  authenticatedWebViewClient,
  /new WebResourceResponse\(mime,\s*"UTF-8"/,
  "binary media responses must not be decoded as UTF-8"
);
assert.match(
  authenticatedWebViewClient,
  /Map<String, List<String>> sourceHeaders = connection\.getHeaderFields\(\);[\s\S]*AuthenticatedResponseHeaders\.from\(sourceHeaders\)/,
  "authenticated media responses must canonicalize singleton and hop-by-hop headers"
);
assert.match(
  authenticatedWebViewClient,
  /String contentType = AuthenticatedResponseHeaders\.contentType\(sourceHeaders\);/,
  "authenticated media responses must canonicalize Content-Type before constructing WebResourceResponse"
);
assert.doesNotMatch(
  authenticatedWebViewClient,
  /String contentType = connection\.getContentType\(\);/,
  "authenticated media responses must not reuse URLConnection's comma-joined Content-Type"
);
assert.doesNotMatch(
  authenticatedWebViewClient,
  /String\.join\(\s*", ",\s*header\.getValue\(\)\s*\)/,
  "authenticated media responses must not join conflicting Content-Length values"
);
console.log("android-server-auth: ok (explicit login, origin isolation, request preservation, redirects)");
