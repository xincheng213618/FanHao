import fs from "node:fs";

export function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());
  if (!match) return null;

  const sizeValue = Math.max(0, Number(size || 0) || 0);
  if (!sizeValue || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, sizeValue - suffixLength),
      end: sizeValue - 1
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : sizeValue - 1;
  const end = Math.min(requestedEnd, sizeValue - 1);

  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start > end || start < 0 || start >= sizeValue) {
    return null;
  }

  return { start, end };
}

function normalizedEntityMtimeMs(file, stat) {
  // A verified startup prefix represents the original entity, whose logical
  // size and timestamp differ from this physical cache file. All complete
  // files keep their opened handle's metadata authoritative.
  const prefixMtime = Number(file?.entityMtimeMs);
  if (Number(file?.totalSize) > Number(stat?.size) && file?.entityMtimeMs !== null
    && file?.entityMtimeMs !== undefined && file?.entityMtimeMs !== ""
    && Number.isFinite(prefixMtime) && prefixMtime >= 0) return prefixMtime;
  for (const value of [stat?.mtimeMs, file?.entityMtimeMs, file?.cacheVersion]) {
    if (value === null || value === undefined || value === "") continue;
    const candidate = Number(value);
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return 0;
}

function normalizedEntityTag(value) {
  const candidate = String(value || "").trim();
  if (!candidate || /[\r\n]/.test(candidate)) return "";
  return /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(candidate) ? candidate : "";
}

export function entityValidators(file, stat, entitySize = Number(stat?.size || 0)) {
  const size = Math.max(0, Math.floor(Number(entitySize || 0)) || 0);
  const authoritativeMtimeMs = normalizedEntityMtimeMs(file, stat);
  // Short-video source URLs and their verified startup prefixes share a
  // catalog revision measured in milliseconds. This explicit precision choice
  // never replaces a complete file's authoritative opened-handle timestamp.
  const mtimeMs = file?.entityMtimeResolutionMs === 1 ? Math.floor(authoritativeMtimeMs) : authoritativeMtimeMs;
  const explicitTag = normalizedEntityTag(file?.entityTag);
  const versionMicros = Math.max(0, Math.round(mtimeMs * 1000));
  // Size and timestamps are revision hints, not byte identity. Only a caller
  // with a trusted entity tag may opt into a strong validator.
  const etag = explicitTag || `W/"${size.toString(16)}-${versionMicros.toString(16)}"`;
  const lastModified = new Date(mtimeMs).toUTCString();
  return { ETag: etag, "Last-Modified": lastModified };
}

export function ifRangeMatches(ifRangeHeader, validators) {
  const candidate = String(ifRangeHeader || "").trim();
  if (!candidate) return true;
  if (/^W\//i.test(candidate)) return false;

  if (candidate.startsWith('"')) {
    const etag = String(validators?.ETag || "");
    return Boolean(etag) && !/^W\//i.test(etag) && candidate === etag;
  }
  // Last-Modified has only second precision and is not a byte identity. This
  // server authorizes a resumed range only with a trusted strong entity tag.
  return false;
}

function entityTagConditionMatches(value, etag, weak) {
  let remaining = String(value || "").trim();
  if (remaining === "*") return true;
  let matched = false, sawTag = false;
  while (remaining) {
    // Commas inside an opaque tag are data, so splitting on commas is unsafe.
    const tag = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/.exec(remaining)?.[0];
    if (!tag) return false;
    sawTag = true;
    const compare = candidate => weak ? candidate.replace(/^W\//, "") : candidate;
    if ((weak || (!tag.startsWith("W/") && !etag.startsWith("W/"))) && compare(tag) === compare(etag)) matched = true;
    remaining = remaining.slice(tag.length).trimStart();
    if (!remaining) break;
    if (!remaining.startsWith(",")) return false;
    remaining = remaining.slice(1).trimStart();
    if (!remaining) return false;
  }
  return sawTag && matched;
}

function readPreconditionStatus(req, validators) {
  if (req?.method !== "GET" && req?.method !== "HEAD") return 0;
  const headers = req.headers || {}, etag = validators.ETag;
  const modified = Date.parse(validators["Last-Modified"]);
  const ifMatch = headers["if-match"], ifNoneMatch = headers["if-none-match"];
  if (ifMatch !== undefined) {
    if (!entityTagConditionMatches(ifMatch, etag, false)) return 412;
  } else if (headers["if-unmodified-since"] !== undefined) {
    const unmodifiedSince = parseHttpDate(headers["if-unmodified-since"]);
    if (Number.isFinite(unmodifiedSince) && modified > unmodifiedSince) return 412;
  }
  if (ifNoneMatch !== undefined) {
    if (entityTagConditionMatches(ifNoneMatch, etag, true)) return 304;
  } else if (headers["if-modified-since"] !== undefined) {
    const modifiedSince = parseHttpDate(headers["if-modified-since"]);
    if (Number.isFinite(modifiedSince) && modified <= modifiedSince) return 304;
  }
  return 0;
}

function parseHttpDate(value) {
  const date = String(value || "").trim();
  // Accept the preferred HTTP-date and its two obsolete wire formats, while
  // ignoring Date.parse extensions such as a bare year or a numeric string.
  if (!/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/.test(date)) return NaN;
  return Date.parse(date);
}

function isSingleByteRange(rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());
  return Boolean(match && (match[1] || match[2]));
}

function diagnosticResponseHeaders(headers) {
  const protectedNames = new Set([
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified"
  ]);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !protectedNames.has(String(name).toLowerCase()))
  );
}

// Await the response without retaining listeners after finish or disconnect.
// HEAD-only test adapters may not expose stream events.
async function finishResponse(res, write) {
  if (typeof res.once !== "function") { write(); return; }
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  res.once("finish", finish);
  res.once("close", finish);
  res.once("error", finish);
  try {
    write();
    if (res.writableFinished || res.destroyed) finish();
    await ended;
  } finally {
    res.off("finish", finish);
    res.off("close", finish);
    res.off("error", finish);
  }
}

export function createFileServer({ defaultChunkBytes = 0, mimeTypes, normalizeExt, notFound, stopTimeoutMs = 2000 }) {
  const normalizedDefaultChunkBytes = Math.max(0, Math.floor(Number(defaultChunkBytes || 0)));
  const normalizedStopTimeoutMs = Math.max(1, Math.floor(Number(stopTimeoutMs) || 2000));
  const owners = new Set();
  let accepting = true, lifecycleGeneration = 0, stopTask = null;

  const incompleteStop = () => Object.assign(new Error("File descriptors have not finished closing"), {
    code: "FILE_SERVER_STOP_INCOMPLETE", statusCode: 503
  });
  function releaseOwner(owner) {
    if (!owner.done || (owner.handle && !owner.closed)) return;
    if (owners.delete(owner)) owner.release();
  }
  function beginStop() {
    accepting = false;
    lifecycleGeneration += 1;
    for (const owner of owners) owner.controller.abort();
  }
  function stop() {
    beginStop();
    if (stopTask) return stopTask;
    let timer;
    const physicalDrain = Promise.all([...owners].map(owner => owner.released));
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(incompleteStop()), normalizedStopTimeoutMs); });
    const task = Promise.race([physicalDrain, timeout]).finally(() => {
      clearTimeout(timer);
      if (stopTask === task) stopTask = null;
    });
    stopTask = task;
    return task;
  }
  async function start() {
    const generation = lifecycleGeneration;
    if (stopTask) {
      try { await stopTask; }
      catch (error) { if (owners.size) throw error; }
    }
    if (generation !== lifecycleGeneration) return false;
    for (const owner of owners) releaseOwner(owner);
    if ((!accepting && owners.size) || [...owners].some(owner => owner.closeFailed)) throw incompleteStop();
    accepting = true;
    return true;
  }

  function attachmentDisposition(fileName = "download") {
    const fallback = String(fileName || "download").replace(/[^\w.-]+/g, "_").slice(0, 180) || "download";
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(fileName || fallback))}`;
  }

  function respondToReadPreconditions(req, res, validators, headers) {
    const status = readPreconditionStatus(req, validators);
    if (!status) return null;
    res.writeHead(status, {
      ...diagnosticResponseHeaders(headers),
      ...(headers["Accept-Ranges"] ? { "Accept-Ranges": headers["Accept-Ranges"] } : {}),
      ...(status === 412 ? { "Cache-Control": "no-store" }
        : headers["Cache-Control"] ? { "Cache-Control": headers["Cache-Control"] } : {}),
      ...validators,
      ...(status === 412 ? { "Content-Length": 0 } : {})
    });
    return finishResponse(res, () => res.end());
  }

  function serveInlineFile(res, filePath, contentType = "", options = {}) {
    const ext = normalizeExt(filePath);
    return serveWholeFile(res.req, res, filePath, (stat) => ({
      "Content-Type": contentType || mimeTypes[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": "inline"
    }), options);
  }

  function serveDownloadFile(req, res, file, fileName = "") {
    const ext = file?.ext || normalizeExt(file?.path || "");
    return serveWholeFile(req, res, file?.path, (stat) => ({
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "Content-Disposition": attachmentDisposition(fileName || file.name || file.fileName || "download")
    }));
  }

  function withOpenedFile(req, res, filePath, respond, options = {}) {
    if (!accepting) {
      if (req?.aborted || options.signal?.aborted || res.destroyed || res.writableEnded) {
        if (!res.destroyed && !res.writableEnded) res.destroy();
        return Promise.resolve(false);
      }
      return finishResponse(res, () => {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": 0, "Cache-Control": "no-store" });
        res.end();
      }).then(() => false);
    }
    const owner = { controller: new AbortController(), done: false, handle: null, closed: false, closeFailed: false };
    owner.released = new Promise(resolve => { owner.release = resolve; });
    const abort = () => owner.controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    owners.add(owner);
    return runOpenedFile(req, res, filePath, respond, { ...options, signal: owner.controller.signal }, owner).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      owner.done = true;
      releaseOwner(owner);
    });
  }

  async function runOpenedFile(req, res, filePath, respond, options, owner) {
    const { signal, isCurrent, validateFile } = options;
    let handle, stream, streamClosed;
    let interrupted = false;
    const unavailable = () => interrupted || signal?.aborted || req?.aborted || res.destroyed || res.writableEnded;
    const current = () => {
      try { return !isCurrent || isCurrent(); }
      catch { return false; }
    };
    const disconnect = () => {
      interrupted = true;
      stream?.destroy();
      if (!res.destroyed && !res.writableEnded) res.destroy();
    };
    req?.once?.("aborted", disconnect);
    res.once?.("close", disconnect);
    signal?.addEventListener("abort", disconnect, { once: true });
    try {
      if (signal?.aborted || req?.aborted) disconnect();
      if (unavailable()) return false;
      if (!current()) { await finishResponse(res, () => notFound(res)); return false; }
      let stat;
      try {
        handle = await fs.promises.open(filePath, "r");
        owner.handle = handle;
        const closeHandle = handle.close.bind(handle);
        // Node marks fd=-1 and emits FileHandle.close before its native close
        // finishes. Later close() calls can already resolve. Capture the first
        // native close promise for both stream autoClose and our final drain.
        handle.close = () => owner.closePromise ||= Promise.resolve().then(closeHandle);
        // An ignored abort during open must close its late descriptor without
        // starting more filesystem work or publishing headers.
        if (unavailable()) return false;
        if (!current()) { await finishResponse(res, () => notFound(res)); return false; }
        stat = await handle.stat();
        if (unavailable()) return false;
        if (!stat.isFile()) throw Object.assign(new Error("File path is not a file"), { code: "ENOTDIR" });
      } catch (error) {
        if (!unavailable()) {
          if (options.throwFileErrors && error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          await finishResponse(res, () => notFound(res));
        }
        return false;
      }
      if (!current()) { await finishResponse(res, () => notFound(res)); return false; }
      // Archive callers recheck source and path safety after the asynchronous
      // open/stat boundary. Validation failures belong to their route handler.
      if (validateFile) await validateFile(stat);
      if (unavailable()) return false;
      if (!current()) { await finishResponse(res, () => notFound(res)); return false; }

      const pipe = async (range) => {
        const bounds = range || { start: 0, end: stat.size - 1 };
        const expectedBytes = bounds.end - bounds.start + 1;
        let receivedBytes = 0;
        const failed = () => {
          if (res.destroyed || res.writableEnded) return;
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end();
          } else {
            // A partial body cannot satisfy its advertised Content-Length.
            res.destroy();
          }
        };
        try {
          stream = handle.createReadStream({ ...bounds, autoClose: true, emitClose: true });
          streamClosed = new Promise(resolve => stream.once("close", resolve));
          stream.on("error", failed);
          stream.on("data", chunk => {
            receivedBytes += chunk.length;
            if (receivedBytes > expectedBytes) failed();
          });
          // End the destination ourselves: pipe's automatic end could still
          // complete a response after a short-read destroy in this same event.
          stream.once("end", () => {
            if (receivedBytes !== expectedBytes) failed();
            else if (!unavailable()) res.end();
          });
          stream.once("close", () => { if (!stream.readableEnded) failed(); });
          await finishResponse(res, () => {
            if (unavailable()) { stream.destroy(); return; }
            stream.pipe(res, { end: false });
          });
        } catch {
          failed();
        }
      };
      return await respond(stat, pipe);
    } finally {
      // Keep the serving promise pending through physical stream/FD closure,
      // including ignored open/stat cancellation and autoClose stream errors.
      try {
        stream?.destroy();
        if (stream && !stream.closed) await streamClosed;
        try {
          await handle?.close();
          owner.closed = true;
        } catch (error) {
          // A rejected native close cannot prove descriptor release, even if
          // Node's JS handle now says fd=-1. Keep shutdown failed instead of
          // retrying an unknown descriptor number.
          owner.closeFailed = true;
          throw error;
        }
      } finally {
        req?.off?.("aborted", disconnect);
        res.off?.("close", disconnect);
        signal?.removeEventListener("abort", disconnect);
      }
    }
  }

  function serveWholeFile(req, res, filePath, responseHeaders, options = {}) {
    return withOpenedFile(req, res, filePath, async (stat, pipe) => {
      // Headers and bytes refer to the same opened handle even if the lexical
      // path is moved/replaced before streaming starts.
      const headers = responseHeaders(stat);
      const validators = entityValidators({ entityTag: headers.ETag }, stat);
      const conditional = respondToReadPreconditions(req, res, validators, headers);
      if (conditional) { await conditional; return true; }
      res.writeHead(200, { ...headers, ...validators });
      if (req?.method === "HEAD" || stat.size === 0) {
        await finishResponse(res, () => res.end());
        return true;
      }
      await pipe();
      return true;
    }, options);
  }

  function serveRangedFile(req, res, file, options = {}) {
    return withOpenedFile(req, res, file?.path, async (stat, pipe) => {
      // A short-video startup cache may contain only the first chunk while still
      // representing the original media entity. Keep the HTTP range total and
      // validators tied to that original entity, but never read past the cached
      // physical prefix.
      const entitySize = Math.max(stat.size, Math.floor(Number(file.totalSize || 0)) || 0);
      const validators = entityValidators(file, stat, entitySize);
      const rangeHeader = req.method === "GET" ? String(req.headers?.range || "").trim() : "";
      const singleByteRange = isSingleByteRange(rangeHeader);
      const ifRangeHeader = String(req.headers?.["if-range"] || "").trim();
      const rangeConditionMatches = !ifRangeHeader || ifRangeMatches(ifRangeHeader, validators);
      const requestedRange = singleByteRange && rangeConditionMatches
        ? parseRange(rangeHeader, entitySize)
        : null;
      const hasExplicitRangeLimit = file.maxRangeBytes !== undefined && file.maxRangeBytes !== null;
      const maxRangeBytes = file.fullResponse
        ? 0
        : hasExplicitRangeLimit
          ? Math.max(0, Math.floor(Number(file.maxRangeBytes || 0)))
          : normalizedDefaultChunkBytes;
      const range = requestedRange && maxRangeBytes
        ? {
            start: requestedRange.start,
            end: Math.min(requestedRange.end, requestedRange.start + maxRangeBytes - 1)
          }
        : requestedRange;
      const contentType = mimeTypes[file.ext] || "application/octet-stream";
      const cacheControl = String(file.cacheControl || "").trim() || "no-store";
      const responseHeaders = file.responseHeaders && typeof file.responseHeaders === "object"
        ? diagnosticResponseHeaders(file.responseHeaders)
        : {};

      const conditional = respondToReadPreconditions(req, res, validators, {
        ...responseHeaders, "Accept-Ranges": "bytes", "Cache-Control": cacheControl
      });
      if (conditional) { await conditional; return; }

      if (singleByteRange && rangeConditionMatches && !requestedRange) {
        res.writeHead(416, {
          ...responseHeaders,
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${entitySize}`,
          "Content-Length": 0,
          "Cache-Control": cacheControl,
          "Content-Disposition": "inline",
          ...validators
        });
        await finishResponse(res, () => res.end());
        return;
      }

      if (!range) {
        // A physical startup-prefix file cannot satisfy a full representation.
        // Callers must fall back to the source entity when If-Range fails.
        if (stat.size < entitySize) {
          res.writeHead(503, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": 0,
            "Cache-Control": "no-store"
          });
          await finishResponse(res, () => res.end());
          return;
        }

        res.writeHead(200, {
          ...responseHeaders,
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Content-Length": entitySize,
          "Cache-Control": cacheControl,
          "Content-Disposition": "inline",
          ...validators
        });
        if (req.method === "HEAD" || stat.size === 0) {
          await finishResponse(res, () => res.end());
          return;
        }
        await pipe();
        return;
      }

      if (range.start >= stat.size) {
        res.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": 0,
          "Cache-Control": "no-store"
        });
        await finishResponse(res, () => res.end());
        return;
      }

      const responseRange = {
        start: range.start,
        end: Math.min(range.end, stat.size - 1)
      };

      res.writeHead(206, {
        ...responseHeaders,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${entitySize}`,
        "Content-Length": responseRange.end - responseRange.start + 1,
        "Cache-Control": cacheControl,
        "Content-Disposition": "inline",
        ...validators
      });
      await pipe(responseRange);
      return;
    }, { ...options, isCurrent: options.isCurrent || file?.isCurrentSource }).then(() => undefined);
  }

  return {
    serveWholeFile,
    serveDownloadFile,
    serveInlineFile,
    serveRangedFile,
    start, beginStop, stop,
    diagnostics: () => ({ accepting, active: owners.size, closeFailed: [...owners].filter(owner => owner.closeFailed).length })
  };
}
