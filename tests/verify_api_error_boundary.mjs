import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";

import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { shortVideoPublicError } from "../src/modules/short-videos/server/public-errors.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { readJsonBody, RequestBodyError } from "../src/platform/server/request-io.js";
import { sendJson, sendText } from "../src/platform/server/responses.js";

assert.deepEqual(await readJsonBody(requestWithBody("")), {}, "an empty JSON body must preserve the existing empty-object contract");
await assert.rejects(
  readJsonBody(requestWithBody("{")),
  (error) => error instanceof RequestBodyError
    && error.name === "RequestBodyError"
    && error.code === "INVALID_JSON_BODY"
    && error.statusCode === 400,
  "malformed JSON must reject with a typed 400 error"
);
await assert.rejects(
  readJsonBody(requestWithBody('"汉汉"'), 4),
  (error) => error instanceof RequestBodyError
    && error.code === "REQUEST_BODY_TOO_LARGE"
    && error.statusCode === 413,
  "the request limit must count UTF-8 bytes and reject with a typed 413 error"
);

const malformed = await invokeShortVideoDelete('{"deleteFiles":');
assert.equal(malformed.response.status, 400, "malformed DELETE JSON must return 400");
assert.equal(malformed.response.payload.error, "JSON 格式无效");
assert.equal(malformed.storeCalls, 0, "malformed DELETE JSON must fail before calling the store");

const oversizedBody = JSON.stringify({ padding: "x".repeat((1024 * 1024) + 1) });
const oversized = await invokeShortVideoDelete(oversizedBody);
assert.equal(oversized.response.status, 413, "oversized DELETE JSON must return 413");
assert.equal(oversized.response.payload.error, "请求体太大");
assert.equal(oversized.storeCalls, 0, "oversized DELETE JSON must fail before calling the store");

const empty = await invokeShortVideoDelete("");
assert.equal(empty.response.status, 200, "an empty DELETE body must remain valid");
assert.equal(empty.storeCalls, 1, "an empty DELETE body must retain the existing delete call");
assert.deepEqual(empty.deleteOptions, { deleteFiles: true }, "an empty DELETE body must retain the default file-deletion option");

const missingJob = Object.assign(new Error("短视频删除作业不存在"), {
  statusCode: 404,
  code: "SHORT_VIDEO_DELETE_JOB_NOT_FOUND",
  expose: true
});
const missingJobResult = await invokeShortVideoDeleteJobStatus(missingJob);
assert.deepEqual(missingJobResult, {
  status: 404,
  payload: { error: "短视频删除作业不存在", code: "SHORT_VIDEO_DELETE_JOB_NOT_FOUND" }
}, "the exact missing delete job must expose its controlled 404 code");

const ordinary404 = Object.assign(new Error("普通资源不存在"), {
  statusCode: 404,
  code: "SHORT_VIDEO_INTERNAL_NOT_FOUND",
  expose: true
});
assert.deepEqual(await invokeShortVideoDeleteJobStatus(ordinary404), {
  status: 404,
  payload: { error: "普通资源不存在" }
}, "an ordinary 404 must not expose an unapproved internal code");

const privateJob500 = Object.assign(new Error("private delete failure at C:\\secret\\delete.bin"), {
  statusCode: 500,
  code: "SHORT_VIDEO_DELETE_JOB_NOT_FOUND"
});
const privateJob500Result = await captureConsoleErrors(() => invokeShortVideoDeleteJobStatus(privateJob500));
assert.deepEqual(privateJob500Result.value, {
  status: 500,
  payload: { error: "短视频删除恢复状态读取失败" }
}, "a 5xx must not expose an internal message or even a whitelisted 4xx code");

const manualRecoveryError = Object.assign(new Error("private guard failure"), {
  statusCode: 500,
  publicBody: {
    pending: true,
    recoveryRequired: true,
    retryable: false,
    manualInterventionRequired: true,
    processRestartRequired: false,
    status: "rollback_pending",
    jobId: "manual-job",
    code: "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING"
  }
});
const manualRecoveryResult = await captureConsoleErrors(() => invokeShortVideoDelete("{}", { storeError: manualRecoveryError }));
assert.deepEqual(manualRecoveryResult.value.response.payload, {
  error: "短视频删除失败",
  ok: false,
  accepted: false,
  pending: true,
  recoveryRequired: true,
  retryable: false,
  manualInterventionRequired: true,
  processRestartRequired: false,
  status: "rollback_pending",
  jobId: "manual-job",
  code: "SHORT_VIDEO_DELETE_GUARD_MODE_MISSING"
}, "manual delete recovery state must survive the route public-error boundary");

const restartRecoveryError = Object.assign(new Error("private same-process fence"), {
  statusCode: 500,
  publicBody: {
    pending: true,
    recoveryRequired: true,
    retryable: true,
    manualInterventionRequired: false,
    processRestartRequired: true,
    status: "rollback_pending",
    jobId: "restart-job",
    code: "SHORT_VIDEO_DELETE_RECOVERY_REQUIRED"
  }
});
const restartRecoveryResult = await captureConsoleErrors(() => invokeShortVideoDelete("{}", { storeError: restartRecoveryError }));
assert.equal(restartRecoveryResult.value.response.payload.processRestartRequired, true);
assert.equal(restartRecoveryResult.value.response.payload.manualInterventionRequired, true, "restart-required recovery must imply manual intervention");
assert.equal(restartRecoveryResult.value.response.payload.retryable, false, "manual recovery must never remain retryable");

const secretStoreError = new Error("delete failed at C:\\secret\\videos\\catalog.bin");
const secretStoreResult = await captureConsoleErrors(() => invokeShortVideoDelete("{}", { storeError: secretStoreError }));
assert.deepEqual(secretStoreResult.value.response, {
  status: 500,
  payload: { error: "短视频删除失败" }
}, "an unknown store failure must return only the route fallback");
assert.doesNotMatch(JSON.stringify(secretStoreResult.value.response), /secret|catalog\.bin/i, "a store failure must not disclose its local path");
assert.equal(secretStoreResult.logs[0]?.[1], secretStoreError, "the local route boundary must log the original store failure");

const sqliteStoreError = new Error("database disk image is malformed at C:\\secret\\catalog.sqlite");
const sqliteStoreResult = await captureConsoleErrors(() => invokeShortVideoDelete("{}", { storeError: sqliteStoreError }));
assert.deepEqual(sqliteStoreResult.value.response, {
  status: 503,
  payload: { error: "短视频数据库正在恢复，请稍后重试" }
}, "a database failure must use the fixed recovery response");
assert.doesNotMatch(JSON.stringify(sqliteStoreResult.value.response), /secret|catalog\.sqlite/i, "the database recovery response must not disclose its local path");
assert.equal(sqliteStoreResult.logs[0]?.[1], sqliteStoreError, "the local route boundary must log the original database failure");

const private503 = Object.assign(new Error("upstream failed at C:\\secret\\manager.sqlite"), { statusCode: 503 });
assert.deepEqual(
  shortVideoPublicError(private503, "采集服务不可用", { defaultStatus: 502 }),
  { status: 503, message: "短视频数据库正在恢复，请稍后重试", log: true },
  "a SQLite-flavored 503 must use the fixed database recovery message"
);
const privateService503 = Object.assign(new Error("upstream failed at C:\\secret\\manager.bin"), { statusCode: 503 });
assert.deepEqual(
  shortVideoPublicError(privateService503, "采集服务不可用", { defaultStatus: 502 }),
  { status: 503, message: "采集服务不可用", log: true },
  "a generic 503 must retain its status but use the route fallback"
);
const exposed500 = Object.assign(new Error("可安全公开的服务状态"), { statusCode: 500, expose: true });
assert.deepEqual(
  shortVideoPublicError(exposed500, "服务失败"),
  { status: 500, message: "可安全公开的服务状态", log: true },
  "an explicitly exposed safe server error may retain its message"
);

const publicError = new RequestBodyError("JSON 格式无效", {
  code: "INVALID_JSON_BODY",
  statusCode: 400
});
const publicResult = await invokeRequestHandler({
  routeApi: async () => { throw publicError; }
});
assert.deepEqual(publicResult.response, {
  status: 400,
  payload: { error: "JSON 格式无效" }
}, "a public 4xx error must retain its safe client message");

const secretPath = "C:\\secret\\catalog.sqlite";
const internalError = new Error(`SQLite open failed: ${secretPath}`);
const internalResult = await invokeRequestHandler({
  routeApi: async () => { throw internalError; }
});
assert.deepEqual(internalResult.response, {
  status: 500,
  payload: { error: "Internal server error" }
}, "unknown failures must have a fixed safe response");
assert.doesNotMatch(JSON.stringify(internalResult.response), /secret|catalog\.sqlite/i, "the 500 response must not disclose internal paths");
assert.equal(internalResult.logs.length, 1, "the detailed internal failure must be logged once");
assert.equal(internalResult.logs[0][1], internalError, "the logger must receive the original detailed error");

let duplicateWriteAttempts = 0;
const startedResult = await invokeRequestHandler({
  responseState: { headersSent: true },
  routeApi: async () => { throw new Error("stream failed after headers"); },
  sendJson() {
    duplicateWriteAttempts += 1;
    const error = new Error("Cannot set headers after they are sent to the client");
    error.code = "ERR_HTTP_HEADERS_SENT";
    throw error;
  }
});
assert.equal(duplicateWriteAttempts, 0, "a started response must not attempt a second header write");
assert.equal(startedResult.logs.length, 1, "a post-header failure must still be logged");
assert.equal(startedResult.res.destroyCalls, 1, "a failed partial response must be closed instead of leaving the client waiting");
for (const responseState of [{ headersSent: true, writableEnded: true }, { destroyed: true }]) {
  const completedResult = await invokeRequestHandler({
    responseState,
    routeApi: async () => { throw new Error("failure after response completion"); },
    sendJson() { assert.fail("an ended or disconnected response must not be rewritten"); }
  });
  assert.equal(completedResult.res.destroyCalls, 0, "ended and disconnected responses must not be destroyed again");
  assert.equal(completedResult.logs.length, 1);
}

await verifyHttpPreludeBoundary();
await verifyHttpPartialResponseBoundary();

console.log("API error boundary verification passed.");

async function verifyHttpPreludeBoundary() {
  const logs = [];
  let authCalls = 0;
  let routeCalls = 0;
  const allowedOrigin = "http://localhost";
  const corsError = new Error("private CORS failure at C:\\secret\\cors.bin");
  const handler = createRequestHandler({
    attachAccessAnalytics() {},
    attachAccessLogger() {},
    requestCorsOrigin(req) {
      if (req.headers["x-fixture-cors-error"]) throw corsError;
      return req.headers.origin === allowedOrigin ? allowedOrigin : "";
    },
    requestAuthState() { authCalls += 1; return { allowed: true }; },
    routeAuth: async () => false,
    sendLoginRequired() { assert.fail("the HTTP fixture must be authorized"); },
    routeApi: async (_req, res, url) => {
      routeCalls += 1;
      if (url.pathname === "/api/internal-url-error") new URL("http://[");
      sendJson(res, 200, { ok: true });
      return true;
    },
    routeMedia: async () => false,
    renderAndroidUpdatePage: () => "",
    serveStatic() { assert.fail("the HTTP fixture must not reach static files"); },
    sendHtml() {},
    sendJson,
    sendText,
    logError(...args) { logs.push(args); }
  });
  // Mount the async handler directly, just like server-host. An escaping
  // rejection must fail this fixture instead of being hidden by a test wrapper.
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = (options = {}) => requestHttpFixture(server.address().port, options);
  try {
    for (const options of [
      { headers: { Host: "[" } },
      { path: "http://[" }
    ]) {
      const beforeAuth = authCalls;
      const beforeRoutes = routeCalls;
      const response = await request(options);
      assert.equal(response.status, 400, "malformed Host and request targets must return 400");
      assert.deepEqual(JSON.parse(response.body), { error: "Invalid request URL" });
      assert.equal(authCalls, beforeAuth, "invalid URLs must fail before authentication");
      assert.equal(routeCalls, beforeRoutes, "invalid URLs must not execute application routes");
      const healthy = await request();
      assert.equal(healthy.status, 200, "the HTTP server must survive a malformed request");
      assert.deepEqual(JSON.parse(healthy.body), { ok: true });
    }

    const beforeCorsAuth = authCalls;
    const corsFailure = await request({ headers: { "X-Fixture-Cors-Error": "1" } });
    assert.equal(corsFailure.status, 500, "CORS setup failures must stay inside the error boundary");
    assert.deepEqual(JSON.parse(corsFailure.body), { error: "Internal server error" });
    assert.equal(authCalls, beforeCorsAuth);
    assert.equal(logs.at(-1)?.[1], corsError, "the original CORS failure must remain in server diagnostics");

    const internalUrlFailure = await request({ path: "/api/internal-url-error" });
    assert.equal(internalUrlFailure.status, 500, "URL errors within application routes must remain server errors");
    assert.deepEqual(JSON.parse(internalUrlFailure.body), { error: "Internal server error" });

    const beforeOptionsAuth = authCalls;
    const preflight = await request({ method: "OPTIONS", headers: { Origin: allowedOrigin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.body, "");
    assert.equal(preflight.headers["access-control-allow-origin"], allowedOrigin);
    assert.equal(preflight.headers.vary, "Origin");
    assert.equal(authCalls, beforeOptionsAuth, "preflight must preserve its early response");
    for (const method of ["GET", "OPTIONS"]) {
      const denied = await request({ method, headers: { Origin: "https://denied.invalid" } });
      assert.equal(denied.status, 403, "disallowed origins must remain forbidden");
      assert.equal(denied.headers["access-control-allow-origin"], undefined);
      assert.equal(authCalls, beforeOptionsAuth);
    }
    const healthy = await request({ headers: { Origin: allowedOrigin } });
    assert.equal(healthy.status, 200, "later valid requests must still complete");
    assert.equal(healthy.headers["access-control-allow-origin"], allowedOrigin);
    assert.equal(healthy.headers.vary, "Origin, Accept-Encoding", "JSON negotiation must preserve the CORS selection header");
    assert.deepEqual(JSON.parse(healthy.body), { ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function requestHttpFixture(port, { method = "GET", path = "/api/health", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("HTTP error-boundary fixture timed out")));
    req.once("error", reject);
    req.end();
  });
}

async function verifyHttpPartialResponseBoundary() {
  const logs = [];
  const failure = new Error("private stream failure at C:\\secret\\stream.bin");
  let releaseFailure;
  let failureGate;
  let failedResponse;
  const failPartialResponse = async (req, res, url, stage) => {
    if (url.pathname !== `/fixture/${stage}`) return false;
    failedResponse = res;
    res.writeHead(200, {
      "Content-Type": "text/plain",
      ...(url.searchParams.has("length") ? { "Content-Length": 1000 } : {})
    });
    res.write("partial fixture bytes");
    // The client releases this gate only after receiving the first chunk.
    // No delay or timing threshold determines when the injected failure runs.
    await failureGate;
    throw failure;
  };
  const handler = createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {},
    requestCorsOrigin: () => "", requestAuthState: () => ({ allowed: true }),
    routeAuth: async () => false,
    sendLoginRequired() { assert.fail("the streaming fixture must be authorized"); },
    async routeApi(req, res, url) {
      if (url.pathname === "/api/health") { sendJson(res, 200, { ok: true }); return true; }
      if (url.pathname === "/api/completed") {
        sendJson(res, 200, { ok: true });
        throw failure;
      }
      return failPartialResponse(req, res, url, "api");
    },
    routeMedia: (req, res, url) => failPartialResponse(req, res, url, "media"),
    serveStatic: (req, res, pathname) => failPartialResponse(req, res, new URL(req.url, "http://fixture"), "static"),
    renderAndroidUpdatePage: () => "", sendHtml() {}, sendJson, sendText,
    logError(...args) { logs.push(args); }
  });
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    for (const stage of ["api", "media", "static"]) {
      for (const length of [false, true]) {
        failureGate = new Promise(resolve => { releaseFailure = resolve; });
        const beforeLogs = logs.length;
        const result = await new Promise((resolve, reject) => {
          const req = http.get({ host: "127.0.0.1", port, path: `/fixture/${stage}${length ? "?length" : ""}`, agent: false }, res => {
            const chunks = [];
            let ended = false;
            let streamError;
            res.on("data", chunk => { chunks.push(chunk); releaseFailure(); });
            res.once("end", () => { ended = true; });
            res.once("error", error => { streamError = error; });
            res.once("close", () => resolve({
              status: res.statusCode, complete: res.complete, ended, streamError,
              body: Buffer.concat(chunks).toString("utf8")
            }));
          });
          req.once("error", reject);
          // Deadlock guard only; success requires a server-side reset, never a timeout.
          req.setTimeout(2000, () => req.destroy(new Error("partial response fixture timed out")));
        });
        assert.equal(result.status, 200, "already-sent headers cannot be replaced by an error status");
        assert.equal(result.complete, false, "a truncated response must not appear complete");
        assert.equal(result.ended, false, "failed streaming output must not emit a successful end");
        assert.equal(result.streamError?.code, "ECONNRESET");
        assert.equal(result.body, "partial fixture bytes", "the error body and private diagnostics must not be appended");
        assert.equal(failedResponse.destroyed, true);
        assert.equal(logs.length, beforeLogs + 1);
        assert.equal(logs.at(-1)?.[1], failure);
        assert.deepEqual(JSON.parse((await requestHttpFixture(port)).body), { ok: true }, "later requests must still complete");
      }
    }
    const completed = await requestHttpFixture(port, { path: "/api/completed" });
    assert.equal(completed.status, 200);
    assert.deepEqual(JSON.parse(completed.body), { ok: true }, "a late error must not truncate a response already ended");
  } finally {
    releaseFailure?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function invokeShortVideoDelete(bodyText, { storeError } = {}) {
  let storeCalls = 0;
  let deleteOptions = null;
  let response = null;
  const handled = await routeShortVideoApi(
    Object.assign(requestWithBody(bodyText), { method: "DELETE" }),
    {},
    new URL("http://127.0.0.1/api/short-videos/video-1"),
    {
      notFound() { assert.fail("the delete fixture must not fall through to not-found"); },
      readJsonBody,
      requireLocalAdmin: () => true,
      sendJson(_res, status, payload) { response = { status, payload }; },
      shortVideoStore: {
        deleteVideo(id, options) {
          storeCalls += 1;
          assert.equal(id, "video-1");
          deleteOptions = options;
          if (storeError) throw storeError;
          return { ok: true, id };
        }
      }
    }
  );
  assert.equal(handled, true, "the short-video DELETE route must be handled");
  return { deleteOptions, response, storeCalls };
}

async function invokeShortVideoDeleteJobStatus(storeError) {
  let response = null;
  const handled = await routeShortVideoApi(
    { method: "GET" },
    {},
    new URL("http://127.0.0.1/api/short-videos/delete-jobs?jobId=missing-job"),
    {
      notFound() { assert.fail("the delete-job status fixture must not fall through"); },
      readJsonBody,
      requireLocalAdmin: () => true,
      sendJson(_res, status, payload) { response = { status, payload }; },
      shortVideoStore: {
        deleteJobStatus() { throw storeError; }
      }
    }
  );
  assert.equal(handled, true);
  return response;
}

async function captureConsoleErrors(action) {
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    return { logs, value: await action() };
  } finally {
    console.error = originalConsoleError;
  }
}

async function invokeRequestHandler({ routeApi, responseState = {}, sendJson } = {}) {
  const logs = [];
  let response = null;
  const handler = createRequestHandler({
    attachAccessAnalytics() {},
    attachAccessLogger() {},
    requestCorsOrigin: () => "",
    requestAuthState: () => ({ allowed: true }),
    routeAuth: async () => false,
    sendLoginRequired() { assert.fail("the error-boundary fixture must be authorized"); },
    routeApi,
    routeMedia: async () => false,
    renderAndroidUpdatePage: () => "",
    serveStatic() {},
    sendHtml() {},
    sendJson: sendJson || ((_res, status, payload) => { response = { status, payload }; }),
    sendText() {},
    logError(...args) { logs.push(args); }
  });
  const res = fakeResponse(responseState);
  await handler({
    method: "GET",
    url: "/api/error-fixture",
    headers: { host: "127.0.0.1" }
  }, res);
  return { logs, response, res };
}

function requestWithBody(body) {
  return Readable.from(body ? [body] : []);
}

function fakeResponse(state = {}) {
  const headers = new Map();
  return {
    destroyed: false,
    destroyCalls: 0,
    headersSent: false,
    writableEnded: false,
    ...state,
    destroy() { this.destroyCalls += 1; this.destroyed = true; },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); }
  };
}
