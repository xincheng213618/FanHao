import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
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

async function invokeShortVideoDelete(bodyText) {
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
          return { ok: true, id };
        }
      }
    }
  );
  assert.equal(handled, true, "the short-video DELETE route must be handled");
  return { deleteOptions, response, storeCalls };
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
