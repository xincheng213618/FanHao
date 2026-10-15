import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { deleteJson, fetchJson, postJson, putJson } from "../android-client/www/js/api.js";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const pendingTimers = new Set();
globalThis.window = {
  setTimeout(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    pendingTimers.add(timer);
    return timer;
  },
  clearTimeout(timer) {
    pendingTimers.delete(timer);
    clearTimeout(timer);
  }
};

const pendingBodies = new Set();
let acceptedRequests = 0;
const server = createServer(async (request, response) => {
  acceptedRequests += 1;
  if (request.url === "/slow-headers") return;
  if (request.url === "/slow-body") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"ok":');
    pendingBodies.add(response);
    response.on("close", () => pendingBodies.delete(response));
    return;
  }
  if (request.url === "/invalid") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{");
    return;
  }
  if (request.url === "/empty") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url === "/busy") {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "暂时繁忙", code: "BUSY", retryable: true, pending: 3 }));
    return;
  }
  if (request.url === "/invalid-error") {
    response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("upstream unavailable");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks).toString("utf8")
  }));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  await test("Android API timeout covers a stalled response body", async () => {
    try {
      await assert.rejects(
        withinDeadline(fetchJson(baseUrl, "/slow-body", { timeoutMs: 100 })),
        isTimeout,
        "receiving headers must not stop the request timeout"
      );
    } finally {
      finishBodies();
    }
    assert.equal(pendingTimers.size, 0, "body timeout must release its timer");
  });

  await test("Android API external abort remains active after headers", async () => {
    const controller = trackedController();
    const headersReceived = Promise.withResolvers();
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      headersReceived.resolve();
      return response;
    };
    try {
      const pending = fetchJson(baseUrl, "/slow-body", { timeoutMs: 0, signal: controller.signal });
      await withinDeadline(headersReceived.promise);
      controller.abort();
      await assert.rejects(withinDeadline(pending), isAbort, "canceling body download must reject as AbortError");
      assert.equal(controller.listenerCount(), 0, "canceled requests must release the external abort listener");
    } finally {
      globalThis.fetch = originalFetch;
      finishBodies();
    }
  });

  await test("Android API keeps cleanup resources until the response body settles", async () => {
    const controller = trackedController();
    const headersReceived = Promise.withResolvers();
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      headersReceived.resolve();
      return response;
    };
    try {
      const pending = fetchJson(baseUrl, "/slow-body", { timeoutMs: 1000, signal: controller.signal });
      await withinDeadline(headersReceived.promise);
      await Promise.resolve();
      assert.equal(controller.listenerCount(), 1, "the abort bridge must stay installed while reading the body");
      assert.equal(pendingTimers.size, 1, "the timeout must stay armed while reading the body");
      finishBodies();
      assert.deepEqual(await withinDeadline(pending), { ok: true });
      assert.equal(controller.listenerCount(), 0);
      assert.equal(pendingTimers.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
      finishBodies();
    }
  });

  await test("Android API header timeout stays a timeout", async () => {
    await assert.rejects(withinDeadline(fetchJson(baseUrl, "/slow-headers", { timeoutMs: 100 })), isTimeout);
    assert.equal(pendingTimers.size, 0);
  });

  await test("Android API external abort before headers is not mislabeled as timeout", async () => {
    const controller = trackedController();
    const pending = fetchJson(baseUrl, "/slow-headers", { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await assert.rejects(withinDeadline(pending), isAbort);
    assert.equal(controller.listenerCount(), 0);
    assert.equal(pendingTimers.size, 0);
  });

  await test("Android API rejects an already-aborted signal without making a request", async () => {
    const controller = trackedController();
    controller.abort();
    const before = acceptedRequests;
    await assert.rejects(withinDeadline(fetchJson(baseUrl, "/ok", { signal: controller.signal })), isAbort);
    assert.equal(acceptedRequests, before);
    assert.equal(controller.listenerCount(), 0);
    assert.equal(pendingTimers.size, 0);
  });

  await test("Android API does not relabel an earlier cancellation when the timer fires", async () => {
    const controller = trackedController();
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        setTimeout(() => reject(new DOMException("fixture canceled", "AbortError")), 30);
      }, { once: true });
    });
    try {
      const pending = fetchJson(baseUrl, "/ok", { timeoutMs: 5, signal: controller.signal });
      controller.abort();
      await assert.rejects(withinDeadline(pending), isAbort);
      assert.equal(controller.listenerCount(), 0);
      assert.equal(pendingTimers.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("Android API preserves success, request serialization and mutation helpers", async () => {
    const controller = trackedController();
    const data = await fetchJson(baseUrl, "/ok", {
      method: "POST",
      body: { value: "正文" },
      headers: { "X-Request-Fixture": "present" },
      signal: controller.signal
    });
    assert.equal(data.method, "POST");
    assert.equal(data.body, '{"value":"正文"}');
    assert.equal(data.headers.accept, "application/json");
    assert.equal(data.headers["content-type"], "application/json");
    assert.equal(data.headers["x-fanhao-client"], "android");
    assert.equal(data.headers["x-request-fixture"], "present");
    assert.equal(controller.listenerCount(), 0);
    assert.equal(pendingTimers.size, 0);
    assert.equal((await postJson(baseUrl, "/ok", { value: 1 })).method, "POST");
    assert.equal((await putJson(baseUrl, "/ok", { value: 2 })).method, "PUT");
    assert.equal((await deleteJson(baseUrl, "/ok")).method, "DELETE");
    assert.equal(pendingTimers.size, 0, "mutation helpers must retain their no-timeout behavior");
  });

  await test("Android API preserves HTTP error fields and non-JSON fallback", async () => {
    await assert.rejects(fetchJson(baseUrl, "/busy"), (error) => {
      assert.equal(error.message, "暂时繁忙");
      assert.equal(error.status, 503);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "BUSY");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.payload, { error: "暂时繁忙", code: "BUSY", retryable: true, pending: 3 });
      return true;
    });
    await assert.rejects(fetchJson(baseUrl, "/invalid-error"), (error) => {
      assert.equal(error.message, "请求失败：502");
      assert.equal(error.status, 502);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.payload, {});
      return true;
    });
    assert.deepEqual(await fetchJson(baseUrl, "/invalid"), {});
    assert.deepEqual(await fetchJson(baseUrl, "/empty"), {});
    assert.equal(pendingTimers.size, 0);
  });

  await test("Android API propagates network failures and cleans up", async () => {
    const failure = new TypeError("fixture network failure");
    const controller = trackedController();
    globalThis.fetch = async () => { throw failure; };
    try {
      await assert.rejects(fetchJson(baseUrl, "/ok", { signal: controller.signal }), (error) => error === failure);
      assert.equal(controller.listenerCount(), 0);
      assert.equal(pendingTimers.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  for (const timer of pendingTimers) clearTimeout(timer);
  finishBodies();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function isTimeout(error) {
  return error?.name !== "AbortError" && error?.message === "请求超时，已保留本地缓存";
}

function isAbort(error) {
  return error?.name === "AbortError" && !/请求超时/u.test(error.message);
}

function finishBodies() {
  for (const response of pendingBodies) response.end("true}");
  pendingBodies.clear();
}

async function withinDeadline(promise) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(1500, null, { signal: controller.signal }).then(() => {
        throw new Error("fixture deadline exceeded: request did not settle");
      })
    ]);
  } finally {
    controller.abort();
  }
}

function trackedController() {
  const controller = new AbortController();
  const listeners = new Set();
  return {
    abort: () => controller.abort(),
    listenerCount: () => listeners.size,
    signal: {
      get aborted() { return controller.signal.aborted; },
      addEventListener(type, callback, options) {
        if (type === "abort") listeners.add(callback);
        controller.signal.addEventListener(type, callback, options);
      },
      removeEventListener(type, callback) {
        if (type === "abort") listeners.delete(callback);
        controller.signal.removeEventListener(type, callback);
      }
    }
  };
}
