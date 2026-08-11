import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerConfig } from "../src/bootstrap/server-config.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { createAuthServices } from "../src/platform/server/auth.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-auth-policy-"));

try {
  const authSecretPath = path.join(tempRoot, "auth-secret.txt");
  const legacyAuthSecret = "auth-policy-test-secret-0123456789abcdef";
  fs.writeFileSync(authSecretPath, legacyAuthSecret, "utf8");
  const auth = authServices("configured-test-password");
  const publicUrl = new URL("http://public.example/api/auth/status");

  const cases = [
    {
      name: "remote client cannot become local by spoofing Host",
      request: fakeRequest({ remoteAddress: "203.0.113.10", host: "127.0.0.1:29998" }),
      mode: "remote",
      allowed: false
    },
    {
      name: "remote client cannot become LAN by spoofing Host",
      request: fakeRequest({ remoteAddress: "203.0.113.10", host: "192.168.1.20:29998" }),
      mode: "remote",
      allowed: false
    },
    {
      name: "untrusted X-Forwarded-For cannot spoof localhost",
      request: fakeRequest({ remoteAddress: "203.0.113.10", headers: { "x-forwarded-for": "127.0.0.1" } }),
      mode: "remote",
      allowed: false
    },
    {
      name: "remote Android marker is only a client hint",
      request: fakeRequest({ remoteAddress: "203.0.113.10", headers: androidHeaders() }),
      mode: "remote",
      allowed: false
    },
    {
      name: "remote Android query marker is only a client hint",
      request: fakeRequest({ remoteAddress: "203.0.113.10", headers: { "user-agent": androidHeaders()["user-agent"] } }),
      url: new URL("http://public.example/api/auth/status?client=android"),
      mode: "remote",
      allowed: false
    },
    {
      name: "LAN client keeps LAN mode but public Host does not receive trusted bypass",
      request: fakeRequest({ remoteAddress: "192.168.1.50", host: "public.example" }),
      mode: "lan",
      allowed: false
    },
    {
      name: "local client keeps local mode but public Host does not receive trusted bypass",
      request: fakeRequest({ remoteAddress: "::ffff:127.0.0.1", host: "public.example" }),
      mode: "local",
      allowed: false
    },
    {
      name: "local client with a local Host stays trusted",
      request: fakeRequest({ remoteAddress: "::ffff:127.0.0.1", host: "127.0.0.1:29998" }),
      mode: "local",
      allowed: true
    }
  ];

  for (const testCase of cases) {
    const state = auth.requestAuthState(testCase.request, testCase.url || publicUrl);
    assert.equal(state.access.mode, testCase.mode, `${testCase.name}: access mode`);
    assert.equal(state.allowed, testCase.allowed, `${testCase.name}: allowed`);
  }

  const remoteSpoof = fakeRequest({ remoteAddress: "203.0.113.10", host: "127.0.0.1:29998" });
  const remoteAccess = auth.requestAccess(remoteSpoof);
  assert.equal(auth.isTrustedNetworkAccess(remoteAccess), false);
  assert.equal(auth.isSameTrustedNetworkOrigin(remoteSpoof, remoteAccess), false);

  const lanAppRequest = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: androidHeaders()
  });
  const lanAppState = auth.requestAuthState(lanAppRequest, publicUrl);
  assert.equal(lanAppState.reason, "app");

  const legacyAppPayload = `app.${Math.floor(Date.now() / 1000)}.legacy`;
  const legacyAppSignature = crypto.createHmac("sha256", legacyAuthSecret).update(legacyAppPayload).digest("base64url");
  const remoteWithLegacyAppCookie = auth.requestAuthState(fakeRequest({
    remoteAddress: "203.0.113.10",
    headers: { ...androidHeaders(), cookie: `fanhao_app_auth=${legacyAppPayload}.${legacyAppSignature}` }
  }), publicUrl);
  assert.equal(remoteWithLegacyAppCookie.allowed, false, "legacy app cookies must stop authorizing remote requests immediately");

  const lanSameOrigin = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: { origin: "http://192.168.1.20:29998" }
  });
  assert.equal(auth.isSameTrustedNetworkOrigin(lanSameOrigin), true);
  const lanCrossOrigin = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: { origin: "https://untrusted.example" }
  });
  assert.equal(auth.isSameTrustedNetworkOrigin(lanCrossOrigin), false);
  const lanRebindingOrigin = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "attacker.example",
    headers: { origin: "https://attacker.example" }
  });
  assert.equal(
    auth.isSameTrustedNetworkOrigin(lanRebindingOrigin),
    false,
    "a matching public Host and Origin must not turn a LAN socket into a privileged same-origin request"
  );
  const lanPublicHostWithoutOrigin = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "attacker.example"
  });
  assert.equal(
    auth.isSameTrustedNetworkOrigin(lanPublicHostWithoutOrigin),
    false,
    "originless privileged requests must still target a trusted local or LAN Host"
  );
  const capacitorLanRequest = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: { origin: "https://localhost", "x-fanhao-client": "android" }
  });
  assert.equal(auth.isSameTrustedNetworkOrigin(capacitorLanRequest), true, "the trusted Capacitor origin must keep LAN mutations working");

  assert.equal(auth.requestAccess(fakeRequest({ remoteAddress: "fe90::1234", host: "[fe90::1234]:29998" })).mode, "lan", "the full IPv6 fe80::/10 link-local range must be trusted");
  assert.equal(auth.requestAccess(fakeRequest({ remoteAddress: "febf::1234", host: "[febf::1234]:29998" })).mode, "lan");
  assert.equal(auth.requestAccess(fakeRequest({ remoteAddress: "fec0::1234", host: "[fec0::1234]:29998" })).mode, "remote", "deprecated site-local IPv6 must not be mistaken for link-local");

  const capacitorCorsRequest = fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    method: "OPTIONS",
    headers: {
      origin: "http://localhost",
      "access-control-request-headers": "content-type,x-fanhao-client",
      "access-control-request-method": "PATCH"
    }
  });
  assert.equal(auth.requestCorsOrigin(capacitorCorsRequest), "http://localhost", "the packaged Android origin must retain LAN API access");
  assert.equal(auth.requestCorsOrigin(fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: { origin: "capacitor://localhost" }
  })), "capacitor://localhost", "the native Capacitor origin must remain explicitly allowlisted");
  assert.equal(auth.requestCorsOrigin(fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: { origin: "https://attacker.example" }
  })), "", "arbitrary web origins must not read the password-free LAN API");
  assert.equal(auth.requestCorsOrigin(fakeRequest({
    remoteAddress: "203.0.113.10",
    host: "192.168.1.20:29998",
    headers: { origin: "http://localhost" }
  })), "", "a remote client must not gain Android CORS access by spoofing localhost Origin");

  const corsHandler = createRequestHandler({
    requestCorsOrigin: auth.requestCorsOrigin,
    requestAuthState: auth.requestAuthState,
    attachAccessAnalytics() {},
    attachAccessLogger() {},
    routeAuth: async () => false,
    sendLoginRequired() {},
    routeApi: async () => false,
    routeMedia: async () => false,
    renderAndroidUpdatePage: () => "",
    serveStatic() {},
    sendHtml() {},
    sendJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    sendText() {}
  });
  const allowedPreflightResponse = fakeResponse();
  await corsHandler(capacitorCorsRequest, allowedPreflightResponse);
  assert.equal(allowedPreflightResponse.status, 204);
  assert.equal(allowedPreflightResponse.headers.get("access-control-allow-origin"), "http://localhost");
  assert.match(allowedPreflightResponse.headers.get("access-control-allow-methods"), /(?:^|,)PATCH(?:,|$)/, "Android collection rename preflights must allow PATCH");
  assert.equal(allowedPreflightResponse.headers.get("vary"), "Origin");
  const rejectedPreflightResponse = fakeResponse();
  await corsHandler(fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    method: "OPTIONS",
    headers: { origin: "https://attacker.example" }
  }), rejectedPreflightResponse);
  assert.equal(rejectedPreflightResponse.status, 403, "disallowed browser preflights must fail closed");
  assert.equal(rejectedPreflightResponse.headers.has("access-control-allow-origin"), false);
  const rejectedSimpleResponse = fakeResponse();
  await corsHandler(fakeRequest({
    remoteAddress: "192.168.1.50",
    host: "192.168.1.20:29998",
    headers: { origin: "https://attacker.example" }
  }), rejectedSimpleResponse);
  assert.equal(rejectedSimpleResponse.status, 403, "disallowed simple cross-origin reads must fail before routing");

  const blankPasswordAuth = authServices("");
  const blankLoginResponse = fakeResponse();
  await blankPasswordAuth.routeAuth(
    fakeRequest({ remoteAddress: "203.0.113.10", method: "POST", headers: { accept: "application/json" } }),
    blankLoginResponse,
    new URL("http://public.example/auth/login"),
    { allowed: false, required: true }
  );
  assert.equal(blankLoginResponse.status, 401, "an empty configured password must not accept an empty login");

  let currentTime = 1_800_000_000_000;
  let submittedPassword = "wrong";
  const limitedAuth = authServices("configured-test-password", {
    now: () => currentTime,
    password: () => submittedPassword
  });
  const limitedClient = { remoteAddress: "203.0.113.20", headers: { accept: "application/json" } };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await login(limitedAuth, limitedClient);
    assert.equal(response.status, 401, `failed login ${attempt} should remain unauthorized`);
  }
  const blockedResponse = await login(limitedAuth, limitedClient);
  assert.equal(blockedResponse.status, 429, "the fifth failed login should start the block");
  assert.equal(blockedResponse.headers.get("retry-after"), "900");
  const isolatedResponse = await login(limitedAuth, { ...limitedClient, remoteAddress: "203.0.113.21" });
  assert.equal(isolatedResponse.status, 401, "login limits should be isolated by TCP client address");
  currentTime += 15 * 60 * 1000 + 1;
  const expiredResponse = await login(limitedAuth, limitedClient);
  assert.equal(expiredResponse.status, 401, "an expired block should accept a new attempt");

  currentTime += 20 * 60 * 1000;
  const spoofedClient = { remoteAddress: "203.0.113.30", headers: { accept: "application/json" } };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await login(limitedAuth, {
      ...spoofedClient,
      headers: { ...spoofedClient.headers, "x-forwarded-for": `198.51.100.${attempt}` }
    });
    assert.equal(response.status, attempt === 5 ? 429 : 401, "X-Forwarded-For must not select the login bucket");
  }

  currentTime += 20 * 60 * 1000;
  const clearedClient = { remoteAddress: "203.0.113.40", headers: { accept: "application/json" } };
  for (let attempt = 1; attempt <= 4; attempt += 1) await login(limitedAuth, clearedClient);
  submittedPassword = "configured-test-password";
  assert.equal((await login(limitedAuth, clearedClient)).status, 200, "a successful login should clear failures");
  submittedPassword = "wrong";
  assert.equal((await login(limitedAuth, clearedClient)).status, 401, "a cleared client should start a fresh failure window");

  const originalPasswordAuth = authServices("original-password", { password: "original-password" });
  const originalLogin = await login(originalPasswordAuth, { remoteAddress: "203.0.113.50", headers: { accept: "application/json" } });
  assert.equal(originalLogin.status, 200);
  const webCookie = String(originalLogin.headers.get("set-cookie") || "").split(";", 1)[0];
  assert.match(webCookie, /^fanhao_web_auth=/);
  const authenticatedWithCurrentPassword = originalPasswordAuth.requestAuthState(fakeRequest({
    remoteAddress: "203.0.113.50",
    headers: { cookie: webCookie }
  }), publicUrl);
  assert.equal(authenticatedWithCurrentPassword.allowed, true);
  assert.equal(authenticatedWithCurrentPassword.reason, "password");

  const changedPasswordAuth = authServices("changed-password");
  const authenticatedAfterPasswordChange = changedPasswordAuth.requestAuthState(fakeRequest({
    remoteAddress: "203.0.113.50",
    headers: { cookie: webCookie }
  }), publicUrl);
  assert.equal(authenticatedAfterPasswordChange.allowed, false, "changing the configured password must revoke existing web sessions");

  const revertedPasswordAuth = authServices("original-password");
  const authenticatedAfterPasswordReuse = revertedPasswordAuth.requestAuthState(fakeRequest({
    remoteAddress: "203.0.113.50",
    headers: { cookie: webCookie }
  }), publicUrl);
  assert.equal(authenticatedAfterPasswordReuse.allowed, false, "reusing an older password must not revive sessions issued for its previous auth epoch");

  const eagerEpochA = authServices("eager-epoch-a", { password: "eager-epoch-a" });
  const eagerEpochLogin = await login(eagerEpochA, { remoteAddress: "203.0.113.52", headers: { accept: "application/json" } });
  const eagerEpochCookie = String(eagerEpochLogin.headers.get("set-cookie") || "").split(";", 1)[0];
  authServices("eager-epoch-b");
  const eagerEpochAReused = authServices("eager-epoch-a");
  const eagerEpochReuseState = eagerEpochAReused.requestAuthState(fakeRequest({
    remoteAddress: "203.0.113.52",
    headers: { cookie: eagerEpochCookie }
  }), publicUrl);
  assert.equal(eagerEpochReuseState.allowed, false, "an intermediate password epoch with no requests must still permanently revoke older sessions");

  const legacyWebPayload = `web.${Math.floor(Date.now() / 1000)}.legacy`;
  const legacyWebSignature = crypto.createHmac("sha256", legacyAuthSecret).update(legacyWebPayload).digest("base64url");
  const legacyWebState = auth.requestAuthState(fakeRequest({
    remoteAddress: "203.0.113.51",
    headers: { cookie: `fanhao_web_auth=${legacyWebPayload}.${legacyWebSignature}` }
  }), publicUrl);
  assert.equal(legacyWebState.allowed, false, "legacy web sessions issued before credential binding must be revoked");

  const config = createServerConfig({
    env: {},
    homeDirectory: tempRoot,
    projectRoot: tempRoot,
    spawn: () => ({ status: 1, stdout: "", stderr: "" })
  });
  assert.equal(config.REMOTE_WEB_PASSWORD, "", "the repository must not ship a remote login password");
  const persistedAuthRecord = JSON.parse(fs.readFileSync(authSecretPath, "utf8"));
  assert.equal(persistedAuthRecord.version, 2, "auth secrets must persist a credential-bound epoch record");
  assert.equal(typeof persistedAuthRecord.webPasswordBinding, "string");

  console.log(`auth-policy: ok (${cases.length} trust cases + legacy-cookie revocation, origin, password and login-limit checks)`);
} finally {
  const resolvedTempRoot = path.resolve(tempRoot);
  if (resolvedTempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
}

function authServices(remoteWebPassword, options = {}) {
  return createAuthServices({
    authSecretPath: path.join(tempRoot, "auth-secret.txt"),
    remoteWebPassword,
    ensureDataDir: () => fs.mkdirSync(tempRoot, { recursive: true }),
    readBodyText: async () => JSON.stringify({
      password: typeof options.password === "function" ? options.password() : options.password || ""
    }),
    sendJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    sendHtml: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
    redirect: (res, target, status = 302, headers = {}) => {
      res.status = status;
      res.target = target;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    },
    now: options.now
  });
}

async function login(auth, options = {}) {
  const response = fakeResponse();
  await auth.routeAuth(
    fakeRequest({
      remoteAddress: options.remoteAddress,
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers }
    }),
    response,
    new URL("http://public.example/auth/login"),
    { allowed: false, required: true }
  );
  return response;
}

function fakeRequest({ remoteAddress, host = "public.example", method = "GET", headers = {}, url = "/api/auth/status" }) {
  return {
    method,
    url,
    headers: { host, ...headers },
    socket: { remoteAddress, encrypted: false }
  };
}

function fakeResponse() {
  return {
    headers: new Map(),
    status: 0,
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return this.headers.get(String(name).toLowerCase());
    },
    writeHead(status) {
      this.status = status;
    },
    end() {
      this.ended = true;
    }
  };
}

function androidHeaders() {
  return {
    "user-agent": "Mozilla/5.0 (Linux; Android 15; wv) Version/4.0 FanHaoAndroidApp/1.0",
    "x-fanhao-client": "android"
  };
}
