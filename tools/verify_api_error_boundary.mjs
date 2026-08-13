import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { shortVideoPublicError } from "../src/modules/short-videos/server/public-errors.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { readJsonBody, RequestBodyError } from "../src/platform/server/request-io.js";

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

console.log("API error boundary verification passed.");

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
    headersSent: false,
    writableEnded: false,
    ...state,
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); }
  };
}
