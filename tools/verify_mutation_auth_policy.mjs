import assert from "node:assert/strict";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";
import { routeToolsApi } from "../src/modules/tools/server/routes.js";

const novelMutations = [
  {
    name: "upload",
    method: "POST",
    pathname: "/api/novels/upload",
    expected: { status: 201, payload: { ok: true, id: "uploaded" } },
    invoke(store) { return store.uploadBook({ title: "fixture" }); }
  },
  {
    name: "delete",
    method: "DELETE",
    pathname: "/api/novels/book-1",
    expected: { status: 200, payload: { ok: true, deleted: { id: "book-1" } } },
    invoke(store) { return store.deleteBook("book-1"); }
  },
  {
    name: "patch",
    method: "PATCH",
    pathname: "/api/novels/book-1",
    expected: { status: 200, payload: { ok: true, book: { id: "book-1", title: "updated" } } },
    invoke(store) { return store.updateBookMetadata("book-1", { title: "updated" }); }
  }
];

for (const mutation of novelMutations) {
  const denied = await invokeNovel(mutation, false);
  assert.deepEqual(denied.response, { status: 403, payload: { error: "forbidden" } }, `${mutation.name} must reject a denied request`);
  assert.equal(denied.bodyReads, 0, `${mutation.name} must reject before reading its body`);
  assert.equal(denied.storeCalls, 0, `${mutation.name} must reject before touching the novel store`);

  const allowed = await invokeNovel(mutation, true);
  assert.deepEqual(allowed.response, mutation.expected, `${mutation.name} must preserve its successful response`);
  assert.equal(allowed.bodyReads, mutation.method === "PATCH" || mutation.method === "POST" ? 1 : 0, `${mutation.name} must retain its existing body read behavior`);
  assert.equal(allowed.storeCalls, 1, `${mutation.name} must preserve its store call`);
}

const deniedTxt = await invokeTxt(false);
assert.deepEqual(deniedTxt.response, { status: 403, payload: { error: "forbidden" } }, "txt format must reject a denied request");
assert.equal(deniedTxt.bodyReads, 0, "txt format must reject before reading its body");
assert.equal(deniedTxt.createDownloadCalls, 0, "txt format must reject before creating a download");

const allowedTxt = await invokeTxt(true);
assert.deepEqual(allowedTxt.response, { status: 200, payload: { id: "download-1" } }, "txt format must preserve its successful response");
assert.equal(allowedTxt.bodyReads, 1, "txt format must retain its body read");
assert.equal(allowedTxt.createDownloadCalls, 1, "txt format must preserve download creation");

console.log("Mutation auth policy verification passed.");

async function invokeNovel(mutation, allowed) {
  let bodyReads = 0;
  let storeCalls = 0;
  let response = null;
  const store = {
    uploadBook(body) { storeCalls += 1; return mutation.invoke({ uploadBook: () => ({ id: "uploaded" }) }, body); },
    deleteBook(id) { storeCalls += 1; return mutation.invoke({ deleteBook: () => ({ id }) }, id); },
    updateBookMetadata(id, body) { storeCalls += 1; return mutation.invoke({ updateBookMetadata: () => ({ id, title: body.title }) }, id, body); }
  };
  const handled = await routeNovelApi({ method: mutation.method }, {}, new URL(`http://fixture${mutation.pathname}`), {
    collectionService: {},
    novelStore: store,
    notFound() { assert.fail(`${mutation.name} should not be not found`); },
    readJsonBody: async () => { bodyReads += 1; return { title: "updated" }; },
    reimportService: {},
    requireLocalAdmin: gate(allowed, (status, payload) => { response = { status, payload }; }),
    sendJson(_res, status, payload) { response = { status, payload }; }
  });
  assert.equal(handled, true, `${mutation.name} route must be handled`);
  return { bodyReads, response, storeCalls };
}

async function invokeTxt(allowed) {
  let bodyReads = 0;
  let createDownloadCalls = 0;
  let response = null;
  const handled = await routeToolsApi({ method: "POST" }, {}, new URL("http://fixture/api/tools/txt-format"), {
    readJsonBody: async () => { bodyReads += 1; return { text: "fixture" }; },
    requireLocalAdmin: gate(allowed, (status, payload) => { response = { status, payload }; }),
    sendJson(_res, status, payload) { response = { status, payload }; },
    txtFormatToolService: {
      maxBodyBytes: 1024,
      async createDownload() { createDownloadCalls += 1; return { id: "download-1" }; }
    }
  });
  assert.equal(handled, true, "txt format route must be handled");
  return { bodyReads, createDownloadCalls, response };
}

function gate(allowed, send) {
  return () => {
    if (allowed) return true;
    send(403, { error: "forbidden" });
    return false;
  };
}
